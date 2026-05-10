import { createHash } from "crypto";
import WebSocket from "ws";
import { config } from "../config";
import {
  PumpFunTransactionParser,
  RawTransactionLine,
} from "../parsing/pumpfun-transaction-parser";
import { ParsedPumpFunTransaction } from "../types";

// ── Constants ─────────────────────────────────────────────────────────────────

const EVAL_INTERVAL_MS = 60_000;
const RECONNECT_DELAY_MS = 5_000;
const TOKEN_MAX_AGE_MS = 3 * 60 * 60 * 1000;

// Only CREATE events hit HTTP; process at most 1 per tick to stay within limits
const QUEUE_TICK_MS = 2_000;
const QUEUE_BATCH_SIZE = 1;
const TX_FETCH_DELAY_MS = 2_000;

// Exponential backoff ceiling when Helius returns 429
const MAX_BACKOFF_MS = 30_000;

// Alert thresholds
const MIN_TOKEN_AGE_MIN = 2;
const MAX_TOKEN_AGE_MIN = 15;
const MIN_UNIQUE_BUYERS = 15;
const MAX_UNIQUE_BUYERS = 80;
const MIN_BUY_INTERVALS = 2;

// Anchor event discriminant: sha256("event:TradeEvent")[0..8]
// BUY events are resolved directly from this log data — no HTTP fetch needed.
const TRADE_EVENT_DISC = createHash("sha256")
  .update("event:TradeEvent")
  .digest()
  .subarray(0, 8);

const BASE58_CHARS = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TokenState {
  mint: string;
  symbol: string;
  firstSeenAt: number;
  uniqueBuyers: Set<string>;
  buyTimestamps: number[];
}

// Only CREATE events are queued for HTTP fetch
interface QueuedSig {
  signature: string;
  slot: number;
}

// ── In-memory state ───────────────────────────────────────────────────────────

const tokens = new Map<string, TokenState>();
const alerted = new Set<string>();
const queue: QueuedSig[] = [];
let currentWs: WebSocket | null = null;
let parser: PumpFunTransactionParser | null = null;

// diagnostic counters
let rawMessages = 0;
let createEvents = 0;
let buyEvents = 0;
let buyLogHits = 0;   // BUY events resolved from Program data (no HTTP)
let buyLogMisses = 0; // BUY events where log parsing failed (skipped)
let fetchAttempts = 0;
let fetchMisses = 0;

// Exponential backoff state for Helius HTTP rate limiting
let rateLimitBackoffMs = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg: string, extra?: Record<string, unknown>): void {
  const line = extra ? `${msg} ${JSON.stringify(extra)}` : msg;
  process.stdout.write(`[${new Date().toISOString()}] ${line}\n`);
}

function get5MinBucket(ts: number): number {
  return Math.floor(ts / (5 * 60 * 1000));
}

function distinctBuyIntervals(timestamps: number[]): number {
  return new Set(timestamps.map(get5MinBucket)).size;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function detectEventType(logs: string[]): "create" | "buy" | "sell" | null {
  for (const line of logs) {
    if (/Program log:\s*Instruction:\s*(Create|CreateV2)\b/i.test(line)) return "create";
    if (/Program log:\s*Instruction:\s*(Buy|BuyExact)/i.test(line)) return "buy";
    if (/Program log:\s*Instruction:\s*(Sell|SellExact)/i.test(line)) return "sell";
  }
  return null;
}

// Encode raw bytes to base58 (Solana pubkey format)
function base58Encode(bytes: Uint8Array): string {
  let num = 0n;
  for (const byte of bytes) num = num * 256n + BigInt(byte);
  let result = "";
  const base = 58n;
  while (num > 0n) {
    result = BASE58_CHARS[Number(num % base)] + result;
    num /= base;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    result = "1" + result;
  }
  return result;
}

// Parse pump.fun's Anchor TradeEvent from "Program data: <base64>" log lines.
// TradeEvent layout (Borsh, after 8-byte discriminant):
//   mint[32] solAmount[8] tokenAmount[8] isBuy[1] user[32] timestamp[8] ...
// Total: 113 bytes. No HTTP fetch required.
function extractTradeEventFromLogs(
  logs: string[],
): { mint: string; buyer: string; isBuy: boolean } | null {
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    const b64 = line.slice("Program data: ".length).trim();
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, "base64");
    } catch {
      continue;
    }
    if (buf.length < 113) continue;
    let match = true;
    for (let i = 0; i < 8; i++) {
      if (buf[i] !== TRADE_EVENT_DISC[i]) {
        match = false;
        break;
      }
    }
    if (!match) continue;
    return {
      mint: base58Encode(buf.subarray(8, 40)),
      isBuy: buf[56] === 1,
      buyer: base58Encode(buf.subarray(57, 89)),
    };
  }
  return null;
}

