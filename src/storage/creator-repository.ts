import type Database from "better-sqlite3";
import { getDatabase } from "./database";
import {
  CombinedTokenEvaluation,
  CreatorLaunchHistory,
  CreatorProfile,
  CreatorRepository,
  CreatorScore,
  RiskLevel,
} from "../types";

interface CreatorRow {
  creator_wallet: string;
  first_seen_at: number;
  last_seen_at: number;
  total_launches: number;
  notes: string | null;
}

interface HistoryRow {
  creator_wallet: string;
  mint: string;
  symbol: string;
  launched_at: number;
  initial_market_cap_usd: number;
  peak_market_cap_usd: number | null;
  max_gain_multiple: number | null;
  time_to_peak_minutes: number | null;
  ended_badly: number | null;
  rug_like: number | null;
}

interface CreatorScoreRow {
  creator_wallet: string;
  total_score: number;
  risk_level: string;
  success_rate_score: number;
  consistency_score: number;
  rug_risk_score: number;
  activity_score: number;
  confidence_score: number;
  reasons_json: string;
  scored_at: number;
}

interface CombinedEvalRow {
  mint: string;
  symbol: string;
  token_score: number;
  creator_score: number;
  combined_score: number;
  combined_risk_level: string;
  reasons_json: string;
  evaluated_at: number;
}

function parseStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

function rowToProfile(row: CreatorRow): CreatorProfile {
  return {
    creatorWallet: row.creator_wallet,
    firstSeenAt: new Date(row.first_seen_at),
    lastSeenAt: new Date(row.last_seen_at),
    totalLaunches: row.total_launches,
    notes: row.notes ?? undefined,
  };
}

function rowToHistory(row: HistoryRow): CreatorLaunchHistory {
  return {
    creatorWallet: row.creator_wallet,
    mint: row.mint,
    symbol: row.symbol,
    launchedAt: new Date(row.launched_at),
    initialMarketCapUsd: row.initial_market_cap_usd,
    peakMarketCapUsd: row.peak_market_cap_usd ?? undefined,
    maxGainMultiple: row.max_gain_multiple ?? undefined,
    timeToPeakMinutes: row.time_to_peak_minutes ?? undefined,
    endedBadly: row.ended_badly === null ? undefined : row.ended_badly === 1,
    rugLike: row.rug_like === null ? undefined : row.rug_like === 1,
  };
}

function rowToCreatorScore(row: CreatorScoreRow): CreatorScore {
  return {
    creatorWallet: row.creator_wallet,
    totalScore: row.total_score,
    riskLevel: row.risk_level as RiskLevel,
    successRateScore: row.success_rate_score,
    consistencyScore: row.consistency_score,
    rugRiskScore: row.rug_risk_score,
    activityScore: row.activity_score,
    confidenceScore: row.confidence_score,
    reasons: parseStringArray(row.reasons_json),
    scoredAt: new Date(row.scored_at),
  };
}

function rowToCombinedEval(row: CombinedEvalRow): CombinedTokenEvaluation {
  return {
    mint: row.mint,
    symbol: row.symbol,
    tokenScore: row.token_score,
    creatorScore: row.creator_score,
    combinedScore: row.combined_score,
    combinedRiskLevel: row.combined_risk_level as RiskLevel,
    reasons: parseStringArray(row.reasons_json),
    evaluatedAt: new Date(row.evaluated_at),
  };
}

function boolToInt(v: boolean | undefined): number | null {
  if (v === undefined) return null;
  return v ? 1 : 0;
}

export class SqliteCreatorRepository implements CreatorRepository {
  private readonly db: Database.Database;

  constructor(db?: Database.Database) {
    this.db = db ?? getDatabase();
  }

