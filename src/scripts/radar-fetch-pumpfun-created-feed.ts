import { config } from "../config";
import { logger } from "../utils/logger";
import { initDatabase, closeDatabase, getDatabase, SqliteTokenRepository } from "../storage";
import { TokenLaunch, TokenSocialLinks } from "../types";

const API_URL =
  "https://frontend-api-v3.pump.fun/coins?sort=created_timestamp&order=DESC&limit=50";
const REQUEST_TIMEOUT_MS = 20_000;

// Minimal Solana mint sanity check — base58, 32–44 chars
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ── API shape ─────────────────────────────────────────────────────────────────

interface ApiCoin {
  // Identity (stable)
  mint?: unknown;
  creator?: unknown;
  name?: unknown;
  symbol?: unknown;
  created_timestamp?: unknown;
  // Market data (mutable)
  market_cap?: unknown;       // may be SOL-denominated on some responses
  usd_market_cap?: unknown;   // USD market cap — preferred
  buy_count?: unknown;
  sell_count?: unknown;
  volume?: unknown;           // may be SOL
  volume_usd?: unknown;       // USD volume — preferred
  bonding_curve_progress?: unknown;  // 0–1 float when present
  // Virtual reserves (fallback for bonding-curve progress calc)
  virtual_sol_reserves?: unknown;
  // Social
  twitter?: unknown;
  telegram?: unknown;
  website?: unknown;
  // Misc (ignored but logged in sample)
  description?: unknown;
  nsfw?: unknown;
  reply_count?: unknown;
  complete?: unknown;
  raydium_pool?: unknown;
  king_of_the_hill_timestamp?: unknown;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function safeFloat(v: unknown, min = -Infinity, max = Infinity): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v < min || v > max) return null;
  return v;
}

