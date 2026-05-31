/**
 * Shared parser for the pump.fun frontend API coin shape.
 *
 * Used by both FeedPumpFunProvider (list endpoint) and
 * PumpFunCoinEnrichmentService (single-coin endpoint).
 * Both endpoints return the same object structure.
 *
 * Keep this file free of side-effects and external dependencies.
 */

import { TokenLaunch, TokenSocialLinks } from "../types";

// ── Wire shape returned by pump.fun frontend-api-v3 ──────────────────────────

export interface ApiCoin {
  // Identity (stable after creation)
  mint?: unknown;
  creator?: unknown;
  name?: unknown;
  symbol?: unknown;
  created_timestamp?: unknown;
  // Market data (changes over time)
  usd_market_cap?: unknown;
  market_cap?: unknown;          // may be SOL-denominated; usd_market_cap preferred
  buy_count?: unknown;
  sell_count?: unknown;
  volume_usd?: unknown;
  volume?: unknown;              // may be SOL-denominated; volume_usd preferred
  bonding_curve_progress?: unknown;
  virtual_sol_reserves?: unknown; // lamports fallback for bonding curve calc
  // Social
  twitter?: unknown;
  telegram?: unknown;
  website?: unknown;
}

// Pump.fun graduation threshold in lamports (~85 SOL)
const GRADUATION_LAMPORTS = 85_000_000_000;

// Solana base58 mint address: 32–44 chars, base58 alphabet
export const MINT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

// ── Internal helpers ──────────────────────────────────────────────────────────

export function isNonEmptyStr(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function safeFloat(v: unknown, min: number, max: number): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  if (v < min || v > max) return null;
  return v;
}

function safeNonNegInt(v: unknown): number {
  const n = typeof v === "number" ? Math.floor(v) : Number.parseInt(String(v), 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// ── Public parser ─────────────────────────────────────────────────────────────

/**
 * Parse a raw pump.fun API coin object into a `TokenLaunch`.
 *
 * Returns null when required identity fields (mint, creator, created_timestamp)
 * are missing or malformed. Optional market/social fields degrade gracefully to
 * zero/empty values — they do NOT cause a null return.
 */
export function parsePumpFunCoin(raw: unknown): TokenLaunch | null {
  if (typeof raw !== "object" || raw === null) return null;
  const c = raw as ApiCoin;

  // Required identity fields
  if (!isNonEmptyStr(c.mint) || !MINT_RE.test(c.mint)) return null;
  if (!isNonEmptyStr(c.creator)) return null;
  const ts = c.created_timestamp;
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return null;

  const symbol = isNonEmptyStr(c.symbol) ? (c.symbol as string).trim() : "UNKNOWN";
  const name   = isNonEmptyStr(c.name)   ? (c.name as string).trim()   : symbol;

  // Market cap — USD field preferred over raw SOL-denominated market_cap
  const marketCapUsd =
    safeFloat(c.usd_market_cap, 0, Infinity) ??
    safeFloat(c.market_cap,     0, Infinity) ??
    0;

  const buyCount  = safeNonNegInt(c.buy_count);
  const sellCount = safeNonNegInt(c.sell_count);

  // Volume — USD field preferred
  const volumeUsd =
    safeFloat(c.volume_usd, 0, Infinity) ??
    safeFloat(c.volume,     0, Infinity) ??
    0;

  // Bonding curve progress (0–1 float).
  // Direct field when present; fall back to computing from virtual_sol_reserves.
  let bondingCurveProgress = safeFloat(c.bonding_curve_progress, 0, 1) ?? null;
  if (bondingCurveProgress === null) {
    const solRes = safeFloat(c.virtual_sol_reserves, 0, Infinity);
    if (solRes !== null && solRes > 0) {
      bondingCurveProgress = Math.min(1, solRes / GRADUATION_LAMPORTS);
    }
  }
  bondingCurveProgress = bondingCurveProgress ?? 0;

  // Social links — all optional
  const twitter  = isNonEmptyStr(c.twitter)  ? (c.twitter as string).trim()  : undefined;
  const telegram = isNonEmptyStr(c.telegram) ? (c.telegram as string).trim() : undefined;
  const website  = isNonEmptyStr(c.website)  ? (c.website as string).trim()  : undefined;
  const socialLinks: TokenSocialLinks | undefined =
    twitter || telegram || website ? { twitter, telegram, website } : undefined;

  return {
    mint:                (c.mint as string).trim(),
    name,
    symbol,
    creatorWallet:       (c.creator as string).trim(),
    launchedAt:          new Date(ts),
    initialMarketCapUsd: marketCapUsd,
    bondingCurveProgress,
    buyCount,
    sellCount,
    volumeUsd,
    socialLinks,
  };
}

/**
 * Quick check: does this TokenLaunch have meaningful enrichment data?
 * Returns false when the token is still in its "detected but not enriched" state.
 */
export function isEnriched(token: Pick<TokenLaunch, "name" | "symbol" | "initialMarketCapUsd">): boolean {
  return (
    token.name !== "Unknown" &&
    token.symbol !== "UNKNOWN" &&
    token.initialMarketCapUsd > 0
  );
}
