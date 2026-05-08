import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import {
  BudgetedRejectionReason,
  Candidate,
  CreatorRow,
  CreatorSuccessScoreInput,
  CreatorSuccessScoreResult,
  CreatorTierResult,
  JoinRow,
  MintMetrics,
  classifyCreator,
  computeCreatorSuccessScore,
  computeCreatorTier,
  computeMinBurstWindowSec,
  computeMintMetrics,
  evaluateBudgetedReject,
  scoreCandidate,
  tokenHasActivity,
} from "../lib/budgeted-watchlist-core";

interface TokenRow {
  mint: string;
  creator_wallet: string;
  launched_at: number;
  symbol: string;
}

function resolveDbPath(databaseUrl: string): string {
  const stripped = databaseUrl.startsWith("sqlite:")
    ? databaseUrl.slice("sqlite:".length)
    : databaseUrl;
  return path.isAbsolute(stripped) ? stripped : path.resolve(process.cwd(), stripped);
}

function readPosInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function ensureDir(file: string): void {
  const dir = path.dirname(file);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function shorten(s: string): string {
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}...${s.slice(-6)}`;
}

function main(): void {
  const databaseUrl = process.env.DATABASE_URL ?? "./data/pumpfun-agent.sqlite";
  const limit = readPosInt("BUDGETED_WATCHLIST_LIMIT", 20);
  const fullnessThreshold = readPosInt("BUDGETED_OUTCOME_FULLNESS_THRESHOLD", 10);
  const minLaunches = readPosInt("HIGH_CONFIDENCE_MIN_CREATOR_LAUNCHES", 3);
  const minScore = readInt("BUDGETED_WATCHLIST_MIN_SCORE", 15);
  const outPathRaw =
    process.env.BUDGETED_WATCHLIST_PATH ?? "./data/budgeted-outcome-watchlist.txt";
  const resolvedOut = path.isAbsolute(outPathRaw)
    ? outPathRaw
    : path.resolve(process.cwd(), outPathRaw);
  const dbPath = resolveDbPath(databaseUrl);

  process.stdout.write("\n=== generate:budgeted:watchlist (read-only) ===\n");
  process.stdout.write(`  databaseUrl:                       ${databaseUrl}\n`);
  process.stdout.write(`  resolvedDbPath:                    ${dbPath}\n`);
  process.stdout.write(`  outputPath:                        ${resolvedOut}\n`);
  process.stdout.write(`  budgetedWatchlistLimit:            ${limit}\n`);
  process.stdout.write(`  budgetedOutcomeFullnessThreshold:  ${fullnessThreshold}\n`);
  process.stdout.write(`  highConfidenceMinLaunches:         ${minLaunches}\n`);
  process.stdout.write(`  budgetedWatchlistMinScore:         ${minScore}\n`);

  if (!fs.existsSync(dbPath)) {
    process.stdout.write(
      `\nSQLite file not found at ${dbPath}. Run radar:scan first.\n`,
    );
    process.exit(1);
  }

  let db: Database.Database;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  } catch (err) {
    process.stdout.write(
      `\nfailed to open SQLite read-only: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  try {
    const joinRows = db
      .prepare(
        `SELECT t.mint, t.creator_wallet, o.observed_at, o.usd_price, o.swap_count
         FROM token_outcomes o
         INNER JOIN tokens t ON t.mint = o.mint
         ORDER BY o.observed_at ASC`,
      )
      .all() as JoinRow[];

    const byMint = new Map<string, JoinRow[]>();
    const mintCreator = new Map<string, string>();
    const outcomeCountByMint = new Map<string, number>();
    for (const r of joinRows) {
      let bucket = byMint.get(r.mint);
      if (!bucket) {
        bucket = [];
        byMint.set(r.mint, bucket);
      }
      bucket.push(r);
      if (!mintCreator.has(r.mint)) mintCreator.set(r.mint, r.creator_wallet);
      outcomeCountByMint.set(r.mint, (outcomeCountByMint.get(r.mint) ?? 0) + 1);
    }

    const mintMetricsByMint = new Map<string, MintMetrics>();
    for (const [mint, rows] of byMint.entries()) {
      const creator = mintCreator.get(mint) ?? "";
      mintMetricsByMint.set(mint, computeMintMetrics(mint, creator, rows));
    }

    interface CreatorAgg {
      creatorWallet: string;
      launchesTracked: number;
      gainSum: number;
      gainCount: number;
      labelCounts: Record<string, number>;
      totalSwaps: number;
      pricedRows: number;
    }
    const byCreator = new Map<string, CreatorAgg>();
    for (const m of mintMetricsByMint.values()) {
      let agg = byCreator.get(m.creatorWallet);
      if (!agg) {
        agg = {
          creatorWallet: m.creatorWallet,
          launchesTracked: 0,
          gainSum: 0,
          gainCount: 0,
          labelCounts: {},
          totalSwaps: 0,
          pricedRows: 0,
        };
        byCreator.set(m.creatorWallet, agg);
      }
      agg.launchesTracked += 1;
      if (typeof m.gainFromStartPercent === "number") {
        agg.gainSum += m.gainFromStartPercent;
        agg.gainCount += 1;
      }
      agg.labelCounts[m.outcomeLabel] = (agg.labelCounts[m.outcomeLabel] ?? 0) + 1;
      agg.totalSwaps += m.latestSwapCount ?? 0;
      agg.pricedRows += m.pricedObservationCount;
    }

    const creatorRowByWallet = new Map<string, CreatorRow>();
    for (const agg of byCreator.values()) {
      const lc = agg.labelCounts;
      const row: CreatorRow = {
        creatorWallet: agg.creatorWallet,
        launchesTracked: agg.launchesTracked,
        avgGainPercent: agg.gainCount > 0 ? agg.gainSum / agg.gainCount : null,
        strongGain: lc.STRONG_GAIN ?? 0,
        up: lc.UP ?? 0,
        activeFlat: lc.ACTIVE_FLAT ?? 0,
        flat: lc.FLAT ?? 0,
        noPrice: lc.NO_PRICE ?? 0,
        down: lc.DOWN ?? 0,
        rugLike: lc.RUG_LIKE ?? 0,
        creatorOutcomeLabel: "UNKNOWN",
      };
      row.creatorOutcomeLabel = classifyCreator(row);
      creatorRowByWallet.set(row.creatorWallet, row);
    }

    // Total launch count + first/last timestamp per creator (includes mints without outcome rows)
    const launchInfoRows = db
      .prepare(
        `SELECT creator_wallet, COUNT(*) as cnt,
                MIN(launched_at) as first_at, MAX(launched_at) as last_at
         FROM tokens GROUP BY creator_wallet`,
      )
      .all() as { creator_wallet: string; cnt: number; first_at: number; last_at: number }[];
    const launchCountByCreator = new Map<string, number>();
    const firstLaunchAtByCreator = new Map<string, number>();
    const lastLaunchAtByCreator = new Map<string, number>();
    for (const r of launchInfoRows) {
      launchCountByCreator.set(r.creator_wallet, r.cnt);
      firstLaunchAtByCreator.set(r.creator_wallet, r.first_at);
      lastLaunchAtByCreator.set(r.creator_wallet, r.last_at);
    }

    // Extreme holder count per creator (table may not exist yet — degrade gracefully)
    const extremeCountByCreator = new Map<string, number>();
    try {
      const extremeRows = db
        .prepare(
          `SELECT t.creator_wallet, COUNT(*) as cnt
           FROM holder_risk_evaluations h
           JOIN tokens t ON t.mint = h.mint
           WHERE h.holder_risk_label = 'EXTREME'
           GROUP BY t.creator_wallet`,
        )
        .all() as { creator_wallet: string; cnt: number }[];
      for (const r of extremeRows) {
        extremeCountByCreator.set(r.creator_wallet, r.cnt);
      }
    } catch {
      // holder_risk_evaluations not yet created — no EXTREME data available
    }

    // HIGH holder count per creator
    const highCountByCreator = new Map<string, number>();
    try {
      const highRows = db
        .prepare(
          `SELECT t.creator_wallet, COUNT(*) as cnt
           FROM holder_risk_evaluations h
           JOIN tokens t ON t.mint = h.mint
           WHERE h.holder_risk_label = 'HIGH'
           GROUP BY t.creator_wallet`,
        )
        .all() as { creator_wallet: string; cnt: number }[];
      for (const r of highRows) {
        highCountByCreator.set(r.creator_wallet, r.cnt);
      }
    } catch {
      // holder_risk_evaluations not yet created
    }

    // Launch timestamps per creator (sorted ascending) — used for burst detection
    const timestampsByCreator = new Map<string, number[]>();
    try {
      const tsRows = db
        .prepare(
          "SELECT creator_wallet, launched_at FROM tokens ORDER BY creator_wallet ASC, launched_at ASC",
        )
        .all() as { creator_wallet: string; launched_at: number }[];
      for (const r of tsRows) {
        let arr = timestampsByCreator.get(r.creator_wallet);
        if (!arr) { arr = []; timestampsByCreator.set(r.creator_wallet, arr); }
        arr.push(r.launched_at);
      }
    } catch { /* tokens table always exists */ }

    // Min burst window per creator (seconds for any 3 consecutive launches)
    const minBurstWindowSecByCreator = new Map<string, number>();
    for (const [wallet, ts] of timestampsByCreator.entries()) {
      const w = computeMinBurstWindowSec(ts);
      if (w !== null) minBurstWindowSecByCreator.set(wallet, w);
    }

    // Per-creator zero-activity stats — computed in TypeScript using tokenHasActivity()
    // so the definition is identical to the per-token realActivity check.
    interface ZeroActivityStats { count: number; totalVolumeUsd: number }
    const zeroActivityByCreator = new Map<string, ZeroActivityStats>();
    try {
      const allTokenActivity = db
        .prepare(
          "SELECT creator_wallet, buy_count, sell_count, volume_usd, bonding_curve_progress FROM tokens",
        )
        .all() as {
          creator_wallet: string;
          buy_count: number;
          sell_count: number;
          volume_usd: number;
          bonding_curve_progress: number;
        }[];
      for (const r of allTokenActivity) {
        let entry = zeroActivityByCreator.get(r.creator_wallet);
        if (!entry) {
          entry = { count: 0, totalVolumeUsd: 0 };
          zeroActivityByCreator.set(r.creator_wallet, entry);
        }
        entry.totalVolumeUsd += r.volume_usd ?? 0;
        if (!tokenHasActivity({
          buyCount: r.buy_count,
          sellCount: r.sell_count,
          volumeUsd: r.volume_usd,
          bondingCurveProgress: r.bonding_curve_progress,
        })) {
          entry.count++;
        }
      }
    } catch { /* safeguard */ }

    // Creator success score — computed before tier so tier can use it
    const successScoreByCreator = new Map<string, CreatorSuccessScoreResult>();
    for (const agg of byCreator.values()) {
      const lc = agg.labelCounts;
      const za = zeroActivityByCreator.get(agg.creatorWallet);
      const ssInput: CreatorSuccessScoreInput = {
        launches: launchCountByCreator.get(agg.creatorWallet) ?? agg.launchesTracked,
        launchesTracked: agg.launchesTracked,
        strongGain: lc.STRONG_GAIN ?? 0,
        up: lc.UP ?? 0,
        activeFlat: lc.ACTIVE_FLAT ?? 0,
        noPrice: lc.NO_PRICE ?? 0,
        down: lc.DOWN ?? 0,
        rugLike: lc.RUG_LIKE ?? 0,
        extremeHolderCount: extremeCountByCreator.get(agg.creatorWallet) ?? 0,
        highHolderCount: highCountByCreator.get(agg.creatorWallet) ?? 0,
        firstLaunchAt: firstLaunchAtByCreator.get(agg.creatorWallet) ?? null,
        lastLaunchAt: lastLaunchAtByCreator.get(agg.creatorWallet) ?? null,
        minBurstWindowSec: minBurstWindowSecByCreator.get(agg.creatorWallet) ?? null,
        zeroActivityCount: za?.count ?? 0,
        totalVolumeUsd: za?.totalVolumeUsd ?? 0,
      };
      successScoreByCreator.set(agg.creatorWallet, computeCreatorSuccessScore(ssInput));
    }

    // Success score distribution summary
    const ssDist = { low: 0, mid: 0, high: 0 };
    for (const r of successScoreByCreator.values()) {
      if (r.successScore < 30) ssDist.low++;
      else if (r.successScore < 60) ssDist.mid++;
      else ssDist.high++;
    }
    process.stdout.write("\n--- creator success score distribution ---\n");
    process.stdout.write(`  low  (0–29):   ${ssDist.low}\n`);
    process.stdout.write(`  mid  (30–59):  ${ssDist.mid}\n`);
    process.stdout.write(`  high (60–100): ${ssDist.high}\n`);

    // Build creator tier map (successScore + burst/activity signals passed)
    const creatorTierByWallet = new Map<string, CreatorTierResult>();
    for (const agg of byCreator.values()) {
      const totalLaunches = launchCountByCreator.get(agg.creatorWallet) ?? agg.launchesTracked;
      const za = zeroActivityByCreator.get(agg.creatorWallet);
      const zeroRate = totalLaunches > 0 ? (za?.count ?? 0) / totalLaunches : null;
      creatorTierByWallet.set(
        agg.creatorWallet,
        computeCreatorTier({
          launches: totalLaunches,
          totalSwaps: agg.totalSwaps,
          pricedRows: agg.pricedRows,
          extremeHolderCount: extremeCountByCreator.get(agg.creatorWallet) ?? 0,
          successScore: successScoreByCreator.get(agg.creatorWallet)?.successScore,
          minBurstWindowSec: minBurstWindowSecByCreator.get(agg.creatorWallet) ?? null,
          zeroActivityRate: zeroRate,
        }),
      );
    }

    const tokens = db
      .prepare(
        `SELECT mint, creator_wallet, launched_at, symbol
         FROM tokens
         ORDER BY launched_at DESC`,
      )
      .all() as TokenRow[];

    const rejectCounts: Record<BudgetedRejectionReason, number> = {
      spammyRiskyCreator: 0,
      alreadyEnoughSnapshots: 0,
      tokenLabelDownOrRug: 0,
      tokenNoPriceWithOutcomes: 0,
      tokenFlatWithoutPositive: 0,
      creatorBadOnly: 0,
      creatorMoreBadThanPositive: 0,
      creatorAvgGainNegative: 0,
    };
    let spamCreatorRejected = 0;
    let deadCreatorRejected = 0;

    const candidates: Candidate[] = [];
    for (const t of tokens) {
      // Creator tier hard-reject (checked before the standard reject evaluator)
      const tierResult = creatorTierByWallet.get(t.creator_wallet);
      if (tierResult?.tier === "SPAM_CREATOR") {
        spamCreatorRejected += 1;
        continue;
      }
      if (tierResult?.tier === "DEAD_CREATOR") {
        deadCreatorRejected += 1;
        continue;
      }

      const cr = creatorRowByWallet.get(t.creator_wallet) ?? null;
      const creatorLabel = cr?.creatorOutcomeLabel ?? "UNKNOWN";
      const tokenLabel = mintMetricsByMint.get(t.mint)?.outcomeLabel ?? null;
      const outcomeCount = outcomeCountByMint.get(t.mint) ?? 0;
      const positive = cr ? cr.strongGain + cr.up + cr.activeFlat : 0;
      const bad = cr ? cr.flat + cr.noPrice + cr.down + cr.rugLike : 0;
      const avgCreatorGain = cr?.avgGainPercent ?? null;

      const reject = evaluateBudgetedReject({
        creatorLabel,
        tokenLabel,
        outcomeCount,
        positive,
        bad,
        avgCreatorGain,
        fullnessThreshold,
      });
      if (reject) {
        rejectCounts[reject.reason] += 1;
        continue;
      }

      const partial = {
        mint: t.mint,
        symbol: t.symbol,
        creatorWallet: t.creator_wallet,
        launchedAt: t.launched_at,
        outcomeCount,
        creatorRow: cr,
        positive,
        bad,
      };
      let { score, breakdown } = scoreCandidate(partial, minLaunches);
      if (tierResult?.tier === "PROMISING_CREATOR") {
        score += 20;
        breakdown += " tier=PROMISING_CREATOR(+20)";
      } else if (tierResult?.tier === "ACTIVE_CREATOR") {
        score += 10;
        breakdown += " tier=ACTIVE_CREATOR(+10)";
      }

      // Success score bonus / penalty
      const ssResult = successScoreByCreator.get(t.creator_wallet);
      if (ssResult !== undefined) {
        const ss = ssResult.successScore;
        if (ss >= 70) {
          score += 15;
          breakdown += ` successScore=${ss}(+15)`;
        } else if (ss >= 50) {
          score += 5;
          breakdown += ` successScore=${ss}(+5)`;
        } else if (ss < 25) {
          score -= 20;
          breakdown += ` successScore=${ss}(-20)`;
        } else if (ss < 35) {
          score -= 10;
          breakdown += ` successScore=${ss}(-10)`;
        } else {
          breakdown += ` successScore=${ss}(0)`;
        }
      }

      candidates.push({ ...partial, score, scoreBreakdown: breakdown });
    }

    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.launchedAt - a.launchedAt;
    });

    const passed = candidates.filter((c) => c.score >= minScore);
    const selected = passed.slice(0, limit);
    const droppedBelowFloor = candidates.length - passed.length;

    const totalHardRejected =
      rejectCounts.spammyRiskyCreator +
      rejectCounts.alreadyEnoughSnapshots +
      rejectCounts.tokenLabelDownOrRug +
      rejectCounts.tokenNoPriceWithOutcomes +
      rejectCounts.tokenFlatWithoutPositive +
      rejectCounts.creatorBadOnly +
      rejectCounts.creatorMoreBadThanPositive +
      rejectCounts.creatorAvgGainNegative;

    ensureDir(resolvedOut);
    const generatedAt = new Date().toISOString();
    const header = [
      "# Budgeted outcome watchlist (generated, read-only source)",
      `# generatedAt:                       ${generatedAt}`,
      `# dbPath:                            ${dbPath}`,
      `# budgetedWatchlistLimit:            ${limit}`,
      `# budgetedWatchlistMinScore:         ${minScore}`,
      `# budgetedOutcomeFullnessThreshold:  ${fullnessThreshold}`,
      `# highConfidenceMinLaunches:         ${minLaunches}`,
      `# tokensConsidered:                  ${tokens.length}`,
      `# rejectedSpammyRiskyCreator:        ${rejectCounts.spammyRiskyCreator}`,
      `# rejectedAlreadyEnoughSnapshots:    ${rejectCounts.alreadyEnoughSnapshots}`,
      `# rejectedTokenLabelDownOrRug:       ${rejectCounts.tokenLabelDownOrRug}`,
      `# rejectedTokenNoPriceWithOutcomes:  ${rejectCounts.tokenNoPriceWithOutcomes}`,
      `# rejectedTokenFlatWithoutPositive:  ${rejectCounts.tokenFlatWithoutPositive}`,
      `# rejectedCreatorBadOnly:            ${rejectCounts.creatorBadOnly}`,
      `# rejectedCreatorMoreBadThanPositive:${rejectCounts.creatorMoreBadThanPositive}`,
      `# rejectedCreatorAvgGainNegative:    ${rejectCounts.creatorAvgGainNegative}`,
      `# droppedBelowMinScore:              ${droppedBelowFloor}`,
      `# mintsWritten:                      ${selected.length}`,
      "#",
      "# Use with:  set OUTCOME_WATCHLIST_PATH=./data/budgeted-outcome-watchlist.txt",
      "#            npm run track:batch:outcomes",
      "# This generator does NOT call any external API and does NOT modify the database.",
      "#",
      "",
    ].join("\n");
    const body = selected.length > 0 ? selected.map((c) => c.mint).join("\n") + "\n" : "";
    fs.writeFileSync(resolvedOut, header + body);

    process.stdout.write("\n--- counts ---\n");
    process.stdout.write(`  tokensConsidered:                  ${tokens.length}\n`);
    process.stdout.write(`  rejectedSpamCreator:               ${spamCreatorRejected}\n`);
    process.stdout.write(`  rejectedDeadCreator:               ${deadCreatorRejected}\n`);
    process.stdout.write(`  rejectedSpammyRiskyCreator:        ${rejectCounts.spammyRiskyCreator}\n`);
    process.stdout.write(`  rejectedAlreadyEnoughSnapshots:    ${rejectCounts.alreadyEnoughSnapshots}\n`);
    process.stdout.write(`  rejectedTokenLabelDownOrRug:       ${rejectCounts.tokenLabelDownOrRug}\n`);
    process.stdout.write(`  rejectedTokenNoPriceWithOutcomes:  ${rejectCounts.tokenNoPriceWithOutcomes}\n`);
    process.stdout.write(`  rejectedTokenFlatWithoutPositive:  ${rejectCounts.tokenFlatWithoutPositive}\n`);
    process.stdout.write(`  rejectedCreatorBadOnly:            ${rejectCounts.creatorBadOnly}\n`);
    process.stdout.write(`  rejectedCreatorMoreBadThanPositive:${rejectCounts.creatorMoreBadThanPositive}\n`);
    process.stdout.write(`  rejectedCreatorAvgGainNegative:    ${rejectCounts.creatorAvgGainNegative}\n`);
    process.stdout.write(`  totalHardRejected:                 ${totalHardRejected}\n`);
    process.stdout.write(`  droppedBelowMinScore:              ${droppedBelowFloor}\n`);
    process.stdout.write(`  mintsWritten:                      ${selected.length}\n`);

    process.stdout.write("\n--- top selected ---\n");
    if (selected.length === 0) {
      process.stdout.write("  (none — no token cleared the quality floor)\n");
    } else {
      let i = 1;
      for (const c of selected) {
        const launchedIso = new Date(c.launchedAt).toISOString();
        const cl = c.creatorRow?.creatorOutcomeLabel ?? "UNKNOWN";
        const tracked = c.creatorRow?.launchesTracked ?? 0;
        const ssEntry = successScoreByCreator.get(c.creatorWallet);
        process.stdout.write(
          `  [${i}] score=${c.score}  mint=${shorten(c.mint)}  symbol=${c.symbol}  launched=${launchedIso}\n`,
        );
        process.stdout.write(
          `      creator=${shorten(c.creatorWallet)}  creatorLabel=${cl}  tracked=${tracked}  outcomeCount=${c.outcomeCount}\n`,
        );
        process.stdout.write(
          `      successScore=${ssEntry?.successScore ?? "n/a"}  successScoreReason=${ssEntry?.successScoreReason ?? "n/a"}\n`,
        );
        process.stdout.write(`      breakdown=${c.scoreBreakdown}\n`);
        i++;
      }
    }
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `generate:budgeted:watchlist unhandled error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
