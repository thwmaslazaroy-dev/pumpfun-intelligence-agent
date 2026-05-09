import { PumpFunProvider, TokenLaunch, TokenSocialLinks } from "../types";
import { logger } from "../utils/logger";

const FEED_URL =
  "https://frontend-api-v3.pump.fun/coins?sort=created_timestamp&order=DESC&limit=50";
const REQUEST_TIMEOUT_MS = 20_000;
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface ApiCoin {
  mint?: unknown;
  creator?: unknown;
  name?: unknown;
  symbol?: unknown;
  created_timestamp?: unknown;
  usd_market_cap?: unknown;
  market_cap?: unknown;
  buy_count?: unknown;
  sell_count?: unknown;
  volume_usd?: unknown;
  volume?: unknown;
  bonding_curve_progress?: unknown;
  virtual_sol_reserves?: unknown;
  twitter?: unknown;
  telegram?: unknown;
  website?: unknown;
}

function isStr(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function safeFloat(v: unknown, min: number, max: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v < min || v > max) return null;
  return v;
}

function safeNonNegInt(v: unknown): number {
  const n = typeof v === "number" ? Math.floor(v) : Number.parseInt(String(v), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function parseCoin(raw: unknown): TokenLaunch | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as ApiCoin;

  if (!isStr(c.mint) || !MINT_RE.test(c.mint as string)) return null;
  if (!isStr(c.creator)) return null;
  const ts = c.created_timestamp;
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return null;

  const symbol = isStr(c.symbol) ? (c.symbol as string).trim() : "UNKNOWN";
  const name = isStr(c.name) ? (c.name as string).trim() : symbol;

  const marketCapUsd =
    safeFloat(c.usd_market_cap, 0, Infinity) ??
    safeFloat(c.market_cap, 0, Infinity) ??
    0;

  const buyCount = safeNonNegInt(c.buy_count);
  const sellCount = safeNonNegInt(c.sell_count);
  const volumeUsd =
    safeFloat(c.volume_usd, 0, Infinity) ??
    safeFloat(c.volume, 0, Infinity) ??
    0;

  let bondingCurveProgress = safeFloat(c.bonding_curve_progress, 0, 1) ?? null;
  if (bondingCurveProgress === null) {
    const solRes = safeFloat(c.virtual_sol_reserves, 0, Infinity);
    if (solRes !== null && solRes > 0) {
      bondingCurveProgress = Math.min(1, solRes / 85_000_000_000);
    }
  }
  bondingCurveProgress = bondingCurveProgress ?? 0;

  const twitter = isStr(c.twitter) ? (c.twitter as string).trim() : undefined;
  const telegram = isStr(c.telegram) ? (c.telegram as string).trim() : undefined;
  const website = isStr(c.website) ? (c.website as string).trim() : undefined;
  const socialLinks: TokenSocialLinks | undefined =
    twitter || telegram || website ? { twitter, telegram, website } : undefined;

  return {
    mint: (c.mint as string).trim(),
    name,
    symbol,
    creatorWallet: (c.creator as string).trim(),
    launchedAt: new Date(ts),
    initialMarketCapUsd: marketCapUsd,
    bondingCurveProgress,
    buyCount,
    sellCount,
    volumeUsd,
    socialLinks,
  };
}

export class FeedPumpFunProvider implements PumpFunProvider {
  async fetchRecentLaunches(): Promise<TokenLaunch[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let body: string;
    try {
      const res = await fetch(FEED_URL, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Referer: "https://pump.fun/",
          "User-Agent": "pumpfun-intelligence-agent/0.1",
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        logger.warn("feed: non-200 response", { status: res.status });
        return [];
      }
      body = await res.text();
    } catch (err) {
      clearTimeout(timer);
      logger.warn("feed: fetch failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }

    let rawArray: unknown[];
    try {
      const parsed = JSON.parse(body) as unknown;
      rawArray = Array.isArray(parsed) ? parsed : [];
    } catch {
      logger.warn("feed: JSON parse failed");
      return [];
    }

    const tokens: TokenLaunch[] = [];
    for (const raw of rawArray) {
      const token = parseCoin(raw);
      if (token) tokens.push(token);
    }

    logger.debug("feed: fetched", { total: rawArray.length, valid: tokens.length });
    return tokens;
  }
}
