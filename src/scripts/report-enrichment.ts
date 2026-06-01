/**
 * report:enrichment
 *
 * Read-only diagnostic report for the token enrichment pipeline.
 * Queries the SQLite database directly — no API calls, no writes.
 *
 * Usage:
 *   npm run report:enrichment
 *   npm run report:enrichment -- --json
 */

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import * as dotenv from "dotenv";

dotenv.config();

// ── Config ────────────────────────────────────────────────────────────────────

const DB_URL   = process.env.DATABASE_URL ?? "./data/pumpfun-agent.sqlite";
const DAY_MS   = 86_400_000;
const HOUR_MS  = 3_600_000;
const MIN_MS   = 60_000;

// Budget limits — read from env, mirror config defaults
const BUDGET_DAY  = Number(process.env.BUDGET_PUMPFUN_FRONTEND_PER_DAY)  || 1_000;
const BUDGET_HOUR = Number(process.env.BUDGET_PUMPFUN_FRONTEND_PER_HOUR) || 60;
const BUDGET_MIN  = Number(process.env.BUDGET_PUMPFUN_FRONTEND_PER_MIN)  || 15;

// Rule C thresholds — mirror enrichment-filter.ts constants
const RULE_C_MIN_LAUNCHES = 10;
const RULE_C_WINDOW_MS    = 10_800_000; // 3 hours

