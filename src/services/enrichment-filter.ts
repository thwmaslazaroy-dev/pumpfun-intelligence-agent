/**
 * EnrichmentFilter
 *
 * A lightweight pre-enrichment gate that decides — using only SQLite data
 * already on disk — whether a newly detected token is worth enriching via the
 * pump.fun API. Every rule is answered by a single indexed lookup; no external
 * calls are made.
 *
 * Rules (applied in order, first match wins):
 *
 *   Rule A — Unknown creator: creator has no row in creator_scores.
 *     Action: skip enrichment for most; sample at `unknownSamplePct`% to
 *     gradually build history for new wallets.
 *
 *   Rule B — Low creator score: creator_scores.total_score < SCORE_THRESHOLD (50).
 *     Rationale: combined score can never reach the 80-point opportunity threshold
 *     when creator score is below 50, regardless of token quality.
 *
 *   Rule C — High-frequency bot: total_launches >= 10 and last launch was
 *     within the last 3 hours. Serial launchers at this cadence are bots.
 *
 *   Pass — All rules missed; enrichment proceeds.
 */

import type Database from "better-sqlite3";
import { getDatabase } from "../storage/database";
import { logger } from "../utils/logger";

// ── Tuning constants ──────────────────────────────────────────────────────────

/** Rule B threshold. Keep in sync with combined-scoring-service analysis. */
const SCORE_THRESHOLD = 50;

/** Rule C: minimum lifetime launches to trigger bot check. */
const HIGH_FREQ_MIN_LAUNCHES = 10;

/** Rule C: window within which a recent launch makes the creator a bot candidate. */
const HIGH_FREQ_WINDOW_MS = 10_800_000; // 3 hours

// ── Public types ──────────────────────────────────────────────────────────────

export type FilterRule = "A_skip" | "A_sample" | "B" | "C" | "D" | "pass";

export interface FilterResult {
  shouldEnrich: boolean;
  rule: FilterRule;
  reason: string;
}

/**
 * Delta counters for one ingestion batch.
 * Persisted to enrichment_filter_stats at the end of each runOnce() call.
 */
export interface FilterCounterDelta {
  filteredByRuleA: number;
  filteredByRuleB: number;
  filteredByRuleC: number;
  filteredByRuleD: number;
  sampledUnknownCreators: number;
  enrichmentsPerformed: number;
}

/**
 * Enrichment outcome metrics for one ingestion batch.
 * Persisted to enrichment_metrics at the end of each runOnce() call.
 */
export interface EnrichmentMetricsDelta {
  successfulEnrichments: number;
  mintMismatches: number;
  enrichmentRetries: number;
}

// ── Internal DB row type ──────────────────────────────────────────────────────

interface CreatorLookupRow {
  total_launches: number;
  last_seen_at: number;
  total_score: number | null;
}

// ── EnrichmentFilter ──────────────────────────────────────────────────────────

export class EnrichmentFilter {
  private readonly db: Database.Database;
  private readonly unknownSamplePct: number;

  constructor(unknownSamplePct: number, db?: Database.Database) {
    this.db = db ?? getDatabase();
    this.unknownSamplePct = Math.max(0, Math.min(100, unknownSamplePct));
  }

  /**
   * Decide whether a token should be enriched.
   *
   * @param creatorWallet  Wallet address extracted from the on-chain transaction.
   * @param nowMs          Current wall-clock time in milliseconds.
   */
  evaluate(creatorWallet: string, nowMs: number): FilterResult {
    const row = this.db
      .prepare(
        `SELECT c.total_launches, c.last_seen_at, cs.total_score
         FROM creators c
         LEFT JOIN creator_scores cs ON cs.creator_wallet = c.creator_wallet
         WHERE c.creator_wallet = ?`,
      )
      .get(creatorWallet) as CreatorLookupRow | undefined;

    // ── Rule A: unknown creator ───────────────────────────────────────────────
    if (!row || row.total_score === null) {
      const sampled = Math.random() * 100 < this.unknownSamplePct;

      if (sampled) {
        logger.debug("enrichment filter: sampled_unknown_creator", {
          creator: shortWallet(creatorWallet),
          samplePct: this.unknownSamplePct,
          hasCreatorRow: Boolean(row),
          hasScore: false,
        });
        return {
          shouldEnrich: true,
          rule: "A_sample",
          reason: `unknown creator — sampled at ${this.unknownSamplePct}%`,
        };
      }

      logger.debug("enrichment filter: skipped_unknown_creator", {
        creator: shortWallet(creatorWallet),
        samplePct: this.unknownSamplePct,
        hasCreatorRow: Boolean(row),
        hasScore: false,
      });
      return {
        shouldEnrich: false,
        rule: "A_skip",
        reason: `unknown creator — not in sample (${this.unknownSamplePct}% chance)`,
      };
    }

    // ── Rule B: score below opportunity threshold ─────────────────────────────
    if (row.total_score < SCORE_THRESHOLD) {
      logger.debug("enrichment filter: skipped_low_creator_score", {
        creator: shortWallet(creatorWallet),
        score: row.total_score,
        threshold: SCORE_THRESHOLD,
      });
      return {
        shouldEnrich: false,
        rule: "B",
        reason: `creator score ${row.total_score.toFixed(1)} < threshold ${SCORE_THRESHOLD}`,
      };
    }

    // ── Rule C: high-frequency bot pattern ────────────────────────────────────
    const msSinceLast = nowMs - row.last_seen_at;
    if (
      row.total_launches >= HIGH_FREQ_MIN_LAUNCHES &&
      msSinceLast < HIGH_FREQ_WINDOW_MS
    ) {
      const minsSinceLast = Math.round(msSinceLast / 60_000);
      logger.debug("enrichment filter: skipped_high_frequency_creator", {
        creator: shortWallet(creatorWallet),
        totalLaunches: row.total_launches,
        minsSinceLastLaunch: minsSinceLast,
        windowHours: HIGH_FREQ_WINDOW_MS / 3_600_000,
      });
      return {
        shouldEnrich: false,
        rule: "C",
        reason: `high-frequency: ${row.total_launches} lifetime launches, last ${minsSinceLast}min ago`,
      };
    }

    // ── Pass ──────────────────────────────────────────────────────────────────
    logger.debug("enrichment filter: passed_filter", {
      creator: shortWallet(creatorWallet),
      score: row.total_score,
      totalLaunches: row.total_launches,
    });
    return {
      shouldEnrich: true,
      rule: "pass",
      reason: `score ${row.total_score.toFixed(1)} >= ${SCORE_THRESHOLD}, no bot pattern`,
    };
  }

