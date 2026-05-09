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

// Throttle HTTP RPC fetches to stay well within QuikNode rate limits
const QUEUE_TICK_MS = 1_000;
const QUEUE_BATCH_SIZE = 3;
const TX_FETCH_DELAY_MS = 250;

// Alert thresholds
const MIN_TOKEN_AGE_MIN = 10;
const MAX_TOKEN_AGE_MIN = 120;
const MIN_UNIQUE_BUYERS = 10;
const MIN_BUY_INTERVALS = 2;

// Program IDs / sysvar addresses that are never buyer wallets
const NON_WALLET_IDS: ReadonlySet<string> = new Set([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "Sysvar1nstructions1111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
]);

// ── Types ─────────────────────────────────────────────────────────────────────

interface TokenState {
  mint: string;
  symbol: string;
  firstSeenAt: number;
  uniqueBuyers: Set<string>;
  buyTimestamps: number[];
}

interface QueuedSig {
  signature: string;
  slot: number;
  eventType: "create" | "buy";
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
let fetchAttempts = 0;
let fetchMisses = 0;

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

// Extract the first wallet address that is not a program/sysvar/mint
function extractBuyerWallet(
  parsed: ParsedPumpFunTransaction,
  programId: string,
): string | null {
  const denylist = new Set<string>(NON_WALLET_IDS);
  denylist.add(programId);
  for (const m of parsed.candidateMints) {
    if (m.length > 0) denylist.add(m);
  }
  for (const w of parsed.candidateWallets) {
    if (w.length > 0 && !denylist.has(w)) return w;
  }
  return null;
}

// ── HTTP RPC ──────────────────────────────────────────────────────────────────

async function fetchTransaction(signature: string): Promise<unknown | null> {
  const url = config.solanaRpcHttpUrl;
  if (!url) return null;

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
    if (!res.ok) { fetchMisses += 1; return null; }
    const json = (await res.json()) as { result?: unknown };
    if (!json.result) { fetchMisses += 1; }
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

function handleBuy(parsed: ParsedPumpFunTransaction, programId: string): void {
  const mint = parsed.candidateMints[0];
  if (!mint) return;

  const state = tokens.get(mint);
  if (!state) return; // not a token we're tracking

  const buyer = extractBuyerWallet(parsed, programId);
  if (!buyer) return;

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

async function processQueuedSig(item: QueuedSig): Promise<void> {
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

  const programId = config.pumpfunProgramId;

  if (item.eventType === "create") {
    handleCreate(parsed);
  } else {
    // For buy events the parser may return BUY or UNKNOWN — try to extract
    // the mint and buyer regardless of the classified kind.
    handleBuy(parsed, programId);
  }
}

// ── Queue processor (runs every QUEUE_TICK_MS) ────────────────────────────────

async function processQueue(): Promise<void> {
  if (queue.length === 0) return;

  const batch = queue.splice(0, QUEUE_BATCH_SIZE);
  for (let i = 0; i < batch.length; i++) {
    await processQueuedSig(batch[i]);
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
    fetchAttempts,
    fetchMisses,
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

  // Log first 3 raw frames to confirm subscription and message shape
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

  // Skip if already in queue (duplicate notification)
  if (queue.some((q) => q.signature === signature)) return;

  // Cap queue to prevent unbounded growth during high-volume bursts
  if (queue.length >= 1000) {
    queue.shift();
  }

  queue.push({ signature, slot, eventType });
  log(`[QUEUED-${eventType.toUpperCase()}]`, {
    sig: signature.slice(0, 12) + "…",
    qLen: queue.length,
  });
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

  process.on("SIGINT", () => { log("shutting down"); process.exit(0); });
  process.on("SIGTERM", () => { log("shutting down"); process.exit(0); });
}

main();
