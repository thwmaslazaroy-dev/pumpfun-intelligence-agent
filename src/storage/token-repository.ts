import type Database from "better-sqlite3";
import { getDatabase } from "./database";
import {
  AlertType,
  RiskLevel,
  TokenAnalysis,
  TokenLaunch,
  TokenMarketSnapshot,
  TokenRepository,
  TokenRiskFlags,
  TokenScore,
  TokenSocialLinks,
} from "../types";

interface TokenRow {
  mint: string;
  name: string;
  symbol: string;
  creator_wallet: string;
  launched_at: number;
  initial_market_cap_usd: number;
  bonding_curve_progress: number;
  buy_count: number;
  sell_count: number;
  volume_usd: number;
  social_links_json: string | null;
}

interface RiskFlagsRow {
  mint: string;
  evaluated_at: number;
  missing_socials: number;
  high_churn: number;
  suspicious_volume_to_market_cap: number;
  early_bonding_curve_spike: number;
  low_activity: number;
  suspicious_creator: number;
  reasons_json: string;
}

interface TokenScoreRow {
  mint: string;
  total_score: number;
  risk_level: string;
  microstructure_score: number;
  social_score: number;
  anomaly_score: number;
  reasons_json: string;
  computed_at: number;
}

function rowToToken(row: TokenRow): TokenLaunch {
  let socialLinks: TokenSocialLinks | undefined;
  if (row.social_links_json) {
    try {
      socialLinks = JSON.parse(row.social_links_json) as TokenSocialLinks;
    } catch {
      socialLinks = undefined;
    }
  }
  return {
    mint: row.mint,
    name: row.name,
    symbol: row.symbol,
    creatorWallet: row.creator_wallet,
    launchedAt: new Date(row.launched_at),
    initialMarketCapUsd: row.initial_market_cap_usd,
    bondingCurveProgress: row.bonding_curve_progress,
    buyCount: row.buy_count,
    sellCount: row.sell_count,
    volumeUsd: row.volume_usd,
    socialLinks,
  };
}

function rowToFlags(row: RiskFlagsRow): TokenRiskFlags {
  let reasons: string[] = [];
  try {
    const parsed = JSON.parse(row.reasons_json);
    if (Array.isArray(parsed)) reasons = parsed.filter((s) => typeof s === "string");
  } catch {
    reasons = [];
  }
  return {
    mint: row.mint,
    evaluatedAt: new Date(row.evaluated_at),
    missingSocials: row.missing_socials === 1,
    highChurn: row.high_churn === 1,
    suspiciousVolumeToMarketCap: row.suspicious_volume_to_market_cap === 1,
    earlyBondingCurveSpike: row.early_bonding_curve_spike === 1,
    lowActivity: row.low_activity === 1,
    suspiciousCreator: row.suspicious_creator === 1,
    reasons,
  };
}

function rowToScore(row: TokenScoreRow): TokenScore {
  let reasons: string[] = [];
  try {
    const parsed = JSON.parse(row.reasons_json);
    if (Array.isArray(parsed)) reasons = parsed.filter((s) => typeof s === "string");
  } catch {
    reasons = [];
  }
  return {
    mint: row.mint,
    totalScore: row.total_score,
    riskLevel: row.risk_level as RiskLevel,
    microstructureScore: row.microstructure_score,
    socialScore: row.social_score,
    anomalyScore: row.anomaly_score,
    reasons,
    computedAt: new Date(row.computed_at),
  };
}

export class SqliteTokenRepository implements TokenRepository {
  private readonly db: Database.Database;

  constructor(db?: Database.Database) {
    this.db = db ?? getDatabase();
  }

  async saveTokenLaunch(token: TokenLaunch): Promise<void> {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO tokens (
          mint, name, symbol, creator_wallet, launched_at,
          initial_market_cap_usd, bonding_curve_progress,
          buy_count, sell_count, volume_usd,
          social_links_json, inserted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        token.mint,
        token.name,
        token.symbol,
        token.creatorWallet,
        token.launchedAt.getTime(),
        token.initialMarketCapUsd,
        token.bondingCurveProgress,
        token.buyCount,
        token.sellCount,
        token.volumeUsd,
        token.socialLinks ? JSON.stringify(token.socialLinks) : null,
        Date.now(),
      );
  }

