/**
 * api:usage — API quota dashboard.
 *
 * Prints current request usage per service, remaining budgets,
 * rate-limit events, and recent error samples.
 *
 * Usage:
 *   npm run api:usage
 *   npm run api:usage -- --json      # machine-readable JSON output
 *   npm run api:usage -- --reset     # clear all api_request_usage rows (use carefully)
 */

import * as fs from "fs";
import * as path from "path";
import Database from "better-sqlite3";
import * as dotenv from "dotenv";

dotenv.config();

// ── Config ────────────────────────────────────────────────────────────────────

const DB_URL = process.env.DATABASE_URL ?? "./data/pumpfun-agent.sqlite";

function resolveDbPath(u: string): string {
  const s = u.startsWith("sqlite:") ? u.slice("sqlite:".length) : u;
  return path.isAbsolute(s) ? s : path.resolve(process.cwd(), s);
}

const MS_MIN = 60_000;
const MS_HOUR = 3_600_000;
const MS_DAY = 86_400_000;

// Budget defaults — mirrors config/index.ts defaults
const LIMITS: Record<string, { perMinute: number; perHour: number; perDay: number }> = {
  helius_http:       { perMinute: Number(process.env.BUDGET_HELIUS_HTTP_PER_MIN) || 60,         perHour: Number(process.env.BUDGET_HELIUS_HTTP_PER_HOUR) || 1_000,    perDay: Number(process.env.BUDGET_HELIUS_HTTP_PER_DAY) || 8_000 },
  pumpfun_frontend:  { perMinute: Number(process.env.BUDGET_PUMPFUN_FRONTEND_PER_MIN) || 15,    perHour: Number(process.env.BUDGET_PUMPFUN_FRONTEND_PER_HOUR) || 150, perDay: Number(process.env.BUDGET_PUMPFUN_FRONTEND_PER_DAY) || 1_000 },
  moralis:           { perMinute: Number(process.env.BUDGET_MORALIS_PER_MIN) || 5,              perHour: Number(process.env.BUDGET_MORALIS_PER_HOUR) || 60,           perDay: Number(process.env.BUDGET_MORALIS_PER_DAY) || 200 },
  discord:           { perMinute: Number(process.env.BUDGET_DISCORD_PER_MIN) || 5,              perHour: Number(process.env.BUDGET_DISCORD_PER_HOUR) || 50,           perDay: Number(process.env.BUDGET_DISCORD_PER_DAY) || 100 },
};
const WARN_PCT = Number(process.env.BUDGET_WARN_PCT) || 70;
const PAUSE_PCT = Number(process.env.BUDGET_PAUSE_PCT) || 85;
const EMERGENCY_PCT = Number(process.env.BUDGET_EMERGENCY_PCT) || 95;

// ── Types ─────────────────────────────────────────────────────────────────────

interface UsageRow {
  service: string;
  window_type: string;
  window_start: number;
  request_count: number;
  rate_limit_count: number;
}

interface LogRow {
  id: number;
  service: string;
  endpoint: string;
  status_code: number | null;
  requested_at: number;
  reason: string | null;
}

interface ServiceStats {
  service: string;
  minuteUsed: number;
  hourUsed: number;
  dayUsed: number;
  rateLimitEventsToday: number;
  dayPct: number;
  status: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}
