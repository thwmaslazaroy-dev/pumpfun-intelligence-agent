import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import {
  BudgetedRejectionReason,
  Candidate,
  CreatorRow,
  JoinRow,
  MintMetrics,
  classifyCreator,
  computeMintMetrics,
  evaluateBudgetedReject,
  scoreCandidate,
} from "../lib/budgeted-watchlist-core";

interface TokenRow {
  mint: string;
  creator_wallet: string;
  launched_at: number;
  symbol: string;
}

type RejectionReason =
  | BudgetedRejectionReason
  | "weakCreatorHistory"
  | "lowScore"
  | "budgetCapExceeded";

interface Evaluation {
  mint: string;
  symbol: string;
  creatorWallet: string;
  launchedAt: number;
  creatorLabel: string;
  tokenLabel: string | null;
  trackedLaunches: number;
  strongGain: number;
  up: number;
  activeFlat: number;
  flat: number;
  noPrice: number;
  down: number;
  rugLike: number;
  avgCreatorGain: number | null;
  outcomeCount: number;
  positive: number;
  bad: number;
  score: number | null;
  scoreBreakdown: string;
  selected: boolean;
  rejectionReason: RejectionReason | null;
  reason: string;
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

function shorten(s: string): string {
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}...${s.slice(-6)}`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function fmtScore(s: number | null): string {
  return s === null ? "n/a" : String(s);
}

function fmtAvg(n: number | null): string {
  return n === null ? "n/a" : `${n.toFixed(2)}%`;
}

function printEvaluation(rank: number, e: Evaluation): void {
  const launchedIso = new Date(e.launchedAt).toISOString();
  process.stdout.write(
    `  [${pad(String(rank), 3)}] score=${pad(fmtScore(e.score), 5)}  selected=${e.selected}  mint=${shorten(e.mint)}  creator=${shorten(e.creatorWallet)}\n`,
  );
  process.stdout.write(
    `        creatorLabel=${e.creatorLabel}  tokenLabel=${e.tokenLabel ?? "n/a"}  tracked=${e.trackedLaunches}  outcomeCount=${e.outcomeCount}  launched=${launchedIso}\n`,
  );
  process.stdout.write(
    `        positive(STRG/UP/ACTV)=${e.strongGain}/${e.up}/${e.activeFlat}  bad(FLAT/NOPX/DOWN/RUG)=${e.flat}/${e.noPrice}/${e.down}/${e.rugLike}  avgCreatorGain=${fmtAvg(e.avgCreatorGain)}\n`,
  );
  if (e.scoreBreakdown.length > 0) {
    process.stdout.write(`        breakdown=${e.scoreBreakdown}\n`);
  }
  process.stdout.write(`        reason=${e.reason}\n`);
}

function main(): void {
  const databaseUrl = process.env.DATABASE_URL ?? "./data/pumpfun-agent.sqlite";
  const limit = readPosInt("BUDGETED_WATCHLIST_LIMIT", 20);
  const fullnessThreshold = readPosInt("BUDGETED_OUTCOME_FULLNESS_THRESHOLD", 10);
  const minLaunches = readPosInt("HIGH_CONFIDENCE_MIN_CREATOR_LAUNCHES", 3);
  const minScore = readInt("BUDGETED_WATCHLIST_MIN_SCORE", 15);
  const dbPath = resolveDbPath(databaseUrl);

  process.stdout.write("\n=== preview:budgeted:watchlist (read-only) ===\n");
  process.stdout.write(`  databaseUrl:                       ${databaseUrl}\n`);
  process.stdout.write(`  resolvedDbPath:                    ${dbPath}\n`);
  process.stdout.write(`  budgetedWatchlistLimit:            ${limit}\n`);
  process.stdout.write(`  budgetedOutcomeFullnessThreshold:  ${fullnessThreshold}\n`);
  process.stdout.write(`  highConfidenceMinLaunches:         ${minLaunches}\n`);
  process.stdout.write(`  budgetedWatchlistMinScore:         ${minScore}\n`);
  process.stdout.write(
    "  (no Moralis call, no RPC call, no file write — DB is opened read-only)\n",
  );

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
        };
        byCreator.set(m.creatorWallet, agg);
      }
      agg.launchesTracked += 1;
      if (typeof m.gainFromStartPercent === "number") {
        agg.gainSum += m.gainFromStartPercent;
        agg.gainCount += 1;
      }
      agg.labelCounts[m.outcomeLabel] = (agg.labelCounts[m.outcomeLabel] ?? 0) + 1;
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

    const tokens = db
      .prepare(
        `SELECT mint, creator_wallet, launched_at, symbol
         FROM tokens
         ORDER BY launched_at DESC`,
      )
      .all() as TokenRow[];

    const evaluations: Evaluation[] = [];
    const scoredCandidates: Candidate[] = [];

    for (const t of tokens) {
      const cr = creatorRowByWallet.get(t.creator_wallet) ?? null;
      const creatorLabel = cr?.creatorOutcomeLabel ?? "UNKNOWN";
      const tokenLabel = mintMetricsByMint.get(t.mint)?.outcomeLabel ?? null;
      const outcomeCount = outcomeCountByMint.get(t.mint) ?? 0;
      const positive = cr ? cr.strongGain + cr.up + cr.activeFlat : 0;
      const bad = cr ? cr.flat + cr.noPrice + cr.down + cr.rugLike : 0;
      const trackedLaunches = cr?.launchesTracked ?? 0;

      const baseEval: Omit<Evaluation, "score" | "scoreBreakdown" | "selected" | "rejectionReason" | "reason"> = {
        mint: t.mint,
        symbol: t.symbol,
        creatorWallet: t.creator_wallet,
        launchedAt: t.launched_at,
        creatorLabel,
        tokenLabel,
        trackedLaunches,
        strongGain: cr?.strongGain ?? 0,
        up: cr?.up ?? 0,
        activeFlat: cr?.activeFlat ?? 0,
        flat: cr?.flat ?? 0,
        noPrice: cr?.noPrice ?? 0,
        down: cr?.down ?? 0,
        rugLike: cr?.rugLike ?? 0,
        avgCreatorGain: cr?.avgGainPercent ?? null,
        outcomeCount,
        positive,
        bad,
      };

      const reject = evaluateBudgetedReject({
        creatorLabel,
        tokenLabel,
        outcomeCount,
        positive,
        bad,
        avgCreatorGain: cr?.avgGainPercent ?? null,
        fullnessThreshold,
      });
      if (reject) {
        evaluations.push({
          ...baseEval,
          score: null,
          scoreBreakdown: "",
          selected: false,
          rejectionReason: reject.reason,
          reason: reject.detail,
        });
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
      const { score, breakdown } = scoreCandidate(partial, minLaunches);
      const scored: Candidate = { ...partial, score, scoreBreakdown: breakdown };
      scoredCandidates.push(scored);
      evaluations.push({
        ...baseEval,
        score,
        scoreBreakdown: breakdown,
        selected: false,
        rejectionReason: null,
        reason: "",
      });
    }

    scoredCandidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.launchedAt - a.launchedAt;
    });

    const passed = scoredCandidates.filter((c) => c.score >= minScore);
    const selectedMints = new Set(passed.slice(0, limit).map((c) => c.mint));
    const overflowMints = new Set(passed.slice(limit).map((c) => c.mint));

    const hardRejectCounts: Record<BudgetedRejectionReason, number> = {
      spammyRiskyCreator: 0,
      alreadyEnoughSnapshots: 0,
      tokenLabelDownOrRug: 0,
      tokenNoPriceWithOutcomes: 0,
      tokenFlatWithoutPositive: 0,
      creatorBadOnly: 0,
      creatorMoreBadThanPositive: 0,
      creatorAvgGainNegative: 0,
    };
    let rejectedWeakCreatorHistory = 0;
    let rejectedLowScore = 0;
    let rejectedBudgetCapExceeded = 0;

    for (const e of evaluations) {
      if (e.rejectionReason !== null && e.rejectionReason in hardRejectCounts) {
        hardRejectCounts[e.rejectionReason as BudgetedRejectionReason] += 1;
        continue;
      }

      if (selectedMints.has(e.mint)) {
        e.selected = true;
        e.reason = `selected (score=${e.score} >= min=${minScore}, within top ${limit})`;
        continue;
      }

      if (overflowMints.has(e.mint)) {
        e.rejectionReason = "budgetCapExceeded";
        e.reason = `passed score floor (score=${e.score}) but exceeded budget limit=${limit}`;
        rejectedBudgetCapExceeded += 1;
        continue;
      }

      if (e.trackedLaunches > 0 && e.trackedLaunches < minLaunches) {
        e.rejectionReason = "weakCreatorHistory";
        e.reason = `score=${e.score} < min=${minScore} (trackedLaunches=${e.trackedLaunches} < minLaunches=${minLaunches})`;
        rejectedWeakCreatorHistory += 1;
        continue;
      }

      e.rejectionReason = "lowScore";
      e.reason = `score=${e.score} < min=${minScore}`;
      rejectedLowScore += 1;
    }

    const rejectedBadTokenLabel =
      hardRejectCounts.tokenLabelDownOrRug +
      hardRejectCounts.tokenNoPriceWithOutcomes +
      hardRejectCounts.tokenFlatWithoutPositive;
    const rejectedBadCreatorOutcomes =
      hardRejectCounts.creatorBadOnly +
      hardRejectCounts.creatorMoreBadThanPositive +
      hardRejectCounts.creatorAvgGainNegative;

    process.stdout.write("\n--- counts ---\n");
    process.stdout.write(`  tokensConsidered:                       ${tokens.length}\n`);
    process.stdout.write(`  selectedCount:                          ${selectedMints.size}\n`);
    process.stdout.write(`  rejectedSpammyRisky:                    ${hardRejectCounts.spammyRiskyCreator}\n`);
    process.stdout.write(`  rejectedAlreadyEnoughSnapshots:         ${hardRejectCounts.alreadyEnoughSnapshots}\n`);
    process.stdout.write(`  rejectedBadTokenLabel:                  ${rejectedBadTokenLabel}\n`);
    process.stdout.write(`    tokenLabelDownOrRug:                  ${hardRejectCounts.tokenLabelDownOrRug}\n`);
    process.stdout.write(`    tokenNoPriceWithOutcomes:             ${hardRejectCounts.tokenNoPriceWithOutcomes}\n`);
    process.stdout.write(`    tokenFlatWithoutPositive:             ${hardRejectCounts.tokenFlatWithoutPositive}\n`);
    process.stdout.write(`  rejectedBadCreatorOutcomes:             ${rejectedBadCreatorOutcomes}\n`);
    process.stdout.write(`    creatorBadOnly:                       ${hardRejectCounts.creatorBadOnly}\n`);
    process.stdout.write(`    creatorMoreBadThanPositive:           ${hardRejectCounts.creatorMoreBadThanPositive}\n`);
    process.stdout.write(`    creatorAvgGainNegative:               ${hardRejectCounts.creatorAvgGainNegative}\n`);
    process.stdout.write(`  rejectedWeakCreatorHistory:             ${rejectedWeakCreatorHistory}\n`);
    process.stdout.write(`  rejectedLowScore:                       ${rejectedLowScore}\n`);
    process.stdout.write(`  rejectedBudgetCapExceeded:              ${rejectedBudgetCapExceeded}\n`);

    const selectedSorted = evaluations
      .filter((e) => e.selected)
      .sort((a, b) => {
        const sa = a.score ?? -Infinity;
        const sb = b.score ?? -Infinity;
        if (sb !== sa) return sb - sa;
        return b.launchedAt - a.launchedAt;
      });

    process.stdout.write("\n--- top 20 selected ---\n");
    if (selectedSorted.length === 0) {
      process.stdout.write("  (none — no token cleared the quality floor)\n");
    } else {
      let i = 1;
      for (const e of selectedSorted.slice(0, 20)) {
        printEvaluation(i, e);
        i += 1;
      }
    }

    const closeRejected = evaluations
      .filter(
        (e) =>
          !e.selected &&
          (e.rejectionReason === "budgetCapExceeded" ||
            e.rejectionReason === "lowScore" ||
            e.rejectionReason === "weakCreatorHistory") &&
          e.score !== null,
      )
      .sort((a, b) => {
        const sa = a.score ?? -Infinity;
        const sb = b.score ?? -Infinity;
        if (sb !== sa) return sb - sa;
        return b.launchedAt - a.launchedAt;
      });

    process.stdout.write("\n--- top 20 rejected but close (highest scoring rejects) ---\n");
    if (closeRejected.length === 0) {
      process.stdout.write("  (none)\n");
    } else {
      let i = 1;
      for (const e of closeRejected.slice(0, 20)) {
        printEvaluation(i, e);
        i += 1;
      }
    }

    process.stdout.write(
      "\n(no file was written; this is preview-only — generate:budgeted:watchlist remains the source of truth)\n",
    );
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `preview:budgeted:watchlist unhandled error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
