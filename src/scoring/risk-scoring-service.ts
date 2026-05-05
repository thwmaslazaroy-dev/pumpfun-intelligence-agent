import { RiskLevel, TokenLaunch, TokenRiskFlags, TokenScore } from "../types";

export interface RiskScoringWeights {
  missingSocials: number;
  highChurn: number;
  suspiciousVolumeToMarketCap: number;
  earlyBondingCurveSpike: number;
  lowActivity: number;
  suspiciousCreator: number;
}

export const DEFAULT_RISK_SCORING_WEIGHTS: RiskScoringWeights = {
  missingSocials: 30,
  highChurn: 25,
  suspiciousVolumeToMarketCap: 35,
  earlyBondingCurveSpike: 20,
  lowActivity: 15,
  suspiciousCreator: 25,
};

const clamp01to100 = (n: number): number => Math.max(0, Math.min(100, n));
const round1 = (n: number): number => Math.round(n * 10) / 10;

function levelFor(totalScore: number): RiskLevel {
  if (totalScore >= 80) return "LOW";
  if (totalScore >= 60) return "MEDIUM";
  if (totalScore >= 40) return "HIGH";
  return "EXTREME";
}

export class RiskScoringService {
  constructor(
    private readonly weights: RiskScoringWeights = DEFAULT_RISK_SCORING_WEIGHTS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  score(token: TokenLaunch, flags: TokenRiskFlags): TokenScore {
    const reasons: string[] = [];

    let microPenalty = 0;
    if (flags.highChurn) {
      microPenalty += this.weights.highChurn;
      reasons.push(`-${this.weights.highChurn} microstructure: highChurn`);
    }
    if (flags.earlyBondingCurveSpike) {
      microPenalty += this.weights.earlyBondingCurveSpike;
      reasons.push(`-${this.weights.earlyBondingCurveSpike} microstructure: earlyBondingCurveSpike`);
    }
    if (flags.lowActivity) {
      microPenalty += this.weights.lowActivity;
      reasons.push(`-${this.weights.lowActivity} microstructure: lowActivity`);
    }

    let socialPenalty = 0;
    if (flags.missingSocials) {
      socialPenalty += this.weights.missingSocials;
      reasons.push(`-${this.weights.missingSocials} social: missingSocials`);
    }

    let anomalyPenalty = 0;
    if (flags.suspiciousVolumeToMarketCap) {
      anomalyPenalty += this.weights.suspiciousVolumeToMarketCap;
      reasons.push(
        `-${this.weights.suspiciousVolumeToMarketCap} anomaly: suspiciousVolumeToMarketCap`,
      );
    }
    if (flags.suspiciousCreator) {
      anomalyPenalty += this.weights.suspiciousCreator;
      reasons.push(`-${this.weights.suspiciousCreator} anomaly: suspiciousCreator`);
    }

    const microstructureScore = clamp01to100(100 - microPenalty);
    const socialScore = clamp01to100(100 - socialPenalty);
    const anomalyScore = clamp01to100(100 - anomalyPenalty);
    const totalScore = clamp01to100(100 - microPenalty - socialPenalty - anomalyPenalty);

    if (reasons.length === 0) {
      reasons.push("no risk flags fired");
    }

    return {
      mint: token.mint,
      totalScore: round1(totalScore),
      riskLevel: levelFor(totalScore),
      microstructureScore: round1(microstructureScore),
      socialScore: round1(socialScore),
      anomalyScore: round1(anomalyScore),
      reasons,
      computedAt: this.now(),
    };
  }
}
