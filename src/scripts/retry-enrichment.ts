/**
 * retry:enrichment
 *
 * Backfill enrichment data for tokens saved as name="Unknown" in the last 24h.
 *
 * Two-pass strategy:
 *   Pass 1 (zero API cost): apply any cached enrichment data that was fetched
 *          previously but not persisted due to the SQL case bug.
 *   Pass 2 (uses budget): call the pump.fun API for tokens with no cache entry,
 *          respecting all budget limits.
 *
 * By default, high-frequency creators (Rule C) are skipped.
 * Use --include-bots to override.
 *
 * Usage:
 *   npm run retry:enrichment -- --dry-run              # preview only
 *   npm run retry:enrichment -- --dry-run --limit 50
 *   npm run retry:enrichment -- --yes                  # run for real
 *   npm run retry:enrichment -- --yes --limit 100
 *   npm run retry:enrichment -- --yes --include-bots
 */

import * as dotenv from "dotenv";
dotenv.config();

import { config } from "../config";
import { logger } from "../utils/logger";
import { initDatabase, getDatabase, closeDatabase, SqliteTokenRepository } from "../storage";
import { initRequestBudgetManager } from "../services/request-budget-manager";
import { PumpFunCoinEnrichmentService } from "../services/pumpfun-coin-enrichment-service";
import { TokenLaunch, TokenSocialLinks } from "../types";

// ── Constants ─────────────────────────────────────────────────────────────────

const DAY_MS              = 86_400_000;
const RULE_C_MIN_LAUNCHES = 10;
const RULE_C_WINDOW_MS    = 10_800_000; // 3 hours — mirrors enrichment-filter.ts

// ── CLI parsing ───────────────────────────────────────────────────────────────

interface CliArgs {
  dryRun:       boolean;
  yes:          boolean;
  limit:        number;
  includeBots:  boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const dryRun      = argv.includes("--dry-run");
  const yes         = argv.includes("--yes");
  const includeBots = argv.includes("--include-bots");

  let limit = 200;
  const li = argv.indexOf("--limit");
  if (li !== -1 && argv[li + 1]) {
    const n = Number.parseInt(argv[li + 1]!, 10);
    if (Number.isFinite(n) && n > 0) limit = n;
  }

  return { dryRun, yes, limit, includeBots };
}

// ── DB row types ──────────────────────────────────────────────────────────────

interface UnknownTokenRow {
  mint:                  string;
  name:                  string;
  symbol:                string;
  creator_wallet:        string;
  launched_at:           number;
  inserted_at:           number;
  initial_market_cap_usd: number;
  bonding_curve_progress: number;
  buy_count:             number;
  sell_count:            number;
  volume_usd:            number;
  social_links_json:     string | null;
}

