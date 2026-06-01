import {
  AlertType,
  CombinedTokenEvaluation,
  CreatorScore,
  RiskLevel,
  TokenLaunch,
  TokenScore,
} from "../types";

export interface AlertPolicyConfig {
  // ── Legacy fields (kept for backward compat; new code uses tier fields below) ─
  minCombinedAlertScore: number;
  alertCombinedRiskLevels: RiskLevel[];
  alertExtremeRiskEnabled: boolean;

  // ── Tier: HIGH_PRIORITY ───────────────────────────────────────────────────────
  highPriorityAlertsEnabled: boolean;
  highPriorityMinTokenScore: number;
  highPriorityMinCombinedScore: number;
  highPriorityMinCreatorScore: number;

  // ── Tier: WATCH_ONLY ─────────────────────────────────────────────────────────
  watchOnlyAlertsEnabled: boolean;
  watchOnlyMinTokenScore: number;
  watchOnlyMinCombinedScore: number;
  watchOnlyMinCreatorScore: number;

  // ── Shared gate ───────────────────────────────────────────────────────────────
  alertMinMarketCapUsd: number;
}

export interface AlertContext {
  token: TokenLaunch;
  tokenScore: TokenScore;
  creatorScore: CreatorScore;
  combined: CombinedTokenEvaluation;
  /** True when the token was successfully enriched this ingestion cycle. */
  enriched: boolean;
}

export interface AlertDecision {
  alertType: AlertType;
  context: AlertContext;
  reason: string;
}

export class AlertPolicy {
  constructor(private readonly cfg: AlertPolicyConfig) {}

  evaluate(ctx: AlertContext): AlertDecision | null {
    const { token, tokenScore, creatorScore, combined } = ctx;

    // ── Legacy: EXTREME rug warning (disabled unless explicitly enabled) ─────────
    if (this.cfg.alertExtremeRiskEnabled && combined.combinedRiskLevel === "EXTREME") {
      return {
        alertType: "warning",
        context: ctx,
        reason: `combined risk EXTREME (combinedScore=${combined.combinedScore})`,
      };
    }

    // ── Both new tiers: require enrichment and minimum market cap ────────────────
    if (!ctx.enriched || token.initialMarketCapUsd < this.cfg.alertMinMarketCapUsd) {
      return null;
    }

    // Both tiers require LOW or MEDIUM combined risk
    if (combined.combinedRiskLevel === "HIGH" || combined.combinedRiskLevel === "EXTREME") {
      return null;
    }

    // ── Tier: HIGH_PRIORITY (checked first — higher bar) ─────────────────────────
    if (
      this.cfg.highPriorityAlertsEnabled &&
      tokenScore.totalScore >= this.cfg.highPriorityMinTokenScore &&
      combined.combinedScore >= this.cfg.highPriorityMinCombinedScore &&
      creatorScore.totalScore >= this.cfg.highPriorityMinCreatorScore
    ) {
      return {
        alertType: "HIGH_PRIORITY",
        context: ctx,
        reason: [
          `tokenScore=${tokenScore.totalScore}`,
          `combinedScore=${combined.combinedScore}`,
          `creatorScore=${creatorScore.totalScore}`,
          `marketCap=$${token.initialMarketCapUsd.toFixed(0)}`,
          `risk=${combined.combinedRiskLevel}`,
        ].join(" "),
      };
    }

    // ── Tier: WATCH_ONLY ─────────────────────────────────────────────────────────
    if (
      this.cfg.watchOnlyAlertsEnabled &&
      tokenScore.totalScore >= this.cfg.watchOnlyMinTokenScore &&
      combined.combinedScore >= this.cfg.watchOnlyMinCombinedScore &&
      creatorScore.totalScore >= this.cfg.watchOnlyMinCreatorScore
    ) {
      return {
        alertType: "WATCH_ONLY",
        context: ctx,
        reason: [
          `tokenScore=${tokenScore.totalScore}`,
          `combinedScore=${combined.combinedScore}`,
          `creatorScore=${creatorScore.totalScore}`,
          `marketCap=$${token.initialMarketCapUsd.toFixed(0)}`,
          `risk=${combined.combinedRiskLevel}`,
        ].join(" "),
      };
    }

    return null;
  }
}
