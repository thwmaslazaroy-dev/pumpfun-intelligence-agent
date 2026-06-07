import { createHash } from "crypto";
import WebSocket from "ws";
import { config } from "../config";

// ── CONFIG ────────────────────────────────────────────────────────────────────
const EVAL_INTERVAL_MS = 30_000;          // check every 30s
const RECONNECT_DELAY_MS = 5_000;
const TOKEN_MAX_AGE_MS = 45 * 60 * 1000; // forget tokens older than 45min

// Entry window: alert only while token is in this age range
const MIN_TOKEN_AGE_MIN = 3;
const MAX_TOKEN_AGE_MIN = 25;

// Market cap range (USD) — early but not too early
const MIN_MARKET_CAP_USD = 6_000;
const MAX_MARKET_CAP_USD = 80_000;

// Quality thresholds
const MIN_UNIQUE_BUYERS = 20;            // at least 20 different wallets
const MAX_WHALE_SHARE = 0.35;            // no single wallet > 35% of buys
const MIN_BUY_SELL_RATIO = 0.60;         // at least 60% of trades are buys
const MIN_BUY_INTERVALS = 3;             // buys spread across 3+ different 5min windows
const MAX_VELOCITY_SPIKE = 0.75;         // no single 5min window > 75% of all buys (detects parabolic)

// Minimum score to trigger alert (0-100)
const MIN_SCORE = 65;

// Max alerts per hour (spam protection)
const MAX_ALERTS_PER_HOUR = 8;

// ── Anchor discriminants ──────────────────────────────────────────────────────
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
interface TradeRecord {
  wallet: string;
  isBuy: boolean;
  solAmount: number;
  ts: number;
}

interface TokenState {
  mint: string;
  name: string;
  symbol: string;
  creator: string;
  firstSeenAt: number;
  trades: TradeRecord[];
  creatorSoldAt: number | null;
}

// ── State ─────────────────────────────────────────────────────────────────────
const tokens = new Map<string, TokenState>();
const alerted = new Set<string>();
const alertTimestamps: number[] = [];

let currentWs: WebSocket | null = null;
let rawMessages = 0;
let createEvents = 0;
let tradeEvents = 0;

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg: string, extra?: Record<string, unknown>): void {
  const line = extra ? `${msg} ${JSON.stringify(extra)}` : msg;
  process.stdout.write(`[${new Date().toISOString()}] ${line}\n`);
}

// ── Base58 encode ─────────────────────────────────────────────────────────────
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
  for (let i = 0; i < 8; i++) if (buf[i] !== disc[i]) return false;
  return true;
}

// ── Borsh parsers ─────────────────────────────────────────────────────────────
function extractCreateEvent(
  logs: string[],
): { mint: string; name: string; symbol: string; creator: string } | null {
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    const b64 = line.slice("Program data: ".length).trim();
    let buf: Buffer;
    try { buf = Buffer.from(b64, "base64"); } catch { continue; }
    if (!discMatches(buf, CREATE_EVENT_DISC)) continue;
    try {
      let offset = 8;
      const nameLen = buf.readUInt32LE(offset); offset += 4;
      const name = buf.subarray(offset, offset + nameLen).toString("utf8"); offset += nameLen;
      const symbolLen = buf.readUInt32LE(offset); offset += 4;
      const symbol = buf.subarray(offset, offset + symbolLen).toString("utf8"); offset += symbolLen;
      const uriLen = buf.readUInt32LE(offset); offset += 4;
      offset += uriLen;
      if (offset + 96 > buf.length) continue; // need mint(32) + bondingCurve(32) + user(32)
      const mint = base58Encode(buf.subarray(offset, offset + 32)); offset += 32;
      offset += 32; // skip bondingCurve
      const creator = base58Encode(buf.subarray(offset, offset + 32));
      return { mint, name, symbol, creator };
    } catch { continue; }
  }
  return null;
}

// TradeEvent layout after 8-byte discriminant:
// mint[32] solAmount[8:u64] tokenAmount[8:u64] isBuy[1] user[32] timestamp[8:i64] ...
function extractTradeEvent(
  logs: string[],
): { mint: string; wallet: string; isBuy: boolean; solAmount: number } | null {
  for (const line of logs) {
    if (!line.startsWith("Program data: ")) continue;
    const b64 = line.slice("Program data: ".length).trim();
    let buf: Buffer;
    try { buf = Buffer.from(b64, "base64"); } catch { continue; }
    if (buf.length < 113) continue;
    if (!discMatches(buf, TRADE_EVENT_DISC)) continue;
    const mint = base58Encode(buf.subarray(8, 40));
    const solLamports = buf.readBigUInt64LE(40);
    const solAmount = Number(solLamports) / 1e9;
    const isBuy = buf[56] === 1;
    const wallet = base58Encode(buf.subarray(57, 89));
    return { mint, wallet, isBuy, solAmount };
  }
  return null;
}