function safeNonNegInt(v: unknown): number {
  const n = typeof v === "number" ? Math.floor(v) : Number.parseInt(String(v), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Redact base58-looking strings for safe console output. */
function sanitiseForLog(raw: unknown): string {
  return JSON.stringify(
    raw,
    (_key, val) => {
      if (
        typeof val === "string" &&
        val.length >= 32 &&
        MINT_RE.test(val)
      ) {
        return `${val.slice(0, 4)}...${val.slice(-4)}`;
      }
      return val;
    },
    2,
  );
}

// ── Field mapping ─────────────────────────────────────────────────────────────

function parseApiCoin(raw: unknown): TokenLaunch | null {
  if (typeof raw !== "object" || raw === null) return null;
  const coin = raw as ApiCoin;

  // ── Required identity fields ───────────────────────────────────────────────
  const mint = coin.mint;
  const creator = coin.creator;
  const tsRaw = coin.created_timestamp;

  if (!isNonEmptyString(mint) || !MINT_RE.test(mint)) return null;
  if (!isNonEmptyString(creator)) return null;
  if (typeof tsRaw !== "number" || !Number.isFinite(tsRaw) || tsRaw <= 0) return null;

  const symbol = isNonEmptyString(coin.symbol) ? coin.symbol.trim() : "UNKNOWN";
  const name   = isNonEmptyString(coin.name)   ? coin.name.trim()   : symbol;

  // ── Market cap (USD preferred over raw market_cap which may be SOL) ────────
  const marketCapUsd =
    safeFloat(coin.usd_market_cap, 0) ??
    safeFloat(coin.market_cap, 0) ??
    0;

  // ── Buy / sell counts ──────────────────────────────────────────────────────
  const buyCount  = safeNonNegInt(coin.buy_count);
  const sellCount = safeNonNegInt(coin.sell_count);

  // ── Volume in USD (prefer volume_usd over volume) ──────────────────────────
  const volumeUsd =
    safeFloat(coin.volume_usd, 0) ??
    safeFloat(coin.volume, 0) ??
    0;

  // ── Bonding curve progress (0–1 float) ────────────────────────────────────
  // Direct field when present; fall back to computing from virtual_sol_reserves.
  // Pump.fun graduation threshold ≈ 85 SOL = 85_000_000_000 lamports.
  let bondingCurveProgress =
    safeFloat(coin.bonding_curve_progress, 0, 1) ?? null;
  if (bondingCurveProgress === null) {
    const solRes = safeFloat(coin.virtual_sol_reserves, 0);
    if (solRes !== null && solRes > 0) {
      const GRAD_THRESHOLD_LAMPORTS = 85_000_000_000;
      bondingCurveProgress = Math.min(1, solRes / GRAD_THRESHOLD_LAMPORTS);
    }
  }
  bondingCurveProgress = bondingCurveProgress ?? 0;

  // ── Social links ───────────────────────────────────────────────────────────
  const twitter  = isNonEmptyString(coin.twitter)  ? coin.twitter.trim()  : undefined;
  const telegram = isNonEmptyString(coin.telegram) ? coin.telegram.trim() : undefined;
  const website  = isNonEmptyString(coin.website)  ? coin.website.trim()  : undefined;
  const socialLinks: TokenSocialLinks | undefined =
    twitter || telegram || website ? { twitter, telegram, website } : undefined;

  return {
    mint: mint.trim(),
    name,
    symbol,
    creatorWallet: creator.trim(),
    launchedAt: new Date(tsRaw),
    initialMarketCapUsd: marketCapUsd,
    bondingCurveProgress,
    buyCount,
    sellCount,
    volumeUsd,
    socialLinks,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  logger.info("radar:fetch:pumpfun:created-feed starting", {
    url: API_URL,
    databaseUrl: config.databaseUrl,
  });

  // ── Single HTTP request ────────────────────────────────────────────────────
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let body = "";
  let httpStatus = 0;
  let contentType = "(unknown)";

  try {
    const res = await fetch(API_URL, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Referer: "https://pump.fun/",
        "User-Agent": "pumpfun-intelligence-agent/0.1",
      },
      signal: controller.signal,
    });
    clearTimeout(timer);
    httpStatus = res.status;
    contentType = res.headers.get("content-type") ?? "(none)";
    body = await res.text();
  } catch (err) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("radar:fetch HTTP request failed", { error: msg });
    process.exit(1);
  }

  logger.info("radar:fetch HTTP response", {
    status: httpStatus,
    contentType,
    bodyLength: body.length,
  });

  if (httpStatus !== 200) {
    logger.error("radar:fetch non-200 response — aborting", {
      status: httpStatus,
      snippet: body.slice(0, 200),
    });
    process.exit(1);
  }

  // ── Parse JSON ─────────────────────────────────────────────────────────────
  let rawArray: unknown[];
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!Array.isArray(parsed)) {
      logger.error("radar:fetch response is not a JSON array", { topType: typeof parsed });
      process.exit(1);
    }
    rawArray = parsed;
  } catch (err) {
    logger.error("radar:fetch JSON parse failed", {
      error: err instanceof Error ? err.message : String(err),
      snippet: body.slice(0, 200),
    });
    process.exit(1);
  }

  const fetchedCoins = rawArray.length;

  // ── Log one sanitised sample to confirm field names ────────────────────────
  if (rawArray.length > 0) {
    process.stdout.write("\n--- raw sample coin (first object, sanitised) ---\n");
    process.stdout.write(sanitiseForLog(rawArray[0]));
    process.stdout.write("\n\n");
  }

  // ── Validate / map rows ────────────────────────────────────────────────────
  const validCoins: TokenLaunch[] = [];
  let invalidRows = 0;

  for (const raw of rawArray) {
    const coin = parseApiCoin(raw);
    if (coin === null) {
      invalidRows += 1;
    } else {
      validCoins.push(coin);
    }
  }

  // ── Ingestion counters ────────────────────────────────────────────────────
  let insertedNewTokens       = 0;
  let updatedExistingTokens   = 0;
  let tokensWithBuyCount      = 0;
  let tokensWithSellCount     = 0;
  let tokensWithVolume        = 0;
  let maxVolumeSeen           = 0;
  let maxBuyCountSeen         = 0;
  let maxSellCountSeen        = 0;

  // ── Open DB and upsert ────────────────────────────────────────────────────
  initDatabase(config.databaseUrl);
  const repo = new SqliteTokenRepository();

  let newestTs: number | null = null;
  let oldestTs: number | null = null;

  for (const coin of validCoins) {
    const ts = coin.launchedAt.getTime();
    if (newestTs === null || ts > newestTs) newestTs = ts;
    if (oldestTs === null || ts < oldestTs) oldestTs = ts;

    if (coin.buyCount  > 0) tokensWithBuyCount++;
    if (coin.sellCount > 0) tokensWithSellCount++;
    if (coin.volumeUsd > 0) tokensWithVolume++;
    if (coin.volumeUsd  > maxVolumeSeen)   maxVolumeSeen   = coin.volumeUsd;
    if (coin.buyCount   > maxBuyCountSeen)  maxBuyCountSeen  = coin.buyCount;
    if (coin.sellCount  > maxSellCountSeen) maxSellCountSeen = coin.sellCount;

    try {
      const wasInserted = repo.upsertTokenFeedData(coin);
      if (wasInserted) {
        insertedNewTokens++;
        logger.info("radar:fetch inserted new token", {
          mint: coin.mint,
          symbol: coin.symbol,
          buyCount: coin.buyCount,
          sellCount: coin.sellCount,
          volumeUsd: coin.volumeUsd,
          bondingCurveProgress: coin.bondingCurveProgress,
        });
      } else {
        updatedExistingTokens++;
        logger.debug("radar:fetch updated existing token", {
          mint: coin.mint,
          buyCount: coin.buyCount,
          sellCount: coin.sellCount,
          volumeUsd: coin.volumeUsd,
        });
      }
    } catch (err) {
      logger.warn("radar:fetch upsert failed", {
        mint: coin.mint,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── SQL diagnostic ────────────────────────────────────────────────────────
  const db = getDatabase();
  const diag = db.prepare(`
    SELECT
      COUNT(*)                                              AS total_tokens,
      SUM(CASE WHEN buy_count  > 0    THEN 1 ELSE 0 END)  AS tokens_with_buys,
      SUM(CASE WHEN sell_count > 0    THEN 1 ELSE 0 END)  AS tokens_with_sells,
      SUM(CASE WHEN volume_usd > 0.001 THEN 1 ELSE 0 END) AS tokens_with_volume,
      MAX(volume_usd)              AS max_volume,
      MAX(buy_count)               AS max_buy_count,
      MAX(sell_count)              AS max_sell_count,
      MAX(bonding_curve_progress)  AS max_bc
    FROM tokens
  `).get() as {
    total_tokens: number;
    tokens_with_buys: number;
    tokens_with_sells: number;
    tokens_with_volume: number;
    max_volume: number | null;
    max_buy_count: number | null;
    max_sell_count: number | null;
    max_bc: number | null;
  };

  closeDatabase();

  // ── Summary output ────────────────────────────────────────────────────────
  const newestIso = newestTs !== null ? new Date(newestTs).toISOString() : "(none)";
  const oldestIso = oldestTs !== null ? new Date(oldestTs).toISOString() : "(none)";

  logger.info("radar:fetch:pumpfun:created-feed finished", {
    fetchedCoins,
    validRows: validCoins.length,
    invalidRows,
    insertedNewTokens,
    updatedExistingTokens,
    tokensWithBuyCount,
    tokensWithSellCount,
    tokensWithVolume,
    maxVolumeSeen,
    maxBuyCountSeen,
    maxSellCountSeen,
  });

  process.stdout.write("=== radar:fetch:pumpfun:created-feed summary ===\n");
  process.stdout.write(`  fetchedCoins:              ${fetchedCoins}\n`);
  process.stdout.write(`  validRows:                 ${validCoins.length}\n`);
  process.stdout.write(`  invalidRows:               ${invalidRows}\n`);
  process.stdout.write(`  insertedNewTokens:         ${insertedNewTokens}\n`);
  process.stdout.write(`  updatedExistingTokens:     ${updatedExistingTokens}\n`);
  process.stdout.write(`  tokensWithBuyCount:        ${tokensWithBuyCount}\n`);
  process.stdout.write(`  tokensWithSellCount:       ${tokensWithSellCount}\n`);
  process.stdout.write(`  tokensWithVolume:          ${tokensWithVolume}\n`);
  process.stdout.write(`  maxVolumeSeen:             ${maxVolumeSeen.toFixed(4)}\n`);
  process.stdout.write(`  maxBuyCountSeen:           ${maxBuyCountSeen}\n`);
  process.stdout.write(`  maxSellCountSeen:          ${maxSellCountSeen}\n`);
  process.stdout.write(`  newestCreatedAtIso:        ${newestIso}\n`);
  process.stdout.write(`  oldestCreatedAtIso:        ${oldestIso}\n`);

  process.stdout.write("\n=== tokens table diagnostic ===\n");
  process.stdout.write(`  total_tokens:              ${diag.total_tokens}\n`);
  process.stdout.write(`  tokens_with_buys:          ${diag.tokens_with_buys}\n`);
  process.stdout.write(`  tokens_with_sells:         ${diag.tokens_with_sells}\n`);
  process.stdout.write(`  tokens_with_volume:        ${diag.tokens_with_volume}\n`);
  process.stdout.write(`  max_volume:                ${(diag.max_volume ?? 0).toFixed(4)}\n`);
  process.stdout.write(`  max_buy_count:             ${diag.max_buy_count ?? 0}\n`);
  process.stdout.write(`  max_sell_count:            ${diag.max_sell_count ?? 0}\n`);
  process.stdout.write(`  max_bonding_curve_progress:${(diag.max_bc ?? 0).toFixed(6)}\n`);
  process.stdout.write("\n");
}

void main().catch((err) => {
  logger.error("radar:fetch:pumpfun:created-feed unhandled error", {
    error: err instanceof Error ? err.message : String(err),
  });
  closeDatabase();
  process.exit(1);
});
