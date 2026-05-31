/**
 * PumpFunCoinEnrichmentService
 *
 * Fetches full token metadata from the pump.fun frontend API for a single mint
 * and returns an enriched TokenLaunch. Integrates with RequestBudgetManager for
 * rate-limiting and uses token_enrichment_cache for deduplication.
 *
 * Mint integrity: the API can return a different token than the one requested
 * (e.g. when a newly created mint is not yet indexed). Every successful parse
 * is verified against the requested mint. A mismatch triggers one 30-second
 * retry. If the retry still mismatches, the minimal token is returned unchanged
 * and nothing is cached.
 */

import { TokenLaunch } from "../types";
import { logger } from "../utils/logger";
import { parsePumpFunCoin, isEnriched } from "../parsing/pump-fun-coin-parser";
import { RequestBudgetManager } from "./request-budget-manager";

// ── Constants ─────────────────────────────────────────────────────────────────

const BASE_URL = "https://frontend-api-v3.pump.fun";
const SINGLE_COIN_PATH = (mint: string) => `/coins/${mint}`;

const DEFAULT_TIMEOUT_MS   = 15_000;
const DEFAULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Delays between network-failure retries (attempt 1 is immediate). */
const RETRY_DELAY_MS = [0, 5_000, 15_000] as const;

/** How long to wait before the single mint-mismatch retry. */
const MISMATCH_RETRY_DELAY_MS = 30_000;

const REQUEST_HEADERS = {
  Accept: "application/json",
  Referer: "https://pump.fun/",
  "User-Agent": "pumpfun-intelligence-agent/0.1",
};

// ── Types ─────────────────────────────────────────────────────────────────────

export interface EnrichmentServiceConfig {
  budgetManager?: RequestBudgetManager;
  timeoutMs?: number;
  cacheTtlMs?: number;
}

export interface EnrichmentOutcome {
  mint: string;
  enriched: boolean;
  cacheHit: boolean;
  attempts: number;
  elapsedMs: number;
  failureReason?: string;
  /** True when the API returned metadata for a different mint than was requested. */
  mintMismatch: boolean;
  /** True when a 30-second mint-mismatch retry was attempted. */
  retried: boolean;
}

