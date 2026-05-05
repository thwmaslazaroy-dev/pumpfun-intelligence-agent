import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

interface OutcomeRow {
  mint: string;
  observed_at: number;
  usd_price: number | null;
  swap_count: number | null;
  first_swap_exchange: string | null;
}

interface MintMetrics {
  mint: string;
  observationCount: number;
  pricedObservationCount: number;
  firstObservedAt: string;
  latestObservedAt: string;
  startPrice: number | null;
  latestPrice: number | null;
  maxPrice: number | null;
  minPrice: number | null;
  gainFromStartPercent: number | null;
  maxGainPercent: number | null;
  maxDrawdownPercent: number | null;
  startSwapCount: number | null;
  latestSwapCount: number | null;
  swapCountDelta: number | null;
  firstSwapExchange: string | null;
  outcomeLabel: string;
}

function resolveDbPath(databaseUrl: string): string {
  const stripped = databaseUrl.startsWith("sqlite:")
    ? databaseUrl.slice("sqlite:".length)
    : databaseUrl;
  return path.isAbsolute(stripped) ? stripped : path.resolve(process.cwd(), stripped);
}

function parseLimit(raw: string | undefined): number | null {
  if (!raw) return null;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
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

function fmtNullable(v: string | number | null): string {
  return v === null || v === undefined ? "n/a" : String(v);
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

function computeMintMetrics(mint: string, rows: OutcomeRow[]): MintMetrics {
  const observationCount = rows.length;
  const firstObservedAt = new Date(rows[0].observed_at).toISOString();
  const latestObservedAt = new Date(rows[rows.length - 1].observed_at).toISOString();

  const priced = rows.filter(
    (r): r is OutcomeRow & { usd_price: number } => typeof r.usd_price === "number",
  );
  const pricedObservationCount = priced.length;

  let startPrice: number | null = null;
  let latestPrice: number | null = null;
  let maxPrice: number | null = null;
  let minPrice: number | null = null;
  let gainFromStartPercent: number | null = null;
  let maxGainPercent: number | null = null;
  let maxDrawdownPercent: number | null = null;

  if (priced.length > 0) {
    const prices = priced.map((p) => p.usd_price);
    startPrice = prices[0];
    latestPrice = prices[prices.length - 1];
    maxPrice = Math.max(...prices);
    minPrice = Math.min(...prices);
    if (startPrice > 0) {
      gainFromStartPercent = ((latestPrice - startPrice) / startPrice) * 100;
      maxGainPercent = ((maxPrice - startPrice) / startPrice) * 100;
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
    if (peak > 0) {
      maxDrawdownPercent = -maxDDPositive;
    }
  }

  const startSwapCount = rows[0].swap_count;
  const latestSwapCount = rows[rows.length - 1].swap_count;
  const swapCountDelta =
    typeof startSwapCount === "number" && typeof latestSwapCount === "number"
      ? latestSwapCount - startSwapCount
      : null;

  const firstSwapExchange =
    rows.find((r) => r.first_swap_exchange !== null)?.first_swap_exchange ?? null;

  const outcomeLabel = classifyOutcome({
    pricedObservationCount,
    latestSwapCount,
    maxDrawdownPercent,
    gainFromStartPercent,
    swapCountDelta,
  });

  return {
    mint,
    observationCount,
    pricedObservationCount,
    firstObservedAt,
    latestObservedAt,
    startPrice,
    latestPrice,
    maxPrice,
    minPrice,
    gainFromStartPercent,
    maxGainPercent,
    maxDrawdownPercent,
    startSwapCount,
    latestSwapCount,
    swapCountDelta,
    firstSwapExchange,
    outcomeLabel,
  };
}

function nullsLast<T>(av: T | null, bv: T | null): number | null {
  if (av === null && bv === null) return 0;
  if (av === null) return 1;
  if (bv === null) return -1;
  return null;
}

function cmpGainDesc(a: MintMetrics, b: MintMetrics): number {
  const ord = nullsLast(a.gainFromStartPercent, b.gainFromStartPercent);
  if (ord !== null) return ord;
  return (b.gainFromStartPercent as number) - (a.gainFromStartPercent as number);
}
function cmpGainAsc(a: MintMetrics, b: MintMetrics): number {
  const ord = nullsLast(a.gainFromStartPercent, b.gainFromStartPercent);
  if (ord !== null) return ord;
  return (a.gainFromStartPercent as number) - (b.gainFromStartPercent as number);
}
function cmpSwapDeltaDesc(a: MintMetrics, b: MintMetrics): number {
  const ord = nullsLast(a.swapCountDelta, b.swapCountDelta);
  if (ord !== null) return ord;
  return (b.swapCountDelta as number) - (a.swapCountDelta as number);
}

function printRanked(
  title: string,
  rows: MintMetrics[],
  keyLabel: string,
  keyFn: (m: MintMetrics) => string,
): void {
  process.stdout.write(`\n--- ${title} ---\n`);
  process.stdout.write(
    `  ${pad("mint", 46)}  ${pad(keyLabel, 14)}  ${pad("dd%", 10)}  ${pad("swapDelta", 9)}  ${pad("obs", 4)}  label\n`,
  );
  for (const m of rows) {
    process.stdout.write(
      `  ${pad(m.mint, 46)}  ${pad(keyFn(m), 14)}  ${pad(fmtPct(m.maxDrawdownPercent), 10)}  ${pad(fmtNullable(m.swapCountDelta), 9)}  ${pad(String(m.observationCount), 4)}  ${m.outcomeLabel}\n`,
    );
  }
}

function main(): void {
  const databaseUrl = process.env.DATABASE_URL ?? "./data/pumpfun-agent.sqlite";
  const limit = parseLimit(process.env.OUTCOME_PERFORMANCE_LIMIT);
  const filePath = resolveDbPath(databaseUrl);

  process.stdout.write("\n=== outcome performance analysis ===\n");
  process.stdout.write(`  databaseUrl:              ${databaseUrl}\n`);
  process.stdout.write(`  resolvedPath:             ${filePath}\n`);
  process.stdout.write(
    `  outcomePerformanceLimit: ${limit === null ? "none" : String(limit)}\n`,
  );

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
    const sql =
      limit === null
        ? "SELECT mint, observed_at, usd_price, swap_count, first_swap_exchange FROM token_outcomes ORDER BY observed_at ASC"
        : `WITH src AS (SELECT * FROM token_outcomes ORDER BY observed_at DESC LIMIT @limit)
           SELECT mint, observed_at, usd_price, swap_count, first_swap_exchange FROM src ORDER BY observed_at ASC`;
    const params = limit === null ? {} : { limit };
    const rows = db.prepare(sql).all(params) as OutcomeRow[];

    if (rows.length === 0) {
      process.stdout.write(`\n  no rows in token_outcomes — run ingestion first.\n`);
      return;
    }

    const byMint = new Map<string, OutcomeRow[]>();
    for (const r of rows) {
      let bucket = byMint.get(r.mint);
      if (!bucket) {
        bucket = [];
        byMint.set(r.mint, bucket);
      }
      bucket.push(r);
    }

    const totalMintsAnalyzed = byMint.size;
    const eligibleEntries: MintMetrics[] = [];
    for (const [mint, mintRows] of byMint.entries()) {
      if (mintRows.length < 2) continue;
      eligibleEntries.push(computeMintMetrics(mint, mintRows));
    }

    process.stdout.write("\n--- counts ---\n");
    process.stdout.write(`  totalMintsAnalyzed:     ${totalMintsAnalyzed}\n`);
    process.stdout.write(`  mintsWith2PlusSnapshots: ${eligibleEntries.length}\n`);

    if (eligibleEntries.length === 0) {
      process.stdout.write(
        `\n  no mints have >=2 snapshots yet — capture more outcome rows over time.\n`,
      );
      return;
    }

    const labelCounts = new Map<string, number>();
    for (const m of eligibleEntries) {
      labelCounts.set(m.outcomeLabel, (labelCounts.get(m.outcomeLabel) ?? 0) + 1);
    }
    const sortedLabels = [...labelCounts.entries()].sort((a, b) => b[1] - a[1]);
    process.stdout.write("\n--- outcomeLabel counts ---\n");
    for (const [label, c] of sortedLabels) {
      process.stdout.write(`  ${pad(label, 22)}  ${c}\n`);
    }

    const topGain = [...eligibleEntries].sort(cmpGainDesc).slice(0, 20);
    const worstGain = [...eligibleEntries].sort(cmpGainAsc).slice(0, 20);
    const topSwapDelta = [...eligibleEntries].sort(cmpSwapDeltaDesc).slice(0, 20);

    printRanked("top 20 by gainFromStartPercent", topGain, "gain%", (m) =>
      fmtPct(m.gainFromStartPercent),
    );
    printRanked("worst 20 by gainFromStartPercent", worstGain, "gain%", (m) =>
      fmtPct(m.gainFromStartPercent),
    );
    printRanked("top 20 by swapCountDelta", topSwapDelta, "swapDelta", (m) =>
      fmtNullable(m.swapCountDelta),
    );

    process.stdout.write("\n--- compact per-mint table ---\n");
    process.stdout.write(
      `  ${pad("mint", 46)}  ${pad("obs", 4)}  ${pad("priced", 6)}  ${pad("startPx", 12)}  ${pad("latestPx", 12)}  ${pad("gain%", 12)}  ${pad("maxGain%", 12)}  ${pad("dd%", 10)}  ${pad("swapDelta", 9)}  ${pad("exchange", 12)}  label\n`,
    );
    const compact = [...eligibleEntries].sort(
      (a, b) => b.observationCount - a.observationCount,
    );
    for (const m of compact) {
      process.stdout.write(
        `  ${pad(m.mint, 46)}  ${pad(String(m.observationCount), 4)}  ${pad(String(m.pricedObservationCount), 6)}  ${pad(fmtPrice(m.startPrice), 12)}  ${pad(fmtPrice(m.latestPrice), 12)}  ${pad(fmtPct(m.gainFromStartPercent), 12)}  ${pad(fmtPct(m.maxGainPercent), 12)}  ${pad(fmtPct(m.maxDrawdownPercent), 10)}  ${pad(fmtNullable(m.swapCountDelta), 9)}  ${pad(fmtNullable(m.firstSwapExchange), 12)}  ${m.outcomeLabel}\n`,
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
    `analyze:outcome:performance unhandled error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
