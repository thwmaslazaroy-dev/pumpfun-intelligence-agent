import { PumpFunProvider, TokenLaunch } from "../types";
import { logger } from "../utils/logger";
import { RequestBudgetManager } from "../services/request-budget-manager";
import { parsePumpFunCoin } from "../parsing/pump-fun-coin-parser";

const FEED_URL =
  "https://frontend-api-v3.pump.fun/coins?sort=created_timestamp&order=DESC&limit=50";
const REQUEST_TIMEOUT_MS = 20_000;

export class FeedPumpFunProvider implements PumpFunProvider {
  private readonly budget?: RequestBudgetManager;

  constructor(opts: { budgetManager?: RequestBudgetManager } = {}) {
    this.budget = opts.budgetManager;
  }

  async fetchRecentLaunches(): Promise<TokenLaunch[]> {
    // Budget gate
    if (this.budget) {
      const check = this.budget.allowRequest("pumpfun_frontend", "HIGH");
      if (!check.allowed) {
        logger.warn("budget: pumpfun_frontend blocked feed fetch", { reason: check.reason });
        return [];
      }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let body: string;
    try {
      const res = await fetch(FEED_URL, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Referer: "https://pump.fun/",
          "User-Agent": "pumpfun-intelligence-agent/0.1",
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        logger.warn("feed: non-200 response", { status: res.status });
        if (res.status === 429) {
          this.budget?.recordRateLimit("pumpfun_frontend", FEED_URL);
        } else {
          this.budget?.recordRequest("pumpfun_frontend", "/coins", { statusCode: res.status });
        }
        return [];
      }
      this.budget?.recordRequest("pumpfun_frontend", "/coins", { statusCode: res.status });
      body = await res.text();
    } catch (err) {
      clearTimeout(timer);
      logger.warn("feed: fetch failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.budget?.recordRequest("pumpfun_frontend", "/coins", { statusCode: null, reason: "fetch-error" });
      return [];
    }

    let rawArray: unknown[];
    try {
      const parsed = JSON.parse(body) as unknown;
      rawArray = Array.isArray(parsed) ? parsed : [];
    } catch {
      logger.warn("feed: JSON parse failed");
      return [];
    }

    const tokens: TokenLaunch[] = [];
    for (const raw of rawArray) {
      const token = parsePumpFunCoin(raw);
      if (token) tokens.push(token);
    }

    logger.debug("feed: fetched", { total: rawArray.length, valid: tokens.length });
    return tokens;
  }
}
