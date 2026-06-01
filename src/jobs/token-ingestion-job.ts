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
import { PumpFunCoinEnrichmentService } from "../services/pumpfun-coin-enrichment-service";
import { EnrichmentFilter, FilterCounterDelta, EnrichmentMetricsDelta, normalizeTokenName } from "../services/enrichment-filter";

export interface IngestionResult {
  fetched: number;
  saved: number;
  skippedDuplicates: number;
  invalid: number;
  scored: number;
  // Enrichment
  enriched: number;
  enrichmentFailed: number;
  enrichmentCacheHits: number;
  enrichmentMintMismatch: number;
  // Pre-enrichment filter
  filteredByRuleA: number;
  filteredByRuleB: number;
  filteredByRuleC: number;
  filteredByRuleD: number;
  sampledUnknownCreators: number;
  // Downstream
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
    /** Optional. When provided, enriches each newly detected token before scoring. */
    private readonly enrichmentService?: PumpFunCoinEnrichmentService,
    /**
     * Optional. When provided alongside enrichmentService, gates enrichment calls
     * using creator history from SQLite before making any API requests.
     */
    private readonly enrichmentFilter?: EnrichmentFilter,
    private readonly duplicateNameCfg: {
      enabled: boolean;
      lookbackHours: number;
    } = { enabled: false, lookbackHours: 48 },
  ) {}

  async runOnce(): Promise<IngestionResult> {
    const result: IngestionResult = {
      fetched: 0,
      saved: 0,
      skippedDuplicates: 0,
      invalid: 0,
      scored: 0,
      enriched: 0,
      enrichmentFailed: 0,
      enrichmentCacheHits: 0,
      enrichmentMintMismatch: 0,
      filteredByRuleA: 0,
      filteredByRuleB: 0,
      filteredByRuleC: 0,
      filteredByRuleD: 0,
      sampledUnknownCreators: 0,
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

      // ── Save minimal token (name="Unknown", marketCap=0) ─────────────────
      await this.repo.saveTokenLaunch(token);
      result.saved += 1;
      logger.info("ingestion: saved token", {
        mint: token.mint,
        symbol: token.symbol,
        name: token.name,
        marketCapUsd: token.initialMarketCapUsd,
      });

      // ── Rule D: duplicate name pre-check ──────────────────────────────────
      // If the WS fast-path gave us a real name, check for duplicates now
      // (before enrichment) to avoid a wasted API call.
      if (this.duplicateNameCfg.enabled) {
        const normalized = normalizeTokenName(token.name);
        if (normalized) {
          const lookbackMs = this.duplicateNameCfg.lookbackHours * 3_600_000;
          const dup = this.repo.findDuplicateTokenName(normalized, token.mint, lookbackMs);
          if (dup) {
            result.filteredByRuleD += 1;
            logger.info("Rule D: duplicate token name skipped", {
              mint: token.mint,
              name: token.name,
              symbol: token.symbol,
              normalizedName: normalized,
              existingMint: dup.mint,
            });
            continue;
          }
        }
      }

      // ── Pre-enrichment filter ─────────────────────────────────────────────
      // Consults SQLite creator history to skip enrichment API calls for tokens
      // that cannot produce meaningful alerts regardless of their market data.
      let tokenForScoring = token;
      let enrichmentAttempted = false;
      let wasEnriched = false;

      if (this.enrichmentService) {
        let shouldEnrich = true;

        if (this.enrichmentFilter) {
          const filterResult = this.enrichmentFilter.evaluate(
            token.creatorWallet,
            Date.now(),
          );
          shouldEnrich = filterResult.shouldEnrich;

          switch (filterResult.rule) {
            case "A_skip":
              result.filteredByRuleA += 1;
              break;
            case "A_sample":
              result.sampledUnknownCreators += 1;
              break;
            case "B":
              result.filteredByRuleB += 1;
              break;
            case "C":
              result.filteredByRuleC += 1;
              break;
            // "pass" — no counter, just proceeds
          }

          if (!shouldEnrich) {
            logger.debug("ingestion: enrichment skipped by filter", {
              mint: token.mint,
              rule: filterResult.rule,
              reason: filterResult.reason,
            });
          }
        }

        // ── Enrichment ──────────────────────────────────────────────────────
        if (shouldEnrich) {
          enrichmentAttempted = true;
          const { token: enriched, outcome } = await this.enrichmentService.enrichMint(token);

          if (outcome.cacheHit) {
            result.enrichmentCacheHits += 1;
          }

          if (outcome.mintMismatch) {
            result.enrichmentMintMismatch += 1;
          }

          if (outcome.enriched) {
            result.enriched += 1;
            wasEnriched = true;
            // Update the stored row: overwrites name/symbol/marketCap/socials/counts
            this.repo.upsertTokenFeedData(enriched);
            tokenForScoring = enriched;

            // ── Rule D: duplicate name post-enrichment check ──────────────
            // Token was Unknown at detection but now has a real name — check
            // for duplicates before scoring and alert evaluation.
            if (this.duplicateNameCfg.enabled) {
              const normalizedPost = normalizeTokenName(tokenForScoring.name);
              if (normalizedPost) {
                const lookbackMs = this.duplicateNameCfg.lookbackHours * 3_600_000;
                const dup = this.repo.findDuplicateTokenName(
                  normalizedPost,
                  tokenForScoring.mint,
                  lookbackMs,
                );
                if (dup) {
                  result.filteredByRuleD += 1;
                  logger.info("Rule D: duplicate token name skipped (post-enrichment)", {
                    mint: tokenForScoring.mint,
                    name: tokenForScoring.name,
                    symbol: tokenForScoring.symbol,
                    normalizedName: normalizedPost,
                    existingMint: dup.mint,
                  });
                  continue;
                }
              }
            }
          } else {
            result.enrichmentFailed += 1;
            logger.warn("ingestion: enrichment failed — scoring on minimal data", {
              mint:         token.mint,
              reason:       outcome.failureReason,
              mintMismatch: outcome.mintMismatch,
              retried:      outcome.retried,
            });
          }
        }
      }

      // ── Risk flags ────────────────────────────────────────────────────────
      const flags = this.flagService.evaluate(tokenForScoring);
      await this.repo.saveRiskFlags(tokenForScoring.mint, flags);

      // ── Token score ───────────────────────────────────────────────────────
      const tokenScore = this.scoringService.score(tokenForScoring, flags);
      await this.repo.saveTokenScore(tokenScore);
      result.scored += 1;

      logger.info("token scored", {
        mint: tokenForScoring.mint,
        symbol: tokenForScoring.symbol,
        score: tokenScore.totalScore,
        riskLevel: tokenScore.riskLevel,
        enriched: tokenForScoring !== token,
        enrichmentAttempted,
      });

      // ── Creator profile + score ───────────────────────────────────────────
      const profile = await this.upsertProfileForLaunch(tokenForScoring);
      const history = await this.creatorRepo.listLaunchHistoryByCreator(tokenForScoring.creatorWallet);
      const stats = this.creatorScoringService.calculatePerformanceStats(
        tokenForScoring.creatorWallet,
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

      // ── Combined score ────────────────────────────────────────────────────
      const combined = this.combinedScoringService.combine(tokenForScoring, tokenScore, creatorScore);
      await this.creatorRepo.saveCombinedEvaluation(combined);
      result.combinedEvaluations += 1;

      logger.info("combined evaluation", {
        symbol: tokenForScoring.symbol,
        tokenScore: combined.tokenScore,
        creatorScore: combined.creatorScore,
        combinedScore: combined.combinedScore,
        riskLevel: combined.combinedRiskLevel,
      });

      // ── Alert ─────────────────────────────────────────────────────────────
      if (this.alertPolicy && this.alertService) {
        const decision = this.alertPolicy.evaluate({
          token: tokenForScoring,
          tokenScore,
          creatorScore,
          combined,
          enriched: wasEnriched,
        });
        if (decision) {
          const alreadySent = await this.repo.hasAlertBeenSent(
            tokenForScoring.mint,
            decision.alertType,
          );
          if (alreadySent) {
            result.alertsDeduped += 1;
            logger.debug("alert: dedup skip", {
              mint: tokenForScoring.mint,
              symbol: tokenForScoring.symbol,
              alertType: decision.alertType,
            });
          } else {
            const alertOutcome = await this.alertService.send(decision);
            if (alertOutcome.delivered || alertOutcome.preview) {
              await this.repo.recordAlertSent(tokenForScoring.mint, decision.alertType, new Date());
              if (alertOutcome.delivered) {
                result.alertsSent += 1;
                logger.info("alert sent", {
                  mint: tokenForScoring.mint,
                  symbol: tokenForScoring.symbol,
                  alertType: decision.alertType,
                  combinedScore: combined.combinedScore,
                  riskLevel: combined.combinedRiskLevel,
                });
              } else {
                result.alertsPreviewed += 1;
                logger.info("alert previewed (no webhook configured)", {
                  mint: tokenForScoring.mint,
                  symbol: tokenForScoring.symbol,
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

    // ── Persist filter counters and enrichment metrics to SQLite ─────────────
    if (this.enrichmentFilter && result.saved > 0) {
      const enrichmentsPerformed =
        result.enriched + result.enrichmentFailed + result.enrichmentCacheHits;

      const filterDelta: FilterCounterDelta = {
        filteredByRuleA:        result.filteredByRuleA,
        filteredByRuleB:        result.filteredByRuleB,
        filteredByRuleC:        result.filteredByRuleC,
        filteredByRuleD:        result.filteredByRuleD,
        sampledUnknownCreators: result.sampledUnknownCreators,
        enrichmentsPerformed,
      };
      this.enrichmentFilter.persistCounterDelta(filterDelta);

      const metricsDelta: EnrichmentMetricsDelta = {
        successfulEnrichments: result.enriched,
        mintMismatches:        result.enrichmentMintMismatch,
        // Every mismatch triggers exactly one 30s retry.
        enrichmentRetries:     result.enrichmentMintMismatch,
      };
      this.enrichmentFilter.persistEnrichmentMetrics(metricsDelta);
    }

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
