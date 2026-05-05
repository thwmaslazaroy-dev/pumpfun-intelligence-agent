import { TokenLaunch, TokenRiskFlags, TokenSocialLinks } from "../types";

export interface RiskFlagThresholds {
  highChurnMinTrades: number;
  highChurnSellBuyRatio: number;
  suspiciousVolumeMarketCapRatio: number;
  earlyBondingCurveProgress: number;
  earlyBondingCurveMaxAgeMinutes: number;
  lowActivityMaxTrades: number;
}

export const DEFAULT_RISK_FLAG_THRESHOLDS: RiskFlagThresholds = {
  highChurnMinTrades: 100,
  highChurnSellBuyRatio: 0.85,
  suspiciousVolumeMarketCapRatio: 5,
  earlyBondingCurveProgress: 50,
  earlyBondingCurveMaxAgeMinutes: 10,
  lowActivityMaxTrades: 10,
};

function hasAnySocial(socials?: TokenSocialLinks): boolean {
  if (!socials) return false;
  return Boolean(
    socials.website || socials.twitter || socials.telegram || socials.instagram || socials.discord,
  );
}

export class TokenRiskFlagService {
  constructor(
    private readonly thresholds: RiskFlagThresholds = DEFAULT_RISK_FLAG_THRESHOLDS,
    private readonly now: () => Date = () => new Date(),
  ) {}

  evaluate(token: TokenLaunch): TokenRiskFlags {
    const reasons: string[] = [];
    const evaluatedAt = this.now();

    const missingSocials = !hasAnySocial(token.socialLinks);
    if (missingSocials) {
      reasons.push("missingSocials: no website, twitter, telegram, instagram, or discord link");
    }

    const totalTrades = token.buyCount + token.sellCount;
    const sellBuyRatio =
      token.buyCount > 0 ? token.sellCount / token.buyCount : token.sellCount > 0 ? Infinity : 0;
    const highChurn =
      totalTrades >= this.thresholds.highChurnMinTrades &&
      sellBuyRatio >= this.thresholds.highChurnSellBuyRatio;
    if (highChurn) {
      reasons.push(
        `highChurn: ${totalTrades} trades with sell/buy ratio ${sellBuyRatio.toFixed(2)} >= ${this.thresholds.highChurnSellBuyRatio}`,
      );
    }

    const volMcRatio =
      token.initialMarketCapUsd > 0 ? token.volumeUsd / token.initialMarketCapUsd : 0;
    const suspiciousVolumeToMarketCap =
      volMcRatio >= this.thresholds.suspiciousVolumeMarketCapRatio;
    if (suspiciousVolumeToMarketCap) {
      reasons.push(
        `suspiciousVolumeToMarketCap: volume/marketCap = ${volMcRatio.toFixed(1)}x (threshold ${this.thresholds.suspiciousVolumeMarketCapRatio}x)`,
      );
    }

    const ageMs = evaluatedAt.getTime() - token.launchedAt.getTime();
    const ageMinutes = ageMs / 60_000;
    const earlyBondingCurveSpike =
      ageMinutes >= 0 &&
      ageMinutes <= this.thresholds.earlyBondingCurveMaxAgeMinutes &&
      token.bondingCurveProgress >= this.thresholds.earlyBondingCurveProgress;
    if (earlyBondingCurveSpike) {
      reasons.push(
        `earlyBondingCurveSpike: ${token.bondingCurveProgress.toFixed(1)}% bonding ${ageMinutes.toFixed(1)}min after launch`,
      );
    }

    const lowActivity = totalTrades <= this.thresholds.lowActivityMaxTrades;
    if (lowActivity) {
      reasons.push(
        `lowActivity: ${totalTrades} total trades (threshold <= ${this.thresholds.lowActivityMaxTrades})`,
      );
    }

    const suspiciousCreator = false;
    reasons.push(
      "suspiciousCreator: skipped — creator history provider not connected yet",
    );

    return {
      mint: token.mint,
      evaluatedAt,
      missingSocials,
      highChurn,
      suspiciousVolumeToMarketCap,
      earlyBondingCurveSpike,
      lowActivity,
      suspiciousCreator,
      reasons,
    };
  }
}