  async findTokenByMint(mint: string): Promise<TokenLaunch | null> {
    const row = this.db
      .prepare("SELECT * FROM tokens WHERE mint = ?")
      .get(mint) as TokenRow | undefined;
    return row ? rowToToken(row) : null;
  }

  async saveMarketSnapshot(snapshot: TokenMarketSnapshot): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO market_snapshots (
          mint, captured_at, price_usd, market_cap_usd,
          bonding_curve_progress, buy_count, sell_count, volume_usd
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.mint,
        snapshot.capturedAt.getTime(),
        snapshot.priceUsd,
        snapshot.marketCapUsd,
        snapshot.bondingCurveProgress,
        snapshot.buyCount,
        snapshot.sellCount,
        snapshot.volumeUsd,
      );
  }

  async saveRiskFlags(mint: string, flags: TokenRiskFlags): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO risk_flags (
          mint, evaluated_at, missing_socials, high_churn,
          suspicious_volume_to_market_cap, early_bonding_curve_spike,
          low_activity, suspicious_creator, reasons_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(mint) DO UPDATE SET
          evaluated_at = excluded.evaluated_at,
          missing_socials = excluded.missing_socials,
          high_churn = excluded.high_churn,
          suspicious_volume_to_market_cap = excluded.suspicious_volume_to_market_cap,
          early_bonding_curve_spike = excluded.early_bonding_curve_spike,
          low_activity = excluded.low_activity,
          suspicious_creator = excluded.suspicious_creator,
          reasons_json = excluded.reasons_json`,
      )
      .run(
        mint,
        flags.evaluatedAt.getTime(),
        flags.missingSocials ? 1 : 0,
        flags.highChurn ? 1 : 0,
        flags.suspiciousVolumeToMarketCap ? 1 : 0,
        flags.earlyBondingCurveSpike ? 1 : 0,
        flags.lowActivity ? 1 : 0,
        flags.suspiciousCreator ? 1 : 0,
        JSON.stringify(flags.reasons),
      );
  }

  async saveTokenScore(score: TokenScore): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO token_scores (
          mint, total_score, risk_level,
          microstructure_score, social_score, anomaly_score,
          reasons_json, computed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(mint) DO UPDATE SET
          total_score = excluded.total_score,
          risk_level = excluded.risk_level,
          microstructure_score = excluded.microstructure_score,
          social_score = excluded.social_score,
          anomaly_score = excluded.anomaly_score,
          reasons_json = excluded.reasons_json,
          computed_at = excluded.computed_at`,
      )
      .run(
        score.mint,
        score.totalScore,
        score.riskLevel,
        score.microstructureScore,
        score.socialScore,
        score.anomalyScore,
        JSON.stringify(score.reasons),
        score.computedAt.getTime(),
      );
  }

  async getTokenAnalysis(mint: string): Promise<TokenAnalysis | null> {
    const tokenRow = this.db
      .prepare("SELECT * FROM tokens WHERE mint = ?")
      .get(mint) as TokenRow | undefined;
    if (!tokenRow) return null;

    const flagsRow = this.db
      .prepare("SELECT * FROM risk_flags WHERE mint = ?")
      .get(mint) as RiskFlagsRow | undefined;

    const scoreRow = this.db
      .prepare("SELECT * FROM token_scores WHERE mint = ?")
      .get(mint) as TokenScoreRow | undefined;

    return {
      token: rowToToken(tokenRow),
      flags: flagsRow ? rowToFlags(flagsRow) : null,
      score: scoreRow ? rowToScore(scoreRow) : null,
    };
  }

  async listRecentTokens(limit: number): Promise<TokenLaunch[]> {
    const rows = this.db
      .prepare("SELECT * FROM tokens ORDER BY launched_at DESC LIMIT ?")
      .all(limit) as TokenRow[];
    return rows.map(rowToToken);
  }

  async recordAlertSent(mint: string, alertType: AlertType, sentAt: Date): Promise<void> {
    this.db
      .prepare(
        "INSERT OR IGNORE INTO alerts (mint, alert_type, sent_at) VALUES (?, ?, ?)",
      )
      .run(mint, alertType, sentAt.getTime());
  }

  async hasAlertBeenSent(mint: string, alertType: AlertType): Promise<boolean> {
    const row = this.db
      .prepare(
        "SELECT 1 AS x FROM alerts WHERE mint = ? AND alert_type = ? LIMIT 1",
      )
      .get(mint, alertType) as { x: number } | undefined;
    return Boolean(row);
  }
}
