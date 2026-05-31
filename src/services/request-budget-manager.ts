import type Database from "better-sqlite3";
import { getDatabase } from "../storage/database";
import { logger } from "../utils/logger";

// ── Public types ──────────────────────────────────────────────────────────────

export type ServiceName =
  | "helius_http"
  | "helius_ws"
  | "pumpfun_frontend"
  | "moralis"
  | "discord";

export type Priority = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";

export interface ServiceLimits {
  perMinute: number;
  perHour: number;
  perDay: number;
}

export interface BudgetManagerConfig {
  limits: Record<ServiceName, ServiceLimits>;
  /** Log warning at this % of daily budget (default 70) */
  warnPct: number;
  /** Block LOW priority at this % of daily budget (default 85) */
  pausePct: number;
  /** Block LOW+MEDIUM at this % of daily budget (default 95) */
  emergencyPct: number;
}

export interface BudgetCheck {
  allowed: boolean;
  reason: string;
  dayUsagePct: number;
  remainingDay: number;
  remainingHour: number;
  remainingMinute: number;
}

export interface RemainingBudget {
  service: ServiceName;
  minute: { used: number; limit: number; remaining: number };
  hour: { used: number; limit: number; remaining: number };
  day: { used: number; limit: number; remaining: number };
  dayUsagePct: number;
  rateLimitEventsToday: number;
  pausedUntil: number | null;
}

export interface RecordOpts {
  statusCode?: number | null;
  cacheHit?: boolean;
  reason?: string;
  relatedMint?: string;
  relatedSignature?: string;
}

export interface EnrichmentCacheEntry {
  mint: string;
  name: string | null;
  symbol: string | null;
  marketCapUsd: number | null;
  bondingCurveProgress: number | null;
  buyCount: number | null;
  sellCount: number | null;
  volumeUsd: number | null;
  socialLinksJson: string | null;
  fetchedAt: number;
}

// ── Internal row types ────────────────────────────────────────────────────────

interface UsageRow {
  request_count: number;
  rate_limit_count: number;
}

interface EnrichmentCacheRow {
  mint: string;
  name: string | null;
  symbol: string | null;
  market_cap_usd: number | null;
  bonding_curve_progress: number | null;
  buy_count: number | null;
  sell_count: number | null;
  volume_usd: number | null;
  social_links_json: string | null;
  fetched_at: number;
  ttl_ms: number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MS_MIN = 60_000;
const MS_HOUR = 3_600_000;
const MS_DAY = 86_400_000;

/** Prune api_request_log when it exceeds this row count */
const LOG_MAX_ROWS = 2_000;
/** Prune down to this many rows */
const LOG_PRUNE_TARGET = 1_500;
/** How often (in recordRequest calls) to run the prune check */
const LOG_PRUNE_EVERY = 200;
/** Sample 1 in N successful requests for the log (rate-limit events always logged) */
const LOG_SAMPLE_RATE = 20;
/** Keep processed_signatures rows for this many ms (7 days) */
const SIG_RETENTION_MS = 7 * MS_DAY;
/** Run signature prune every N markSignatureProcessed calls */
const SIG_PRUNE_EVERY = 500;

// ── RequestBudgetManager ──────────────────────────────────────────────────────

export class RequestBudgetManager {
  private readonly db: Database.Database;
  private readonly cfg: BudgetManagerConfig;

  /** In-memory pause state: service → Unix ms when pause expires */
  private readonly pauses = new Map<ServiceName, number>();
  private recordCallCount = 0;
  private sigMarkCount = 0;
  private lastWarnLogged = new Map<ServiceName, number>();

  constructor(cfg: BudgetManagerConfig, db?: Database.Database) {
    this.cfg = cfg;
    this.db = db ?? getDatabase();
  }

  // ── Budget checking ─────────────────────────────────────────────────────────

