import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

interface CountRow {
  c: number;
}

interface MintCountRow {
  mint: string;
  c: number;
}

interface NewestRow {
  mint: string;
  observed_at: number;
  usd_price: number | null;
  swap_count: number | null;
  first_swap_type: string | null;
  first_swap_exchange: string | null;
}

interface ExchangeCountRow {
  first_swap_exchange: string;
  c: number;
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

function main(): void {
  const databaseUrl = process.env.DATABASE_URL ?? "./data/pumpfun-agent.sqlite";
  const limit = parseLimit(process.env.OUTCOME_ANALYZE_LIMIT);
  const filePath = resolveDbPath(databaseUrl);

  process.stdout.write("\n=== batch outcome analysis ===\n");
  process.stdout.write(`  databaseUrl:           ${databaseUrl}\n`);
  process.stdout.write(`  resolvedPath:          ${filePath}\n`);
  process.stdout.write(
    `  outcomeAnalyzeLimit:   ${limit === null ? "none" : String(limit)}\n`,
  );

  if (!fs.existsSync(filePath)) {
    process.stdout.write(
      `\nSQLite file not found at ${filePath}. Run ingestion first (e.g. 'npm run track:batch:outcomes').\n`,
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
    const sourceCte =
      limit === null
        ? "WITH src AS (SELECT * FROM token_outcomes)"
        : "WITH src AS (SELECT * FROM token_outcomes ORDER BY observed_at DESC LIMIT @limit)";
    const params = limit === null ? {} : { limit };

    const totalRows = (
      db.prepare(`${sourceCte} SELECT COUNT(*) AS c FROM src`).get(params) as CountRow
    ).c;
    const uniqueMints = (
      db
        .prepare(`${sourceCte} SELECT COUNT(DISTINCT mint) AS c FROM src`)
        .get(params) as CountRow
    ).c;
    const rowsWithUsdPrice = (
      db
        .prepare(`${sourceCte} SELECT COUNT(*) AS c FROM src WHERE usd_price IS NOT NULL`)
        .get(params) as CountRow
    ).c;
    const rowsWithSwapCount = (
      db
        .prepare(`${sourceCte} SELECT COUNT(*) AS c FROM src WHERE swap_count IS NOT NULL`)
        .get(params) as CountRow
    ).c;
    const rowsWithFirstSwapType = (
      db
        .prepare(
          `${sourceCte} SELECT COUNT(*) AS c FROM src WHERE first_swap_type IS NOT NULL`,
        )
        .get(params) as CountRow
    ).c;

    process.stdout.write("\n--- counts ---\n");
    process.stdout.write(`  totalRows:             ${totalRows}\n`);
    process.stdout.write(`  uniqueMints:           ${uniqueMints}\n`);
    process.stdout.write(`  rowsWithUsdPrice:      ${rowsWithUsdPrice}\n`);
    process.stdout.write(`  rowsWithSwapCount:     ${rowsWithSwapCount}\n`);
    process.stdout.write(`  rowsWithFirstSwapType: ${rowsWithFirstSwapType}\n`);

    if (totalRows === 0) {
      process.stdout.write(
        "\nno rows in token_outcomes — run 'npm run track:batch:outcomes' first to capture snapshots.\n",
      );
      return;
    }

    const topMints = db
      .prepare(
        `${sourceCte} SELECT mint, COUNT(*) AS c FROM src GROUP BY mint ORDER BY c DESC LIMIT 10`,
      )
      .all(params) as MintCountRow[];

    process.stdout.write("\n--- top mints by snapshot count ---\n");
    for (const row of topMints) {
      process.stdout.write(`  ${pad(row.mint, 46)}  ${row.c}\n`);
    }

    const newest = db
      .prepare(
        `${sourceCte} SELECT mint, observed_at, usd_price, swap_count, first_swap_type, first_swap_exchange FROM src ORDER BY observed_at DESC LIMIT 20`,
      )
      .all(params) as NewestRow[];

    process.stdout.write("\n--- newest 20 outcomes ---\n");
    process.stdout.write(
      `  ${pad("observedAt", 26)}  ${pad("mint", 46)}  ${pad("usdPrice", 14)}  ${pad("swaps", 6)}  ${pad("firstType", 10)}  firstExchange\n`,
    );
    for (const row of newest) {
      const observedAt = new Date(row.observed_at).toISOString();
      process.stdout.write(
        `  ${pad(observedAt, 26)}  ${pad(row.mint, 46)}  ${pad(fmtPrice(row.usd_price), 14)}  ${pad(fmtNullable(row.swap_count), 6)}  ${pad(fmtNullable(row.first_swap_type), 10)}  ${fmtNullable(row.first_swap_exchange)}\n`,
      );
    }

    const byExchange = db
      .prepare(
        `${sourceCte} SELECT first_swap_exchange, COUNT(*) AS c FROM src WHERE first_swap_exchange IS NOT NULL GROUP BY first_swap_exchange ORDER BY c DESC`,
      )
      .all(params) as ExchangeCountRow[];

    process.stdout.write("\n--- outcomes by firstSwapExchange ---\n");
    if (byExchange.length === 0) {
      process.stdout.write("  n/a (no rows have first_swap_exchange set)\n");
    } else {
      for (const row of byExchange) {
        process.stdout.write(`  ${pad(row.first_swap_exchange, 24)}  ${row.c}\n`);
      }
    }
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `analyze:batch:outcomes unhandled error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
