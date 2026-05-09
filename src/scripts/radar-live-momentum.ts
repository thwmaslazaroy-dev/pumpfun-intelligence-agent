import WebSocket from "ws";
import { config } from "../config";

// ── Constants ─────────────────────────────────────────────────────────────────

const PUMPPORTAL_WS_URL = "wss://pumpportal.fun/api/data";
const EVAL_INTERVAL_MS = 60_000;
const RECONNECT_DELAY_MS = 5_000;
const TOKEN_MAX_AGE_MS = 3 * 60 * 60 * 1000;
const GRADUATION_SOL = 85;

const MIN_TOKEN_AGE_MIN = 10;
const MAX_TOKEN_AGE_MIN = 120;
const MIN_UNIQUE_BUYERS = 15;
const MIN_BUY_INTERVALS = 3;
const MAX_BC_PROGRESS = 60;

// ── Types ─────────────────────────────────────────────────────────────────────

interface TokenState {
  mint: string;
  symbol: string;
  name: string;
  firstSeenAt: number;
  uniqueBuyers: Set<string>;
  buyTimestamps: number[];
  marketCapSol: number;
  bondingCurveProgress: number;
}

interface PumpPortalMessage {
  mint?: unknown;
  traderPublicKey?: unknown;
  txType?: unknown;
  marketCapSol?: unknown;
  symbol?: unknown;
  name?: unknown;
}

// ── In-memory state ───────────────────────────────────────────────────────────

const tokens = new Map<string, TokenState>();
const alerted = new Set<string>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function bcProgress(marketCapSol: number): number {
  return Math.min(100, (marketCapSol / GRADUATION_SOL) * 100);
}

function get5MinBucket(ts: number): number {
  return Math.floor(ts / (5 * 60 * 1000));
}

function distinctBuyIntervals(timestamps: number[]): number {
  return new Set(timestamps.map(get5MinBucket)).size;
}

function log(msg: string, extra?: Record<string, unknown>): void {
  const line = extra ? `${msg} ${JSON.stringify(extra)}` : msg;
  process.stdout.write(`[${new Date().toISOString()}] ${line}\n`);
}

