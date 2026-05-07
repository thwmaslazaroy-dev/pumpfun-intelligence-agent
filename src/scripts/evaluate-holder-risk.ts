/**
 * evaluate-holder-risk
 *
 * Reads mints from the budgeted watchlist, fetches holder distribution via
 * Helius JSON-RPC (getTokenLargestAccounts + getTokenSupply), computes
 * concentration metrics, and stores a risk label in holder_risk_evaluations.
 *
 * Run AFTER generate:budgeted:watchlist and BEFORE preview:high-confidence:alerts.
 * No Discord, no radar loop changes, no feed ingestion changes.
 *
 * Provider: Helius JSON-RPC
 *   Priority 1 — HELIUS_API_KEY env var  → https://mainnet.helius-rpc.com/?api-key=KEY
 *   Priority 2 — SOLANA_RPC_HTTP_URL if it contains "helius" (case-insensitive)
 *
 * Note v1 limitation: getTokenLargestAccounts returns token-account addresses,
 * not wallet addresses. creatorHoldPercent requires getAccountInfo per account
 * to resolve the owner — deferred to v2. All v1 results store creator=null.
 */

import * as fs from "fs";
import * as path from "path";
import { config } from "../config";
import { logger } from "../utils/logger";
import { initDatabase, closeDatabase, getDatabase } from "../storage";

// ── Config ────────────────────────────────────────────────────────────────────

const HELIUS_BASE = "https://mainnet.helius-rpc.com";
const REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_WATCHLIST_PATH = "./data/budgeted-outcome-watchlist.txt";

function readPosInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function resolveRpcEndpoint(): { url: string; source: string } | null {
  const heliusKey = (process.env["HELIUS_API_KEY"] ?? "").trim();
  if (heliusKey) {
    return { url: `${HELIUS_BASE}/?api-key=${heliusKey}`, source: "HELIUS_API_KEY" };
  }
  const existing = (config.solanaRpcHttpUrl ?? "").trim();
  if (existing && /helius/i.test(existing)) {
    return { url: existing, source: "SOLANA_RPC_HTTP_URL (Helius)" };
  }
  return null;
}

// ── Types ─────────────────────────────────────────────────────────────────────

type HolderRiskLabel = "LOW" | "MEDIUM" | "HIGH" | "EXTREME";

interface HolderEntry {
  address: string;         // token-account address (not wallet address in v1)
  percentOfSupply: number; // 0–100, derived from uiAmount / totalSupply
}

interface HolderFetchResult {
  holders: HolderEntry[];
  apiError: string | null;
}

interface HolderMetrics {
  largestWalletPercent: number;
  top10HolderPercent: number;
  creatorHoldPercent: number | null; // null in v1 — see file header
}

interface RiskClassification {
  label: HolderRiskLabel;
  reason: string;
}

// ── JSON-RPC helpers ──────────────────────────────────────────────────────────

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

let nextRpcId = 1;

interface RpcResponse {
  result?: unknown;
  error?: { code: number; message: string };
}

async function rpcCall(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<RpcResponse> {
  const body = { jsonrpc: "2.0", id: nextRpcId++, method, params };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as RpcResponse;
  } finally {
    clearTimeout(timer);
  }
}

// ── Helius holder fetch ───────────────────────────────────────────────────────

async function fetchTotalSupply(mint: string, rpcUrl: string): Promise<number | null> {
  try {
    const res = await rpcCall(rpcUrl, "getTokenSupply", [mint]);
    if (res.error) return null;
    const value = isObject(res.result) ? res.result["value"] : null;
    if (!isObject(value)) return null;
    const ui = asNumber(value["uiAmount"]);
    return ui !== null && ui > 0 ? ui : null;
  } catch {
    return null;
  }
}

async function fetchHolders(mint: string, rpcUrl: string): Promise<HolderFetchResult> {
  let largestRes: RpcResponse;
  try {
    largestRes = await rpcCall(rpcUrl, "getTokenLargestAccounts", [mint]);
  } catch (err) {
    return {
      holders: [],
      apiError: err instanceof Error ? err.message : String(err),
    };
  }

  if (largestRes.error) {
    return {
      holders: [],
      apiError: `RPC error ${largestRes.error.code}: ${largestRes.error.message}`,
    };
  }

  // result.value: [{ address, amount, decimals, uiAmount, uiAmountString }]
  const value = isObject(largestRes.result) ? largestRes.result["value"] : null;
  if (!Array.isArray(value)) {
    return {
      holders: [],
      apiError: "getTokenLargestAccounts: result.value is not an array",
    };
  }

  const totalSupply = await fetchTotalSupply(mint, rpcUrl);
  if (totalSupply === null) {
    return {
      holders: [],
      apiError: "getTokenSupply returned no usable uiAmount — cannot compute percentages",
    };
  }

  const holders: HolderEntry[] = [];
  for (const item of value) {
    if (!isObject(item)) continue;
    const addr = asString(item["address"]);
    if (!addr) continue;
    const ui = asNumber(item["uiAmount"]);
    if (ui === null || ui <= 0) continue;
    holders.push({
      address: addr,
      percentOfSupply: (ui / totalSupply) * 100,
    });
  }

  // RPC already returns descending by balance; sort defensively
  holders.sort((a, b) => b.percentOfSupply - a.percentOfSupply);

  return { holders, apiError: null };
}

