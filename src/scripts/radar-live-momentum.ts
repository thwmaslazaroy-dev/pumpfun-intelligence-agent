import { createHash } from "crypto";
import WebSocket from "ws";
import { config } from "../config";

// ── Constants ─────────────────────────────────────────────────────────────────

const EVAL_INTERVAL_MS = 60_000;
const RECONNECT_DELAY_MS = 5_000;
const TOKEN_MAX_AGE_MS = 3 * 60 * 60 * 1000;

// Alert thresholds
const MIN_TOKEN_AGE_MIN = 2;
const MAX_TOKEN_AGE_MIN = 15;
const MIN_UNIQUE_BUYERS = 15;
const MAX_UNIQUE_BUYERS = 80;
const MIN_BUY_INTERVALS = 2;

// Anchor event discriminants: sha256("event:<Name>")[0..8]
// No HTTP fetches — all data is extracted directly from WebSocket Program data logs.
const CREATE_EVENT_DISC = createHash("sha256")
  .update("event:CreateEvent")
  .digest()
  .subarray(0, 8);

const TRADE_EVENT_DISC = createHash("sha256")
  .update("event:TradeEvent")
  .digest()
  .subarray(0, 8);

const BASE58_CHARS = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TokenState {
  mint: string;
  name: string;
  symbol: string;
  firstSeenAt: number;
  uniqueBuyers: Set<string>;
  buyTimestamps: number[];
}

// ── In-memory state ───────────────────────────────────────────────────────────

const tokens = new Map<string, TokenState>();
const alerted = new Set<string>();
let currentWs: WebSocket | null = null;

// diagnostic counters
let rawMessages = 0;
let createEvents = 0;
let createLogHits = 0;
let createLogMisses = 0;
let buyEvents = 0;
let buyLogHits = 0;
let buyLogMisses = 0;

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

function discMatches(buf: Buffer, disc: Uint8Array): boolean {
  if (buf.length < 8) return false;
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== disc[i]) return false;
  }
  return true;
}

// Parse pump.fun CreateEvent from "Program data: <base64>" log lines.
// Layout (Borsh after 8-byte discriminant):
//   name: string (u32 len + bytes)
//   symbol: string (u32 len + bytes)
//   uri: string (u32 len + bytes)
//   mint: Pubkey (32 bytes)
//   bondingCurve: Pubkey (32 bytes)
//   user: Pubkey (32 bytes)
function extractCreateEventFromLogs(
  logs: string[],
): { mint: string; name: string; symbol: string } | null {
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    const b64 = line.slice("Program data: ".length).trim();
    let buf: Buffer;
    try {
      buf = Buffer.from(b64, "base64");
    } catch {
      continue;
    }
    if (!discMatches(buf, CREATE_EVENT_DISC)) continue;
    try {
      let offset = 8;
      const nameLen = buf.readUInt32LE(offset); offset += 4;
      const name = buf.subarray(offset, offset + nameLen).toString("utf8"); offset += nameLen;
      const symbolLen = buf.readUInt32LE(offset); offset += 4;
      const symbol = buf.subarray(offset, offset + symbolLen).toString("utf8"); offset += symbolLen;
      const uriLen = buf.readUInt32LE(offset); offset += 4;
      offset += uriLen;
      if (offset + 32 > buf.length) continue;
      const mint = base58Encode(buf.subarray(offset, offset + 32));
      return { mint, name, symbol };
    } catch {
      continue;
    }
  }
  return null;
}

// Parse pump.fun TradeEvent from "Program data: <base64>" log lines.
// Layout (Borsh after 8-byte discriminant):
//   mint[32] solAmount[8] tokenAmount[8] isBuy[1] user[32] timestamp[8] ...
// Total: 113 bytes minimum.
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
    if (!discMatches(buf, TRADE_EVENT_DISC)) continue;
    return {
      mint: base58Encode(buf.subarray(8, 40)),
      isBuy: buf[56] === 1,
      buyer: base58Encode(buf.subarray(57, 89)),
    };
  }
  return null;
}

// ── Event handlers ────────────────────────────────────────────────────────────

function handleCreate(mint: string, name: string, symbol: string): void {
  if (tokens.has(mint)) return;
  tokens.set(mint, {
    mint,
    name,
    symbol,
    firstSeenAt: Date.now(),
    uniqueBuyers: new Set(),
    buyTimestamps: [],
  });
  createEvents += 1;
  log("[CREATE]", { mint: mint.slice(0, 8) + "…", name, symbol, tracked: tokens.size });
}

function handleBuy(mint: string, buyer: string): void {
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
          { name: "🏷 Name", value: state.name || "Unknown", inline: true },
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
    createLogHits,
    createLogMisses,
    buyEvents,
    buyLogHits,
    buyLogMisses,
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

  if (typeof value?.signature !== "string" || value.err != null) return;

  const rawLogs = value.logs;
  const logs: string[] = Array.isArray(rawLogs)
    ? rawLogs.filter((l): l is string => typeof l === "string")
    : [];

  const eventType = detectEventType(logs);
  if (eventType === null || eventType === "sell") return;

  if (eventType === "create") {
    const event = extractCreateEventFromLogs(logs);
    if (event) {
      createLogHits += 1;
      handleCreate(event.mint, event.name, event.symbol);
    } else {
      createLogMisses += 1;
    }
    return;
  }

  // eventType === "buy"
  const trade = extractTradeEventFromLogs(logs);
  if (trade && trade.isBuy) {
    buyLogHits += 1;
    handleBuy(trade.mint, trade.buyer);
  } else {
    buyLogMisses += 1;
  }
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

  if (!wsUrl || !programId) {
    log("ERROR: SOLANA_RPC_WS_URL and PUMPFUN_PROGRAM_ID must be set in .env");
    process.exit(1);
  }

  log("[STARTING] radar:live:momentum (zero-HTTP, WebSocket-only)", {
    minUniqueBuyers: MIN_UNIQUE_BUYERS,
    minBuyIntervals: MIN_BUY_INTERVALS,
    minTokenAgeMin: MIN_TOKEN_AGE_MIN,
    maxTokenAgeMin: MAX_TOKEN_AGE_MIN,
    webhookConfigured: Boolean(config.discordWebhookUrl),
  });

  connect();

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
