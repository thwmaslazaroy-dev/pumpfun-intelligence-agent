import {
  CreatorLaunchHistory,
  CreatorPerformanceStats,
  CreatorProfile,
  CreatorScore,
  RiskLevel,
} from "../types";

export interface CreatorScoringWeights {
  successRate: number;
  consistency: number;
  rugRisk: number;
  activity: number;
  confidence: number;
}

export const DEFAULT_CREATOR_SCORING_WEIGHTS: CreatorScoringWeights = {
  successRate: 0.25,
  consistency: 0.2,
  rugRisk: 0.3,
  activity: 0.1,
  confidence: 0.15,
};

const SUCCESS_GAIN_THRESHOLD = 2;

const clamp = (n: number): number => Math.max(0, Math.min(100, n));
const round1 = (n: number): number => Math.round(n * 10) / 10;

function levelFor(totalScore: number): RiskLevel {
  if (totalScore >= 80) return "LOW";
  if (totalScore >= 60) return "MEDIUM";
  if (totalScore >= 40) return "HIGH";
  return "EXTREME";
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

export class CreatorScoringService {
  constructor(
    private readonly weights: CreatorScoringWeights = DEFAULT_CREATOR_SCORING_WEIGHTS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  calculatePerformanceStats(
    creatorWallet: string,
    history: CreatorLaunchHistory[],
  ): CreatorPerformanceStats {
    if (history.length === 0) {
      return {
        creatorWallet,
        totalLaunches: 0,
        successfulLaunches: 0,
        failedLaunches: 0,
        successRate: 0,
        averageMaxGain: 0,
        medianMaxGain: 0,
        rugLikeCount: 0,
      };
    }

    const gains = history
      .map((h) => h.maxGainMultiple ?? 0)
      .slice()
      .sort((a, b) => a - b);
    const sum = gains.reduce((s, g) => s + g, 0);
    const avg = sum / gains.length;
    const med = median(gains);

    const rugLikeCount = history.filter((h) => h.rugLike === true).length;

    const successful = history.filter(
      (h) =>
        h.rugLike !== true &&
        h.endedBadly !== true &&
        (h.maxGainMultiple ?? 0) >= SUCCESS_GAIN_THRESHOLD,
    ).length;
    const failed = history.length - successful;
    const successRate = successful / history.length;

    const peakTimes = history
      .map((h) => h.timeToPeakMinutes)
      .filter((t): t is number => typeof t === "number");
    const averageTimeToPeakMinutes =
      peakTimes.length > 0
        ? peakTimes.reduce((s, t) => s + t, 0) / peakTimes.length
        : undefined;

    return {
      creatorWallet,
      totalLaunches: history.length,
      successfulLaunches: successful,
      failedLaunches: failed,
      successRate,
      averageMaxGain: avg,
      medianMaxGain: med,
      rugLikeCount,
      averageTimeToPeakMinutes,
    };
  }

  score(profile: CreatorProfile, history: CreatorLaunchHistory[]): CreatorScore {
    const stats = this.calculatePerformanceStats(profile.creatorWallet, history);
    const reasons: string[] = [];
    const now = this.now();

    let successRateScore: number;
    let consistencyScore: number;
    let rugRiskScore: number;
    let activityScore: number;
    let confidenceScore: number;

    if (stats.totalLaunches === 0) {
      successRateScore = 50;
      consistencyScore = 50;
      rugRiskScore = 75;
      activityScore = 50;
      confidenceScore = 0;
      reasons.push(
        "creator has no on-chain launch history yet — score is provisional and confidencePenalty applies",
      );
    } else {
      successRateScore = clamp(stats.successRate * 100);
      reasons.push(
        `successRate=${(stats.successRate * 100).toFixed(0)}% (${stats.successfulLaunches}/${stats.totalLaunches} launches >= ${SUCCESS_GAIN_THRESHOLD}x with no rug/end-badly)`,
      );

      consistencyScore = clamp(50 + 25 * (stats.medianMaxGain - 1));
      reasons.push(
        `medianMaxGain=${stats.medianMaxGain.toFixed(2)}x, avgMaxGain=${stats.averageMaxGain.toFixed(2)}x`,
      );

      rugRiskScore = clamp(100 - stats.rugLikeCount * 30);
      if (stats.rugLikeCount > 0) {
        reasons.push(
          `rugRisk: ${stats.rugLikeCount} rug-like launches detected (-${stats.rugLikeCount * 30} from rugRiskScore)`,
        );
      }

      const daysSinceLast =
        (now.getTime() - profile.lastSeenAt.getTime()) / (24 * 60 * 60 * 1000);
      if (daysSinceLast <= 7) activityScore = 100;
      else if (daysSinceLast <= 30) activityScore = 80;
      else if (daysSinceLast <= 90) activityScore = 50;
      else activityScore = 30;
      reasons.push(`activity: ${daysSinceLast.toFixed(1)}d since last launch`);

      if (stats.totalLaunches >= 6) confidenceScore = 100;
      else if (stats.totalLaunches >= 3) confidenceScore = 70;
      else confidenceScore = 40;
      reasons.push(
        `confidence: ${stats.totalLaunches} historical launches → ${confidenceScore}/100`,
      );
    }

    const totalScore = clamp(
      successRateScore * this.weights.successRate +
        consistencyScore * this.weights.consistency +
        rugRiskScore * this.weights.rugRisk +
        activityScore * this.weights.activity +
        confidenceScore * this.weights.confidence,
    );

    return {
      creatorWallet: profile.creatorWallet,
      totalScore: round1(totalScore),
      riskLevel: levelFor(totalScore),
      successRateScore: round1(successRateScore),
      consistencyScore: round1(consistencyScore),
      rugRiskScore: round1(rugRiskScore),
      activityScore: round1(activityScore),
      confidenceScore: round1(confidenceScore),
      reasons,
      scoredAt: now,
    };
  }
}