// ── Metrics computation ───────────────────────────────────────────────────────

function computeMetrics(holders: HolderEntry[]): HolderMetrics {
  const largestWalletPercent = holders.length > 0 ? holders[0].percentOfSupply : 0;
  const top10HolderPercent = holders
    .slice(0, 10)
    .reduce((s, h) => s + h.percentOfSupply, 0);

  // v1: token-account addresses ≠ wallet addresses; owner resolution deferred
  return {
    largestWalletPercent,
    top10HolderPercent,
    creatorHoldPercent: null,
  };
}

// ── Risk classification ───────────────────────────────────────────────────────

function classifyRisk(m: HolderMetrics): RiskClassification {
  const { largestWalletPercent: lw, top10HolderPercent: t10, creatorHoldPercent: cr } = m;
  const parts: string[] = [];

  // EXTREME — highest priority
  if (lw >= 20 || t10 >= 50 || (cr !== null && cr >= 20)) {
    if (lw >= 20) parts.push(`largest=${lw.toFixed(1)}%>=20%`);
    if (t10 >= 50) parts.push(`top10=${t10.toFixed(1)}%>=50%`);
    if (cr !== null && cr >= 20) parts.push(`creator=${cr.toFixed(1)}%>=20%`);
    return { label: "EXTREME", reason: parts.join(" ") };
  }

  // HIGH
  if (lw > 7 || t10 > 35 || (cr !== null && cr > 7)) {
    if (lw > 7) parts.push(`largest=${lw.toFixed(1)}%>7%`);
    if (t10 > 35) parts.push(`top10=${t10.toFixed(1)}%>35%`);
    if (cr !== null && cr > 7) parts.push(`creator=${cr.toFixed(1)}%>7%`);
    return { label: "HIGH", reason: parts.join(" ") };
  }

  // LOW
  if (lw <= 3 && t10 <= 25) {
    return {
      label: "LOW",
      reason: `largest=${lw.toFixed(1)}%<=3% top10=${t10.toFixed(1)}%<=25%`,
    };
  }

  // MEDIUM (catch-all: 3 < lw <= 7 or 25 < t10 <= 35)
  return {
    label: "MEDIUM",
    reason: `largest=${lw.toFixed(1)}% top10=${t10.toFixed(1)}%`,
  };
}

// ── DB helpers ────────────────────────────────────────────────────────────────

interface HolderRiskRow {
  mint: string;
  evaluated_at: number;
}

function findExistingEval(mint: string): HolderRiskRow | null {
  const db = getDatabase();
  return (
    (db
      .prepare("SELECT mint, evaluated_at FROM holder_risk_evaluations WHERE mint = ?")
      .get(mint) as HolderRiskRow | undefined) ?? null
  );
}

function saveHolderRisk(
  mint: string,
  label: HolderRiskLabel,
  reason: string,
  metrics: HolderMetrics,
): void {
  const db = getDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO holder_risk_evaluations
       (mint, holder_risk_label, holder_risk_reason, creator_hold_percent,
        largest_wallet_percent, top10_holder_percent, evaluated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    mint,
    label,
    reason.slice(0, 500),
    metrics.creatorHoldPercent,
    metrics.largestWalletPercent,
    metrics.top10HolderPercent,
    Date.now(),
  );
}

function lookupCreatorWallet(mint: string): string | null {
  const db = getDatabase();
  const row = db
    .prepare("SELECT creator_wallet FROM tokens WHERE mint = ?")
    .get(mint) as { creator_wallet: string } | undefined;
  return row?.creator_wallet ?? null;
}

// ── Watchlist reader ──────────────────────────────────────────────────────────

