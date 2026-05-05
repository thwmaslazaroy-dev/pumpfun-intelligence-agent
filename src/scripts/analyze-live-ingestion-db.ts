import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { config } from "../config";

interface CountRow {
  n: number;
}

interface RiskLevelCountRow {
  risk_level: string;
  n: number;
}

interface CreatorLaunchCountRow {
  creator_wallet: string;
  launches: number;
}

interface SampleTokenRow {
  mint: string;
  creator_wallet: string;
  symbol: string;
  name: string;
  launched_at: number;
  token_score: number | null;
  creator_score: number | null;
  combined_score: number | null;
  combined_risk_level: string | null;
}

function resolveDbPath(databaseUrl: string): string {
  const stripped = databaseUrl.startsWith("sqlite:")
    ? databaseUrl.slice("sqlite:".length)
    : databaseUrl;
  return path.isAbsolute(stripped) ? stripped : path.resolve(process.cwd(), stripped);
}

function fmtNum(v: number | null | undefined): string {
  if (v === null || v === undefined) return "n/a";
  return Number.isInteger(v) ? v.toString() : v.toFixed(2);
}

function fmtIsoFromMs(ms: number): string {
  return new Date(ms).toISOString();
}

function main(): void {
  const dbPath = resolveDbPath(config.databaseUrl);
  if (!fs.existsSync(dbPath)) {
    console.error(`database file not found: ${dbPath}`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  const total = db.prepare("SELECT COUNT(*) AS n FROM tokens").get() as CountRow;
  const unknownSymbol = db
    .prepare("SELECT COUNT(*) AS n FROM tokens WHERE symbol = ?")
    .get("UNKNOWN") as CountRow;
  const zeroMcap = db
    .prepare("SELECT COUNT(*) AS n FROM tokens WHERE initial_market_cap_usd = 0")
    .get() as CountRow;

  const now = Date.now();
  const lastHour = db
    .prepare("SELECT COUNT(*) AS n FROM tokens WHERE launched_at >= ?")
    .get(now - 60 * 60 * 1000) as CountRow;
  const last24h = db
    .prepare("SELECT COUNT(*) AS n FROM tokens WHERE launched_at >= ?")
    .get(now - 24 * 60 * 60 * 1000) as CountRow;
  const last7d = db
    .prepare("SELECT COUNT(*) AS n FROM tokens WHERE launched_at >= ?")
    .get(now - 7 * 24 * 60 * 60 * 1000) as CountRow;

  const topCreators = db
    .prepare(
      `SELECT creator_wallet, COUNT(*) AS launches
       FROM tokens
       GROUP BY creator_wallet
       ORDER BY launches DESC, creator_wallet ASC
       LIMIT 10`,
    )
    .all() as CreatorLaunchCountRow[];

  const tokenScoreDist = db
    .prepare(
      `SELECT risk_level, COUNT(*) AS n
       FROM token_scores
       GROUP BY risk_level
       ORDER BY n DESC, risk_level ASC`,
    )
    .all() as RiskLevelCountRow[];

  const creatorScoreDist = db
    .prepare(
      `SELECT risk_level, COUNT(*) AS n
       FROM creator_scores
       GROUP BY risk_level
       ORDER BY n DESC, risk_level ASC`,
    )
    .all() as RiskLevelCountRow[];

  const combinedDist = db
    .prepare(
      `SELECT combined_risk_level AS risk_level, COUNT(*) AS n
       FROM combined_token_evaluations
       GROUP BY combined_risk_level
       ORDER BY n DESC, combined_risk_level ASC`,
    )
    .all() as RiskLevelCountRow[];

  const sample = db
    .prepare(
      `SELECT t.mint, t.creator_wallet, t.symbol, t.name, t.launched_at,
              ts.total_score   AS token_score,
              cs.total_score   AS creator_score,
              ce.combined_score AS combined_score,
              ce.combined_risk_level AS combined_risk_level
       FROM tokens t
       LEFT JOIN token_scores ts ON ts.mint = t.mint
       LEFT JOIN creator_scores cs ON cs.creator_wallet = t.creator_wallet
       LEFT JOIN combined_token_evaluations ce ON ce.mint = t.mint
       ORDER BY t.launched_at DESC
       LIMIT 20`,
    )
    .all() as SampleTokenRow[];

  console.log("=== Live Ingestion DB Summary (read-only) ===");
  console.log(`db path: ${dbPath}`);
  console.log("");
  console.log(`total tokens:                     ${total.n}`);
  console.log(`tokens with symbol UNKNOWN:       ${unknownSymbol.n}`);
  console.log(`tokens with marketCapUsd = 0:     ${zeroMcap.n}`);
  console.log(`tokens launched in last 1h:       ${lastHour.n}`);
  console.log(`tokens launched in last 24h:      ${last24h.n}`);
  console.log(`tokens launched in last 7d:       ${last7d.n}`);

  console.log("");
  console.log("--- top creators by launch count (top 10) ---");
  if (topCreators.length === 0) {
    console.log("  (none)");
  } else {
    for (const c of topCreators) {
      console.log(`  ${c.creator_wallet}  launches=${c.launches}`);
    }
  }

  console.log("");
  console.log("--- token score distribution by riskLevel ---");
  if (tokenScoreDist.length === 0) {
    console.log("  (none)");
  } else {
    for (const r of tokenScoreDist) {
      console.log(`  ${r.risk_level}: ${r.n}`);
    }
  }

  console.log("");
  console.log("--- creator score distribution by riskLevel ---");
  if (creatorScoreDist.length === 0) {
    console.log("  (none)");
  } else {
    for (const r of creatorScoreDist) {
      console.log(`  ${r.risk_level}: ${r.n}`);
    }
  }

  console.log("");
  console.log("--- combined evaluation distribution by riskLevel ---");
  if (combinedDist.length === 0) {
    console.log("  (none)");
  } else {
    for (const r of combinedDist) {
      console.log(`  ${r.risk_level}: ${r.n}`);
    }
  }

  console.log("");
  console.log(`--- 20 newest tokens (by launched_at DESC) ---`);
  if (sample.length === 0) {
    console.log("  (none)");
  } else {
    for (const r of sample) {
      console.log(`  ${fmtIsoFromMs(r.launched_at)}  ${r.mint}`);
      console.log(`    creator=${r.creator_wallet}  symbol=${r.symbol}  name=${r.name}`);
      console.log(
        `    tokenScore=${fmtNum(r.token_score)}  creatorScore=${fmtNum(r.creator_score)}` +
          `  combined=${fmtNum(r.combined_score)} (${r.combined_risk_level ?? "n/a"})`,
      );
    }
  }

  db.close();
}

main();