  allowRequest(service: ServiceName, priority: Priority = "MEDIUM"): BudgetCheck {
    const now = Date.now();
    const limits = this.cfg.limits[service];

    // Check in-memory pause
    const pausedUntil = this.pauses.get(service) ?? 0;
    if (now < pausedUntil) {
      return this.deny(
        service,
        limits,
        `service paused for ${Math.ceil((pausedUntil - now) / 1000)}s after rate-limit`,
      );
    }

    // Current window starts
    const minStart = Math.floor(now / MS_MIN) * MS_MIN;
    const hourStart = Math.floor(now / MS_HOUR) * MS_HOUR;
    const dayStart = Math.floor(now / MS_DAY) * MS_DAY;

    const minUsed = this.getWindowCount(service, "minute", minStart);
    const hourUsed = this.getWindowCount(service, "hour", hourStart);
    const dayUsed = this.getWindowCount(service, "day", dayStart);

    const dayPct = limits.perDay > 0 ? (dayUsed / limits.perDay) * 100 : 100;
    const remaining = {
      minute: Math.max(0, limits.perMinute - minUsed),
      hour: Math.max(0, limits.perHour - hourUsed),
      day: Math.max(0, limits.perDay - dayUsed),
    };

    const base: Omit<BudgetCheck, "allowed" | "reason"> = {
      dayUsagePct: dayPct,
      remainingDay: remaining.day,
      remainingHour: remaining.hour,
      remainingMinute: remaining.minute,
    };

    // Hard minute limit — applies to all priorities (prevents 429 bursts)
    if (minUsed >= limits.perMinute) {
      return { ...base, allowed: false, reason: `minute limit reached (${minUsed}/${limits.perMinute})` };
    }

    // Hard hour limit
    if (hourUsed >= limits.perHour) {
      return { ...base, allowed: false, reason: `hour limit reached (${hourUsed}/${limits.perHour})` };
    }

    // Daily kill switch — tiered by priority
    if (dayPct >= 100) {
      return { ...base, allowed: false, reason: `daily budget exhausted (${dayUsed}/${limits.perDay})` };
    }
    if (dayPct >= this.cfg.emergencyPct && (priority === "MEDIUM" || priority === "LOW")) {
      return { ...base, allowed: false, reason: `emergency threshold ${this.cfg.emergencyPct}% reached — only CRITICAL/HIGH allowed` };
    }
    if (dayPct >= this.cfg.pausePct && priority === "LOW") {
      return { ...base, allowed: false, reason: `pause threshold ${this.cfg.pausePct}% reached — LOW priority blocked` };
    }

    // Warn log (throttled to once per hour per service)
    if (dayPct >= this.cfg.warnPct) {
      const lastWarn = this.lastWarnLogged.get(service) ?? 0;
      if (now - lastWarn > MS_HOUR) {
        this.lastWarnLogged.set(service, now);
        logger.warn("budget: approaching daily limit", { service, dayUsed, limit: limits.perDay, pct: dayPct.toFixed(1) });
      }
    }

    return { ...base, allowed: true, reason: "ok" };
  }

  // ── Recording ───────────────────────────────────────────────────────────────

  recordRequest(service: ServiceName, endpoint: string, opts: RecordOpts = {}): void {
    const now = Date.now();
    const minStart = Math.floor(now / MS_MIN) * MS_MIN;
    const hourStart = Math.floor(now / MS_HOUR) * MS_HOUR;
    const dayStart = Math.floor(now / MS_DAY) * MS_DAY;

    // Increment usage counters for all three windows atomically
    this.upsertUsage(service, "minute", minStart, now);
    this.upsertUsage(service, "hour", hourStart, now);
    this.upsertUsage(service, "day", dayStart, now);

    // Log to api_request_log: always log errors/cache-misses; sample successes
    const isError = opts.statusCode !== undefined && opts.statusCode !== null && opts.statusCode >= 400;
    const isCacheHit = opts.cacheHit === true;
    const shouldLog = isError || (!isCacheHit && (this.recordCallCount % LOG_SAMPLE_RATE === 0));

    if (shouldLog) {
      this.insertLog(service, endpoint, opts, now);
    }

    this.recordCallCount += 1;
    if (this.recordCallCount % LOG_PRUNE_EVERY === 0) {
      this.pruneLog();
    }
  }

  recordRateLimit(service: ServiceName, endpoint = "unknown"): void {
    const now = Date.now();
    const minStart = Math.floor(now / MS_MIN) * MS_MIN;
    const hourStart = Math.floor(now / MS_HOUR) * MS_HOUR;
    const dayStart = Math.floor(now / MS_DAY) * MS_DAY;

    this.upsertRateLimitCount(service, "minute", minStart, now);
    this.upsertRateLimitCount(service, "hour", hourStart, now);
    this.upsertRateLimitCount(service, "day", dayStart, now);

    // Always log rate limit events
    this.insertLog(service, endpoint, { statusCode: 429, reason: "rate-limit recorded" }, now);

    // Apply exponential pause: base 30s, doubles per event in the last hour, max 10 min
    const hourEvents = this.getWindowRateLimits(service, "hour", hourStart);
    const pauseMs = Math.min(10 * 60 * 1000, 30_000 * Math.pow(2, Math.max(0, hourEvents - 1)));
    this.pauses.set(service, now + pauseMs);

    logger.warn("budget: rate limit recorded — service paused", {
      service,
      endpoint,
      pauseSec: Math.ceil(pauseMs / 1000),
      rateLimitEventsThisHour: hourEvents,
    });
  }