interface CreatorRow {
  total_launches: number;
  last_seen_at:   number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function isRuleCCreator(creatorWallet: string, nowMs: number): boolean {
  const db = getDatabase();
  const row = db.prepare(
    "SELECT total_launches, last_seen_at FROM creators WHERE creator_wallet = ?"
  ).get(creatorWallet) as CreatorRow | undefined;
  if (!row) return false;
  return row.total_launches >= RULE_C_MIN_LAUNCHES &&
         (nowMs - row.last_seen_at) < RULE_C_WINDOW_MS;
}

function rowToTokenLaunch(row: UnknownTokenRow): TokenLaunch {
  let socialLinks: TokenSocialLinks | undefined;
  if (row.social_links_json) {
    try { socialLinks = JSON.parse(row.social_links_json) as TokenSocialLinks; } catch { /* ignore */ }
  }
  return {
    mint:                 row.mint,
    name:                 row.name,
    symbol:               row.symbol,
    creatorWallet:        row.creator_wallet,
    launchedAt:           new Date(row.launched_at),
    initialMarketCapUsd:  row.initial_market_cap_usd,
    bondingCurveProgress: row.bonding_curve_progress,
    buyCount:             row.buy_count,
    sellCount:            row.sell_count,
    volumeUsd:            row.volume_usd,
    socialLinks,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Require explicit action
  if (!args.dryRun && !args.yes) {
    process.stdout.write(`
retry:enrichment — backfill enrichment for Unknown tokens (last 24h)

You must pass one of:
  --dry-run        Preview what would be updated without making any changes.
  --yes            Run for real (respects budget limits).

Options:
  --limit N        Process at most N tokens (default 200).
  --include-bots   Also retry high-frequency creators skipped by Rule C.

Examples:
  npm run retry:enrichment -- --dry-run --limit 50
  npm run retry:enrichment -- --yes
  npm run retry:enrichment -- --yes --limit 100 --include-bots
`);
    process.exit(0);
  }

  // ── Initialise infrastructure ──────────────────────────────────────────────
  initDatabase(config.databaseUrl);

  const budget = initRequestBudgetManager({
    limits: {
      helius_http:      { perMinute: config.budgetHeliusHttpPerMin, perHour: config.budgetHeliusHttpPerHour, perDay: config.budgetHeliusHttpPerDay },
      helius_ws:        { perMinute: 120, perHour: 5_000, perDay: 50_000 },
      pumpfun_frontend: { perMinute: config.budgetPumpfunFrontendPerMin, perHour: config.budgetPumpfunFrontendPerHour, perDay: config.budgetPumpfunFrontendPerDay },
      moralis:          { perMinute: config.budgetMoralisPerMin, perHour: config.budgetMoralisPerHour, perDay: config.budgetMoralisPerDay },
      discord:          { perMinute: config.budgetDiscordPerMin, perHour: config.budgetDiscordPerHour, perDay: config.budgetDiscordPerDay },
    },
    warnPct:      config.budgetWarnPct,
    pausePct:     config.budgetPausePct,
    emergencyPct: config.budgetEmergencyPct,
  });

  const repo = new SqliteTokenRepository();
  const enrichmentService = new PumpFunCoinEnrichmentService({
    budgetManager: budget,
    cacheTtlMs:    config.cacheEnrichmentTtlMs,
  });

  // ── Query Unknown tokens ───────────────────────────────────────────────────
  const db = getDatabase();
  const since = Date.now() - DAY_MS;

  // Prioritise tokens that already have a cache entry (Pass 1, zero API cost).
  // Among each group, newest first so the most recent data gets fixed first.
  const allUnknown = db.prepare(`
    SELECT
      t.mint, t.name, t.symbol, t.creator_wallet, t.launched_at, t.inserted_at,
      t.initial_market_cap_usd, t.bonding_curve_progress,
      t.buy_count, t.sell_count, t.volume_usd, t.social_links_json
    FROM tokens t
    LEFT JOIN token_enrichment_cache ec ON ec.mint = t.mint
    WHERE t.inserted_at >= ?
      AND t.name IN ('', 'Unknown', 'UNKNOWN')
    ORDER BY
      CASE WHEN ec.mint IS NOT NULL AND ec.name NOT IN ('','Unknown','UNKNOWN') THEN 0 ELSE 1 END,
      t.inserted_at DESC
    LIMIT ?
  `).all(since, args.limit) as UnknownTokenRow[];

  const now = Date.now();

  // Classify into: cache-ready, needs-api, rule-c-skipped
  interface Classified {
    token:     UnknownTokenRow;
    hasCacheEntry: boolean;
    cacheHasRealName: boolean;
    isRuleC:   boolean;
  }

  const classified: Classified[] = [];
  for (const row of allUnknown) {
    const isRuleC    = !args.includeBots && isRuleCCreator(row.creator_wallet, now);
    const cacheEntry = budget.getEnrichmentCache(row.mint);
    const hasCacheEntry     = cacheEntry !== null;
    const cacheHasRealName  = cacheEntry !== null &&
                               cacheEntry.name !== null &&
                               !["", "Unknown", "UNKNOWN"].includes(cacheEntry.name);
    classified.push({ token: row, hasCacheEntry, cacheHasRealName, isRuleC });
  }

  const ruleCSkipped   = classified.filter((c) => c.isRuleC);
  const cacheReady     = classified.filter((c) => !c.isRuleC && c.cacheHasRealName);
  const needsApi       = classified.filter((c) => !c.isRuleC && !c.cacheHasRealName);
  const budgetForApi   = budget.getRemainingBudget("pumpfun_frontend");

  // ── Pre-flight summary ─────────────────────────────────────────────────────
  process.stdout.write("\n=== retry:enrichment pre-flight ===\n");
  process.stdout.write(`  mode:                  ${args.dryRun ? "DRY RUN" : "LIVE"}\n`);
  process.stdout.write(`  Unknown tokens found:  ${allUnknown.length}  (last 24h, limit=${args.limit})\n`);
  process.stdout.write(`  Skipped by Rule C:     ${ruleCSkipped.length}  (high-frequency bots${args.includeBots ? " — overridden by --include-bots" : ""})\n`);
  process.stdout.write(`  Pass 1 (cache→DB):     ${cacheReady.length}  (zero API cost — apply cached data)\n`);
  process.stdout.write(`  Pass 2 (API calls):    ${needsApi.length}  (uses pumpfun_frontend budget)\n`);
  process.stdout.write(`  Budget remaining/day:  ${budgetForApi.day.remaining}  (${budgetForApi.dayUsagePct.toFixed(1)}% used)\n`);
  process.stdout.write(`  Budget remaining/hour: ${budgetForApi.hour.remaining}\n`);

  const apiWillBeBlocked = needsApi.length > 0 && budgetForApi.day.remaining === 0;
  if (apiWillBeBlocked) {
    process.stdout.write("  ⚠️  pumpfun_frontend day budget exhausted — Pass 2 will be skipped.\n");
    process.stdout.write("  Only Pass 1 (cache→DB) will run. Resets at midnight UTC.\n");
  }

  if (args.dryRun) {
    process.stdout.write("\n[DRY RUN] No changes made.\n");
    if (cacheReady.length > 0) {
      process.stdout.write("\n  Sample cache-ready tokens that would be updated:\n");
      for (const c of cacheReady.slice(0, 8)) {
        const ce = budget.getEnrichmentCache(c.token.mint)!;
        process.stdout.write(`  ${c.token.mint.slice(0, 12)}…  ${(ce.symbol ?? "?").padEnd(10)} ${ce.name ?? "?"}\n`);
      }
    }
    if (needsApi.length > 0) {
      process.stdout.write("\n  Sample tokens that would need API enrichment:\n");
      for (const c of needsApi.slice(0, 5)) {
        process.stdout.write(`  ${c.token.mint.slice(0, 12)}…  inserted ${new Date(c.token.inserted_at).toISOString().slice(11, 19)}\n`);
      }
    }
    closeDatabase();
    return;
  }

  // ── Pass 1: Apply cached enrichment data ────────────────────────────────────
  process.stdout.write("\n[PASS 1] Applying cached enrichment data...\n");
  let pass1Updated = 0;
  let pass1Skipped = 0;

  for (const c of cacheReady) {
    const cacheEntry = budget.getEnrichmentCache(c.token.mint)!;
    const base       = rowToTokenLaunch(c.token);

    // Merge cache into a full TokenLaunch
    let socialLinks: TokenSocialLinks | undefined = base.socialLinks;
    if (cacheEntry.socialLinksJson) {
      try { socialLinks = JSON.parse(cacheEntry.socialLinksJson) as TokenSocialLinks; } catch { /* keep original */ }
    }

    const enriched: TokenLaunch = {
      ...base,
      name:                 cacheEntry.name                ?? base.name,
      symbol:               cacheEntry.symbol              ?? base.symbol,
      initialMarketCapUsd:  cacheEntry.marketCapUsd        ?? base.initialMarketCapUsd,
      bondingCurveProgress: cacheEntry.bondingCurveProgress ?? base.bondingCurveProgress,
      buyCount:             cacheEntry.buyCount             ?? base.buyCount,
      sellCount:            cacheEntry.sellCount            ?? base.sellCount,
      volumeUsd:            cacheEntry.volumeUsd            ?? base.volumeUsd,
      socialLinks,
    };

    try {
      repo.upsertTokenFeedData(enriched);
      pass1Updated += 1;
      logger.info("retry: pass1 cache→DB updated", {
        mint:   c.token.mint.slice(0, 8) + "…",
        name:   enriched.name,
        symbol: enriched.symbol,
      });
    } catch (err) {
      pass1Skipped += 1;
      logger.warn("retry: pass1 upsert failed", {
        mint:  c.token.mint.slice(0, 8) + "…",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  process.stdout.write(`  Pass 1 done: ${pass1Updated} updated, ${pass1Skipped} errors.\n`);

  // ── Pass 2: API enrichment for tokens without cache ────────────────────────
  process.stdout.write("\n[PASS 2] Fetching enrichment from pump.fun API...\n");
  let pass2Updated = 0;
  let pass2Failed  = 0;
  let pass2BudgetBlocked = 0;

  for (let i = 0; i < needsApi.length; i++) {
    const c = needsApi[i]!;

    // Re-check budget before each call
    const check = budget.allowRequest("pumpfun_frontend", "MEDIUM");
    if (!check.allowed) {
      pass2BudgetBlocked += (needsApi.length - i);
      logger.warn("retry: pass2 budget exhausted — stopping", {
        reason:    check.reason,
        remaining: i,
        of:        needsApi.length,
      });
      process.stdout.write(`  Budget blocked at token ${i + 1}/${needsApi.length}. Stopping Pass 2.\n`);
      break;
    }

    const minimal = rowToTokenLaunch(c.token);

    try {
      const { token: enriched, outcome } = await enrichmentService.enrichMint(minimal);

      if (outcome.enriched && !outcome.cacheHit) {
        repo.upsertTokenFeedData(enriched);
        pass2Updated += 1;
        logger.info("retry: pass2 API→DB updated", {
          mint:        c.token.mint.slice(0, 8) + "…",
          name:        enriched.name,
          symbol:      enriched.symbol,
          mintMismatch: outcome.mintMismatch,
        });
      } else if (outcome.cacheHit) {
        // Shouldn't happen (we only put no-cache tokens in pass2), but handle gracefully
        repo.upsertTokenFeedData(enriched);
        pass2Updated += 1;
      } else {
        pass2Failed += 1;
        logger.debug("retry: pass2 enrichment returned no real data", {
          mint:   c.token.mint.slice(0, 8) + "…",
          reason: outcome.failureReason,
        });
      }
    } catch (err) {
      pass2Failed += 1;
      logger.warn("retry: pass2 exception", {
        mint:  c.token.mint.slice(0, 8) + "…",
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Brief delay between API calls
    if (i < needsApi.length - 1) {
      await sleep(200);
    }
  }

  process.stdout.write(`  Pass 2 done: ${pass2Updated} updated, ${pass2Failed} failed, ${pass2BudgetBlocked} budget-blocked.\n`);

  // ── Summary ────────────────────────────────────────────────────────────────
  closeDatabase();

  const totalUpdated = pass1Updated + pass2Updated;
  process.stdout.write("\n=== retry:enrichment summary ===\n");
  process.stdout.write(`  Total Unknown tokens scanned:   ${allUnknown.length}\n`);
  process.stdout.write(`  Skipped (Rule C bots):          ${ruleCSkipped.length}\n`);
  process.stdout.write(`  Pass 1 updated (cache):         ${pass1Updated}\n`);
  process.stdout.write(`  Pass 2 updated (API):           ${pass2Updated}\n`);
  process.stdout.write(`  Pass 2 failed:                  ${pass2Failed}\n`);
  process.stdout.write(`  Pass 2 budget-blocked:          ${pass2BudgetBlocked}\n`);
  process.stdout.write(`  Total updated:                  ${totalUpdated}\n`);
  process.stdout.write("\nRun 'npm run report:enrichment' to see the updated state.\n");
}

void main().catch((err) => {
  logger.error("retry:enrichment unhandled error", {
    error: err instanceof Error ? err.message : String(err),
  });
  closeDatabase();
  process.exit(1);
});
