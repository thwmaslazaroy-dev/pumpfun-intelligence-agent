import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

interface JoinRow {
  mint: string;
  creator_wallet: string;
  observed_at: number;
  usd_price: number | null;
  swap_count: number | null;
  first_swap_exchange: string | null;
}

interface MintMetrics {
  mint: string;
  creatorWallet: string;
  observationCount: number;
  pricedObservationCount: number;
  gainFromStartPercent: number | null;
  maxDrawdownPercent: number | null;
  swapCountDelta: number | null;
  latestSwapCount: number | null;
  outcomeLabel: string;
}

interface CreatorRow {
  creatorWallet: string;
  launchesTracked: number;
  avgGainPercent: number | null;
  avgSwapDelta: number | null;
  strongGain: number;
  up: number;
  activeFlat: number;
  flat: number;
  noPrice: number;
  down: number;
  rugLike: number;
  creatorOutcomeLabel: string;
}

function resolveDbPath(databaseUrl: string): string {
  const stripped = databaseUrl.startsWith("sqlite:")
    ? databaseUrl.slice("sqlite:".length)
    : databaseUrl;
  return path.isAbsolute(stripped) ? stripped : path.resolve(process.cwd(), stripped);
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function classifyOutcome(m: {
  pricedObservationCount: number;
  latestSwapCount: number | null;
  maxDrawdownPercent: number | null;
  gainFromStartPercent: number | null;
  swapCountDelta: number | null;
}): string {
  if (m.pricedObservationCount === 0) return "NO_PRICE";
  if (m.latestSwapCount === null || m.latestSwapCount === 0) {
    return "DEAD_OR_NO_ACTIVITY";
  }
  if (m.maxDrawdownPercent !== null && m.maxDrawdownPercent <= -70) {
    return "RUG_LIKE";
  }
  const gain = m.gainFromStartPercent;
  if (gain === null) return "UNKNOWN";
  if (gain >= 50) return "STRONG_GAIN";
  if (Math.abs(gain) < 20) {
    if (m.swapCountDelta !== null && m.swapCountDelta > 0) return "ACTIVE_FLAT";
    return "FLAT";
  }
  if (gain <= -20) return "DOWN";
  if (gain >= 20) return "UP";
  return "UNKNOWN";
}

function computeMintMetrics(
  mint: string,
  creatorWallet: string,
  rows: JoinRow[],
): MintMetrics {
  const observationCount = rows.length;
  const priced = rows.filter(
    (r): r is JoinRow & { usd_price: number } => typeof r.usd_price === "number",
  );
  const pricedObservationCount = priced.length;

  let gainFromStartPercent: number | null = null;
  let maxDrawdownPercent: number | null = null;

  if (priced.length > 0) {
    const prices = priced.map((p) => p.usd_price);
    const startPrice = prices[0];
    const latestPrice = prices[prices.length - 1];
    if (startPrice > 0) {
      gainFromStartPercent = ((latestPrice - startPrice) / startPrice) * 100;
    }
    let peak = prices[0];
    let maxDDPositive = 0;
    for (const p of prices) {
      if (p > peak) peak = p;
      if (peak > 0) {
        const dd = ((peak - p) / peak) * 100;
        if (dd > maxDDPositive) maxDDPositive = dd;
      }
    }
    if (peak > 0) maxDrawdownPercent = -maxDDPositive;
  }

  const startSwapCount = rows[0].swap_count;
  const latestSwapCount = rows[rows.length - 1].swap_count;
  const swapCountDelta =
    typeof startSwapCount === "number" && typeof latestSwapCount === "number"
      ? latestSwapCount - startSwapCount
      : null;

  const outcomeLabel = classifyOutcome({
    pricedObservationCount,
    latestSwapCount,
    maxDrawdownPercent,
    gainFromStartPercent,
    swapCountDelta,
  });

  return {
    mint,
    creatorWallet,
    observationCount,
    pricedObservationCount,
    gainFromStartPercent,
    maxDrawdownPercent,
    swapCountDelta,
    latestSwapCount,
    outcomeLabel,
  };
}

function classifyCreator(c: CreatorRow): string {
  const promising =
    c.strongGain + c.up + c.activeFlat >= 2 &&
    c.avgGainPercent !== null &&
    c.avgGainPercent >= 0;
  if (promising) return "PROMISING";
  if (c.flat + c.noPrice >= 3) return "SPAMMY";
  if (c.rugLike + c.down >= 2) return "RISKY";
  return "UNKNOWN";
}

function main(): void {
  const databaseUrl = process.env.DATABASE_URL ?? "./data/pumpfun-agent.sqlite";
  const filePath = resolveDbPath(databaseUrl);

  process.stdout.write("\n=== creator outcome analysis ===\n");
  process.stdout.write(`  databaseUrl:   ${databaseUrl}\n`);
  process.stdout.write(`  resolvedPath:  ${filePath}\n`);

  if (!fs.existsSync(filePath)) {
    process.stdout.write(
      `\nSQLite file not found at ${filePath}. Run ingestion first.\n`,
    );
    process.exit(1);
  }

  let db: Database.Database;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
  } catch (err) {
    process.stdout.write(
      `\nfailed to open SQLite read-only: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  try {
    const rows = db
      .prepare(
        `SELECT t.mint, t.creator_wallet, o.observed_at, o.usd_price, o.swap_count, o.first_swap_exchange
         FROM token_outcomes o
         INNER JOIN tokens t ON t.mint = o.mint
         ORDER BY o.observed_at ASC`,
      )
      .all() as JoinRow[];

    if (rows.length === 0) {
      process.stdout.write(
        `\n  no joined rows — token_outcomes is empty or no outcomes match a tokens row.\n`,
      );
      return;
    }

    const byMint = new Map<string, JoinRow[]>();
    const mintCreator = new Map<string, string>();
    for (const r of rows) {
      let bucket = byMint.get(r.mint);
      if (!bucket) {
        bucket = [];
        byMint.set(r.mint, bucket);
      }
      bucket.push(r);
      if (!mintCreator.has(r.mint)) {
        mintCreator.set(r.mint, r.creator_wallet);
      }
    }

    const mintMetrics: MintMetrics[] = [];
    for (const [mint, mintRows] of byMint.entries()) {
      const creator = mintCreator.get(mint) ?? "";
      mintMetrics.push(computeMintMetrics(mint, creator, mintRows));
    }

    interface CreatorAgg {
      creatorWallet: string;
      launchesTracked: number;
      gainSum: number;
      gainCount: number;
      swapDeltaSum: number;
      swapDeltaCount: number;
      labelCounts: Record<string, number>;
    }

    const byCreator = new Map<string, CreatorAgg>();
    for (const m of mintMetrics) {
      let agg = byCreator.get(m.creatorWallet);
      if (!agg) {
        agg = {
          creatorWallet: m.creatorWallet,
          launchesTracked: 0,
          gainSum: 0,
          gainCount: 0,
          swapDeltaSum: 0,
          swapDeltaCount: 0,
          labelCounts: {},
        };
        byCreator.set(m.creatorWallet, agg);
      }
      agg.launchesTracked += 1;
      if (typeof m.gainFromStartPercent === "number") {
        agg.gainSum += m.gainFromStartPercent;
        agg.gainCount += 1;
      }
      if (typeof m.swapCountDelta === "number") {
        agg.swapDeltaSum += m.swapCountDelta;
        agg.swapDeltaCount += 1;
      }
      agg.labelCounts[m.outcomeLabel] =
        (agg.labelCounts[m.outcomeLabel] ?? 0) + 1;
    }

    const creatorRows: CreatorRow[] = [...byCreator.values()].map((agg) => {
      const avgGainPercent = agg.gainCount > 0 ? agg.gainSum / agg.gainCount : null;
      const avgSwapDelta =
        agg.swapDeltaCount > 0 ? agg.swapDeltaSum / agg.swapDeltaCount : null;
      const lc = agg.labelCounts;
      const row: CreatorRow = {
        creatorWallet: agg.creatorWallet,
        launchesTracked: agg.launchesTracked,
        avgGainPercent,
        avgSwapDelta,
        strongGain: lc.STRONG_GAIN ?? 0,
        up: lc.UP ?? 0,
        activeFlat: lc.ACTIVE_FLAT ?? 0,
        flat: lc.FLAT ?? 0,
        noPrice: lc.NO_PRICE ?? 0,
        down: lc.DOWN ?? 0,
        rugLike: lc.RUG_LIKE ?? 0,
        creatorOutcomeLabel: "UNKNOWN",
      };
      row.creatorOutcomeLabel = classifyCreator(row);
      return row;
    });

    process.stdout.write("\n--- counts ---\n");
    process.stdout.write(`  totalCreatorsAnalyzed:   ${creatorRows.length}\n`);
    process.stdout.write(`  totalMintsWithOutcomes:  ${mintMetrics.length}\n`);

    process.stdout.write("\n--- top creators by launchesTracked ---\n");
    const topByLaunches = [...creatorRows]
      .sort(
        (a, b) =>
          b.launchesTracked - a.launchesTracked ||
          a.creatorWallet.localeCompare(b.creatorWallet),
      )
      .slice(0, 20);
    for (const c of topByLaunches) {
      process.stdout.write(
        `  ${pad(c.creatorWallet, 46)}  launchesTracked=${c.launchesTracked}\n`,
      );
    }

    process.stdout.write("\n--- compact creator table ---\n");
    process.stdout.write(
      `  legend: STRG=STRONG_GAIN  UP=UP  ACTV=ACTIVE_FLAT  FLAT=FLAT  NOPX=NO_PRICE  DOWN=DOWN  RUG=RUG_LIKE\n`,
    );
    process.stdout.write(
      `  ${pad("creatorWallet", 46)}  ${pad("launches", 8)}  ${pad("avgGain%", 12)}  ${pad("avgSwapDelta", 14)}  ${pad("STRG", 4)}  ${pad("UP", 3)}  ${pad("ACTV", 4)}  ${pad("FLAT", 4)}  ${pad("NOPX", 4)}  ${pad("DOWN", 4)}  ${pad("RUG", 3)}  label\n`,
    );
    const compact = [...creatorRows].sort(
      (a, b) =>
        b.launchesTracked - a.launchesTracked ||
        a.creatorWallet.localeCompare(b.creatorWallet),
    );
    for (const c of compact) {
      const avgGain =
        c.avgGainPercent === null ? "n/a" : `${c.avgGainPercent.toFixed(2)}%`;
      const avgSwap =
        c.avgSwapDelta === null ? "n/a" : c.avgSwapDelta.toFixed(2);
      process.stdout.write(
        `  ${pad(c.creatorWallet, 46)}  ${pad(String(c.launchesTracked), 8)}  ${pad(avgGain, 12)}  ${pad(avgSwap, 14)}  ${pad(String(c.strongGain), 4)}  ${pad(String(c.up), 3)}  ${pad(String(c.activeFlat), 4)}  ${pad(String(c.flat), 4)}  ${pad(String(c.noPrice), 4)}  ${pad(String(c.down), 4)}  ${pad(String(c.rugLike), 3)}  ${c.creatorOutcomeLabel}\n`,
      );
    }
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `analyze:creator:outcomes unhandled error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