  getRemainingBudget(service: ServiceName): RemainingBudget {
    const now = Date.now();
    const limits = this.cfg.limits[service];
    const minStart = Math.floor(now / MS_MIN) * MS_MIN;
    const hourStart = Math.floor(now / MS_HOUR) * MS_HOUR;
    const dayStart = Math.floor(now / MS_DAY) * MS_DAY;

    const minUsed = this.getWindowCount(service, "minute", minStart);
    const hourUsed = this.getWindowCount(service, "hour", hourStart);
    const dayUsed = this.getWindowCount(service, "day", dayStart);
    const rateLimitEventsToday = this.getWindowRateLimits(service, "day", dayStart);

    const dayUsagePct = limits.perDay > 0 ? (dayUsed / limits.perDay) * 100 : 0;
    const pausedUntil = this.pauses.get(service) ?? null;

    return {
      service,
      minute: { used: minUsed, limit: limits.perMinute, remaining: Math.max(0, limits.perMinute - minUsed) },
      hour: { used: hourUsed, limit: limits.perHour, remaining: Math.max(0, limits.perHour - hourUsed) },
      day: { used: dayUsed, limit: limits.perDay, remaining: Math.max(0, limits.perDay - dayUsed) },
      dayUsagePct,
      rateLimitEventsToday,
      pausedUntil: pausedUntil !== null && Date.now() < pausedUntil ? pausedUntil : null,
    };
  }

  shouldPause(service: ServiceName): boolean {
    const pausedUntil = this.pauses.get(service) ?? 0;
    return Date.now() < pausedUntil;
  }

  pauseService(service: ServiceName, durationMs: number, reason: string): void {
    this.pauses.set(service, Date.now() + durationMs);
    logger.warn("budget: service manually paused", { service, durationMs, reason });
  }

  // ── Signature deduplication ─────────────────────────────────────────────────

  hasProcessedSignature(signature: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS x FROM processed_signatures WHERE signature = ? LIMIT 1")
      .get(signature) as { x: number } | undefined;
    return Boolean(row);
  }

  markSignatureProcessed(signature: string, resultKind?: string): void {
    const now = Date.now();
    this.db
      .prepare(
        "INSERT OR IGNORE INTO processed_signatures (signature, processed_at, result_kind) VALUES (?, ?, ?)",
      )
      .run(signature, now, resultKind ?? null);

    this.sigMarkCount += 1;
    if (this.sigMarkCount % SIG_PRUNE_EVERY === 0) {
      this.pruneSignatures();
    }
  }

  // ── Token enrichment cache ──────────────────────────────────────────────────

  getEnrichmentCache(mint: string): EnrichmentCacheEntry | null {
    const row = this.db
      .prepare("SELECT * FROM token_enrichment_cache WHERE mint = ?")
      .get(mint) as EnrichmentCacheRow | undefined;
    if (!row) return null;
    if (Date.now() > row.fetched_at + row.ttl_ms) return null; // expired
    return {
      mint: row.mint,
      name: row.name,
      symbol: row.symbol,
      marketCapUsd: row.market_cap_usd,
      bondingCurveProgress: row.bonding_curve_progress,
      buyCount: row.buy_count,
      sellCount: row.sell_count,
      volumeUsd: row.volume_usd,
      socialLinksJson: row.social_links_json,
      fetchedAt: row.fetched_at,
    };
  }

