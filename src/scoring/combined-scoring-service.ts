import {
  CombinedTokenEvaluation,
  CreatorScore,
  RiskLevel,
  TokenLaunch,
  TokenScore,
} from "../types";

export interface CombinedScoringWeights {
  token: number;
  creator: number;
  unknownCreatorPenalty: number;
  unknownCreatorConfidenceThreshold: number;
  capWhenCreatorExtreme: number;
  capWhenTokenExtreme: number;
}

export const DEFAULT_COMBINED_SCORING_WEIGHTS: CombinedScoringWeights = {
  token: 0.6,
  creator: 0.4,
  unknownCreatorPenalty: 10,
  unknownCreatorConfidenceThreshold: 30,
  capWhenCreatorExtreme: 50,
  capWhenTokenExtreme: 45,
};

const clamp = (n: number): number => Math.max(0, Math.min(100, n));
const round1 = (n: number): number => Math.round(n * 10) / 10;

function levelFor(totalScore: number): RiskLevel {
  if (totalScore >= 80) return "LOW";
  if (totalScore >= 60) return "MEDIUM";
  if (totalScore >= 40) return "HIGH";
  return "EXTREME";
}

export class CombinedScoringService {
  constructor(
    private readonly weights: CombinedScoringWeights = DEFAULT_COMBINED_SCORING_WEIGHTS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  combine(
    token: TokenLaunch,
    tokenScore: TokenScore,
    creatorScore: CreatorScore,
  ): CombinedTokenEvaluation {
    const reasons: string[] = [];

    const base =
      this.weights.token * tokenScore.totalScore +
      this.weights.creator * creatorScore.totalScore;
    reasons.push(
      `base = ${this.weights.token}*${tokenScore.totalScore} (token) + ${this.weights.creator}*${creatorScore.totalScore} (creator) = ${base.toFixed(1)}`,
    );

    let combined = base;

    if (creatorScore.riskLevel === "EXTREME" && combined > this.weights.capWhenCreatorExtreme) {
      reasons.push(
        `cap: creator risk EXTREME → combined capped at ${this.weights.capWhenCreatorExtreme}`,
      );
      combined = this.weights.capWhenCreatorExtreme;
    }

    if (tokenScore.riskLevel === "EXTREME" && combined > this.weights.capWhenTokenExtreme) {
      reasons.push(
        `cap: token risk EXTREME → combined capped at ${this.weights.capWhenTokenExtreme}`,
      );
      combined = this.weights.capWhenTokenExtreme;
    }

    if (creatorScore.confidenceScore < this.weights.unknownCreatorConfidenceThreshold) {
      reasons.push(
        `confidence penalty: -${this.weights.unknownCreatorPenalty} (creator confidence ${creatorScore.confidenceScore} < ${this.weights.unknownCreatorConfidenceThreshold})`,
      );
      combined -= this.weights.unknownCreatorPenalty;
    }

    combined = clamp(combined);

    return {
      mint: token.mint,
      symbol: token.symbol,
      tokenScore: tokenScore.totalScore,
      creatorScore: creatorScore.totalScore,
      combinedScore: round1(combined),
      combinedRiskLevel: levelFor(combined),
      reasons,
      evaluatedAt: this.now(),
    };
  }
}