  /**
   * Atomically add a batch's counter delta to today's row in enrichment_filter_stats.
   * Safe to call after every runOnce() regardless of whether any tokens were processed.
   */
  persistCounterDelta(delta: FilterCounterDelta): void {
    if (
      delta.filteredByRuleA === 0 &&
      delta.filteredByRuleB === 0 &&
      delta.filteredByRuleC === 0 &&
      delta.filteredByRuleD === 0 &&
      delta.sampledUnknownCreators === 0 &&
      delta.enrichmentsPerformed === 0
    ) {
      return; // nothing to write
    }

    const now = Date.now();
    const dayStart = Math.floor(now / 86_400_000) * 86_400_000;

    this.db
      .prepare(
        `INSERT INTO enrichment_filter_stats
           (day_start, filtered_by_rule_a, filtered_by_rule_b, filtered_by_rule_c,
            filtered_by_rule_d, sampled_unknown_creators, enrichments_performed, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(day_start) DO UPDATE SET
           filtered_by_rule_a       = filtered_by_rule_a       + excluded.filtered_by_rule_a,
           filtered_by_rule_b       = filtered_by_rule_b       + excluded.filtered_by_rule_b,
           filtered_by_rule_c       = filtered_by_rule_c       + excluded.filtered_by_rule_c,
           filtered_by_rule_d       = filtered_by_rule_d       + excluded.filtered_by_rule_d,
           sampled_unknown_creators = sampled_unknown_creators + excluded.sampled_unknown_creators,
           enrichments_performed    = enrichments_performed    + excluded.enrichments_performed,
           updated_at               = excluded.updated_at`,
      )
      .run(
        dayStart,
        delta.filteredByRuleA,
        delta.filteredByRuleB,
        delta.filteredByRuleC,
        delta.filteredByRuleD,
        delta.sampledUnknownCreators,
        delta.enrichmentsPerformed,
        now,
      );
  }
  /**
   * Atomically add enrichment outcome metrics to today's row in enrichment_metrics.
   * Safe to call after every runOnce() regardless of whether any tokens were processed.
   */
  persistEnrichmentMetrics(delta: EnrichmentMetricsDelta): void {
    if (
      delta.successfulEnrichments === 0 &&
      delta.mintMismatches === 0 &&
      delta.enrichmentRetries === 0
    ) {
      return;
    }

    const now = Date.now();
    const dayStart = Math.floor(now / 86_400_000) * 86_400_000;

    this.db
      .prepare(
        `INSERT INTO enrichment_metrics
           (day_start, successful_enrichments, mint_mismatches, enrichment_retries, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(day_start) DO UPDATE SET
           successful_enrichments = successful_enrichments + excluded.successful_enrichments,
           mint_mismatches        = mint_mismatches        + excluded.mint_mismatches,
           enrichment_retries     = enrichment_retries     + excluded.enrichment_retries,
           updated_at             = excluded.updated_at`,
      )
      .run(
        dayStart,
        delta.successfulEnrichments,
        delta.mintMismatches,
        delta.enrichmentRetries,
        now,
      );
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function shortWallet(wallet: string): string {
  return wallet.length > 12 ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : wallet;
}

// ── normalizeTokenName ────────────────────────────────────────────────────────

const ZERO_WIDTH_RE =
  /[​-‍﻿­͏ᅟᅠ឴឵ㅤﾠ]/g;

const UNKNOWN_SENTINELS = new Set(["unknown", ""]);

/**
 * Normalize a token name for duplicate detection.
 *  - Removes zero-width / invisible characters
 *  - Trims leading/trailing whitespace
 *  - Lowercases
 *  - Collapses internal repeated whitespace to a single space
 *
 * Returns null when the name is empty, whitespace-only, or a known
 * "Unknown" / "UNKNOWN" sentinel so callers can skip the duplicate check.
 */
export function normalizeTokenName(name: string): string | null {
  if (!name) return null;
  let n = name.replace(ZERO_WIDTH_RE, "").trim().toLowerCase().replace(/\s+/g, " ");
  if (!n || UNKNOWN_SENTINELS.has(n)) return null;
  return n;
}