function asStr(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asNum(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// ── Discord ────────────────────────────────────────────────────────────────────

async function sendDiscordAlert(state: TokenState): Promise<void> {
  const ageMin = Math.floor((Date.now() - state.firstSeenAt) / 60_000);
  const intervals = distinctBuyIntervals(state.buyTimestamps);
  const bc = state.bondingCurveProgress.toFixed(1);
  const mcap = state.marketCapSol.toFixed(2);

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
          { name: "📈 Bonding curve", value: `${bc}%`, inline: true },
          { name: "💰 Market cap", value: `${mcap} SOL`, inline: true },
          {
            name: "📊 Buying pattern",
            value: `steady across ${intervals} of 5-min windows over ${ageMin} min`,
            inline: false,
          },
          {
            name: "🔗 Link",
            value: `https://pump.fun/coin/${state.mint}`,
            inline: false,
          },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };

  if (!config.discordWebhookUrl) {
    log("MOMENTUM ALERT (no webhook — set DISCORD_WEBHOOK_URL to receive alerts)", {
      mint: state.mint,
      symbol: state.symbol,
      ageMin,
      uniqueBuyers: state.uniqueBuyers.size,
      bcProgress: bc,
      marketCapSol: mcap,
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
    if (!res.ok) {
      log("discord webhook rejected", { status: res.status });
    } else {
      log("discord alert sent", { mint: state.mint, symbol: state.symbol });
    }
  } catch (err) {
    log("discord webhook error", { error: err instanceof Error ? err.message : String(err) });
  } finally {
    clearTimeout(timer);
  }
}

// ── Evaluation loop ────────────────────────────────────────────────────────────

async function evaluate(): Promise<void> {
  const now = Date.now();

  for (const [mint, state] of tokens) {
    if (now - state.firstSeenAt > TOKEN_MAX_AGE_MS) {
      tokens.delete(mint);
    }
  }

  let sent = 0;

  for (const [mint, state] of tokens) {
    if (alerted.has(mint)) continue;

    const ageMin = (now - state.firstSeenAt) / 60_000;
    if (ageMin < MIN_TOKEN_AGE_MIN || ageMin > MAX_TOKEN_AGE_MIN) continue;
    if (state.uniqueBuyers.size < MIN_UNIQUE_BUYERS) continue;
    if (distinctBuyIntervals(state.buyTimestamps) < MIN_BUY_INTERVALS) continue;
    if (state.bondingCurveProgress >= MAX_BC_PROGRESS) continue;

    alerted.add(mint);
    await sendDiscordAlert(state);
    sent += 1;
  }

  log("eval tick", { tracked: tokens.size, alerted: alerted.size, sent });
}

// ── Event handler ─────────────────────────────────────────────────────────────

function handleMessage(raw: string): void {
  let msg: PumpPortalMessage;
  try {
    msg = JSON.parse(raw) as PumpPortalMessage;
  } catch {
    return;
  }

  const mint = asStr(msg.mint);
  if (!mint) return;

  const now = Date.now();
  const txType = asStr(msg.txType);
  const marketCapSol = asNum(msg.marketCapSol) ?? 0;
  const symbol = asStr(msg.symbol) ?? "UNKNOWN";
  const name = asStr(msg.name) ?? "Unknown";

  if (!tokens.has(mint)) {
    tokens.set(mint, {
      mint,
      symbol,
      name,
      firstSeenAt: now,
      uniqueBuyers: new Set(),
      buyTimestamps: [],
      marketCapSol,
      bondingCurveProgress: bcProgress(marketCapSol),
    });
  }

  const state = tokens.get(mint)!;

  if (marketCapSol > 0) {
    state.marketCapSol = marketCapSol;
    state.bondingCurveProgress = bcProgress(marketCapSol);
  }
  if (symbol !== "UNKNOWN" && state.symbol === "UNKNOWN") state.symbol = symbol;
  if (name !== "Unknown" && state.name === "Unknown") state.name = name;

  if (txType === "buy") {
    const buyer = asStr(msg.traderPublicKey);
    if (buyer) state.uniqueBuyers.add(buyer);
    state.buyTimestamps.push(now);
  }
}

// ── WebSocket ─────────────────────────────────────────────────────────────────

function connect(): void {
  log("connecting to pumpportal", { url: PUMPPORTAL_WS_URL });

  const ws = new WebSocket(PUMPPORTAL_WS_URL);

  ws.on("open", () => {
    log("connected — subscribing to new tokens and trades");
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    ws.send(JSON.stringify({ method: "subscribeTokenTrade" }));
  });

  ws.on("message", (data: WebSocket.RawData) => {
    handleMessage(data.toString());
  });

  ws.on("close", (code: number, reason: Buffer) => {
    log("disconnected — reconnecting in 5s", { code, reason: reason.toString() });
    setTimeout(connect, RECONNECT_DELAY_MS);
  });

  ws.on("error", (err: Error) => {
    log("ws error", { error: err.message });
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

log("radar:live:momentum starting", {
  minUniqueBuyers: MIN_UNIQUE_BUYERS,
  minBuyIntervals: MIN_BUY_INTERVALS,
  minTokenAgeMin: MIN_TOKEN_AGE_MIN,
  maxTokenAgeMin: MAX_TOKEN_AGE_MIN,
  maxBcProgress: MAX_BC_PROGRESS,
  webhookConfigured: Boolean(config.discordWebhookUrl),
});

connect();
setInterval(() => {
  evaluate().catch((err: Error) => log("eval error", { error: err.message }));
}, EVAL_INTERVAL_MS);

process.on("SIGINT", () => { log("shutting down"); process.exit(0); });
process.on("SIGTERM", () => { log("shutting down"); process.exit(0); });