function detectEventType(logs: string[]): "create" | "buy" | "sell" | null {
  for (const line of logs) {
    if (/Program log:\s*Instruction:\s*(Create|CreateV2)\b/i.test(line)) return "create";
    if (/Program log:\s*Instruction:\s*(Buy|BuyExact)/i.test(line)) return "buy";
    if (/Program log:\s*Instruction:\s*(Sell|SellExact)/i.test(line)) return "sell";
  }
  return null;
}

// ── Quality Scoring ───────────────────────────────────────────────────────────
interface ScoreResult {
  score: number;
  breakdown: Record<string, number>;
  flags: string[];
  uniqueBuyers: number;
  buySellRatio: number;
  whaleShare: number;
  buyIntervals: number;
  velocitySpike: number;
  creatorHolds: boolean;
}

function scoreToken(state: TokenState, now: number): ScoreResult {
  const recentCutoff = now - 20 * 60 * 1000; // last 20 min
  const recentTrades = state.trades.filter(t => t.ts >= recentCutoff);

  const buys = recentTrades.filter(t => t.isBuy);
  const sells = recentTrades.filter(t => !t.isBuy);

  const uniqueBuyers = new Set(buys.map(t => t.wallet)).size;
  const totalTrades = buys.length + sells.length;
  const buySellRatio = totalTrades > 0 ? buys.length / totalTrades : 0;

  // Whale concentration: what % of buys does the top buyer account for?
  const buysByWallet = new Map<string, number>();
  for (const t of buys) {
    buysByWallet.set(t.wallet, (buysByWallet.get(t.wallet) ?? 0) + 1);
  }
  const maxBuys = Math.max(...Array.from(buysByWallet.values()), 0);
  const whaleShare = buys.length > 0 ? maxBuys / buys.length : 0;

  // Buy spread across 5min windows
  const get5MinBucket = (ts: number) => Math.floor(ts / (5 * 60 * 1000));
  const buyIntervals = new Set(buys.map(t => get5MinBucket(t.ts))).size;

  // Velocity spike: what % of all buys happened in the single busiest 5min window?
  const bucketCounts = new Map<number, number>();
  for (const t of buys) {
    const b = get5MinBucket(t.ts);
    bucketCounts.set(b, (bucketCounts.get(b) ?? 0) + 1);
  }
  const maxBucket = Math.max(...Array.from(bucketCounts.values()), 0);
  const velocitySpike = buys.length > 0 ? maxBucket / buys.length : 0;

  // Creator sold?
  const creatorHolds = state.creatorSoldAt === null;

  // ── Score breakdown (each component 0-20, total 0-100) ──
  const breakdown: Record<string, number> = {};
  const flags: string[] = [];

  // 1. Unique buyers (0-25 pts)
  if (uniqueBuyers >= 40) breakdown.uniqueBuyers = 25;
  else if (uniqueBuyers >= 25) breakdown.uniqueBuyers = 20;
  else if (uniqueBuyers >= MIN_UNIQUE_BUYERS) breakdown.uniqueBuyers = 12;
  else { breakdown.uniqueBuyers = 0; flags.push(`low_buyers:${uniqueBuyers}`); }

  // 2. Buy/sell ratio (0-25 pts)
  if (buySellRatio >= 0.80) breakdown.buySellRatio = 25;
  else if (buySellRatio >= 0.70) breakdown.buySellRatio = 20;
  else if (buySellRatio >= MIN_BUY_SELL_RATIO) breakdown.buySellRatio = 12;
  else { breakdown.buySellRatio = 0; flags.push(`low_ratio:${buySellRatio.toFixed(2)}`); }

  // 3. Whale concentration (0-20 pts) — lower is better
  if (whaleShare <= 0.10) breakdown.whaleConc = 20;
  else if (whaleShare <= 0.20) breakdown.whaleConc = 15;
  else if (whaleShare <= MAX_WHALE_SHARE) breakdown.whaleConc = 8;
  else { breakdown.whaleConc = 0; flags.push(`whale:${(whaleShare * 100).toFixed(0)}%`); }

  // 4. Buy spread across time (0-20 pts)
  if (buyIntervals >= 5) breakdown.buySpread = 20;
  else if (buyIntervals >= 4) breakdown.buySpread = 16;
  else if (buyIntervals >= MIN_BUY_INTERVALS) breakdown.buySpread = 10;
  else { breakdown.buySpread = 0; flags.push(`low_spread:${buyIntervals}`); }

  // 5. No velocity spike (0-10 pts)
  if (velocitySpike <= 0.40) breakdown.velocity = 10;
  else if (velocitySpike <= MAX_VELOCITY_SPIKE) breakdown.velocity = 5;
  else { breakdown.velocity = 0; flags.push(`spike:${(velocitySpike * 100).toFixed(0)}%`); }

  // Bonus: creator still holds (+bonus flag in message)
  // Not in score — just informational

  const score = Object.values(breakdown).reduce((a, b) => a + b, 0);

  return {
    score,
    breakdown,
    flags,
    uniqueBuyers,
    buySellRatio,
    whaleShare,
    buyIntervals,
    velocitySpike,
    creatorHolds,
  };
}

