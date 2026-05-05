import {
  AlertType,
  CombinedTokenEvaluation,
  CreatorScore,
  RiskLevel,
  TokenLaunch,
  TokenScore,
} from "../types";

export interface AlertPolicyConfig {
  minCombinedAlertScore: number;
  alertCombinedRiskLevels: RiskLevel[];
  alertExtremeRiskEnabled: boolean;
}

export interface AlertContext {
  token: TokenLaunch;
  tokenScore: TokenScore;
  creatorScore: CreatorScore;
  combined: CombinedTokenEvaluation;
}

export interface AlertDecision {
  alertType: AlertType;
  context: AlertContext;
  reason: string;
}

export class AlertPolicy {
  constructor(private readonly cfg: AlertPolicyConfig) {}

  evaluate(ctx: AlertContext): AlertDecision | null {
    if (this.cfg.alertExtremeRiskEnabled && ctx.combined.combinedRiskLevel === "EXTREME") {
      return {
        alertType: "warning",
        context: ctx,
        reason: `combined risk EXTREME (combinedScore=${ctx.combined.combinedScore})`,
      };
    }

    if (
      ctx.combined.combinedScore >= this.cfg.minCombinedAlertScore &&
      this.cfg.alertCombinedRiskLevels.includes(ctx.combined.combinedRiskLevel)
    ) {
      return {
        alertType: "opportunity",
        context: ctx,
        reason: `combinedScore ${ctx.combined.combinedScore} >= ${this.cfg.minCombinedAlertScore} and risk ${ctx.combined.combinedRiskLevel} in [${this.cfg.alertCombinedRiskLevels.join(",")}]`,
      };
    }

    return null;
  }
}