// Internal result of a single HTTP attempt.
interface FetchResult {
  token: TokenLaunch | null;
  statusCode: number | null;
  failureReason?: string;
  /** The API returned data but its mint field != requested mint. */
  mintMismatch: boolean;
  /** The mint the API actually returned (only meaningful when mintMismatch=true). */
  returnedMint?: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class PumpFunCoinEnrichmentService {
  private readonly budget?: RequestBudgetManager;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;

  constructor(cfg: EnrichmentServiceConfig = {}) {
    this.budget     = cfg.budgetManager;
    this.timeoutMs  = cfg.timeoutMs  ?? DEFAULT_TIMEOUT_MS;
    this.cacheTtlMs = cfg.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  }

  /**
   * Enrich a minimal TokenLaunch with real data from the pump.fun API.
   *
   * Returns the enriched token on success, or the original `minimal` token
   * unchanged if enrichment fails for any reason. The `outcome` field always
   * describes what happened.
   */
  async enrichMint(
    minimal: TokenLaunch,
  ): Promise<{ token: TokenLaunch; outcome: EnrichmentOutcome }> {
    const { mint } = minimal;
    const startMs = Date.now();

    const baseOutcome: Omit<EnrichmentOutcome, "elapsedMs"> = {
      mint,
      enriched: false,
      cacheHit: false,
      attempts: 0,
      mintMismatch: false,
      retried: false,
    };

    // ── 1. Cache check ──────────────────────────────────────────────────────
    if (this.budget) {
      const cached = this.budget.getEnrichmentCache(mint);
      if (cached) {
        logger.debug("enrichment: cache hit", {
          mint: shortMint(mint),
          fetchedAt: new Date(cached.fetchedAt).toISOString(),
          ttlRemainingMin: Math.ceil(
            (cached.fetchedAt + this.cacheTtlMs - Date.now()) / 60_000,
          ),
        });
        return {
          token: this.applyCache(minimal, cached),
          outcome: {
            ...baseOutcome,
            enriched: true,
            cacheHit: true,
            elapsedMs: Date.now() - startMs,
          },
        };
      }
    }

    logger.debug("enrichment: cache miss — will fetch", { mint: shortMint(mint) });

    // ── 2. Budget gate ──────────────────────────────────────────────────────
    if (this.budget) {
      const check = this.budget.allowRequest("pumpfun_frontend", "HIGH");
      if (!check.allowed) {
        logger.warn("enrichment: budget blocked", {
          mint: shortMint(mint),
          reason: check.reason,
          dayUsagePct: check.dayUsagePct.toFixed(1),
          remainingDay: check.remainingDay,
        });
        return {
          token: minimal,
          outcome: {
            ...baseOutcome,
            failureReason: `budget blocked: ${check.reason}`,
            elapsedMs: Date.now() - startMs,
          },
        };
      }
    }

    // ── 3. Fetch with network-failure retries ───────────────────────────────
    logger.info("enrichment: started", { mint: shortMint(mint) });

    let attempt = 0;
    let lastFailureReason = "unknown";
    let mintMismatchDetected = false;
    let mismatchReturnedMint: string | undefined;

    for (const delayMs of RETRY_DELAY_MS) {
      if (delayMs > 0) {
        logger.info("enrichment: retry", { mint: shortMint(mint), attempt, delayMs });
        await sleep(delayMs);
      }
      attempt += 1;

      const fetchResult = await this.fetchOnce(mint, attempt);

      // ── Mint mismatch ──────────────────────────────────────────────────────
      if (fetchResult.mintMismatch) {
        mintMismatchDetected = true;
        mismatchReturnedMint = fetchResult.returnedMint;
        lastFailureReason = `mint mismatch: requested ${shortMint(mint)}, got ${shortMint(fetchResult.returnedMint ?? "unknown")}`;

        logger.warn("enrichment: mint mismatch — will retry after 30s", {
          requestedMint: mint,
          returnedMint:  fetchResult.returnedMint ?? "unknown",
          attempt,
        });

        this.budget?.recordRequest("pumpfun_frontend", SINGLE_COIN_PATH(mint), {
          statusCode: fetchResult.statusCode ?? undefined,
          reason: "mint-mismatch",
          relatedMint: mint,
        });

        break; // Do not continue the network-failure retry loop
      }

      // ── HTTP / parse success ───────────────────────────────────────────────
      if (fetchResult.token) {
        return this.recordSuccess(minimal, fetchResult, mint, attempt, startMs, baseOutcome, false);
      }

      // ── HTTP / network failure ─────────────────────────────────────────────
      lastFailureReason = fetchResult.failureReason ?? "unknown";

      if (fetchResult.statusCode === 429) {
        this.budget?.recordRateLimit("pumpfun_frontend", SINGLE_COIN_PATH(mint));
        logger.warn("enrichment: rate limited — stopping retries", {
          mint: shortMint(mint),
          attempt,
        });
        break;
      }

      this.budget?.recordRequest("pumpfun_frontend", SINGLE_COIN_PATH(mint), {
        statusCode: fetchResult.statusCode ?? undefined,
        reason: lastFailureReason,
        relatedMint: mint,
      });

      logger.warn("enrichment: attempt failed", {
        mint:      shortMint(mint),
        attempt,
        reason:    lastFailureReason,
        statusCode: fetchResult.statusCode,
        willRetry:  attempt < RETRY_DELAY_MS.length,
      });
    }

    // ── 4. Mint-mismatch retry (30 seconds) ─────────────────────────────────
    if (mintMismatchDetected) {
      logger.info("enrichment: waiting 30s before mismatch retry", {
        mint: shortMint(mint),
        returnedMint: mismatchReturnedMint ?? "unknown",
      });

      await sleep(MISMATCH_RETRY_DELAY_MS);
      attempt += 1;

      const retryResult = await this.fetchOnce(mint, attempt);

      if (retryResult.mintMismatch) {
        // Still wrong after 30s — give up, do not cache
        logger.warn("enrichment: mint mismatch persists after retry — keeping minimal data", {
          requestedMint: mint,
          returnedMint:  retryResult.returnedMint ?? "unknown",
          totalAttempts: attempt,
          elapsedMs:     Date.now() - startMs,
        });

        this.budget?.recordRequest("pumpfun_frontend", SINGLE_COIN_PATH(mint), {
          statusCode: retryResult.statusCode ?? undefined,
          reason: "mint-mismatch-retry",
          relatedMint: mint,
        });

        return {
          token: minimal,
          outcome: {
            ...baseOutcome,
            attempts:      attempt,
            mintMismatch:  true,
            retried:       true,
            failureReason: `mint mismatch persisted after 30s retry`,
            elapsedMs:     Date.now() - startMs,
          },
        };
      }

      if (retryResult.token) {
        // Retry resolved the mismatch — use this data
        logger.info("enrichment: mismatch retry succeeded", {
          mint: shortMint(mint),
          attempt,
          elapsedMs: Date.now() - startMs,
        });
        return this.recordSuccess(minimal, retryResult, mint, attempt, startMs, baseOutcome, true);
      }

      // Retry also failed for a different reason (network/HTTP)
      lastFailureReason = retryResult.failureReason ?? lastFailureReason;
      this.budget?.recordRequest("pumpfun_frontend", SINGLE_COIN_PATH(mint), {
        statusCode: retryResult.statusCode ?? undefined,
        reason: lastFailureReason,
        relatedMint: mint,
      });

      return {
        token: minimal,
        outcome: {
          ...baseOutcome,
          attempts:     attempt,
          mintMismatch: true,
          retried:      true,
          failureReason: lastFailureReason,
          elapsedMs:    Date.now() - startMs,
        },
      };
    }

    // ── 5. All network-failure attempts exhausted ────────────────────────────
    logger.warn("enrichment: failed — using minimal token data", {
      mint:          shortMint(mint),
      totalAttempts: attempt,
      reason:        lastFailureReason,
      elapsedMs:     Date.now() - startMs,
    });

    return {
      token: minimal,
      outcome: {
        ...baseOutcome,
        attempts:      attempt,
        failureReason: lastFailureReason,
        elapsedMs:     Date.now() - startMs,
      },
    };
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private async fetchOnce(mint: string, attempt: number): Promise<FetchResult> {
    const url = `${BASE_URL}${SINGLE_COIN_PATH(mint)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: REQUEST_HEADERS,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        return { token: null, statusCode: res.status, failureReason: `HTTP ${res.status}`, mintMismatch: false };
      }

      let body: unknown;
      try {
        body = await res.json();
      } catch {
        return { token: null, statusCode: res.status, failureReason: "JSON parse failed", mintMismatch: false };
      }

      const parsed = parsePumpFunCoin(body);
      if (!parsed) {
        return {
          token: null,
          statusCode: res.status,
          failureReason: "API response missing required fields (mint/creator/timestamp)",
          mintMismatch: false,
        };
      }

      // ── Mint integrity check ─────────────────────────────────────────────────
      if (parsed.mint !== mint) {
        return {
          token:       null,
          statusCode:  res.status,
          mintMismatch: true,
          returnedMint: parsed.mint,
          failureReason: `mint mismatch: requested ${shortMint(mint)}, API returned ${shortMint(parsed.mint)}`,
        };
      }

      return { token: parsed, statusCode: res.status, mintMismatch: false };
    } catch (err) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      const isTimeout = msg.includes("abort") || msg.includes("timed out");
      return {
        token: null,
        statusCode: null,
        mintMismatch: false,
        failureReason: isTimeout ? `timeout after ${this.timeoutMs}ms (attempt ${attempt})` : msg,
      };
    }
  }

  /** Shared success path used by both the normal loop and the mismatch retry. */
  private recordSuccess(
    minimal: TokenLaunch,
    fetchResult: FetchResult,
    mint: string,
    attempt: number,
    startMs: number,
    baseOutcome: Omit<EnrichmentOutcome, "elapsedMs">,
    retried: boolean,
  ): { token: TokenLaunch; outcome: EnrichmentOutcome } {
    const fetched = fetchResult.token!;

    this.budget?.recordRequest("pumpfun_frontend", SINGLE_COIN_PATH(mint), {
      statusCode: fetchResult.statusCode ?? undefined,
      relatedMint: mint,
    });

    if (this.budget && isEnriched(fetched)) {
      this.budget.saveEnrichmentCache(
        mint,
        {
          name:                 fetched.name,
          symbol:               fetched.symbol,
          marketCapUsd:         fetched.initialMarketCapUsd,
          bondingCurveProgress: fetched.bondingCurveProgress,
          buyCount:             fetched.buyCount,
          sellCount:            fetched.sellCount,
          volumeUsd:            fetched.volumeUsd,
          socialLinksJson:      fetched.socialLinks ? JSON.stringify(fetched.socialLinks) : null,
        },
        this.cacheTtlMs,
      );
    }

    const merged = mergeTokens(minimal, fetched);

    logger.info("enrichment: success", {
      mint:         shortMint(mint),
      attempt,
      retried,
      name:         merged.name,
      symbol:       merged.symbol,
      marketCapUsd: merged.initialMarketCapUsd,
      buyCount:     merged.buyCount,
      sellCount:    merged.sellCount,
      hasSocials:   Boolean(merged.socialLinks?.twitter || merged.socialLinks?.telegram),
      elapsedMs:    Date.now() - startMs,
    });

    return {
      token: merged,
      outcome: {
        ...baseOutcome,
        enriched:  true,
        attempts:  attempt,
        retried,
        elapsedMs: Date.now() - startMs,
      },
    };
  }

  private applyCache(
    minimal: TokenLaunch,
    cached: import("./request-budget-manager").EnrichmentCacheEntry,
  ): TokenLaunch {
    let socialLinks = minimal.socialLinks;
    if (cached.socialLinksJson) {
      try {
        socialLinks = JSON.parse(cached.socialLinksJson) as typeof socialLinks;
      } catch { /* keep original */ }
    }
    return {
      ...minimal,
      name:                 cached.name                ?? minimal.name,
      symbol:               cached.symbol              ?? minimal.symbol,
      initialMarketCapUsd:  cached.marketCapUsd        ?? minimal.initialMarketCapUsd,
      bondingCurveProgress: cached.bondingCurveProgress ?? minimal.bondingCurveProgress,
      buyCount:             cached.buyCount             ?? minimal.buyCount,
      sellCount:            cached.sellCount            ?? minimal.sellCount,
      volumeUsd:            cached.volumeUsd            ?? minimal.volumeUsd,
      socialLinks,
    };
  }
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function mergeTokens(minimal: TokenLaunch, enriched: TokenLaunch): TokenLaunch {
  return {
    // Identity from on-chain detection — never overwrite
    mint:          minimal.mint,
    creatorWallet: minimal.creatorWallet,
    launchedAt:    minimal.launchedAt,
    // Enriched fields — prefer API values; fall back to minimal
    name:                 enriched.name   !== "UNKNOWN" ? enriched.name   : minimal.name,
    symbol:               enriched.symbol !== "UNKNOWN" ? enriched.symbol : minimal.symbol,
    initialMarketCapUsd:  enriched.initialMarketCapUsd  > 0 ? enriched.initialMarketCapUsd  : minimal.initialMarketCapUsd,
    bondingCurveProgress: enriched.bondingCurveProgress > 0 ? enriched.bondingCurveProgress : minimal.bondingCurveProgress,
    buyCount:             enriched.buyCount  > 0 ? enriched.buyCount  : minimal.buyCount,
    sellCount:            enriched.sellCount > 0 ? enriched.sellCount : minimal.sellCount,
    volumeUsd:            enriched.volumeUsd > 0 ? enriched.volumeUsd : minimal.volumeUsd,
    socialLinks:          enriched.socialLinks ?? minimal.socialLinks,
  };
}

function shortMint(mint: string): string {
  return mint.length > 12 ? `${mint.slice(0, 6)}…${mint.slice(-4)}` : mint;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
