import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { config } from "../config";

interface MintRow {
  mint: string;
}

function resolveDbPath(databaseUrl: string): string {
  const stripped = databaseUrl.startsWith("sqlite:")
    ? databaseUrl.slice("sqlite:".length)
    : databaseUrl;
  return path.isAbsolute(stripped) ? stripped : path.resolve(process.cwd(), stripped);
}

function readPosInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const v = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  return fallback;
}

function ensureDir(file: string): void {
  const dir = path.dirname(file);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function main(): void {
  const dbPath = resolveDbPath(config.databaseUrl);
  if (!fs.existsSync(dbPath)) {
    console.error(`database file not found: ${dbPath}`);
    process.exit(1);
  }

  const limit = readPosInt("LIVE_WATCHLIST_LIMIT", 50);
  const hours = readPosInt("LIVE_WATCHLIST_HOURS", 24);
  const unknownOnly = readBool("LIVE_WATCHLIST_UNKNOWN_ONLY", false);

  const outPathRaw = process.env.OUTCOME_WATCHLIST_PATH;
  const outPath =
    outPathRaw && outPathRaw.length > 0 ? outPathRaw : "./data/live-outcome-watchlist.txt";
  const resolvedOut = path.isAbsolute(outPath)
    ? outPath
    : path.resolve(process.cwd(), outPath);

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  const sinceMs = Date.now() - hours * 60 * 60 * 1000;

  const sql = unknownOnly
    ? `SELECT mint FROM tokens
       WHERE launched_at >= ? AND (symbol = 'UNKNOWN' OR name = 'Unknown')
       ORDER BY launched_at DESC
       LIMIT ?`
    : `SELECT mint FROM tokens
       WHERE launched_at >= ?
       ORDER BY launched_at DESC
       LIMIT ?`;

  const rows = db.prepare(sql).all(sinceMs, limit) as MintRow[];
  db.close();

  const seen = new Set<string>();
  const mints: string[] = [];
  for (const r of rows) {
    if (typeof r.mint !== "string" || r.mint.length === 0) continue;
    if (seen.has(r.mint)) continue;
    seen.add(r.mint);
    mints.push(r.mint);
  }

  ensureDir(resolvedOut);

  const generatedAt = new Date().toISOString();
  const header = [
    "# Live outcome watchlist (generated, read-only source)",
    `# generatedAt:    ${generatedAt}`,
    `# dbPath:         ${dbPath}`,
    `# windowHours:    ${hours}`,
    `# limit:          ${limit}`,
    `# unknownOnly:    ${unknownOnly}`,
    `# mintsWritten:   ${mints.length}`,
    "#",
    "# Use with:  npm run track:batch:outcomes",
    "# This generator does NOT call any external API and does NOT modify the database.",
    "#",
    "",
  ].join("\n");

  const body = mints.length > 0 ? mints.join("\n") + "\n" : "";
  fs.writeFileSync(resolvedOut, header + body);

  console.log("=== generate:live:watchlist (read-only) ===");
  console.log(`dbPath:        ${dbPath}`);
  console.log(`outputPath:    ${resolvedOut}`);
  console.log(`windowHours:   ${hours}`);
  console.log(`limit:         ${limit}`);
  console.log(`unknownOnly:   ${unknownOnly}`);
  console.log(`mintsWritten:  ${mints.length}`);
  console.log("");
  console.log("--- first 10 mints ---");
  if (mints.length === 0) {
    console.log("  (none)");
  } else {
    for (const m of mints.slice(0, 10)) {
      console.log(`  ${m}`);
    }
  }
}

main();
