import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import {
  classifyCreator,
  computeCreatorSuccessScore,
  computeCreatorTier,
  computeMinBurstWindowSec,
  computeMintMetrics,
  CreatorRow,
  CreatorSuccessScoreInput,
  JoinRow,
  tokenHasActivity,
} from "../lib/budgeted-watchlist-core";

// ── Row types from SQLite ─────────────────────────────────────────────────────

interface LaunchStatsRow {
  creator_wallet: string;
  launches: number;
  total_volume: number;
  first_at: number;
  last_at: number;
}

interface TokenActivityRow {
  creator_wallet: string;
  buy_count: number;
  sell_count: number;
  volume_usd: number;
  bonding_curve_progress: number;
}

interface TokenDetailRow {
  launched_at: number;
  symbol: string;
  mint: string;
  initial_market_cap_usd: number;
  buy_count: number;
  sell_count: number;
  volume_usd: number;
}

interface LatestOutcomeRow {
  mint: string;
  usd_price: number | null;
  swap_count: number | null;
}

// ── Internal aggregate ────────────────────────────────────────────────────────

interface CreatorAgg {
  launchesTracked: number;
  gainSum: number;
  gainCount: number;
  labelCounts: Record<string, number>;
  totalSwaps: number;
  pricedRows: number;
}

interface HolderRiskCounts {
  extremeCount: number;
  highCount: number;
}

// ── Candidate record (post-filter) ───────────────────────────────────────────

interface CreatorCandidate {
  wallet: string;
  launches: number;
  launchesTracked: number;
  pricedRows: number;
  totalSwaps: number;
  totalVolumeUsd: number;
  zeroActivityCount: number;
  zeroActivityRate: number;
  minBurstWindowSec: number | null;
  extremeHolderCount: number;
  highHolderCount: number;
  successScore: number;
  successScoreReason: string;
  tier: string;
  tierReason: string;
  avgGainPercent: number | null;
  strongGain: number;
  up: number;
  activeFlat: number;
  down: number;
  rugLike: number;
  noPrice: number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveDbPath(url: string): string {
  const stripped = url.startsWith("sqlite:") ? url.slice("sqlite:".length) : url;
  return path.isAbsolute(stripped) ? stripped : path.resolve(process.cwd(), stripped);
}

function shorten(s: string): string {
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}...${s.slice(-6)}`;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function fmtUsd(n: number | null): string {
  if (n === null || n === undefined) return "n/a";
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function fmtDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

function fmtPrice(p: number | null): string {
  if (p === null || p === undefined) return "n/a";
  if (p === 0) return "$0";
  if (p < 0.000001) return `$${p.toExponential(2)}`;
  if (p < 0.01) return `$${p.toFixed(7)}`;
  return `$${p.toFixed(4)}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const databaseUrl = process.env.DATABASE_URL ?? "./data/pumpfun-agent.sqlite";
  const dbPath = resolveDbPath(databaseUrl);
  const topN = (() => {
    const raw = process.env.CREATOR_CANDIDATES_LIMIT;
    if (!raw) return 30;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : 30;
  })();

  process.stdout.write("\n=== creator candidates report ===\n");
  process.stdout.write(`  database:  ${databaseUrl}\n`);
  process.stdout.write(`  generated: ${new Date().toISOString()}\n`);
  process.stdout.write(`  topN:      ${topN}\n`);

