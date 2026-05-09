import { CreatorProfile, CreatorRepository, TokenLaunch, TokenRepository } from "../types";
import { logger } from "../utils/logger";
import { FeedPumpFunProvider } from "../providers/feed-pumpfun-provider";
import { MomentumRepository } from "../storage/momentum-repository";
import { MomentumDetectionService, MomentumSnapshot } from "../scoring/momentum-detection-service";
import { TokenRiskFlagService } from "../services";
import { CombinedScoringService, CreatorScoringService, RiskScoringService } from "../scoring";
import { DiscordMomentumAlertService } from "../alerts/discord-momentum-alert-service";

export interface MomentumMonitorConfig {
  minCombinedScore: number;
  tokenMaxAgeMs: number;
  pruneOlderThanMs: number;
}

export const DEFAULT_MOMENTUM_MONITOR_CONFIG: MomentumMonitorConfig = {
  minCombinedScore: 40,
  tokenMaxAgeMs: 4 * 60 * 60 * 1000,
  pruneOlderThanMs: 6 * 60 * 60 * 1000,
};

export interface MomentumRunResult {
  fetched: number;
  upserted: number;
  snapshotsSaved: number;
  evaluated: number;
  momentumDetected: number;
  alertsSent: number;
  alertsDeduped: number;
}

export class MomentumMonitorJob {
  constructor(
    private readonly feedProvider: FeedPumpFunProvider,
    private readonly repo: TokenRepository,
    private readonly creatorRepo: CreatorRepository,
    private readonly momentumRepo: MomentumRepository,
    private readonly flagService: TokenRiskFlagService,
    private readonly scoringService: RiskScoringService,
    private readonly creatorScoringService: CreatorScoringService,
    private readonly combinedScoringService: CombinedScoringService,
    private readonly momentumService: MomentumDetectionService,
    private readonly alertService: DiscordMomentumAlertService,
    private readonly cfg: MomentumMonitorConfig = DEFAULT_MOMENTUM_MONITOR_CONFIG,
  ) {}

  async runOnce(): Promise<MomentumRunResult> {
    const result: MomentumRunResult = {
      fetched: 0,
      upserted: 0,
      snapshotsSaved: 0,
      evaluated: 0,
      momentumDetected: 0,
      alertsSent: 0,
      alertsDeduped: 0,
    };

    let tokens: TokenLaunch[];
    try {
      tokens = await this.feedProvider.fetchRecentLaunches();
    } catch (err) {
      logger.error("momentum: feed fetch failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return result;
    }

    result.fetched = tokens.length;
    const now = Date.now();
    const cutoff = now - this.cfg.tokenMaxAgeMs;

    for (const token of tokens) {
      if (token.launchedAt.getTime() < cutoff) continue;

      (this.repo as { upsertTokenFeedData?: (t: TokenLaunch) => boolean }).upsertTokenFeedData?.(token);
      result.upserted += 1;

      const snapshot: MomentumSnapshot = {
        mint: token.mint,
        capturedAt: new Date(now),
        bondingCurveProgress: token.bondingCurveProgress,
        buyCount: token.buyCount,
        sellCount: token.sellCount,
        volumeUsd: token.volumeUsd,
        marketCapUsd: token.initialMarketCapUsd,
      };
      this.momentumRepo.save(snapshot);
      result.snapshotsSaved += 1;

      const pair = this.momentumRepo.getLastTwo(token.mint);
      if (!pair) continue;

      result.evaluated += 1;
      const [older, newer] = pair;
      const signals = this.momentumService.detect(older, newer);

      if (!signals.isMomentum) continue;
      result.momentumDetected += 1;

      const flags = this.flagService.evaluate(token);
      const tokenScore = this.scoringService.score(token, flags);
      const creatorProfile = await this.getOrCreateProfile(token);
      const creatorHistory = await this.creatorRepo.listLaunchHistoryByCreator(token.creatorWallet);
      const creatorScore = this.creatorScoringService.score(creatorProfile, creatorHistory);
      const combined = this.combinedScoringService.combine(token, tokenScore, creatorScore);

      if (combined.combinedScore < this.cfg.minCombinedScore) {
        logger.debug("momentum: skipped low combined score", {
          mint: token.mint,
          symbol: token.symbol,
          combinedScore: combined.combinedScore,
        });
        continue;
      }

      const alreadySent = await this.repo.hasAlertBeenSent(token.mint, "momentum");
      if (alreadySent) {
        result.alertsDeduped += 1;
        continue;
      }

      const outcome = await this.alertService.send(token, signals, combined);
      if (outcome.delivered || outcome.preview) {
        await this.repo.recordAlertSent(token.mint, "momentum", new Date(now));
        if (outcome.delivered) {
          result.alertsSent += 1;
          logger.info("momentum alert sent", {
            mint: token.mint,
            symbol: token.symbol,
            bcVelocity: signals.bcVelocityPerMin.toFixed(4),
            buyPressure: signals.buyPressure.toFixed(2),
            combinedScore: combined.combinedScore,
          });
        } else {
          logger.info("momentum alert preview (no webhook)", {
            mint: token.mint,
            symbol: token.symbol,
          });
        }
      }
    }

    this.momentumRepo.pruneOlderThan(now - this.cfg.pruneOlderThanMs);
    logger.info("momentum: run complete", result);
    return result;
  }

  private async getOrCreateProfile(token: TokenLaunch): Promise<CreatorProfile> {
    const existing = await this.creatorRepo.findCreatorProfile(token.creatorWallet);
    if (existing) return existing;
    const profile: CreatorProfile = {
      creatorWallet: token.creatorWallet,
      firstSeenAt: token.launchedAt,
      lastSeenAt: token.launchedAt,
      totalLaunches: 1,
    };
    await this.creatorRepo.upsertCreatorProfile(profile);
    return profile;
  }
}
