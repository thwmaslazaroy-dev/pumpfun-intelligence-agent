/**
 * track:batch:outcomes
 *
 * Reads mints from a watchlist file, calls Moralis for each one, and writes
 * outcome rows to the SQLite token_outcomes table.
 *
 * Safety flags:
 *   --dry-run        Print what would be fetched without making any API calls.
 *   --yes            Skip the pre-flight confirmation prompt.
 *   --limit N        Process at most N mints.
 *   --delay-ms N     Override the inter-request delay (default: OUTCOME_BATCH_DELAY_MS).
 *   --resume         Skip mints that already have an outcome row from the last 24h.
 *
 * This script is READ-ONLY: no Discord alerts, no feed ingestion changes.
 */

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
import { getDatabase } from "../storage/database";

// ── Constants ─────────────────────────────────────────────────────────────────

const SAFE_MODE_HELP_NO_KEY = `
MORALIS_API_KEY is not set — cannot run batch outcome tracker.

Set in your .env:
  MORALIS_API_KEY=<your moralis api key>
  OUTCOME_WATCHLIST_PATH=./data/watchlist-mints.txt   # optional
  OUTCOME_BATCH_DELAY_MS=500                           # optional

Then run:
  npm run track:batch:outcomes -- --dry-run   # see estimate first
  npm run track:batch:outcomes -- --yes       # run for real
`;

const EXAMPLE_WATCHLIST = `# Watchlist of Solana token mints to track outcomes for.
# One mint per line. Lines starting with # are comments.
# Empty lines are ignored. Mints are deduplicated.
#
# Example (uncomment and replace with real mints):
# 5Bx97ZJSicb9GhNkKEPSJeSBvm3TVKznE7weotqqpump
`;

// Each mint = 2 Moralis API calls (price + swaps)
const MORALIS_CALLS_PER_MINT = 2;
/** Skip mints with an outcome row younger than this (--resume mode) */
const RESUME_SKIP_AGE_MS = 24 * 60 * 60 * 1000;

// ── CLI argument parsing ──────────────────────────────────────────────────────

interface CliArgs {
  dryRun: boolean;
  yes: boolean;
  limit: number | null;
  delayMs: number | null;
  resume: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const dryRun = argv.includes("--dry-run");
  const yes = argv.includes("--yes");
  const resume = argv.includes("--resume");

  let limit: number | null = null;
  const limitIdx = argv.indexOf("--limit");
  if (limitIdx !== -1 && argv[limitIdx + 1]) {
    const n = Number.parseInt(argv[limitIdx + 1]!, 10);
    if (Number.isFinite(n) && n > 0) limit = n;
  }

  let delayMs: number | null = null;
  const delayIdx = argv.indexOf("--delay-ms");
  if (delayIdx !== -1 && argv[delayIdx + 1]) {
    const n = Number.parseInt(argv[delayIdx + 1]!, 10);
    if (Number.isFinite(n) && n >= 0) delayMs = n;
  }

  return { dryRun, yes, limit, delayMs, resume };
}

// ── Watchlist parsing ─────────────────────────────────────────────────────────

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
    if (t.length === 0 || t.startsWith("#")) { commentOrBlankLines += 1; continue; }
    raw.push(t);
  }
  const seen = new Set<string>();
  const mints: string[] = [];
  let duplicatesRemoved = 0;
  for (const m of raw) {
    if (seen.has(m)) { duplicatesRemoved += 1; continue; }
    seen.add(m);
    mints.push(m);
  }
  return { mints, commentOrBlankLines, duplicatesRemoved };
}

function ensureDir(file: string): void {
  const dir = path.dirname(file);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((r) => setTimeout(r, ms));
}

// ── Resume: check which mints already have recent outcomes ────────────────────

function getRecentlyTrackedMints(cutoffMs: number): Set<string> {
  try {
    const db = getDatabase();
    const rows = db
      .prepare("SELECT DISTINCT mint FROM token_outcomes WHERE observed_at >= ?")
      .all(cutoffMs) as Array<{ mint: string }>;
    return new Set(rows.map((r) => r.mint));
  } catch {
    return new Set();
  }
}

// ── Pre-flight budget check ───────────────────────────────────────────────────

