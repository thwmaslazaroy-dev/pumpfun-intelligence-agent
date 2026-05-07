import { config } from "../config";
import { logger } from "../utils/logger";
import { initDatabase, closeDatabase, SqliteTokenRepository } from "../storage";
import { TokenLaunch } from "../types";

const API_URL =
  "https://frontend-api-v3.pump.fun/coins?sort=created_timestamp&order=DESC&limit=50";
const REQUEST_TIMEOUT_MS = 20_000;

// Minimal Solana mint sanity check — base58, 32–44 chars
const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

interface ApiCoin {
  mint?: unknown;
  creator?: unknown;
  name?: unknown;
  symbol?: unknown;
  created_timestamp?: unknown;
  market_cap?: unknown;
  reply_count?: unknown;
  nsfw?: unknown;
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function parseApiCoin(raw: unknown): TokenLaunch | null {
  if (typeof raw !== "object" || raw === null) return null;
  const coin = raw as ApiCoin;

  const mint = coin.mint;
  const creator = coin.creator;
  const tsRaw = coin.created_timestamp;

  if (!isNonEmptyString(mint) || !MINT_RE.test(mint)) return null;
  if (!isNonEmptyString(creator)) return null;
  if (typeof tsRaw !== "number" || !Number.isFinite(tsRaw) || tsRaw <= 0) return null;

  const symbol = isNonEmptyString(coin.symbol) ? coin.symbol.trim() : "UNKNOWN";
  const name = isNonEmptyString(coin.name) ? coin.name.trim() : symbol;
  const marketCap =
    typeof coin.market_cap === "number" && Number.isFinite(coin.market_cap)
      ? coin.market_cap
      : 0;

  return {
    mint: mint.trim(),
    name,
    symbol,
    creatorWallet: creator.trim(),
    launchedAt: new Date(tsRaw),
    initialMarketCapUsd: marketCap,
    bondingCurveProgress: 0,
    buyCount: 0,
    sellCount: 0,
    volumeUsd: 0,
  };
}

async function main(): Promise<void> {
  logger.info("radar:fetch:pumpfun:created-feed starting", {
    url: API_URL,
    databaseUrl: config.databaseUrl,
  });

  // ── Single HTTP request ──────────────────────────────────────────────────
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

  // ── Parse JSON ───────────────────────────────────────────────────────────
  let rawArray: unknown[];
  try {
    const parsed = JSON.parse(body) as unknown;
    if (!Array.isArray(parsed)) {
      logger.error("radar:fetch response is not a JSON array", {
        topType: typeof parsed,
      });
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

  const fetched = rawArray.length;

  // ── Validate rows ────────────────────────────────────────────────────────
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

  // ── Open DB and insert ───────────────────────────────────────────────────
  initDatabase(config.databaseUrl);
  const repo = new SqliteTokenRepository();

  let inserted = 0;
  let duplicateMintsSkipped = 0;
  let newestTs: number | null = null;
  let oldestTs: number | null = null;

  for (const coin of validCoins) {
    const ts = coin.launchedAt.getTime();
    if (newestTs === null || ts > newestTs) newestTs = ts;
    if (oldestTs === null || ts < oldestTs) oldestTs = ts;

    const existing = await repo.findTokenByMint(coin.mint);
    if (existing !== null) {
      duplicateMintsSkipped += 1;
      continue;
    }

    try {
      await repo.saveTokenLaunch(coin);
      inserted += 1;
      logger.info("radar:fetch saved new token", {
        mint: coin.mint,
        symbol: coin.symbol,
        creator: coin.creatorWallet,
        launchedAt: coin.launchedAt.toISOString(),
        marketCapUsd: coin.initialMarketCapUsd,
      });
    } catch (err) {
      logger.warn("radar:fetch saveTokenLaunch failed", {
        mint: coin.mint,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  closeDatabase();

  // ── Summary ──────────────────────────────────────────────────────────────
  const newestCreatedAtIso = newestTs !== null ? new Date(newestTs).toISOString() : null;
  const oldestCreatedAtIso = oldestTs !== null ? new Date(oldestTs).toISOString() : null;

  logger.info("radar:fetch:pumpfun:created-feed finished", {
    fetched,
    validRows: validCoins.length,
    invalidRows,
    inserted,
    duplicateMintsSkipped,
    newestCreatedAtIso,
    oldestCreatedAtIso,
  });

  process.stdout.write("\n=== radar:fetch:pumpfun:created-feed summary ===\n");
  process.stdout.write(`  fetched:                ${fetched}\n`);
  process.stdout.write(`  validRows:              ${validCoins.length}\n`);
  process.stdout.write(`  invalidRows:            ${invalidRows}\n`);
  process.stdout.write(`  inserted:               ${inserted}\n`);
  process.stdout.write(`  duplicateMintsSkipped:  ${duplicateMintsSkipped}\n`);
  process.stdout.write(`  newestCreatedAtIso:     ${newestCreatedAtIso ?? "(none)"}\n`);
  process.stdout.write(`  oldestCreatedAtIso:     ${oldestCreatedAtIso ?? "(none)"}\n`);
  process.stdout.write("\n");
}

void main().catch((err) => {
  logger.error("radar:fetch:pumpfun:created-feed unhandled error", {
    error: err instanceof Error ? err.message : String(err),
  });
  closeDatabase();
  process.exit(1);
});
