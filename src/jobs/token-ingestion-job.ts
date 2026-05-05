import {
  CreatorProfile,
  CreatorRepository,
  PumpFunProvider,
  TokenLaunch,
  TokenRepository,
} from "../types";
import { logger } from "../utils/logger";
import { ValidationError, validateTokenLaunch } from "../utils/validation";
import { TokenRiskFlagService } from "../services";
import {
  CombinedScoringService,
  CreatorScoringService,
  RiskScoringService,
} from "../scoring";
import { AlertPolicy, DiscordAlertService } from "../alerts";

export interface IngestionResult {
  fetched: number;
  saved: number;
  skippedDuplicates: number;
  invalid: number;
  scored: number;
  creatorsEvaluated: number;
  combinedEvaluations: number;
  alertsSent: number;
  alertsPreviewed: number;
  alertsDeduped: number;
}

export class TokenIngestionJob {
  constructor(
    private readonly provider: PumpFunProvider,
    private readonly repo: TokenRepository,
    private readonly creatorRepo: CreatorRepository,
    private readonly flagService: TokenRiskFlagService = new TokenRiskFlagService(),
    private readonly scoringService: RiskScoringService = new RiskScoringService(),
    private readonly creatorScoringService: CreatorScoringService = new CreatorScoringService(),
    private readonly combinedScoringService: CombinedScoringService = new CombinedScoringService(),
    private readonly alertPolicy?: AlertPolicy,
    private readonly alertService?: DiscordAlertService,
  ) {}

  async runOnce(): Promise<IngestionResult> {
    const result: IngestionResult = {
      fetched: 0,
      saved: 0,
      skippedDuplicates: 0,
      invalid: 0,
      scored: 0,
      creatorsEvaluated: 0,
      combinedEvaluations: 0,
      alertsSent: 0,
      alertsPreviewed: 0,
      alertsDeduped: 0,
    };

    let batch: TokenLaunch[];
    try {
      batch = await this.provider.fetchRecentLaunches();
    } catch (err) {
      logger.error("provider.fetchRecentLaunches failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return result;
    }

    result.fetched = batch.length;
    logger.info("ingestion: fetched batch", { count: batch.length });

    for (const token of batch) {
      try {
        validateTokenLaunch(token);
      } catch (err) {
        result.invalid += 1;
        if (err instanceof ValidationError) {
          logger.warn("ingestion: invalid token skipped", {
            mint: token.mint,
            field: err.field,
            reason: err.message,
          });
        } else {
          logger.warn("ingestion: invalid token skipped", {
            mint: token.mint,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
        continue;
      }

      const existing = await this.repo.findTokenByMint(token.mint);
      if (existing) {
        result.skippedDuplicates += 1;
        logger.debug("ingestion: duplicate skipped", {
          mint: token.mint,
          symbol: token.symbol,
        });
        continue;
      }

      await this.repo.saveTokenLaunch(token);
      result.saved += 1;
      logger.info("ingestion: saved token", {
        mint: token.mint,
        symbol: token.symbol,
        name: token.name,
        marketCapUsd: token.initialMarketCapUsd,
      });

      const flags = this.flagService.evaluate(token);
      await this.repo.saveRiskFlags(token.mint, flags);

      const tokenScore = this.scoringService.score(token, flags);
      await this.repo.saveTokenScore(tokenScore);
      result.scored += 1;

      logger.info("token scored", {
        mint: token.mint,
        symbol: token.symbol,
        score: tokenScore.totalScore,
        riskLevel: tokenScore.riskLevel,
      });

      const profile = await this.upsertProfileForLaunch(token);
      const history = await this.creatorRepo.listLaunchHistoryByCreator(token.creatorWallet);
      const stats = this.creatorScoringService.calculatePerformanceStats(
        token.creatorWallet,
        history,
      );
      const creatorScore = this.creatorScoringService.score(profile, history);
      await this.creatorRepo.saveCreatorScore(creatorScore);
      result.creatorsEvaluated += 1;

      logger.info("creator evaluated", {
        wallet: profile.creatorWallet,
        creatorScore: creatorScore.totalScore,
        riskLevel: creatorScore.riskLevel,
        successRate: Number((stats.successRate * 100).toFixed(1)),
        totalLaunches: profile.totalLaunches,
        historyLaunches: stats.totalLaunches,
        rugLikeCount: stats.rugLikeCount,
      });

      const combined = this.combinedScoringService.combine(token, tokenScore, creatorScore);
      await this.creatorRepo.saveCombinedEvaluation(combined);
      result.combinedEvaluations += 1;

      logger.info("combined evaluation", {
        symbol: token.symbol,
        tokenScore: combined.tokenScore,
        creatorScore: combined.creatorScore,
        combinedScore: combined.combinedScore,
        riskLevel: combined.combinedRiskLevel,
      });

      if (this.alertPolicy && this.alertService) {
        const decision = this.alertPolicy.evaluate({
          token,
          tokenScore,
          creatorScore,
          combined,
        });
        if (decision) {
          const alreadySent = await this.repo.hasAlertBeenSent(
            token.mint,
            decision.alertType,
          );
          if (alreadySent) {
            result.alertsDeduped += 1;
            logger.debug("alert: dedup skip", {
              mint: token.mint,
              symbol: token.symbol,
              alertType: decision.alertType,
            });
          } else {
            const outcome = await this.alertService.send(decision);
            if (outcome.delivered || outcome.preview) {
              await this.repo.recordAlertSent(token.mint, decision.alertType, new Date());
              if (outcome.delivered) {
                result.alertsSent += 1;
                logger.info("alert sent", {
                  mint: token.mint,
                  symbol: token.symbol,
                  alertType: decision.alertType,
                  combinedScore: combined.combinedScore,
                  riskLevel: combined.combinedRiskLevel,
                });
              } else {
                result.alertsPreviewed += 1;
                logger.info("alert previewed (no webhook configured)", {
                  mint: token.mint,
                  symbol: token.symbol,
                  alertType: decision.alertType,
                  combinedScore: combined.combinedScore,
                  riskLevel: combined.combinedRiskLevel,
                });
              }
            }
          }
        }
      }
    }

    logger.info("ingestion: run complete", result);
    return result;
  }

  private async upsertProfileForLaunch(token: TokenLaunch): Promise<CreatorProfile> {
    const existing = await this.creatorRepo.findCreatorProfile(token.creatorWallet);
    const profile: CreatorProfile = existing
      ? {
          ...existing,
          lastSeenAt:
            token.launchedAt > existing.lastSeenAt ? token.launchedAt : existing.lastSeenAt,
          totalLaunches: existing.totalLaunches + 1,
        }
      : {
          creatorWallet: token.creatorWallet,
          firstSeenAt: token.launchedAt,
          lastSeenAt: token.launchedAt,
          totalLaunches: 1,
        };
    await this.creatorRepo.upsertCreatorProfile(profile);
    return profile;
  }
}