function resolveDb(u: string): string {
  const s = u.startsWith("sqlite:") ? u.slice("sqlite:".length) : u;
  return path.isAbsolute(s) ? s : path.resolve(process.cwd(), s);
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}
function lpad(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}
function fmtPct(n: number, d: number): string {
  if (d === 0) return "n/a";
  return ((n / d) * 100).toFixed(1) + "%";
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const wantJson = process.argv.includes("--json");

  const filePath = resolveDb(DB_URL);
  if (!fs.existsSync(filePath)) {
    process.stdout.write(`\nDatabase not found at ${filePath}.\n`);
    process.exit(1);
  }

  const db = new Database(filePath, { readonly: true, fileMustExist: true });

  const now      = Date.now();
  const dayStart = Math.floor(now / DAY_MS) * DAY_MS;
  const hourStart = Math.floor(now / HOUR_MS) * HOUR_MS;
  const minStart  = Math.floor(now / MIN_MS) * MIN_MS;
  const oneDayAgo = now - DAY_MS;

  // ── 1. Token counts today ───────────────────────────────────────────────────
  interface TokenCoverage {
    total_today: number;
    enriched_today: number;
    unknown_today: number;
    has_cache_entry: number;
    no_cache_entry: number;
    cache_but_still_unknown: number;
  }
  const coverage = db.prepare(`
    SELECT
      COUNT(*)                                                     AS total_today,
      SUM(CASE WHEN t.name NOT IN ('','Unknown','UNKNOWN') THEN 1 ELSE 0 END) AS enriched_today,
      SUM(CASE WHEN t.name     IN ('','Unknown','UNKNOWN') THEN 1 ELSE 0 END) AS unknown_today,
      SUM(CASE WHEN ec.mint IS NOT NULL                    THEN 1 ELSE 0 END) AS has_cache_entry,
      SUM(CASE WHEN ec.mint IS NULL                        THEN 1 ELSE 0 END) AS no_cache_entry,
      SUM(CASE WHEN ec.mint IS NOT NULL
               AND t.name IN ('','Unknown','UNKNOWN')      THEN 1 ELSE 0 END) AS cache_but_still_unknown
    FROM tokens t
    LEFT JOIN token_enrichment_cache ec ON ec.mint = t.mint
    WHERE t.inserted_at >= ?
  `).get(dayStart) as TokenCoverage;

  // ── 2. Filter stats ─────────────────────────────────────────────────────────
  interface FilterStats {
    filtered_by_rule_a: number;
    filtered_by_rule_b: number;
    filtered_by_rule_c: number;
    filtered_by_rule_d: number;
    sampled_unknown_creators: number;
    enrichments_performed: number;
  }
  const filterStats = db.prepare(
    "SELECT * FROM enrichment_filter_stats WHERE day_start = ?"
  ).get(dayStart) as FilterStats | undefined;

  // ── 3. Enrichment metrics ───────────────────────────────────────────────────
  interface EnrichMetrics {
    successful_enrichments: number;
    mint_mismatches: number;
    enrichment_retries: number;
  }
  const enrichMetrics = db.prepare(
    "SELECT * FROM enrichment_metrics WHERE day_start = ?"
  ).get(dayStart) as EnrichMetrics | undefined;

  // ── 4. Budget usage ─────────────────────────────────────────────────────────
  interface UsageRow { request_count: number; rate_limit_count: number }
  const getUsage = (wt: string, ws: number): UsageRow =>
    (db.prepare(
      "SELECT request_count, rate_limit_count FROM api_request_usage WHERE service='pumpfun_frontend' AND window_type=? AND window_start=?"
    ).get(wt, ws) as UsageRow | undefined) ?? { request_count: 0, rate_limit_count: 0 };

  const usageDay  = getUsage("day",    dayStart);
  const usageHour = getUsage("hour",   hourStart);
  const usageMin  = getUsage("minute", minStart);

  // ── 5. Top skipped creators (Rule C) ────────────────────────────────────────
  interface SkippedCreator {
    creator_wallet: string;
    tokens_today: number;
    enriched_count: number;
    lifetime_launches: number;
    mins_since_last: number;
  }
  const topSkipped = db.prepare(`
    SELECT
      t.creator_wallet,
      COUNT(*)                                                          AS tokens_today,
      SUM(CASE WHEN t.name NOT IN ('','Unknown','UNKNOWN') THEN 1 ELSE 0 END) AS enriched_count,
      c.total_launches                                                  AS lifetime_launches,
      ROUND((? - c.last_seen_at) / 60000.0, 1)                         AS mins_since_last
    FROM tokens t
    LEFT JOIN creators c ON c.creator_wallet = t.creator_wallet
    WHERE t.inserted_at >= ?
      AND c.total_launches >= ?
      AND c.last_seen_at  >= ?
    GROUP BY t.creator_wallet
    ORDER BY tokens_today DESC
    LIMIT 10
  `).all(now, dayStart, RULE_C_MIN_LAUNCHES, now - RULE_C_WINDOW_MS) as SkippedCreator[];

  // ── 6. Example tokens: cache available, still Unknown ──────────────────────
  interface CacheToken {
    mint: string;
    creator_wallet: string;
    launched_at: string;
    cached_name: string;
    cached_symbol: string;
  }
  const cacheReadyTokens = db.prepare(`
    SELECT
      t.mint,
      t.creator_wallet,
      datetime(t.inserted_at/1000,'unixepoch') AS launched_at,
      ec.name   AS cached_name,
      ec.symbol AS cached_symbol
    FROM tokens t
    JOIN token_enrichment_cache ec ON ec.mint = t.mint
    WHERE t.inserted_at >= ?
      AND t.name IN ('','Unknown','UNKNOWN')
      AND ec.name NOT IN ('','Unknown','UNKNOWN')
    ORDER BY t.inserted_at DESC
    LIMIT 8
  `).all(oneDayAgo) as CacheToken[];

  // ── 7. Example tokens: no cache, no enrichment ──────────────────────────────
  interface NoCacheToken {
    mint: string;
    creator_wallet: string;
    launched_at: string;
    creator_score: number | null;
    lifetime_launches: number | null;
  }
  const noCacheTokens = db.prepare(`
    SELECT
      t.mint,
      t.creator_wallet,
      datetime(t.inserted_at/1000,'unixepoch') AS launched_at,
      cs.total_score                            AS creator_score,
      c.total_launches                          AS lifetime_launches
    FROM tokens t
    LEFT JOIN token_enrichment_cache ec ON ec.mint = t.mint
    LEFT JOIN creator_scores         cs ON cs.creator_wallet = t.creator_wallet
    LEFT JOIN creators               c  ON c.creator_wallet  = t.creator_wallet
    WHERE t.inserted_at >= ?
      AND t.name IN ('','Unknown','UNKNOWN')
      AND ec.mint IS NULL
    ORDER BY t.inserted_at DESC
    LIMIT 8
  `).all(oneDayAgo) as NoCacheToken[];

  db.close();

  // ── Output ────────────────────────────────────────────────────────────────────

  if (wantJson) {
    process.stdout.write(JSON.stringify({
      generatedAt: new Date().toISOString(),
      coverage, filterStats, enrichMetrics,
      budget: { day: usageDay, hour: usageHour, minute: usageMin, limits: { day: BUDGET_DAY, hour: BUDGET_HOUR, minute: BUDGET_MIN } },
      topSkippedCreators: topSkipped,
      cacheReadyTokens,
      noCacheTokens,
    }, null, 2) + "\n");
    return;
  }

  const line  = "─".repeat(72);
  const w     = process.stdout.write.bind(process.stdout);
  const pct   = (n: number, d: number) => lpad(fmtPct(n, d), 7);
  const n6    = (v: number | undefined) => lpad(String(v ?? 0), 6);

  w(`\n${line}\n`);
  w(` Enrichment Report  |  ${new Date().toISOString()}\n`);
  w(`${line}\n\n`);

  // Section 1: Token coverage
  w(" Token enrichment coverage (today):\n");
  w(`  ${"Tokens detected today:"}             ${n6(coverage.total_today)}\n`);
  w(`  ${"Enriched (real name/symbol):"}       ${n6(coverage.enriched_today)}  ${pct(coverage.enriched_today, coverage.total_today)}\n`);
  w(`  ${"Still Unknown:"}                     ${n6(coverage.unknown_today)}  ${pct(coverage.unknown_today, coverage.total_today)}\n`);
  w(`  ${"Has cache entry:"}                   ${n6(coverage.has_cache_entry)}\n`);
  w(`  ${"Cache entry but still Unknown:"}     ${n6(coverage.cache_but_still_unknown)}  ← SQL fix needed / retry available\n`);
  w(`  ${"No cache entry:"}                    ${n6(coverage.no_cache_entry)}  ← budget blocked or filter skipped\n`);

  // Section 2: Filter breakdown
  w("\n Filter decisions (today):\n");
  const fs2 = filterStats;
  w(`  ${"Skipped by Rule A (unknown creator):"} ${n6(fs2?.filtered_by_rule_a)}  (${process.env.ENRICH_UNKNOWN_CREATOR_PERCENT ?? "10"}% sampled)\n`);
  w(`  ${"Sampled unknown creators:"}           ${n6(fs2?.sampled_unknown_creators)}\n`);
  w(`  ${"Skipped by Rule B (score < 50):"}    ${n6(fs2?.filtered_by_rule_b)}\n`);
  w(`  ${"Skipped by Rule C (high-freq bot):"} ${n6(fs2?.filtered_by_rule_c)}\n`);
  w(`  ${"Skipped by Rule D (duplicate name):"} ${n6(fs2?.filtered_by_rule_d)}\n`);
  w(`  ${"Enrichments attempted:"}             ${n6(fs2?.enrichments_performed)}\n`);

  // Section 3: Enrichment outcomes
  w("\n Enrichment API outcomes (today):\n");
  const em = enrichMetrics;
  w(`  ${"Successful enrichments:"}            ${n6(em?.successful_enrichments)}\n`);
  w(`  ${"Mint mismatches:"}                   ${n6(em?.mint_mismatches)}\n`);
  w(`  ${"Mismatch retries:"}                  ${n6(em?.enrichment_retries)}\n`);

  // Section 4: Budget
  w("\n pumpfun_frontend budget (today):\n");
  w(`  ${"Day:"}    ${lpad(String(usageDay.request_count), 5)} / ${BUDGET_DAY}  ${pct(usageDay.request_count, BUDGET_DAY)}  remaining: ${Math.max(0, BUDGET_DAY - usageDay.request_count)}\n`);
  w(`  ${"Hour:"}   ${lpad(String(usageHour.request_count), 5)} / ${BUDGET_HOUR}   ${pct(usageHour.request_count, BUDGET_HOUR)}  remaining: ${Math.max(0, BUDGET_HOUR - usageHour.request_count)}\n`);
  w(`  ${"Minute:"} ${lpad(String(usageMin.request_count), 5)} / ${BUDGET_MIN}   ${pct(usageMin.request_count, BUDGET_MIN)}  remaining: ${Math.max(0, BUDGET_MIN - usageMin.request_count)}\n`);

  // Section 5: Top skipped creators
  if (topSkipped.length > 0) {
    w("\n Top creators skipped by Rule C today:\n");
    w(`  ${pad("Creator", 46)} ${lpad("Tokens", 6)} ${lpad("Enrch", 5)} ${lpad("Lifetime", 8)} ${lpad("MinsSince", 9)}\n`);
    for (const c of topSkipped) {
      w(`  ${pad(c.creator_wallet, 46)} ${lpad(String(c.tokens_today), 6)} ${lpad(String(c.enriched_count), 5)} ${lpad(String(c.lifetime_launches), 8)} ${lpad(String(c.mins_since_last), 9)}\n`);
    }
  } else {
    w("\n No creators triggering Rule C today.\n");
  }

  // Section 6: Cache-ready tokens
  if (cacheReadyTokens.length > 0) {
    w(`\n Tokens with cache data but still Unknown (sample — last 24h):\n`);
    w(`  These can be updated without an API call via: npm run retry:enrichment -- --yes\n`);
    for (const t of cacheReadyTokens) {
      w(`  ${t.mint.slice(0, 12)}…  ${pad(t.cached_symbol ?? "?", 10)} ${pad(t.cached_name ?? "?", 30)} ${t.launched_at}\n`);
    }
  } else {
    w("\n No cache-ready tokens pending update.\n");
  }

  // Section 7: No-cache tokens
  if (noCacheTokens.length > 0) {
    w(`\n Tokens still Unknown with no cache (sample — last 24h):\n`);
    w(`  These require an API call. Run: npm run retry:enrichment -- --yes\n`);
    for (const t of noCacheTokens) {
      w(`  ${t.mint.slice(0, 12)}…  score=${t.creator_score ?? "null"}  launches=${t.lifetime_launches ?? "?"}  ${t.launched_at}\n`);
    }
  } else {
    w("\n No unenriched tokens without cache.\n");
  }

  w(`\n${line}\n\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`report:enrichment error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