function readWatchlist(filePath: string): string[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const watchlistPathRaw =
    process.env["OUTCOME_WATCHLIST_PATH"] ?? DEFAULT_WATCHLIST_PATH;
  const watchlistPath = path.isAbsolute(watchlistPathRaw)
    ? watchlistPathRaw
    : path.resolve(process.cwd(), watchlistPathRaw);
  const maxTokens = readPosInt("HOLDER_RISK_MAX_TOKENS", 5);
  const rpcEndpoint = resolveRpcEndpoint();

  logger.info("evaluate:holder-risk starting", {
    provider: "helius",
    rpcSource: rpcEndpoint?.source ?? "none — will exit",
    watchlistPath,
    maxTokens,
    databaseUrl: config.databaseUrl,
  });

  if (!rpcEndpoint) {
    process.stdout.write(
      "\nWARNING: No Helius RPC endpoint configured.\n" +
        "  Option 1: Set HELIUS_API_KEY=<your-key> in .env\n" +
        "  Option 2: Set SOLANA_RPC_HTTP_URL to a Helius endpoint URL\n" +
        "             (URL must contain 'helius' for auto-detection)\n" +
        "  Skipping all mints — no fake results written.\n\n",
    );
    process.exit(0);
  }

  const allMints = readWatchlist(watchlistPath);
  if (allMints.length === 0) {
    process.stdout.write(
      `\nWatchlist is empty or missing at ${watchlistPath}.\n` +
        "  Run generate:budgeted:watchlist first.\n\n",
    );
    process.exit(0);
  }

  const mints = allMints.slice(0, maxTokens);
  initDatabase(config.databaseUrl);

  const counters = {
    processed: 0,
    skipped: 0,
    apiErrors: 0,
    low: 0,
    medium: 0,
    high: 0,
    extreme: 0,
  };

  for (const mint of mints) {
    const existing = findExistingEval(mint);
    if (existing !== null) {
      counters.skipped += 1;
      logger.info("evaluate:holder-risk skipping already-evaluated mint", {
        mint: mint.slice(0, 16) + "…",
        evaluatedAt: new Date(existing.evaluated_at).toISOString(),
      });
      continue;
    }

    const creatorWallet = lookupCreatorWallet(mint);

    logger.info("evaluate:holder-risk fetching holders", {
      provider: "helius",
      mint: mint.slice(0, 16) + "…",
      creatorWalletKnown: Boolean(creatorWallet),
    });

    const { holders, apiError } = await fetchHolders(mint, rpcEndpoint.url);

    if (apiError !== null) {
      counters.apiErrors += 1;
      logger.warn("evaluate:holder-risk API error", {
        provider: "helius",
        mint: mint.slice(0, 16) + "…",
        error: apiError,
      });
      continue;
    }

    if (holders.length === 0) {
      counters.apiErrors += 1;
      logger.warn("evaluate:holder-risk no holders returned", {
        provider: "helius",
        mint: mint.slice(0, 16) + "…",
      });
      continue;
    }

    const metrics = computeMetrics(holders);
    const { label, reason: baseReason } = classifyRisk(metrics);
    // Append v1 note so downstream consumers know creator was not checked
    const reason = `${baseReason} creator=n/a(v1)`;

    saveHolderRisk(mint, label, reason, metrics);
    counters.processed += 1;
    counters[label.toLowerCase() as "low" | "medium" | "high" | "extreme"] += 1;

    logger.info("evaluate:holder-risk result", {
      provider: "helius",
      mint: mint.slice(0, 16) + "…",
      label,
      reason,
      largestWalletPercent: metrics.largestWalletPercent.toFixed(2),
      top10HolderPercent: metrics.top10HolderPercent.toFixed(2),
      creatorHoldPercent: "n/a — token-account addresses not resolved to wallets in v1",
      holdersReturned: holders.length,
    });
  }

  closeDatabase();

  process.stdout.write("\n=== holder risk summary ===\n");
  process.stdout.write(`  processed:  ${counters.processed}\n`);
  process.stdout.write(`  skipped:    ${counters.skipped}\n`);
  process.stdout.write(`  low:        ${counters.low}\n`);
  process.stdout.write(`  medium:     ${counters.medium}\n`);
  process.stdout.write(`  high:       ${counters.high}\n`);
  process.stdout.write(`  extreme:    ${counters.extreme}\n`);
  process.stdout.write(`  apiErrors:  ${counters.apiErrors}\n`);
  process.stdout.write("\n");

  if (counters.apiErrors > 0) {
    process.stdout.write(
      "  NOTE: apiErrors > 0. Common causes:\n" +
        "    - Token is very new and has no on-chain holder data yet\n" +
        "    - Helius RPC rate limit hit\n" +
        "    - Token mint not found (migrated, rugged, or non-standard)\n\n",
    );
  }
}

void main().catch((err) => {
  logger.error("evaluate:holder-risk unhandled error", {
    error: err instanceof Error ? err.message : String(err),
  });
  closeDatabase();
  process.exit(1);
});