  saveEnrichmentCache(
    mint: string,
    data: Omit<EnrichmentCacheEntry, "mint" | "fetchedAt">,
    ttlMs: number,
  ): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO token_enrichment_cache
          (mint, name, symbol, market_cap_usd, bonding_curve_progress,
           buy_count, sell_count, volume_usd, social_links_json, fetched_at, ttl_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(mint) DO UPDATE SET
           name = excluded.name,
           symbol = excluded.symbol,
           market_cap_usd = excluded.market_cap_usd,
           bonding_curve_progress = excluded.bonding_curve_progress,
           buy_count = excluded.buy_count,
           sell_count = excluded.sell_count,
           volume_usd = excluded.volume_usd,
           social_links_json = excluded.social_links_json,
           fetched_at = excluded.fetched_at,
           ttl_ms = excluded.ttl_ms`,
      )
      .run(
        mint,
        data.name ?? null,
        data.symbol ?? null,
        data.marketCapUsd ?? null,
        data.bondingCurveProgress ?? null,
        data.buyCount ?? null,
        data.sellCount ?? null,
        data.volumeUsd ?? null,
        data.socialLinksJson ?? null,
        now,
        ttlMs,
      );
  }

  // ── Internal helpers ────────────────────────────────────────────────────────

  private getWindowCount(service: ServiceName, window: string, start: number): number {
    const row = this.db
      .prepare(
        "SELECT request_count FROM api_request_usage WHERE service = ? AND window_type = ? AND window_start = ?",
      )
      .get(service, window, start) as UsageRow | undefined;
    return row?.request_count ?? 0;
  }

  private getWindowRateLimits(service: ServiceName, window: string, start: number): number {
    const row = this.db
      .prepare(
        "SELECT rate_limit_count FROM api_request_usage WHERE service = ? AND window_type = ? AND window_start = ?",
      )
      .get(service, window, start) as UsageRow | undefined;
    return row?.rate_limit_count ?? 0;
  }

  private upsertUsage(service: ServiceName, window: string, start: number, now: number): void {
    this.db
      .prepare(
        `INSERT INTO api_request_usage
           (service, window_type, window_start, request_count, rate_limit_count, created_at, updated_at)
         VALUES (?, ?, ?, 1, 0, ?, ?)
         ON CONFLICT(service, window_type, window_start) DO UPDATE SET
           request_count = request_count + 1,
           updated_at = excluded.updated_at`,
      )
      .run(service, window, start, now, now);
  }

  private upsertRateLimitCount(service: ServiceName, window: string, start: number, now: number): void {
    this.db
      .prepare(
        `INSERT INTO api_request_usage
           (service, window_type, window_start, request_count, rate_limit_count, created_at, updated_at)
         VALUES (?, ?, ?, 0, 1, ?, ?)
         ON CONFLICT(service, window_type, window_start) DO UPDATE SET
           rate_limit_count = rate_limit_count + 1,
           updated_at = excluded.updated_at`,
      )
      .run(service, window, start, now, now);
  }

  private insertLog(service: ServiceName, endpoint: string, opts: RecordOpts, now: number): void {
    this.db
      .prepare(
        `INSERT INTO api_request_log
           (service, endpoint, method, status_code, cache_hit, requested_at, reason, related_mint, related_signature)
         VALUES (?, ?, 'GET', ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        service,
        endpoint,
        opts.statusCode ?? null,
        opts.cacheHit ? 1 : 0,
        now,
        opts.reason ?? null,
        opts.relatedMint ?? null,
        opts.relatedSignature ?? null,
      );
  }

  private pruneLog(): void {
    const count = (
      this.db.prepare("SELECT COUNT(*) AS n FROM api_request_log").get() as { n: number }
    ).n;
    if (count > LOG_MAX_ROWS) {
      this.db
        .prepare(
          `DELETE FROM api_request_log WHERE id IN (
            SELECT id FROM api_request_log ORDER BY id ASC LIMIT ?
          )`,
        )
        .run(count - LOG_PRUNE_TARGET);
    }
  }

  private pruneSignatures(): void {
    const cutoff = Date.now() - SIG_RETENTION_MS;
    this.db
      .prepare("DELETE FROM processed_signatures WHERE processed_at < ?")
      .run(cutoff);
  }

  private deny(
    service: ServiceName,
    limits: ServiceLimits,
    reason: string,
  ): BudgetCheck {
    return {
      allowed: false,
      reason,
      dayUsagePct: 0,
      remainingDay: limits.perDay,
      remainingHour: limits.perHour,
      remainingMinute: limits.perMinute,
    };
  }
}

// ── Module-level singleton ────────────────────────────────────────────────────

let instance: RequestBudgetManager | null = null;

export function getRequestBudgetManager(): RequestBudgetManager {
  if (!instance) {
    throw new Error(
      "RequestBudgetManager not initialized. Call initRequestBudgetManager() first.",
    );
  }
  return instance;
}

export function initRequestBudgetManager(cfg: BudgetManagerConfig): RequestBudgetManager {
  instance = new RequestBudgetManager(cfg);
  return instance;
}