// ── HTTP RPC ──────────────────────────────────────────────────────────────────

async function fetchTransaction(signature: string): Promise<unknown | null> {
  const url = config.solanaRpcHttpUrl;
  if (!url) return null;

  if (rateLimitBackoffMs > 0) {
    log("[BACKOFF]", { waitMs: rateLimitBackoffMs });
    await sleep(rateLimitBackoffMs);
  }

  fetchAttempts += 1;
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "getTransaction",
    params: [
      signature,
      { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" },
    ],
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: controller.signal,
    });
    if (res.status === 429) {
      rateLimitBackoffMs =
        rateLimitBackoffMs === 0 ? 2_000 : Math.min(rateLimitBackoffMs * 2, MAX_BACKOFF_MS);
      log("[RATE-LIMITED]", { backoffMs: rateLimitBackoffMs });
      fetchMisses += 1;
      return null;
    }
    if (!res.ok) {
      fetchMisses += 1;
      return null;
    }
    const json = (await res.json()) as { result?: unknown };
    if (!json.result) {
      fetchMisses += 1;
    } else if (rateLimitBackoffMs > 0) {
      rateLimitBackoffMs = Math.max(0, rateLimitBackoffMs - 1_000);
    }
    return json.result ?? null;
  } catch {
    fetchMisses += 1;
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── Transaction processing ────────────────────────────────────────────────────

function handleCreate(parsed: ParsedPumpFunTransaction): void {
  const mint = parsed.candidateMints[0];
  if (!mint || tokens.has(mint)) return;

  tokens.set(mint, {
    mint,
    symbol: "UNKNOWN",
    firstSeenAt: Date.now(),
    uniqueBuyers: new Set(),
    buyTimestamps: [],
  });
  createEvents += 1;
  log("[CREATE]", { mint: mint.slice(0, 8) + "…", tracked: tokens.size });
}

function handleBuyDirect(mint: string, buyer: string): void {
  const state = tokens.get(mint);
  if (!state) return;

  const now = Date.now();
  state.uniqueBuyers.add(buyer);
  state.buyTimestamps.push(now);
  if (state.buyTimestamps.length > 500) {
    state.buyTimestamps = state.buyTimestamps.slice(-500);
  }

  buyEvents += 1;
  log("[BUY]", {
    mint: mint.slice(0, 8) + "…",
    buyers: state.uniqueBuyers.size,
    intervals: distinctBuyIntervals(state.buyTimestamps),
  });
}

async function processQueuedCreate(item: QueuedSig): Promise<void> {
  if (!parser) return;

  const txData = await fetchTransaction(item.signature);
  if (txData === null) return;

  const raw: RawTransactionLine = {
    fetchedAt: new Date().toISOString(),
    signature: item.signature,
    slot: item.slot,
    blockTime: null,
    confirmationStatus: "confirmed",
    signatureErr: null,
    transaction: txData,
  };

  let parsed: ParsedPumpFunTransaction;
  try {
    parsed = parser.parse(raw);
  } catch (err) {
    log("[PARSE-ERR]", { error: String(err) });
    return;
  }

  handleCreate(parsed);
}

// ── Queue processor (runs every QUEUE_TICK_MS) ────────────────────────────────

async function processQueue(): Promise<void> {
  if (queue.length === 0) return;

  const batch = queue.splice(0, QUEUE_BATCH_SIZE);
  for (let i = 0; i < batch.length; i++) {
    await processQueuedCreate(batch[i]);
    if (i < batch.length - 1) await sleep(TX_FETCH_DELAY_MS);
  }
}

// ── Discord alert ─────────────────────────────────────────────────────────────

async function sendDiscordAlert(state: TokenState): Promise<void> {
  const ageMin = Math.floor((Date.now() - state.firstSeenAt) / 60_000);
  const intervals = distinctBuyIntervals(state.buyTimestamps);

  const payload = {
    username: "pumpfun-momentum",
    embeds: [
      {
        title: `🚀 MOMENTUM ALERT: $${state.symbol}`,
        color: 0xfee75c,
        fields: [
          { name: "📍 Mint", value: `\`${state.mint}\``, inline: false },
          { name: "⏱ Age", value: `${ageMin} minutes`, inline: true },
          { name: "👥 Unique buyers", value: String(state.uniqueBuyers.size), inline: true },
          {
            name: "📊 Buying pattern",
            value: `steady across ${intervals} distinct 5-min windows over ${ageMin} min`,
            inline: false,
          },
          { name: "🔗 Link", value: `https://pump.fun/coin/${state.mint}`, inline: false },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };

  if (!config.discordWebhookUrl) {
    log("MOMENTUM ALERT (no webhook — set DISCORD_WEBHOOK_URL)", {
      mint: state.mint,
      ageMin,
      uniqueBuyers: state.uniqueBuyers.size,
    });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(config.discordWebhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (res.ok) {
      log("[ALERT-SENT]", { mint: state.mint, symbol: state.symbol });
    } else {
      log("[ALERT-FAILED]", { status: res.status });
    }
  } catch (err) {
    log("[ALERT-ERROR]", { error: String(err) });
  } finally {
    clearTimeout(timer);
  }
}

// ── Evaluation loop ───────────────────────────────────────────────────────────

async function evaluate(): Promise<void> {
  const now = Date.now();

  for (const [mint, state] of tokens) {
    if (now - state.firstSeenAt > TOKEN_MAX_AGE_MS) {
      tokens.delete(mint);
      alerted.delete(mint);
    }
  }

  let sent = 0;
  for (const [mint, state] of tokens) {
    if (alerted.has(mint)) continue;
    const ageMin = (now - state.firstSeenAt) / 60_000;
    if (ageMin < MIN_TOKEN_AGE_MIN || ageMin > MAX_TOKEN_AGE_MIN) continue;
    if (state.uniqueBuyers.size < MIN_UNIQUE_BUYERS) continue;
    if (state.uniqueBuyers.size > MAX_UNIQUE_BUYERS) continue;
    if (distinctBuyIntervals(state.buyTimestamps) < MIN_BUY_INTERVALS) continue;

    alerted.add(mint);
    await sendDiscordAlert(state);
    sent += 1;
  }

  log("[EVAL]", {
    tracked: tokens.size,
    alerted: alerted.size,
    rawWsMessages: rawMessages,
    createEvents,
    buyEvents,
    buyLogHits,
    buyLogMisses,
    fetchAttempts,
    fetchMisses,
    rateLimitBackoffMs,
    queuePending: queue.length,
    sent,
  });
}

// ── WebSocket message handler ─────────────────────────────────────────────────

interface LogsValue {
  signature?: unknown;
  err?: unknown;
  logs?: unknown;
}

interface LogsNotification {
  method?: unknown;
  params?: {
    result?: {
      context?: { slot?: unknown };
      value?: LogsValue;
    };
  };
}

function handleWsMessage(raw: string): void {
  rawMessages += 1;

  if (rawMessages <= 3) {
    log("[RAW]", { n: rawMessages, frame: raw.slice(0, 300) });
  }

  let msg: LogsNotification;
  try {
    msg = JSON.parse(raw) as LogsNotification;
  } catch {
    return;
  }

  if (msg.method !== "logsNotification") return;

  const result = msg.params?.result;
  const value = result?.value;
  const slot = typeof result?.context?.slot === "number" ? result.context.slot : 0;

  if (typeof value?.signature !== "string" || value.err != null) return;

  const signature = value.signature;
  const rawLogs = value.logs;
  const logs: string[] = Array.isArray(rawLogs)
    ? rawLogs.filter((l): l is string => typeof l === "string")
    : [];

  const eventType = detectEventType(logs);
  if (eventType === null || eventType === "sell") return;

  if (eventType === "buy") {
    // Resolve BUY events directly from the Anchor TradeEvent in Program data logs.
    // This avoids all HTTP fetches for buys, which are ~99% of events.
    const trade = extractTradeEventFromLogs(logs);
    if (trade && trade.isBuy) {
      buyLogHits += 1;
      handleBuyDirect(trade.mint, trade.buyer);
    } else {
      buyLogMisses += 1;
    }
    return;
  }

  // CREATE: queue for HTTP fetch (low volume, mint requires full transaction)
  if (queue.some((q) => q.signature === signature)) return;
  if (queue.length >= 500) {
    queue.shift();
  }
  queue.push({ signature, slot });
  log("[QUEUED-CREATE]", { sig: signature.slice(0, 12) + "…", qLen: queue.length });
}

// ── WebSocket connection ───────────────────────────────────────────────────────

function connect(): void {
  const wsUrl = config.solanaRpcWsUrl;
  const programId = config.pumpfunProgramId;

  log("[CONNECT]", { url: wsUrl.slice(0, 50) + "…", programId });

  const ws = new WebSocket(wsUrl);
  currentWs = ws;

  ws.on("open", () => {
    log("[CONNECTED] subscribing to pump.fun program logs");
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "logsSubscribe",
        params: [{ mentions: [programId] }, { commitment: "processed" }],
      }),
    );
  });

  ws.on("message", (data: WebSocket.RawData) => {
    handleWsMessage(data.toString());
  });

  ws.on("close", (code: number, reason: Buffer) => {
    if (currentWs === ws) currentWs = null;
    log("[DISCONNECTED] reconnecting in 5s", { code, reason: reason.toString() });
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  ws.on("error", (err: Error) => {
    log("[WS-ERROR]", { error: err.message });
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

function main(): void {
  const programId = config.pumpfunProgramId;
  const wsUrl = config.solanaRpcWsUrl;
  const httpUrl = config.solanaRpcHttpUrl;

  if (!wsUrl || !programId || !httpUrl) {
    log("ERROR: SOLANA_RPC_WS_URL, SOLANA_RPC_HTTP_URL, and PUMPFUN_PROGRAM_ID must be set in .env");
    process.exit(1);
  }

  parser = new PumpFunTransactionParser(programId);

  log("[STARTING] radar:live:momentum (Helius/QuikNode logsSubscribe)", {
    minUniqueBuyers: MIN_UNIQUE_BUYERS,
    minBuyIntervals: MIN_BUY_INTERVALS,
    minTokenAgeMin: MIN_TOKEN_AGE_MIN,
    maxTokenAgeMin: MAX_TOKEN_AGE_MIN,
    webhookConfigured: Boolean(config.discordWebhookUrl),
    httpUrl: httpUrl.slice(0, 40) + "…",
  });

  connect();

  setInterval(() => {
    processQueue().catch((err: Error) => log("[QUEUE-ERR]", { error: err.message }));
  }, QUEUE_TICK_MS);

  setInterval(() => {
    evaluate().catch((err: Error) => log("[EVAL-ERR]", { error: err.message }));
  }, EVAL_INTERVAL_MS);

  process.on("SIGINT", () => {
    log("shutting down");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    log("shutting down");
    process.exit(0);
  });
}

main();