function checkBudget(mintCount: number): { safe: boolean; warnings: string[] } {
  const warnings: string[] = [];
  const moralisDay = Number(process.env.BUDGET_MORALIS_PER_DAY) || 200;
  const callsNeeded = mintCount * MORALIS_CALLS_PER_MINT;

  if (callsNeeded > moralisDay) {
    warnings.push(
      `Will make ${callsNeeded} Moralis calls but daily budget is ${moralisDay}. ` +
      `Reduce watchlist size or increase BUDGET_MORALIS_PER_DAY.`,
    );
  }
  if (callsNeeded > moralisDay * 0.85) {
    warnings.push(
      `This run uses ${((callsNeeded / moralisDay) * 100).toFixed(0)}% of your daily Moralis budget.`,
    );
  }

  return { safe: warnings.length === 0, warnings };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  logSanitizedEnvSummary({
    context: "track:batch:outcomes",
    extras: {
      MORALIS_API_KEY_set: Boolean(config.moralisApiKey),
      OUTCOME_WATCHLIST_PATH: config.outcomeWatchlistPath,
      OUTCOME_BATCH_DELAY_MS: config.outcomeBatchDelayMs,
      flags: { dryRun: args.dryRun, yes: args.yes, limit: args.limit, resume: args.resume },
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
    process.stdout.write(
      `\nCreated empty watchlist at ${wlPath}.\n` +
        `Add one Solana mint per line (comments start with #), then re-run:\n` +
        `  npm run track:batch:outcomes -- --dry-run\n`,
    );
    process.exit(0);
  }

  const content = fs.readFileSync(wlPath, "utf8");
  const parsed = parseWatchlist(content);

  if (parsed.mints.length === 0) {
    process.stdout.write(`\nWatchlist at ${wlPath} contains no usable mints.\n`);
    process.exit(0);
  }

  // Initialise DB only for --resume check (needed before we filter mints)
  initDatabase(config.databaseUrl);

  let mints = parsed.mints;

  // --resume: skip mints with a recent outcome row
  let skippedByResume = 0;
  if (args.resume) {
    const recentlySeen = getRecentlyTrackedMints(Date.now() - RESUME_SKIP_AGE_MS);
    const before = mints.length;
    mints = mints.filter((m) => !recentlySeen.has(m));
    skippedByResume = before - mints.length;
  }

  // --limit: truncate
  if (args.limit !== null && mints.length > args.limit) {
    mints = mints.slice(0, args.limit);
  }

  const delayMs = args.delayMs !== null ? args.delayMs : config.outcomeBatchDelayMs;
  const totalCalls = mints.length * MORALIS_CALLS_PER_MINT;
  const estimatedSec = mints.length > 0 ? ((mints.length - 1) * delayMs) / 1000 : 0;

  // ── Pre-flight summary ─────────────────────────────────────────────────────
  process.stdout.write("\n=== track:batch:outcomes pre-flight ===\n");
  process.stdout.write(`  watchlist:          ${wlPath}\n`);
  process.stdout.write(`  total mints:        ${parsed.mints.length}\n`);
  if (args.resume) process.stdout.write(`  skipped (resume):   ${skippedByResume}\n`);
  if (args.limit !== null) process.stdout.write(`  limit applied:      ${args.limit}\n`);
  process.stdout.write(`  mints to process:   ${mints.length}\n`);
  process.stdout.write(`  Moralis calls:      ${totalCalls} (${MORALIS_CALLS_PER_MINT} per mint)\n`);
  process.stdout.write(`  inter-request delay:${delayMs}ms\n`);
  process.stdout.write(`  estimated duration: ~${estimatedSec.toFixed(0)}s\n`);

  const { warnings } = checkBudget(mints.length);
  if (warnings.length > 0) {
    process.stdout.write("\n⚠️  Budget warnings:\n");
    for (const w of warnings) process.stdout.write(`  ! ${w}\n`);
  }

  if (args.dryRun) {
    process.stdout.write("\n[DRY RUN] No API calls made. Pass --yes to run for real.\n");
    if (mints.length > 0) {
      process.stdout.write("\n  First 5 mints that would be tracked:\n");
      for (const m of mints.slice(0, 5)) process.stdout.write(`    ${m}\n`);
      if (mints.length > 5) process.stdout.write(`    ... and ${mints.length - 5} more\n`);
    }
    closeDatabase();
    return;
  }

  if (!args.yes) {
    process.stdout.write(`
To proceed, re-run with --yes:
  npm run track:batch:outcomes -- --yes
  npm run track:batch:outcomes -- --yes --limit 20
  npm run track:batch:outcomes -- --yes --resume

Use --dry-run first if you're unsure.
`);
    closeDatabase();
    process.exit(0);
  }

  // ── Execute ────────────────────────────────────────────────────────────────
  process.stdout.write("\n[RUNNING]\n");

  const service = new MoralisTokenEnrichmentService({ apiKey: config.moralisApiKey });
  const repo = new SqliteTokenOutcomeRepository();

  let savedOutcomes = 0;
  let failedOutcomes = 0;
  let budgetBlocked = 0;

  for (let i = 0; i < mints.length; i++) {
    const mint = mints[i]!;
    try {
      const snapshot = await service.getTokenEnrichmentSnapshot(mint);

      // Detect budget-blocked response (both calls failed with the same budget reason)
      const bothBlocked =
        !snapshot.priceCall.ok &&
        !snapshot.swapsCall.ok &&
        snapshot.priceCall.errorMessage?.startsWith("budget blocked");

      if (bothBlocked) {
        budgetBlocked += 1;
        logger.warn("track:batch: budget blocked — stopping early", { mint, index: i + 1 });
        process.stdout.write(`\n  Budget limit reached at mint ${i + 1}/${mints.length}. Stopping.\n`);
        break;
      }

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
        of: mints.length,
        mint,
        usdPrice: snapshot.usdPrice,
        swapCount: snapshot.swapCount,
      });
    } catch (err) {
      failedOutcomes += 1;
      logger.warn("outcome failed", {
        index: i + 1,
        of: mints.length,
        mint,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    if (i < mints.length - 1) {
      await sleep(delayMs);
    }
  }

  closeDatabase();

  const summary = {
    totalMintsInWatchlist: parsed.mints.length,
    skippedByResume,
    limitApplied: args.limit,
    mintsProcessed: mints.length,
    savedOutcomes,
    failedOutcomes,
    budgetBlocked,
    delayMs,
    watchlistPath: wlPath,
  };
  logger.info("track:batch:outcomes finished", summary);

  process.stdout.write("\n=== batch summary ===\n");
  for (const [k, v] of Object.entries(summary)) {
    if (v !== null) process.stdout.write(`  ${k}: ${JSON.stringify(v)}\n`);
  }
  process.stdout.write("\nRun 'npm run api:usage' to check your remaining Moralis budget.\n");
}

void main().catch((err) => {
  logger.error("track:batch:outcomes unhandled error", {
    error: err instanceof Error ? err.message : String(err),
  });
  closeDatabase();
  process.exit(1);
});
