import { config } from "../config";
import { logger } from "../utils/logger";
import { logSanitizedEnvSummary } from "../utils/env-summary";
import {
  closeDatabase,
  initDatabase,
  SqliteTokenOutcomeRepository,
} from "../storage";
import { TokenOutcome } from "../types";

const SAFE_MODE_HELP = `
OUTCOME_TEST_TOKEN_MINT is not set — cannot analyze outcomes.

This is a read-only analyzer. It does NOT trade, does NOT send Discord alerts,
and does NOT modify scoring or ingestion. It loads all rows from the SQLite
'token_outcomes' table for one mint and prints basic performance metrics.

To use it:
  1. Populate outcome rows by running 'npm run track:token:outcome'
     repeatedly for the same mint (multiple snapshots over time).
  2. Set OUTCOME_TEST_TOKEN_MINT in your .env.
  3. Run:
       npm run build
       npm run analyze:token:outcomes
`;

interface AnalysisMetrics {
  mint: string;
  observationCount: number;
  pricedObservations: number;
  firstObservedAt: string | null;
  latestObservedAt: string | null;
  startPrice: number | null;
  latestPrice: number | null;
  maxPrice: number | null;
  minPrice: number | null;
  gainFromStartPercent: number | null;
  maxGainPercent: number | null;
  maxDrawdownPercent: number | null;
}

function computeMetrics(mint: string, outcomes: TokenOutcome[]): AnalysisMetrics {
  const observationCount = outcomes.length;
  const firstObservedAt = outcomes[0]?.observedAt.toISOString() ?? null;
  const latestObservedAt =
    outcomes[outcomes.length - 1]?.observedAt.toISOString() ?? null;

  const priced = outcomes.filter(
    (o): o is TokenOutcome & { usdPrice: number } => typeof o.usdPrice === "number",
  );
  const pricedObservations = priced.length;

  if (priced.length === 0) {
    return {
      mint,
      observationCount,
      pricedObservations,
      firstObservedAt,
      latestObservedAt,
      startPrice: null,
      latestPrice: null,
      maxPrice: null,
      minPrice: null,
      gainFromStartPercent: null,
      maxGainPercent: null,
      maxDrawdownPercent: null,
    };
  }

  const prices = priced.map((o) => o.usdPrice);
  const startPrice = prices[0];
  const latestPrice = prices[prices.length - 1];
  const maxPrice = Math.max(...prices);
  const minPrice = Math.min(...prices);

  const gainFromStartPercent =
    startPrice > 0 ? ((latestPrice - startPrice) / startPrice) * 100 : null;
  const maxGainPercent =
    startPrice > 0 ? ((maxPrice - startPrice) / startPrice) * 100 : null;

  let peak = prices[0];
  let maxDD = 0;
  for (const p of prices) {
    if (p > peak) peak = p;
    if (peak > 0) {
      const dd = ((peak - p) / peak) * 100;
      if (dd > maxDD) maxDD = dd;
    }
  }
  const maxDrawdownPercent = peak > 0 ? maxDD : null;

  return {
    mint,
    observationCount,
    pricedObservations,
    firstObservedAt,
    latestObservedAt,
    startPrice,
    latestPrice,
    maxPrice,
    minPrice,
    gainFromStartPercent,
    maxGainPercent,
    maxDrawdownPercent,
  };
}

function fmtPct(n: number | null): string {
  return typeof n === "number" ? `${n.toFixed(2)}%` : "n/a";
}
function fmtPrice(n: number | null): string {
  if (typeof n !== "number") return "n/a";
  if (n === 0) return "0";
  if (Math.abs(n) < 0.0001) return n.toExponential(4);
  return n.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

async function main(): Promise<void> {
  logSanitizedEnvSummary({
    context: "analyze:token:outcomes",
    extras: {
      OUTCOME_TEST_TOKEN_MINT_set: Boolean(config.outcomeTestTokenMint),
    },
  });

  if (!config.outcomeTestTokenMint) {
    process.stdout.write(SAFE_MODE_HELP);
    process.exit(0);
  }

  initDatabase(config.databaseUrl);

  const mint = config.outcomeTestTokenMint;
  const repo = new SqliteTokenOutcomeRepository();

  let metrics: AnalysisMetrics;
  try {
    const outcomes = await repo.listOutcomesByMint(mint);
    logger.info("analyze:token:outcomes loaded", {
      mint,
      count: outcomes.length,
    });
    metrics = computeMetrics(mint, outcomes);
  } finally {
    closeDatabase();
  }

  process.stdout.write("\n=== outcome analysis ===\n");
  process.stdout.write(`  mint:                  ${metrics.mint}\n`);
  process.stdout.write(`  observationCount:      ${metrics.observationCount}\n`);
  process.stdout.write(`  pricedObservations:    ${metrics.pricedObservations}\n`);
  process.stdout.write(
    `  firstObservedAt:       ${metrics.firstObservedAt ?? "n/a"}\n`,
  );
  process.stdout.write(
    `  latestObservedAt:      ${metrics.latestObservedAt ?? "n/a"}\n`,
  );
  process.stdout.write(`  startPrice (USD):      ${fmtPrice(metrics.startPrice)}\n`);
  process.stdout.write(`  latestPrice (USD):     ${fmtPrice(metrics.latestPrice)}\n`);
  process.stdout.write(`  maxPrice (USD):        ${fmtPrice(metrics.maxPrice)}\n`);
  process.stdout.write(`  minPrice (USD):        ${fmtPrice(metrics.minPrice)}\n`);
  process.stdout.write(
    `  gainFromStartPercent:  ${fmtPct(metrics.gainFromStartPercent)}\n`,
  );
  process.stdout.write(`  maxGainPercent:        ${fmtPct(metrics.maxGainPercent)}\n`);
  process.stdout.write(
    `  maxDrawdownPercent:    ${fmtPct(metrics.maxDrawdownPercent)}\n`,
  );

  if (metrics.observationCount === 0) {
    process.stdout.write(
      "\nno outcome rows for this mint — run 'npm run track:token:outcome' first to capture snapshots.\n",
    );
  } else if (metrics.pricedObservations === 0) {
    process.stdout.write(
      "\nrows present but no usdPrice values — Moralis price calls may have failed; see token_outcomes.usd_price.\n",
    );
  } else if (metrics.pricedObservations === 1) {
    process.stdout.write(
      "\nonly one priced observation — gain/drawdown are 0 by definition. Capture more snapshots over time.\n",
    );
  }
}

void main().catch((err) => {
  logger.error("analyze:token:outcomes unhandled error", {
    error: err instanceof Error ? err.message : String(err),
  });
  closeDatabase();
  process.exit(1);
});
