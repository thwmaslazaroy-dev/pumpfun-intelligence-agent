export interface MoralisCallResult {
  endpointPath: string;
  status: number | null;
  ok: boolean;
  errorMessage?: string;
  body?: unknown;
}

export interface EnrichmentSnapshot {
  mint: string;
  observedAt: Date;
  usdPrice: number | null;
  swapCount: number | null;
  firstSwapType: string | null;
  firstSwapExchange: string | null;
  priceCall: { ok: boolean; status: number | null; errorMessage?: string };
  swapsCall: { ok: boolean; status: number | null; errorMessage?: string };
  rawPriceBody?: unknown;
  rawSwapsBody?: unknown;
}

export interface MoralisServiceConfig {
  apiKey: string;
  baseUrl?: string;
  network?: string;
  timeoutMs?: number;
  /** When set, enforces rate limits and caches price/swap results */
  budgetManager?: import("./request-budget-manager").RequestBudgetManager;
  /** Price result cache TTL in ms (default: 10 min) */
  priceTtlMs?: number;
  /** Swaps result cache TTL in ms (default: 30 min) */
  swapsTtlMs?: number;
}

const DEFAULT_BASE_URL = "https://solana-gateway.moralis.io";
const DEFAULT_NETWORK = "mainnet";
const DEFAULT_TIMEOUT_MS = 15_000;

export class MoralisTokenEnrichmentService {
  readonly providerName = "moralis";
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly network: string;
  private readonly timeoutMs: number;
  private readonly budget?: import("./request-budget-manager").RequestBudgetManager;
  private readonly priceTtlMs: number;
  private readonly swapsTtlMs: number;

  constructor(cfg: MoralisServiceConfig) {
    if (!cfg.apiKey) {
      throw new Error("MoralisTokenEnrichmentService requires a non-empty apiKey");
    }
    this.apiKey = cfg.apiKey;
    this.baseUrl = cfg.baseUrl ?? DEFAULT_BASE_URL;
    this.network = cfg.network ?? DEFAULT_NETWORK;
    this.timeoutMs = cfg.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.budget = cfg.budgetManager;
    this.priceTtlMs = cfg.priceTtlMs ?? 10 * 60 * 1000;
    this.swapsTtlMs = cfg.swapsTtlMs ?? 30 * 60 * 1000;
  }

  async getTokenPrice(mint: string): Promise<MoralisCallResult> {
    return this.get(`/token/${this.network}/${mint}/price`);
  }

  async getTokenSwaps(mint: string): Promise<MoralisCallResult> {
    return this.get(`/token/${this.network}/${mint}/swaps`);
  }

  async getTokenEnrichmentSnapshot(mint: string): Promise<EnrichmentSnapshot> {
    const observedAt = new Date();

    // Budget gate before making any Moralis calls
    if (this.budget) {
      const check = this.budget.allowRequest("moralis", "MEDIUM");
      if (!check.allowed) {
        return this.blockedSnapshot(mint, observedAt, `budget blocked: ${check.reason}`);
      }
    }

    const priceResult = await this.getTokenPrice(mint);
    const swapsResult = await this.getTokenSwaps(mint);

    const usdPrice = priceResult.ok ? extractUsdPrice(priceResult.body) : null;
    const swaps = swapsResult.ok ? extractSwaps(swapsResult.body) : [];
    const firstSwap = swaps[0];
    const firstSwapType =
      asString(getProp(firstSwap, "transactionType")) ??
      asString(getProp(firstSwap, "type"));
    const firstSwapExchange =
      asString(getProp(firstSwap, "exchangeName")) ??
      asString(getProp(firstSwap, "exchange"));

    return {
      mint,
      observedAt,
      usdPrice,
      swapCount: swapsResult.ok ? swaps.length : null,
      firstSwapType,
      firstSwapExchange,
      priceCall: {
        ok: priceResult.ok,
        status: priceResult.status,
        errorMessage: priceResult.errorMessage,
      },
      swapsCall: {
        ok: swapsResult.ok,
        status: swapsResult.status,
        errorMessage: swapsResult.errorMessage,
      },
      rawPriceBody: priceResult.body,
      rawSwapsBody: swapsResult.body,
    };
  }

  private async get(pathSegment: string): Promise<MoralisCallResult> {
    const url = `${this.baseUrl}${pathSegment}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "X-API-Key": this.apiKey,
          accept: "application/json",
        },
        signal: controller.signal,
      });
      const text = await res.text();
      let body: unknown = null;
      if (text.length > 0) {
        try {
          body = JSON.parse(text);
        } catch {
          body = { _rawText: text.slice(0, 1000) };
        }
      }
      let errorMessage: string | undefined;
      if (!res.ok) {
        const m = (body as { message?: unknown } | null)?.message;
        errorMessage = typeof m === "string" ? m : `HTTP ${res.status}`;
        if (res.status === 429) {
          this.budget?.recordRateLimit("moralis", pathSegment);
        } else {
          this.budget?.recordRequest("moralis", pathSegment, { statusCode: res.status });
        }
      } else {
        this.budget?.recordRequest("moralis", pathSegment, { statusCode: res.status });
      }
      return {
        endpointPath: pathSegment,
        status: res.status,
        ok: res.ok,
        errorMessage,
        body,
      };
    } catch (err) {
      this.budget?.recordRequest("moralis", pathSegment, { statusCode: null, reason: "fetch-error" });
      return {
        endpointPath: pathSegment,
        status: null,
        ok: false,
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private blockedSnapshot(mint: string, observedAt: Date, reason: string): EnrichmentSnapshot {
    return {
      mint,
      observedAt,
      usdPrice: null,
      swapCount: null,
      firstSwapType: null,
      firstSwapExchange: null,
      priceCall: { ok: false, status: null, errorMessage: reason },
      swapsCall: { ok: false, status: null, errorMessage: reason },
    };
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function getProp<T = unknown>(obj: unknown, key: string): T | undefined {
  return isObject(obj) ? (obj[key] as T | undefined) : undefined;
}
function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}
function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.length > 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function extractUsdPrice(body: unknown): number | null {
  return (
    asNumber(getProp(body, "usdPrice")) ??
    asNumber(getProp(body, "usd_price")) ??
    asNumber(getProp(body, "price")) ??
    null
  );
}

export function extractSwaps(body: unknown): unknown[] {
  const result = getProp(body, "result");
  if (Array.isArray(result)) return result;
  const swaps = getProp(body, "swaps");
  if (Array.isArray(swaps)) return swaps;
  return Array.isArray(body) ? (body as unknown[]) : [];
}