  async upsertCreatorProfile(profile: CreatorProfile): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO creators (
          creator_wallet, first_seen_at, last_seen_at, total_launches, notes
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(creator_wallet) DO UPDATE SET
          first_seen_at = MIN(creators.first_seen_at, excluded.first_seen_at),
          last_seen_at = MAX(creators.last_seen_at, excluded.last_seen_at),
          total_launches = excluded.total_launches,
          notes = COALESCE(excluded.notes, creators.notes)`,
      )
      .run(
        profile.creatorWallet,
        profile.firstSeenAt.getTime(),
        profile.lastSeenAt.getTime(),
        profile.totalLaunches,
        profile.notes ?? null,
      );
  }

  async findCreatorProfile(creatorWallet: string): Promise<CreatorProfile | null> {
    const row = this.db
      .prepare("SELECT * FROM creators WHERE creator_wallet = ?")
      .get(creatorWallet) as CreatorRow | undefined;
    return row ? rowToProfile(row) : null;
  }

  async saveCreatorLaunchHistory(history: CreatorLaunchHistory): Promise<void> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO creator_launch_history (
          creator_wallet, mint, symbol, launched_at,
          initial_market_cap_usd, peak_market_cap_usd, max_gain_multiple,
          time_to_peak_minutes, ended_badly, rug_like
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        history.creatorWallet,
        history.mint,
        history.symbol,
        history.launchedAt.getTime(),
        history.initialMarketCapUsd,
        history.peakMarketCapUsd ?? null,
        history.maxGainMultiple ?? null,
        history.timeToPeakMinutes ?? null,
        boolToInt(history.endedBadly),
        boolToInt(history.rugLike),
      );
  }

  async listLaunchHistoryByCreator(creatorWallet: string): Promise<CreatorLaunchHistory[]> {
    const rows = this.db
      .prepare(
        "SELECT * FROM creator_launch_history WHERE creator_wallet = ? ORDER BY launched_at ASC",
      )
      .all(creatorWallet) as HistoryRow[];
    return rows.map(rowToHistory);
  }

  async saveCreatorScore(score: CreatorScore): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO creator_scores (
          creator_wallet, total_score, risk_level,
          success_rate_score, consistency_score, rug_risk_score,
          activity_score, confidence_score, reasons_json, scored_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(creator_wallet) DO UPDATE SET
          total_score = excluded.total_score,
          risk_level = excluded.risk_level,
          success_rate_score = excluded.success_rate_score,
          consistency_score = excluded.consistency_score,
          rug_risk_score = excluded.rug_risk_score,
          activity_score = excluded.activity_score,
          confidence_score = excluded.confidence_score,
          reasons_json = excluded.reasons_json,
          scored_at = excluded.scored_at`,
      )
      .run(
        score.creatorWallet,
        score.totalScore,
        score.riskLevel,
        score.successRateScore,
        score.consistencyScore,
        score.rugRiskScore,
        score.activityScore,
        score.confidenceScore,
        JSON.stringify(score.reasons),
        score.scoredAt.getTime(),
      );
  }

  async getCreatorScore(creatorWallet: string): Promise<CreatorScore | null> {
    const row = this.db
      .prepare("SELECT * FROM creator_scores WHERE creator_wallet = ?")
      .get(creatorWallet) as CreatorScoreRow | undefined;
    return row ? rowToCreatorScore(row) : null;
  }

  async saveCombinedEvaluation(evaluation: CombinedTokenEvaluation): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO combined_token_evaluations (
          mint, symbol, token_score, creator_score,
          combined_score, combined_risk_level, reasons_json, evaluated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(mint) DO UPDATE SET
          symbol = excluded.symbol,
          token_score = excluded.token_score,
          creator_score = excluded.creator_score,
          combined_score = excluded.combined_score,
          combined_risk_level = excluded.combined_risk_level,
          reasons_json = excluded.reasons_json,
          evaluated_at = excluded.evaluated_at`,
      )
      .run(
        evaluation.mint,
        evaluation.symbol,
        evaluation.tokenScore,
        evaluation.creatorScore,
        evaluation.combinedScore,
        evaluation.combinedRiskLevel,
        JSON.stringify(evaluation.reasons),
        evaluation.evaluatedAt.getTime(),
      );
  }

  async getCombinedEvaluation(mint: string): Promise<CombinedTokenEvaluation | null> {
    const row = this.db
      .prepare("SELECT * FROM combined_token_evaluations WHERE mint = ?")
      .get(mint) as CombinedEvalRow | undefined;
    return row ? rowToCombinedEval(row) : null;
  }
}