  if (!fs.existsSync(dbPath)) {
    process.stdout.write(`\nSQLite not found at ${dbPath}. Run ingestion first.\n`);
    process.exit(1);
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  try {
    // ── 1. Outcomes → per-mint metrics → aggregate by creator ─────────────────
    const joinRows = db
      .prepare(
        `SELECT t.mint, t.creator_wallet, o.observed_at, o.usd_price, o.swap_count
         FROM token_outcomes o
         INNER JOIN tokens t ON t.mint = o.mint
         ORDER BY o.observed_at ASC`,
      )
      .all() as JoinRow[];

    const byMint = new Map<string, JoinRow[]>();
    for (const r of joinRows) {
      let b = byMint.get(r.mint);
      if (!b) { b = []; byMint.set(r.mint, b); }
      b.push(r);
    }

    const byCreator = new Map<string, CreatorAgg>();
    for (const [mint, rows] of byMint.entries()) {
      const creator = rows[0].creator_wallet;
      const m = computeMintMetrics(mint, creator, rows);
      let agg = byCreator.get(creator);
      if (!agg) {
        agg = { launchesTracked: 0, gainSum: 0, gainCount: 0, labelCounts: {}, totalSwaps: 0, pricedRows: 0 };
        byCreator.set(creator, agg);
      }
      agg.launchesTracked += 1;
      if (typeof m.gainFromStartPercent === "number") { agg.gainSum += m.gainFromStartPercent; agg.gainCount += 1; }
      agg.labelCounts[m.outcomeLabel] = (agg.labelCounts[m.outcomeLabel] ?? 0) + 1;
      agg.totalSwaps += m.latestSwapCount ?? 0;
      agg.pricedRows += m.pricedObservationCount;
    }

    // ── 2. Per-creator launch stats from tokens table ─────────────────────────
    // Launch counts and timestamps (stable identity data)
    const launchStatsRows = db
      .prepare(
        `SELECT creator_wallet,
           COUNT(*) as launches,
           SUM(volume_usd) as total_volume,
           MIN(launched_at) as first_at,
           MAX(launched_at) as last_at
         FROM tokens
         GROUP BY creator_wallet`,
      )
      .all() as LaunchStatsRow[];

    const launchStatsByCreator = new Map<
      string,
      { launches: number; totalVolumeUsd: number; zeroActivityCount: number; firstLaunchAt: number; lastLaunchAt: number }
    >();
    for (const r of launchStatsRows) {
      launchStatsByCreator.set(r.creator_wallet, {
        launches: r.launches,
        totalVolumeUsd: r.total_volume ?? 0,
        zeroActivityCount: 0,   // filled in below using tokenHasActivity()
        firstLaunchAt: r.first_at,
        lastLaunchAt: r.last_at,
      });
    }

    // Per-token activity — computed via tokenHasActivity() so the definition matches
    // the per-token realActivity check and contradictions are impossible.
    const tokenActivityRows = db
      .prepare(
        "SELECT creator_wallet, buy_count, sell_count, volume_usd, bonding_curve_progress FROM tokens",
      )
      .all() as TokenActivityRow[];
    for (const r of tokenActivityRows) {
      const entry = launchStatsByCreator.get(r.creator_wallet);
      if (!entry) continue;
      if (!tokenHasActivity({
        buyCount: r.buy_count,
        sellCount: r.sell_count,
        volumeUsd: r.volume_usd,
        bondingCurveProgress: r.bonding_curve_progress,
      })) {
        entry.zeroActivityCount++;
      }
    }

    // ── 3. Burst detection — sorted timestamps per creator ────────────────────
    const tsRows = db
      .prepare(
        "SELECT creator_wallet, launched_at FROM tokens ORDER BY creator_wallet ASC, launched_at ASC",
      )
      .all() as { creator_wallet: string; launched_at: number }[];

    const timestampsByCreator = new Map<string, number[]>();
    for (const r of tsRows) {
      let arr = timestampsByCreator.get(r.creator_wallet);
      if (!arr) { arr = []; timestampsByCreator.set(r.creator_wallet, arr); }
      arr.push(r.launched_at);
    }

    const minBurstWindowSecByCreator = new Map<string, number>();
    for (const [w, ts] of timestampsByCreator.entries()) {
      const bw = computeMinBurstWindowSec(ts);
      if (bw !== null) minBurstWindowSecByCreator.set(w, bw);
    }

    // ── 4. Holder risk counts per creator ────────────────────────────────────
    const holderRiskByCreator = new Map<string, HolderRiskCounts>();
    let holderRiskDataAvailable = false;
    try {
      const hrRows = db
        .prepare(
          `SELECT t.creator_wallet,
             SUM(CASE WHEN h.holder_risk_label = 'EXTREME' THEN 1 ELSE 0 END) as extreme_count,
             SUM(CASE WHEN h.holder_risk_label = 'HIGH'    THEN 1 ELSE 0 END) as high_count
           FROM holder_risk_evaluations h
           JOIN tokens t ON t.mint = h.mint
           GROUP BY t.creator_wallet`,
        )
        .all() as { creator_wallet: string; extreme_count: number; high_count: number }[];
      for (const r of hrRows) {
        holderRiskByCreator.set(r.creator_wallet, {
          extremeCount: r.extreme_count ?? 0,
          highCount: r.high_count ?? 0,
        });
      }
      if (hrRows.length > 0) holderRiskDataAvailable = true;
    } catch { /* holder_risk_evaluations may not exist yet */ }

    // ── 5. Score + tier + filter every creator ────────────────────────────────
    let totalAnalyzed = 0;
    let spamDeadExcluded = 0;
    let burstExcluded = 0;
    let zeroActivityExcluded = 0;
    let massLowVolExcluded = 0;
    let holderRiskExcluded = 0;

    const candidates: CreatorCandidate[] = [];

    // Iterate all creators known from the tokens table
    for (const [wallet, stats] of launchStatsByCreator.entries()) {
      totalAnalyzed++;

      const agg = byCreator.get(wallet);
      const hr = holderRiskByCreator.get(wallet) ?? { extremeCount: 0, highCount: 0 };
      const burst = minBurstWindowSecByCreator.get(wallet) ?? null;
      const { launches, totalVolumeUsd, zeroActivityCount, firstLaunchAt, lastLaunchAt } = stats;
      const zeroActivityRate = launches > 0 ? zeroActivityCount / launches : 0;

      const lc = agg?.labelCounts ?? {};

      // Build CreatorRow so classifyCreator works
      const cr: CreatorRow = {
        creatorWallet: wallet,
        launchesTracked: agg?.launchesTracked ?? 0,
        avgGainPercent: agg && agg.gainCount > 0 ? agg.gainSum / agg.gainCount : null,
        strongGain: lc.STRONG_GAIN ?? 0,
        up: lc.UP ?? 0,
        activeFlat: lc.ACTIVE_FLAT ?? 0,
        flat: lc.FLAT ?? 0,
        noPrice: lc.NO_PRICE ?? 0,
        down: lc.DOWN ?? 0,
        rugLike: lc.RUG_LIKE ?? 0,
        creatorOutcomeLabel: "UNKNOWN",
      };
      cr.creatorOutcomeLabel = classifyCreator(cr);

      const ssInput: CreatorSuccessScoreInput = {
        launches,
        launchesTracked: agg?.launchesTracked ?? 0,
        strongGain: lc.STRONG_GAIN ?? 0,
        up: lc.UP ?? 0,
        activeFlat: lc.ACTIVE_FLAT ?? 0,
        noPrice: lc.NO_PRICE ?? 0,
        down: lc.DOWN ?? 0,
        rugLike: lc.RUG_LIKE ?? 0,
        extremeHolderCount: hr.extremeCount,
        highHolderCount: hr.highCount,
        firstLaunchAt,
        lastLaunchAt,
        minBurstWindowSec: burst,
        zeroActivityCount,
        totalVolumeUsd,
      };
      const ssResult = computeCreatorSuccessScore(ssInput);

      const totalSwaps = agg?.totalSwaps ?? 0;
      const pricedRows = agg?.pricedRows ?? 0;

      const tierResult = computeCreatorTier({
        launches,
        totalSwaps,
        pricedRows,
        extremeHolderCount: hr.extremeCount,
        successScore: ssResult.successScore,
        minBurstWindowSec: burst,
        zeroActivityRate: launches > 0 ? zeroActivityCount / launches : null,
      });

      // Exclusion 1: SPAM or DEAD tier
      if (tierResult.tier === "SPAM_CREATOR" || tierResult.tier === "DEAD_CREATOR") {
        spamDeadExcluded++;
        continue;
      }

      // Exclusion 2: burst (belt-and-suspenders for creators near the threshold)
      if (burst !== null && burst <= 120) {
        burstExcluded++;
        continue;
      }

      // Exclusion 3: zero activity rate (belt-and-suspenders for launches < 5)
      if (zeroActivityRate >= 0.8 && launches >= 3) {
        zeroActivityExcluded++;
        continue;
      }

      // Exclusion 4: many launches with near-zero total volume
      if (launches >= 10 && totalVolumeUsd <= 1.0) {
        massLowVolExcluded++;
        continue;
      }

      // Exclusion 5: HIGH or EXTREME holder risk (only when we have data)
      if (holderRiskDataAvailable && (hr.extremeCount > 0 || hr.highCount > 0)) {
        holderRiskExcluded++;
        continue;
      }

      candidates.push({
        wallet,
        launches,
        launchesTracked: agg?.launchesTracked ?? 0,
        pricedRows,
        totalSwaps,
        totalVolumeUsd,
        zeroActivityCount,
        zeroActivityRate,
        minBurstWindowSec: burst,
        extremeHolderCount: hr.extremeCount,
        highHolderCount: hr.highCount,
        successScore: ssResult.successScore,
        successScoreReason: ssResult.successScoreReason,
        tier: tierResult.tier,
        tierReason: tierResult.reason,
        avgGainPercent: cr.avgGainPercent,
        strongGain: lc.STRONG_GAIN ?? 0,
        up: lc.UP ?? 0,
        activeFlat: lc.ACTIVE_FLAT ?? 0,
        down: lc.DOWN ?? 0,
        rugLike: lc.RUG_LIKE ?? 0,
        noPrice: lc.NO_PRICE ?? 0,
      });
    }

    // Sort: successScore ↓, pricedRows ↓, totalSwaps ↓
    candidates.sort((a, b) => {
      if (b.successScore !== a.successScore) return b.successScore - a.successScore;
      if (b.pricedRows !== a.pricedRows) return b.pricedRows - a.pricedRows;
      return b.totalSwaps - a.totalSwaps;
    });

    const shown = candidates.slice(0, topN);

    // ── 6. Summary ────────────────────────────────────────────────────────────
    process.stdout.write("\n--- exclusion summary ---\n");
    process.stdout.write(`  total creators analyzed:        ${totalAnalyzed}\n`);
    process.stdout.write(`  spam / dead tier excluded:      ${spamDeadExcluded}\n`);
    process.stdout.write(`  burst (<=120s) excluded:        ${burstExcluded}\n`);
    process.stdout.write(`  zero activity (>=80%) excluded: ${zeroActivityExcluded}\n`);
    process.stdout.write(`  mass launch + low vol excluded: ${massLowVolExcluded}\n`);
    process.stdout.write(`  high/extreme holder excluded:   ${holderRiskExcluded}\n`);
    process.stdout.write(`  final candidates:               ${candidates.length}\n`);
    process.stdout.write(`  shown (topN=${topN}):           ${shown.length}\n`);
    if (!holderRiskDataAvailable) {
      process.stdout.write("  note: no holder risk data — run evaluate:holder-risk for full filtering\n");
    }

    if (shown.length === 0) {
      process.stdout.write("\nNo candidates after filtering. Collect more outcome data.\n");
      return;
    }

    // ── 7. Latest outcome per mint (one query, used for all candidates) ────────
    const latestOutcomeByMint = new Map<string, { usd_price: number | null; swap_count: number | null }>();
    try {
      const latestRows = db
        .prepare(
          `SELECT o.mint, o.usd_price, o.swap_count
           FROM token_outcomes o
           INNER JOIN (
             SELECT mint, MAX(observed_at) as max_obs
             FROM token_outcomes
             GROUP BY mint
           ) lat ON o.mint = lat.mint AND o.observed_at = lat.max_obs`,
        )
        .all() as LatestOutcomeRow[];
      for (const r of latestRows) {
        latestOutcomeByMint.set(r.mint, { usd_price: r.usd_price, swap_count: r.swap_count });
      }
    } catch { /* no outcomes table */ }

    const last5Stmt = db.prepare(
      `SELECT launched_at, symbol, mint, initial_market_cap_usd, buy_count, sell_count, volume_usd
       FROM tokens
       WHERE creator_wallet = ?
       ORDER BY launched_at DESC
       LIMIT 5`,
    );

    // ── 8. Print each candidate ───────────────────────────────────────────────
    process.stdout.write("\n--- candidates (strongest first) ---\n");

    for (let i = 0; i < shown.length; i++) {
      const c = shown[i];
      const zarPct = (c.zeroActivityRate * 100).toFixed(0);
      const burstStr = c.minBurstWindowSec !== null ? `${c.minBurstWindowSec.toFixed(0)}s` : "n/a";
      const avgStr = c.avgGainPercent !== null ? `${c.avgGainPercent.toFixed(1)}%` : "n/a";
      const hrStr = holderRiskDataAvailable
        ? `HIGH=${c.highHolderCount} EXTREME=${c.extremeHolderCount}`
        : "no data";

      process.stdout.write(`\n[ ${i + 1} / ${shown.length} ]  ${c.wallet}\n`);
      process.stdout.write(`  tier:          ${c.tier}\n`);
      process.stdout.write(`  tierReason:    ${c.tierReason}\n`);
      process.stdout.write(`  successScore:  ${c.successScore}\n`);
      process.stdout.write(`  scoreReason:   ${c.successScoreReason}\n`);
      process.stdout.write(
        `  launches:      ${c.launches}  tracked=${c.launchesTracked}  pricedRows=${c.pricedRows}  totalSwaps=${c.totalSwaps}\n`,
      );
      process.stdout.write(
        `  volume:        ${fmtUsd(c.totalVolumeUsd)}  zeroRate=${zarPct}%  minBurst=${burstStr}\n`,
      );
      process.stdout.write(`  holderRisk:    ${hrStr}\n`);
      process.stdout.write(
        `  outcomes:      STRG=${c.strongGain} UP=${c.up} ACTV=${c.activeFlat} ` +
          `DOWN=${c.down} RUG=${c.rugLike} NOPX=${c.noPrice}  avgGain=${avgStr}\n`,
      );

      // Last 5 tokens
      const tokenRows = last5Stmt.all(c.wallet) as TokenDetailRow[];
      process.stdout.write("  --- last 5 tokens ---\n");
      if (tokenRows.length === 0) {
        process.stdout.write("    (none)\n");
      } else {
        for (const t of tokenRows) {
          const outcome = latestOutcomeByMint.get(t.mint);
          const priceStr = fmtPrice(outcome?.usd_price ?? null);
          const swapsStr = outcome?.swap_count != null ? String(outcome.swap_count) : "n/a";
          process.stdout.write(
            `    ${fmtDate(t.launched_at)}  ${pad(t.symbol, 10)}  ${shorten(t.mint)}\n`,
          );
          process.stdout.write(
            `      mcap=${pad(fmtUsd(t.initial_market_cap_usd), 12)}` +
              `  buy=${pad(String(t.buy_count), 4)}  sell=${pad(String(t.sell_count), 4)}` +
              `  vol=${pad(fmtUsd(t.volume_usd), 10)}` +
              `  price=${pad(priceStr, 14)}  swaps=${swapsStr}\n`,
          );
        }
      }
    }

    process.stdout.write("\n");
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `report:creator-candidates error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
