import * as fs from "fs";
import * as path from "path";
import { config } from "../config";
import { logger } from "../utils/logger";
import { logSanitizedEnvSummary } from "../utils/env-summary";
import {
  closeDatabase,
  initDatabase,
  SqliteTokenOutcomeRepository,
} from "../storage";
import { MoralisTokenEnrichmentService } from "../services";
import { TokenOutcome } from "../types";

const SAFE_MODE_HELP_NO_KEY = `
MORALIS_API_KEY is not set — cannot run batch outcome tracker.

This is a read-only batch tracker. It does NOT trade, does NOT send Discord
alerts, and does NOT replace the mock provider. It reads a watchlist file of
Solana mints, calls Moralis for each one, and writes outcome rows to the
SQLite 'token_outcomes' table.

To use it, set in your .env:
  MORALIS_API_KEY=<your moralis api key>
  OUTCOME_WATCHLIST_PATH=./data/watchlist-mints.txt    # optional, default shown
  OUTCOME_BATCH_DELAY_MS=500                            # optional, default 500

Then create the watchlist file (one mint per line, # for comments) and run:
  npm run build
  npm run track:batch:outcomes
`;

const EXAMPLE_WATCHLIST = `# Watchlist of Solana token mints to track outcomes for.
# One mint per line. Lines starting with # are comments. Empty lines are
# ignored. Mints are deduplicated. Each run appends one outcome row per mint
# to the SQLite token_outcomes table.
#
# Example (uncomment and replace with real mints):
# 5Bx97ZJSicb9GhNkKEPSJeSBvm3TVKznE7weotqqpump
# 2LXBtfu9z54fvESGSYSfCneRUbkMthirE7UeEihxpump
`;

interface ParsedWatchlist {
  mints: string[];
  commentOrBlankLines: number;
  duplicatesRemoved: number;
}

function parseWatchlist(content: string): ParsedWatchlist {
  const lines = content.split(/\r?\n/);
  const raw: string[] = [];
  let commentOrBlankLines = 0;
  for (const ln of lines) {
    const t = ln.trim();
    if (t.length === 0 || t.startsWith("#")) {
      commentOrBlankLines += 1;
      continue;
    }
    raw.push(t);
  }
  const seen = new Set<string>();
  const mints: string[] = [];
  let duplicatesRemoved = 0;
  for (const m of raw) {
    if (seen.has(m)) {
      duplicatesRemoved += 1;
      continue;
    }
    seen.add(m);
    mints.push(m);
  }
  return { mints, commentOrBlankLines, duplicatesRemoved };
}

function ensureDir(file: string): void {
  const dir = path.dirname(file);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  logSanitizedEnvSummary({
    context: "track:batch:outcomes",
    extras: {
      MORALIS_API_KEY_set: Boolean(config.moralisApiKey),
      OUTCOME_WATCHLIST_PATH: config.outcomeWatchlistPath,
      OUTCOME_BATCH_DELAY_MS: config.outcomeBatchDelayMs,
    },
  });

  if (!config.moralisApiKey) {
    process.stdout.write(SAFE_MODE_HELP_NO_KEY);
    process.exit(0);
  }

  const wlPath = config.outcomeWatchlistPath;

  if (!fs.existsSync(wlPath)) {
    ensureDir(wlPath);
    fs.writeFileSync(wlPath, EXAMPLE_WATCHLIST);
    logger.info("watchlist file created", { path: wlPath });
    process.stdout.write(
      `\nCreated empty watchlist at ${wlPath}.\n` +
        `Add one Solana mint per line (comments start with #), then re-run:\n` +
        `  npm run track:batch:outcomes\n`,
    );
    process.exit(0);
  }

  const content = fs.readFileSync(wlPath, "utf8");
  const parsed = parseWatchlist(content);

  logger.info("watchlist parsed", {
    path: wlPath,
    mints: parsed.mints.length,
    commentOrBlankLines: parsed.commentOrBlankLines,
    duplicatesRemoved: parsed.duplicatesRemoved,
  });

  if (parsed.mints.length === 0) {
    process.stdout.write(
      `\nWatchlist at ${wlPath} contains no usable mints.\n` +
        `Add one mint per line (comments start with #), then re-run.\n`,
    );
    process.exit(0);
  }

  initDatabase(config.databaseUrl);

  const service = new MoralisTokenEnrichmentService({ apiKey: config.moralisApiKey });
  const repo = new SqliteTokenOutcomeRepository();
  const delayMs = config.outcomeBatchDelayMs;

  logger.info("track:batch:outcomes starting (read-only)", {
    provider: service.providerName,
    mintCount: parsed.mints.length,
    delayMs,
  });

  let savedOutcomes = 0;
  let failedOutcomes = 0;

  for (let i = 0; i < parsed.mints.length; i++) {
    const mint = parsed.mints[i];
    try {
      const snapshot = await service.getTokenEnrichmentSnapshot(mint);
      const outcome: TokenOutcome = {
        mint: snapshot.mint,
        observedAt: snapshot.observedAt,
        usdPrice: snapshot.usdPrice,
        swapCount: snapshot.swapCount,
        firstSwapType: snapshot.firstSwapType,
        firstSwapExchange: snapshot.firstSwapExchange,
        rawSourceProvider: service.providerName,
        createdAt: new Date(),
      };
      await repo.saveOutcome(outcome);
      savedOutcomes += 1;
      logger.info("outcome saved", {
        index: i + 1,
        of: parsed.mints.length,
        mint,
        usdPrice: snapshot.usdPrice,
        swapCount: snapshot.swapCount,
        saved: true,
      });
    } catch (err) {
      failedOutcomes += 1;
      logger.warn("outcome failed", {
        index: i + 1,
        of: parsed.mints.length,
        mint,
        saved: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (i < parsed.mints.length - 1) {
      await sleep(delayMs);
    }
  }

  closeDatabase();

  const summary = {
    totalMints: parsed.mints.length,
    savedOutcomes,
    failedOutcomes,
    skippedLines: parsed.commentOrBlankLines,
    duplicatesRemoved: parsed.duplicatesRemoved,
    delayMs,
    watchlistPath: wlPath,
  };
  logger.info("track:batch:outcomes finished", summary);

  process.stdout.write("\n=== batch summary ===\n");
  for (const [k, v] of Object.entries(summary)) {
    process.stdout.write(`  ${k}: ${JSON.stringify(v)}\n`);
  }
}

void main().catch((err) => {
  logger.error("track:batch:outcomes unhandled error", {
    error: err instanceof Error ? err.message : String(err),
  });
  closeDatabase();
  process.exit(1);
});