function lpad(s: string, w: number): string {
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}
function fmtTs(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}
function bar(pct: number, width = 20): string {
  const filled = Math.round((pct / 100) * width);
  return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
}
function statusEmoji(pct: number): string {
  if (pct >= EMERGENCY_PCT) return "🔴 EMERGENCY";
  if (pct >= PAUSE_PCT) return "🟠 PAUSE";
  if (pct >= WARN_PCT) return "🟡 WARNING";
  return "🟢 NORMAL";
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const args = process.argv.slice(2);
  const wantJson = args.includes("--json");
  const wantReset = args.includes("--reset");

  const filePath = resolveDbPath(DB_URL);

  if (!fs.existsSync(filePath)) {
    process.stdout.write(`\nNo database found at ${filePath}.\nRun the agent first to create it.\n`);
    process.exit(0);
  }

  const db = new Database(filePath, { readonly: !wantReset, fileMustExist: true });

  // Check if tables exist
  const hasUsageTable = (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='api_request_usage'").get()
  ) as { 1: number } | undefined;

  if (!hasUsageTable) {
    process.stdout.write("\napi_request_usage table not found — run the agent once to initialize the schema.\n");
    db.close();
    process.exit(0);
  }

  if (wantReset) {
    const confirm = args.includes("--yes");
    if (!confirm) {
      process.stdout.write("\nPass --reset --yes to confirm clearing all api_request_usage rows.\n");
      db.close();
      process.exit(0);
    }
    db.prepare("DELETE FROM api_request_usage").run();
    db.prepare("DELETE FROM api_request_log").run();
    process.stdout.write("api_request_usage and api_request_log cleared.\n");
    db.close();
    return;
  }

  const now = Date.now();
  const minStart = Math.floor(now / MS_MIN) * MS_MIN;
  const hourStart = Math.floor(now / MS_HOUR) * MS_HOUR;
  const dayStart = Math.floor(now / MS_DAY) * MS_DAY;

  const services = Object.keys(LIMITS);
  const stats: ServiceStats[] = [];

  for (const service of services) {
    const getCount = (windowType: string, windowStart: number): { req: number; rl: number } => {
      const row = db
        .prepare(
          "SELECT request_count, rate_limit_count FROM api_request_usage WHERE service = ? AND window_type = ? AND window_start = ?",
        )
        .get(service, windowType, windowStart) as UsageRow | undefined;
      return { req: row?.request_count ?? 0, rl: row?.rate_limit_count ?? 0 };
    };

    const min = getCount("minute", minStart);
    const hour = getCount("hour", hourStart);
    const day = getCount("day", dayStart);
    const limit = LIMITS[service]!;
    const dayPct = limit.perDay > 0 ? (day.req / limit.perDay) * 100 : 0;

    stats.push({
      service,
      minuteUsed: min.req,
      hourUsed: hour.req,
      dayUsed: day.req,
      rateLimitEventsToday: day.rl,
      dayPct,
      status: statusEmoji(dayPct),
    });
  }

  // Signature dedup stats
  const sigCount = (
    db.prepare("SELECT COUNT(*) AS n FROM processed_signatures").get() as { n: number }
  ).n;

  // Top endpoints today
  const hasLogTable = (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='api_request_log'").get()
  ) as { 1: number } | undefined;

  interface EndpointCount { service: string; endpoint: string; cnt: number }
  let topEndpoints: EndpointCount[] = [];
  let recentRateLimits: LogRow[] = [];

  if (hasLogTable) {
    topEndpoints = db
      .prepare(
        `SELECT service, endpoint, COUNT(*) AS cnt
         FROM api_request_log
         WHERE requested_at >= ?
         GROUP BY service, endpoint
         ORDER BY cnt DESC
         LIMIT 15`,
      )
      .all(dayStart) as EndpointCount[];

    recentRateLimits = db
      .prepare(
        `SELECT id, service, endpoint, status_code, requested_at, reason
         FROM api_request_log
         WHERE status_code = 429 OR reason LIKE '%rate-limit%'
         ORDER BY requested_at DESC
         LIMIT 10`,
      )
      .all() as LogRow[];
  }

  // Enrichment cache stats
  interface CacheStats { total: number; fresh: number; expired: number }
  let enrichCache: CacheStats = { total: 0, fresh: 0, expired: 0 };
  const hasCacheTable = (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='token_enrichment_cache'").get()
  ) as { 1: number } | undefined;
  if (hasCacheTable) {
    const total = (db.prepare("SELECT COUNT(*) AS n FROM token_enrichment_cache").get() as { n: number }).n;
    const fresh = (
      db
        .prepare("SELECT COUNT(*) AS n FROM token_enrichment_cache WHERE fetched_at + ttl_ms > ?")
        .get(now) as { n: number }
    ).n;
    enrichCache = { total, fresh, expired: total - fresh };
  }

  // Enrichment filter stats (today)
  interface FilterStatsRow {
    filtered_by_rule_a: number;
    filtered_by_rule_b: number;
    filtered_by_rule_c: number;
    filtered_by_rule_d: number;
    sampled_unknown_creators: number;
    enrichments_performed: number;
    updated_at: number;
  }
  let filterStats: FilterStatsRow | null = null;
  const hasFilterTable = (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='enrichment_filter_stats'").get()
  ) as { 1: number } | undefined;
  if (hasFilterTable) {
    filterStats = db
      .prepare("SELECT * FROM enrichment_filter_stats WHERE day_start = ?")
      .get(dayStart) as FilterStatsRow | undefined ?? null;
  }

  // Enrichment outcome metrics (today)
  interface EnrichmentMetricsRow {
    successful_enrichments: number;
    mint_mismatches: number;
    enrichment_retries: number;
    updated_at: number;
  }
  let enrichmentMetrics: EnrichmentMetricsRow | null = null;
  const hasMetricsTable = (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='enrichment_metrics'").get()
  ) as { 1: number } | undefined;
  if (hasMetricsTable) {
    enrichmentMetrics = db
      .prepare("SELECT * FROM enrichment_metrics WHERE day_start = ?")
      .get(dayStart) as EnrichmentMetricsRow | undefined ?? null;
  }

  db.close();

  if (wantJson) {
    process.stdout.write(
      JSON.stringify({ generatedAt: new Date().toISOString(), stats, topEndpoints, recentRateLimits, sigCount, enrichCache, filterStats, enrichmentMetrics }, null, 2) + "\n",
    );
    return;
  }

  // ── Human-readable output ────────────────────────────────────────────────────

  const line = "─".repeat(78);
  const w = process.stdout.write.bind(process.stdout);

  w(`\n${line}\n`);
  w(` API Usage Dashboard  |  ${new Date().toISOString()}\n`);
  w(`${line}\n\n`);

  // Service table
  w(` ${pad("Service", 20)} ${lpad("Min", 6)}/${lpad("Max", 6)}  ${lpad("Hour", 6)}/${lpad("Max", 6)}  ${lpad("Day", 6)}/${lpad("Max", 6)}   Day%  ${pad("Status", 15)}\n`);
  w(` ${"─".repeat(76)}\n`);
  for (const s of stats) {
    const lim = LIMITS[s.service]!;
    const pct = s.dayPct.toFixed(1).padStart(5);
    w(
      ` ${pad(s.service, 20)} ${lpad(String(s.minuteUsed), 6)}/${lpad(String(lim.perMinute), 6)}  ${lpad(String(s.hourUsed), 6)}/${lpad(String(lim.perHour), 6)}  ${lpad(String(s.dayUsed), 6)}/${lpad(String(lim.perDay), 6)}  ${pct}%  ${s.status}\n`,
    );
  }

  // Budget bar
  w("\n Budget bars (daily usage):\n");
  for (const s of stats) {
    const lim = LIMITS[s.service]!;
    const remaining = Math.max(0, lim.perDay - s.dayUsed);
    w(`  ${pad(s.service, 20)} ${bar(s.dayPct, 24)} ${s.dayPct.toFixed(1)}%  (${remaining} remaining)\n`);
  }

  // Kill-switch thresholds explanation
  w(`\n Thresholds: warn=${WARN_PCT}%  pause-LOW=${PAUSE_PCT}%  emergency-MEDIUM=${EMERGENCY_PCT}%  hard-stop=100%\n`);

  // Rate limit events
  w(`\n Rate-limit events today:\n`);
  let anyRl = false;
  for (const s of stats) {
    if (s.rateLimitEventsToday > 0) {
      w(`  ${pad(s.service, 20)}  ${s.rateLimitEventsToday} event(s)\n`);
      anyRl = true;
    }
  }
  if (!anyRl) w("  none\n");

  // Dedup & cache
  w(`\n Signature dedup cache:    ${sigCount} signatures stored\n`);
  w(` Enrichment cache:         ${enrichCache.fresh} fresh / ${enrichCache.expired} expired / ${enrichCache.total} total entries\n`);

  // Top endpoints
  if (topEndpoints.length > 0) {
    w(`\n Top endpoints today:\n`);
    w(`  ${pad("Service", 20)} ${pad("Endpoint", 35)} Count\n`);
    for (const e of topEndpoints) {
      w(`  ${pad(e.service, 20)} ${pad(e.endpoint.slice(0, 34), 35)} ${e.cnt}\n`);
    }
  }

  // Recent rate limit events
  if (recentRateLimits.length > 0) {
    w(`\n Recent rate-limit events:\n`);
    for (const r of recentRateLimits) {
      w(`  ${fmtTs(r.requested_at)}  ${pad(r.service, 18)} ${r.endpoint.slice(0, 30)}\n`);
    }
  }

  // Enrichment filter stats
  w(`\n Enrichment filter (today):\n`);
  if (!hasFilterTable) {
    w("  table not found — run the agent once to initialize.\n");
  } else if (!filterStats) {
    w("  no data yet for today.\n");
  } else {
    const ruleD = filterStats.filtered_by_rule_d ?? 0;
    const totalSaved =
      filterStats.filtered_by_rule_a +
      filterStats.filtered_by_rule_b +
      filterStats.filtered_by_rule_c +
      ruleD +
      filterStats.sampled_unknown_creators +
      filterStats.enrichments_performed;
    const totalSkipped =
      filterStats.filtered_by_rule_a +
      filterStats.filtered_by_rule_b +
      filterStats.filtered_by_rule_c +
      ruleD;
    const skipPct = totalSaved > 0 ? ((totalSkipped / totalSaved) * 100).toFixed(1) : "0.0";
    const lastUpdated = fmtTs(filterStats.updated_at);

    w(`  ${pad("Rule A skipped (unknown creator):", 38)} ${filterStats.filtered_by_rule_a}\n`);
    w(`  ${pad("Rule A sampled (unknown, allowed):", 38)} ${filterStats.sampled_unknown_creators}\n`);
    w(`  ${pad("Rule B skipped (score < 50):", 38)} ${filterStats.filtered_by_rule_b}\n`);
    w(`  ${pad("Rule C skipped (high-frequency):", 38)} ${filterStats.filtered_by_rule_c}\n`);
    w(`  ${pad("Rule D skipped (duplicate name):", 38)} ${ruleD}\n`);
    w(`  ${pad("Enrichments performed:", 38)} ${filterStats.enrichments_performed}\n`);
    w(`  ${"─".repeat(50)}\n`);
    w(`  ${pad("Total tokens evaluated:", 38)} ${totalSaved}\n`);
    w(`  ${pad("Total skipped (API calls saved):", 38)} ${totalSkipped}  (${skipPct}% reduction)\n`);
    w(`  ${pad("Last updated:", 38)} ${lastUpdated}\n`);
  }

  // Enrichment outcome metrics
  w(`\n Enrichment outcomes (today):\n`);
  if (!hasMetricsTable) {
    w("  table not found — run the agent once to initialize.\n");
  } else if (!enrichmentMetrics) {
    w("  no data yet for today.\n");
  } else {
    const m = enrichmentMetrics;
    const mismatchPct = m.successful_enrichments + m.mint_mismatches > 0
      ? ((m.mint_mismatches / (m.successful_enrichments + m.mint_mismatches)) * 100).toFixed(1)
      : "0.0";
    w(`  ${pad("Successful enrichments:", 36)} ${m.successful_enrichments}\n`);
    w(`  ${pad("Mint mismatches:", 36)} ${m.mint_mismatches}  (${mismatchPct}% of attempts)\n`);
    w(`  ${pad("Mismatch retries (30s wait):", 36)} ${m.enrichment_retries}\n`);
    w(`  ${pad("Last updated:", 36)} ${fmtTs(m.updated_at)}\n`);
  }

  w(`\n${line}\n`);

  // Estimated safe runtime
  w(" Estimated safe remaining runtime:\n");
  for (const s of stats) {
    const lim = LIMITS[s.service]!;
    const remaining = Math.max(0, lim.perDay - s.dayUsed);
    const ratePerMin = s.minuteUsed > 0 ? s.minuteUsed : (s.hourUsed > 0 ? s.hourUsed / 60 : 0.1);
    const estimatedMinutes = ratePerMin > 0 ? remaining / ratePerMin : Infinity;
    const display = estimatedMinutes === Infinity
      ? "unlimited (no recent activity)"
      : estimatedMinutes > 1440
      ? `${(estimatedMinutes / 60).toFixed(0)}h`
      : `${estimatedMinutes.toFixed(0)}min`;
    w(`  ${pad(s.service, 20)}  ~${display}\n`);
  }

  w(`\n Run "npm run api:usage -- --json" for machine-readable output.\n`);
  w(`${line}\n\n`);
}

try {
  main();
} catch (err) {
  process.stderr.write(`api:usage error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