// ── Discord alert ─────────────────────────────────────────────────────────────
async function sendAlert(state: TokenState, sr: ScoreResult, ageMin: number): Promise<void> {
  const qualityBar = sr.score >= 80 ? "🟢 HIGH" : sr.score >= 65 ? "🟡 MEDIUM" : "🔴 LOW";
  const creatorLine = sr.creatorHolds ? "✅ Creator still holds" : "⚠️ Creator sold";

  const payload = {
    username: "quality-pump-radar",
    embeds: [
      {
        title: `📡 QUALITY SIGNAL: $${state.symbol}`,
        color: sr.score >= 80 ? 0x00ff88 : 0xfee75c,
        fields: [
          { name: "📍 Mint", value: `\`${state.mint}\``, inline: false },
          { name: "🏷 Name", value: state.name || "Unknown", inline: true },
          { name: "⏱ Age", value: `${ageMin}m`, inline: true },
          { name: "🎯 Quality", value: `${qualityBar} (${sr.score}/100)`, inline: true },
          { name: "👥 Unique buyers", value: String(sr.uniqueBuyers), inline: true },
          { name: "📈 Buy ratio", value: `${(sr.buySellRatio * 100).toFixed(0)}%`, inline: true },
          { name: "🐋 Whale share", value: `${(sr.whaleShare * 100).toFixed(0)}%`, inline: true },
          { name: "📊 Buy windows", value: `${sr.buyIntervals} × 5min`, inline: true },
          { name: "⚡ Velocity spike", value: `${(sr.velocitySpike * 100).toFixed(0)}%`, inline: true },
          { name: "👨‍💻 Creator", value: creatorLine, inline: true },
          {
            name: "🔍 Score breakdown",
            value: Object.entries(sr.breakdown)
              .map(([k, v]) => `${k}: ${v}`)
              .join(" | "),
            inline: false,
          },
          { name: "🔗 Link", value: `https://pump.fun/coin/${state.mint}`, inline: false },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };

  if (!config.discordWebhookUrl) {
    log("[ALERT-NO-WEBHOOK]", { mint: state.mint, score: sr.score });
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
      log("[ALERT-SENT]", { mint: state.mint, symbol: state.symbol, score: sr.score });
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

  // Cleanup old tokens
  for (const [mint, state] of tokens) {
    if (now - state.firstSeenAt > TOKEN_MAX_AGE_MS) {
      tokens.delete(mint);
      alerted.delete(mint);
    }
  }

  // Cleanup old alert timestamps
  const oneHourAgo = now - 60 * 60 * 1000;
  while (alertTimestamps.length > 0 && alertTimestamps[0] < oneHourAgo) {
    alertTimestamps.shift();
  }

  let sent = 0;
  let candidates = 0;

  for (const [mint, state] of tokens) {
    if (alerted.has(mint)) continue;

    const ageMin = (now - state.firstSeenAt) / 60_000;
    if (ageMin < MIN_TOKEN_AGE_MIN || ageMin > MAX_TOKEN_AGE_MIN) continue;

    // Quick pre-filter before scoring
    const recentBuys = state.trades.filter(
      t => t.isBuy && t.ts >= now - 20 * 60 * 1000,
    );
    if (recentBuys.length < MIN_UNIQUE_BUYERS) continue;

    const sr = scoreToken(state, now);
    if (sr.uniqueBuyers < MIN_UNIQUE_BUYERS) continue;
    if (sr.buySellRatio < MIN_BUY_SELL_RATIO) continue;
    if (sr.whaleShare > MAX_WHALE_SHARE) continue;
    if (sr.buyIntervals < MIN_BUY_INTERVALS) continue;

    candidates += 1;

    if (sr.score < MIN_SCORE) {
      log("[CANDIDATE-REJECTED]", {
        mint: mint.slice(0, 8) + "…",
        symbol: state.symbol,
        score: sr.score,
        flags: sr.flags,
      });
      continue;
    }

    if (alertTimestamps.length >= MAX_ALERTS_PER_HOUR) {
      log("[SUPPRESSED-CAP]", { mint: mint.slice(0, 8) + "…", score: sr.score });
      continue;
    }

    alerted.add(mint);
    alertTimestamps.push(now);
    await sendAlert(state, sr, Math.floor(ageMin));
    sent += 1;
  }

  log("[EVAL]", {
    tracked: tokens.size,
    alerted: alerted.size,
    candidates,
    sent,
    alertsThisHour: alertTimestamps.length,
    rawWs: rawMessages,
    creates: createEvents,
    trades: tradeEvents,
  });
}

// ── Event handlers ────────────────────────────────────────────────────────────
function handleCreate(mint: string, name: string, symbol: string, creator: string): void {
  if (tokens.has(mint)) return;
  tokens.set(mint, {
    mint, name, symbol, creator,
    firstSeenAt: Date.now(),
    trades: [],
    creatorSoldAt: null,
  });
  createEvents += 1;
  log("[CREATE]", { mint: mint.slice(0, 8) + "…", name, symbol, tracked: tokens.size });
}

function handleTrade(mint: string, wallet: string, isBuy: boolean, solAmount: number): void {
  const state = tokens.get(mint);
  if (!state) return;

  const now = Date.now();
  state.trades.push({ wallet, isBuy, solAmount, ts: now });

  // Keep last 1000 trades per token
  if (state.trades.length > 1000) state.trades = state.trades.slice(-1000);

  // Track if creator sells
  if (!isBuy && wallet === state.creator && state.creatorSoldAt === null) {
    state.creatorSoldAt = now;
    log("[CREATOR-SOLD]", { mint: mint.slice(0, 8) + "…", symbol: state.symbol });
  }

  tradeEvents += 1;
}

// ── WS message handler ────────────────────────────────────────────────────────
interface LogsNotification {
  method?: unknown;
  params?: {
    result?: {
      value?: {
        signature?: unknown;
        err?: unknown;
        logs?: unknown;
      };
    };
  };
}

function handleWsMessage(raw: string): void {
  rawMessages += 1;
  if (rawMessages <= 3) log("[RAW]", { n: rawMessages, frame: raw.slice(0, 200) });

  let msg: LogsNotification;
  try { msg = JSON.parse(raw) as LogsNotification; } catch { return; }

  if (msg.method !== "logsNotification") return;
  const value = msg.params?.result?.value;
  if (typeof value?.signature !== "string" || value.err != null) return;

  const rawLogs = value.logs;
  const logs: string[] = Array.isArray(rawLogs)
    ? rawLogs.filter((l): l is string => typeof l === "string")
    : [];

  const eventType = detectEventType(logs);
  if (!eventType) return;

  if (eventType === "create") {
    const ev = extractCreateEvent(logs);
    if (ev) handleCreate(ev.mint, ev.name, ev.symbol, ev.creator);
    return;
  }

  const trade = extractTradeEvent(logs);
  if (trade) handleTrade(trade.mint, trade.wallet, trade.isBuy, trade.solAmount);
}

// ── WebSocket ─────────────────────────────────────────────────────────────────
function connect(): void {
  const wsUrl = config.solanaRpcWsUrl;
  const programId = config.pumpfunProgramId;
  log("[CONNECT]", { url: wsUrl.slice(0, 50) + "…" });

  const ws = new WebSocket(wsUrl);
  currentWs = ws;

  ws.on("open", () => {
    log("[CONNECTED] subscribing to pump.fun logs");
    ws.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "logsSubscribe",
      params: [{ mentions: [programId] }, { commitment: "processed" }],
    }));
  });

  ws.on("message", (data: WebSocket.RawData) => handleWsMessage(data.toString()));

  ws.on("close", (code: number, reason: Buffer) => {
    if (currentWs === ws) currentWs = null;
    log("[DISCONNECTED] reconnecting in 5s", { code, reason: reason.toString() });
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  ws.on("error", (err: Error) => log("[WS-ERROR]", { error: err.message }));
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main(): void {
  if (!config.solanaRpcWsUrl || !config.pumpfunProgramId) {
    log("ERROR: SOLANA_RPC_WS_URL and PUMPFUN_PROGRAM_ID must be set");
    process.exit(1);
  }

  log("[STARTING] quality-pump-detector", {
    minScore: MIN_SCORE,
    minUniqueBuyers: MIN_UNIQUE_BUYERS,
    minBuySellRatio: MIN_BUY_SELL_RATIO,
    maxWhaleShare: MAX_WHALE_SHARE,
    minBuyIntervals: MIN_BUY_INTERVALS,
    ageWindow: `${MIN_TOKEN_AGE_MIN}-${MAX_TOKEN_AGE_MIN}min`,
    webhookConfigured: Boolean(config.discordWebhookUrl),
  });

  connect();

  setInterval(() => {
    evaluate().catch((err: Error) => log("[EVAL-ERR]", { error: err.message }));
  }, EVAL_INTERVAL_MS);

  process.on("SIGINT", () => { log("shutting down"); process.exit(0); });
  process.on("SIGTERM", () => { log("shutting down"); process.exit(0); });
}

main();
