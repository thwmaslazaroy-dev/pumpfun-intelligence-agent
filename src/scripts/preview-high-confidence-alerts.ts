import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import {
  computeCreatorSuccessScore,
  computeCreatorTier,
  CreatorSuccessScoreInput,
  CreatorSuccessScoreResult,
  CreatorTierResult,
} from "../lib/budgeted-watchlist-core";

interface TokenRow {
  mint: string;
  creator_wallet: string;
  launched_at: number;
  symbol: string;
}

interface JoinRow {
  mint: string;
  creator_wallet: string;
  observed_at: number;
  usd_price: number | null;
  swap_count: number | null;
}

interface MintMetrics {
  mint: string;
  creatorWallet: string;
  observationCount: number;
  pricedObservationCount: number;
  gainFromStartPercent: number | null;
  maxDrawdownPercent: number | null;
  swapCountDelta: number | null;
  latestSwapCount: number | null;
  outcomeLabel: string;
}

interface CreatorRow {
  creatorWallet: string;
  launchesTracked: number;
  avgGainPercent: number | null;
  avgSwapDelta: number | null;
  strongGain: number;
  up: number;
  activeFlat: number;
  flat: number;
  noPrice: number;
  down: number;
  rugLike: number;
  creatorOutcomeLabel: string;
}

const BAD_CURRENT_TOKEN_LABELS = new Set([
  "NO_PRICE",
  "DEAD_OR_NO_ACTIVITY",
  "FLAT",
  "DOWN",
  "RUG_LIKE",
]);
const OK_CURRENT_TOKEN_LABELS = new Set(["ACTIVE_FLAT", "UP", "STRONG_GAIN"]);

function resolveDbPath(databaseUrl: string): string {
  const stripped = databaseUrl.startsWith("sqlite:")
    ? databaseUrl.slice("sqlite:".length)
    : databaseUrl;
  return path.isAbsolute(stripped) ? stripped : path.resolve(process.cwd(), stripped);
}

function parseLimit(raw: string | undefined, def: number): number {
  if (!raw) return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) return def;
  return n;
}

function shorten(s: string): string {
  if (s.length <= 16) return s;
  return `${s.slice(0, 8)}...${s.slice(-6)}`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function classifyOutcome(m: {
  pricedObservationCount: number;
  latestSwapCount: number | null;
  maxDrawdownPercent: number | null;
  gainFromStartPercent: number | null;
  swapCountDelta: number | null;
}): string {
  if (m.pricedObservationCount === 0) return "NO_PRICE";
  if (m.latestSwapCount === null || m.latestSwapCount === 0) {
    return "DEAD_OR_NO_ACTIVITY";
  }
  if (m.maxDrawdownPercent !== null && m.maxDrawdownPercent <= -70) {
    return "RUG_LIKE";
  }
  const gain = m.gainFromStartPercent;
  if (gain === null) return "UNKNOWN";
  if (gain >= 50) return "STRONG_GAIN";
  if (Math.abs(gain) < 20) {
    if (m.swapCountDelta !== null && m.swapCountDelta > 0) return "ACTIVE_FLAT";
    return "FLAT";
  }
  if (gain <= -20) return "DOWN";
  if (gain >= 20) return "UP";
  return "UNKNOWN";
}

function computeMintMetrics(
  mint: string,
  creatorWallet: string,
  rows: JoinRow[],
): MintMetrics {
  const observationCount = rows.length;
  const priced = rows.filter(
    (r): r is JoinRow & { usd_price: number } => typeof r.usd_price === "number",
  );
  const pricedObservationCount = priced.length;

  let gainFromStartPercent: number | null = null;
  let maxDrawdownPercent: number | null = null;

  if (priced.length > 0) {
    const prices = priced.map((p) => p.usd_price);
    const startPrice = prices[0];
    const latestPrice = prices[prices.length - 1];
    if (startPrice > 0) {
      gainFromStartPercent = ((latestPrice - startPrice) / startPrice) * 100;
    }
    let peak = prices[0];
    let maxDDPositive = 0;
    for (const p of prices) {
      if (p > peak) peak = p;
      if (peak > 0) {
        const dd = ((peak - p) / peak) * 100;
        if (dd > maxDDPositive) maxDDPositive = dd;
      }
    }
    if (peak > 0) maxDrawdownPercent = -maxDDPositive;
  }

  const startSwapCount = rows[0].swap_count;
  const latestSwapCount = rows[rows.length - 1].swap_count;
  const swapCountDelta =
    typeof startSwapCount === "number" && typeof latestSwapCount === "number"
      ? latestSwapCount - startSwapCount
      : null;

  const outcomeLabel = classifyOutcome({
    pricedObservationCount,
    latestSwapCount,
    maxDrawdownPercent,
    gainFromStartPercent,
    swapCountDelta,
  });

  return {
    mint,
    creatorWallet,
    observationCount,
    pricedObservationCount,
    gainFromStartPercent,
    maxDrawdownPercent,
    swapCountDelta,
    latestSwapCount,
    outcomeLabel,
  };
}

function classifyCreator(c: CreatorRow): string {
  const promising =
    c.strongGain + c.up + c.activeFlat >= 2 &&
    c.avgGainPercent !== null &&
    c.avgGainPercent >= 0;
  if (promising) return "PROMISING";
  if (c.flat + c.noPrice >= 3) return "SPAMMY";
  if (c.rugLike + c.down >= 2) return "RISKY";
  return "UNKNOWN";
}

interface CreatorScoreResult {
  creatorScore: number;
  creatorScoreReason: string[];
  previousLaunches: number;
  positiveOutcomes: number;
  negativeOutcomes: number;
}

function scoreCreator(c: CreatorRow | null): CreatorScoreResult {
  if (c === null) {
    return {
      creatorScore: 0,
      creatorScoreReason: ["no creator history yet"],
      previousLaunches: 0,
      positiveOutcomes: 0,
      negativeOutcomes: 0,
    };
  }

  const reasons: string[] = [];
  let score = 0;

  const addPoints = (count: number, perPoints: number, label: string): void => {
    if (count <= 0) return;
    const pts = count * perPoints;
    score += pts;
    const sign = pts >= 0 ? `+${pts}` : `${pts}`;
    reasons.push(`${label} x${count} (${sign})`);
  };

  addPoints(c.strongGain, 5, "STRONG_GAIN");
  addPoints(c.up, 3, "UP");
  addPoints(c.activeFlat, 1, "ACTIVE_FLAT");
  addPoints(c.flat, -1, "FLAT");
  addPoints(c.noPrice, -3, "NO_PRICE");
  addPoints(c.down, -4, "DOWN");
  addPoints(c.rugLike, -6, "RUG_LIKE");

  const positiveOutcomes = c.strongGain + c.up + c.activeFlat;
  const negativeOutcomes = c.flat + c.noPrice + c.down + c.rugLike;
  const previousLaunches = c.launchesTracked || 0;

  if (
    previousLaunches >= 5 &&
    negativeOutcomes / previousLaunches >= 0.7
  ) {
    score -= 5;
    reasons.push("spam penalty: many launches with mostly bad outcomes (-5)");
  }
  if (previousLaunches >= 3 && c.noPrice / previousLaunches >= 0.7) {
    score -= 4;
    reasons.push("no-price penalty: mostly NO_PRICE outcomes (-4)");
  }

  if (previousLaunches < 3) {
    reasons.push(`limited history: launches=${previousLaunches}`);
  }

  if (reasons.length === 0) {
    reasons.push("no scored events yet");
  }

  return {
    creatorScore: score,
    creatorScoreReason: reasons,
    previousLaunches,
    positiveOutcomes,
    negativeOutcomes,
  };
}

type Decision = "HIGH_PRIORITY_ALERT" | "WATCH_ONLY" | "REJECT";

function decide(
  tokenLabel: string | null,
  creatorRow: CreatorRow | null,
  minLaunches: number,
  scoreResult: CreatorScoreResult,
  successScore: number | undefined,
): { decision: Decision; reason: string } {
  // Rule 0: success score confirms spam / rug farm — hard reject before anything else
  if (successScore !== undefined && successScore < 20) {
    return {
      decision: "REJECT",
      reason: `rule 0: successScore=${successScore}<20 (confirmed spam/rug pattern)`,
    };
  }

  if (scoreResult.creatorScore <= -8) {
    return {
      decision: "REJECT",
      reason: `rule 9: very negative creatorScore=${scoreResult.creatorScore}`,
    };
  }

  if (creatorRow === null) {
    return { decision: "REJECT", reason: "rule 1: no creator history" };
  }

  const creatorLabel = creatorRow.creatorOutcomeLabel;
  if (creatorLabel === "SPAMMY" || creatorLabel === "RISKY") {
    return {
      decision: "REJECT",
      reason: `rule 1: creator label is ${creatorLabel}`,
    };
  }

  if (creatorRow.launchesTracked < minLaunches) {
    return {
      decision: "REJECT",
      reason: `rule 2: creatorLaunchesTracked=${creatorRow.launchesTracked} < min=${minLaunches}`,
    };
  }

  const positive = creatorRow.strongGain + creatorRow.up + creatorRow.activeFlat;
  const bad =
    creatorRow.flat + creatorRow.noPrice + creatorRow.down + creatorRow.rugLike;

  if (positive === 0) {
    return { decision: "REJECT", reason: "rule 3: creator has 0 positive outcomes" };
  }

  if (bad > positive) {
    return {
      decision: "REJECT",
      reason: `rule 4: bad=${bad} > positive=${positive}`,
    };
  }

  if (tokenLabel !== null && BAD_CURRENT_TOKEN_LABELS.has(tokenLabel)) {
    return {
      decision: "REJECT",
      reason: `rule 5: current tokenLabel is ${tokenLabel}`,
    };
  }

  const eligibleByCreator =
    creatorLabel === "PROMISING" || (positive >= 2 && bad <= positive);
  const tokenOk = tokenLabel === null || OK_CURRENT_TOKEN_LABELS.has(tokenLabel);
  const tokenStrictOk =
    tokenLabel !== null && OK_CURRENT_TOKEN_LABELS.has(tokenLabel);

  if (eligibleByCreator && tokenOk) {
    // HIGH_PRIORITY_ALERT requires strong creatorScore, confirmed token momentum,
    // and a successScore >= 45 so borderline spam farms cannot slip through.
    const successScoreOk = successScore === undefined || successScore >= 45;
    if (scoreResult.creatorScore >= 8 && tokenStrictOk && successScoreOk) {
      return {
        decision: "HIGH_PRIORITY_ALERT",
        reason: `rule 6: creatorLabel=${creatorLabel} positive=${positive} bad=${bad} tokenLabel=${tokenLabel ?? "n/a"} creatorScore=${scoreResult.creatorScore} successScore=${successScore ?? "n/a"}`,
      };
    }
    const gateBlockReason = !successScoreOk
      ? `successScore=${successScore}<45`
      : `creatorScore=${scoreResult.creatorScore}<8 or tokenLabel=${tokenLabel ?? "n/a"} not strict-ok`;
    return {
      decision: "WATCH_ONLY",
      reason: `rule 6b: high-priority gate not met (${gateBlockReason}); held at watch-only`,
    };
  }

  return {
    decision: "WATCH_ONLY",
    reason: `rule 7: passed filters but not strong enough (creatorLabel=${creatorLabel} positive=${positive} bad=${bad} tokenLabel=${tokenLabel ?? "n/a"})`,
  };
}

interface HolderRiskEval {
  label: string;
  reason: string;
}

interface PreviewRow {
  token: TokenRow;
  tokenLabel: string | null;
  creatorRow: CreatorRow | null;
  decision: Decision;
  reason: string;
  positive: number;
  bad: number;
  creatorScore: number;
  creatorScoreReason: string[];
  previousLaunches: number;
  positiveOutcomes: number;
  negativeOutcomes: number;
  holderRiskLabel: string | null;
  holderRiskReason: string | null;
  creatorTier: string;
  creatorTierReason: string;
  successScore: number | null;
  successScoreReason: string | null;
}

function decisionRank(d: Decision): number {
  if (d === "HIGH_PRIORITY_ALERT") return 0;
  if (d === "WATCH_ONLY") return 1;
  return 2;
}

function comparePreviews(a: PreviewRow, b: PreviewRow): number {
  const dr = decisionRank(a.decision) - decisionRank(b.decision);
  if (dr !== 0) return dr;

  if (b.positive !== a.positive) return b.positive - a.positive;

  const aGain = a.creatorRow?.avgGainPercent;
  const bGain = b.creatorRow?.avgGainPercent;
  if (aGain == null && bGain != null) return 1;
  if (aGain != null && bGain == null) return -1;
  if (aGain != null && bGain != null && aGain !== bGain) return bGain - aGain;

  const aTracked = a.creatorRow?.launchesTracked ?? 0;
  const bTracked = b.creatorRow?.launchesTracked ?? 0;
  if (aTracked !== bTracked) return bTracked - aTracked;

  return b.token.launched_at - a.token.launched_at;
}

function main(): void {
  const databaseUrl = process.env.DATABASE_URL ?? "./data/pumpfun-agent.sqlite";
  const limit = parseLimit(process.env.HIGH_CONFIDENCE_ALERT_LIMIT, 100);
  const minLaunches = parseLimit(
    process.env.HIGH_CONFIDENCE_MIN_CREATOR_LAUNCHES,
    3,
  );
  const maxAlerts = parseLimit(process.env.HIGH_CONFIDENCE_MAX_ALERTS, 2);
  const filePath = resolveDbPath(databaseUrl);

  process.stdout.write("\n=== high-confidence early alert preview ===\n");
  process.stdout.write(`  databaseUrl:                    ${databaseUrl}\n`);
  process.stdout.write(`  resolvedPath:                   ${filePath}\n`);
  process.stdout.write(`  highConfidenceAlertLimit:       ${limit}\n`);
  process.stdout.write(`  highConfidenceMinLaunches:      ${minLaunches}\n`);
  process.stdout.write(`  highConfidenceMaxAlerts:        ${maxAlerts}\n`);

  if (!fs.existsSync(filePath)) {
    process.stdout.write(
      `\nSQLite file not found at ${filePath}. Run ingestion first.\n`,
    );
    process.exit(1);
  }

  let db: Database.Database;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
  } catch (err) {
    process.stdout.write(
      `\nfailed to open SQLite read-only: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  // Load holder risk evaluations (table may not exist on first run — handle gracefully)
  const holderRiskByMint = new Map<string, HolderRiskEval>();
  try {
    const hrRows = db
      .prepare(
        "SELECT mint, holder_risk_label, holder_risk_reason FROM holder_risk_evaluations",
      )
      .all() as { mint: string; holder_risk_label: string; holder_risk_reason: string }[];
    for (const r of hrRows) {
      holderRiskByMint.set(r.mint, {
        label: r.holder_risk_label,
        reason: r.holder_risk_reason,
      });
    }
  } catch {
    // Table does not exist yet — evaluate:holder-risk has not been run; show n/a for all
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
    for (const r of joinRows) {
      let bucket = byMint.get(r.mint);
      if (!bucket) {
        bucket = [];
        byMint.set(r.mint, bucket);
      }
      bucket.push(r);
      if (!mintCreator.has(r.mint)) {
        mintCreator.set(r.mint, r.creator_wallet);
      }
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
      swapDeltaSum: number;
      swapDeltaCount: number;
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
          swapDeltaSum: 0,
          swapDeltaCount: 0,
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
      if (typeof m.swapCountDelta === "number") {
        agg.swapDeltaSum += m.swapCountDelta;
        agg.swapDeltaCount += 1;
      }
      agg.labelCounts[m.outcomeLabel] =
        (agg.labelCounts[m.outcomeLabel] ?? 0) + 1;
      agg.totalSwaps += m.latestSwapCount ?? 0;
      agg.pricedRows += m.pricedObservationCount;
    }

    const creatorRowByWallet = new Map<string, CreatorRow>();
    for (const agg of byCreator.values()) {
      const avgGainPercent = agg.gainCount > 0 ? agg.gainSum / agg.gainCount : null;
      const avgSwapDelta =
        agg.swapDeltaCount > 0 ? agg.swapDeltaSum / agg.swapDeltaCount : null;
      const lc = agg.labelCounts;
      const row: CreatorRow = {
        creatorWallet: agg.creatorWallet,
        launchesTracked: agg.launchesTracked,
        avgGainPercent,
        avgSwapDelta,
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

    // Total launch count + first/last timestamp per creator (includes tokens without outcome rows)
    const launchCountByCreator = new Map<string, number>();
    const firstLaunchAtByCreator = new Map<string, number>();
    const lastLaunchAtByCreator = new Map<string, number>();
    try {
      const lcRows = db
        .prepare(
          `SELECT creator_wallet, COUNT(*) as cnt,
                  MIN(launched_at) as first_at, MAX(launched_at) as last_at
           FROM tokens GROUP BY creator_wallet`,
        )
        .all() as { creator_wallet: string; cnt: number; first_at: number; last_at: number }[];
      for (const r of lcRows) {
        launchCountByCreator.set(r.creator_wallet, r.cnt);
        firstLaunchAtByCreator.set(r.creator_wallet, r.first_at);
        lastLaunchAtByCreator.set(r.creator_wallet, r.last_at);
      }
    } catch {
      // tokens table always exists — this catch is a safeguard only
    }

    // Extreme holder count per creator
    const extremeCountByCreator = new Map<string, number>();
    try {
      const exRows = db
        .prepare(
          `SELECT t.creator_wallet, COUNT(*) as cnt
           FROM holder_risk_evaluations h
           JOIN tokens t ON t.mint = h.mint
           WHERE h.holder_risk_label = 'EXTREME'
           GROUP BY t.creator_wallet`,
        )
        .all() as { creator_wallet: string; cnt: number }[];
      for (const r of exRows) extremeCountByCreator.set(r.creator_wallet, r.cnt);
    } catch {
      // holder_risk_evaluations may not exist yet — no EXTREME data
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
      for (const r of highRows) highCountByCreator.set(r.creator_wallet, r.cnt);
    } catch {
      // holder_risk_evaluations may not exist yet
    }

    // Creator success score — computed before tier so tier can use it
    const successScoreByCreator = new Map<string, CreatorSuccessScoreResult>();
    for (const agg of byCreator.values()) {
      const lc = agg.labelCounts;
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
      };
      successScoreByCreator.set(agg.creatorWallet, computeCreatorSuccessScore(ssInput));
    }

    // Build creator tier map (successScore passed to allow tier upgrades/downgrades)
    const creatorTierByWallet = new Map<string, CreatorTierResult>();
    for (const agg of byCreator.values()) {
      creatorTierByWallet.set(
        agg.creatorWallet,
        computeCreatorTier({
          launches: launchCountByCreator.get(agg.creatorWallet) ?? agg.launchesTracked,
          totalSwaps: agg.totalSwaps,
          pricedRows: agg.pricedRows,
          extremeHolderCount: extremeCountByCreator.get(agg.creatorWallet) ?? 0,
          successScore: successScoreByCreator.get(agg.creatorWallet)?.successScore,
        }),
      );
    }

    const recentTokens = db
      .prepare(
        `SELECT mint, creator_wallet, launched_at, symbol
         FROM tokens
         ORDER BY launched_at DESC
         LIMIT ?`,
      )
      .all(limit) as TokenRow[];

    const previews: PreviewRow[] = [];
    for (const t of recentTokens) {
      const m = mintMetricsByMint.get(t.mint) ?? null;
      const tokenLabel = m?.outcomeLabel ?? null;
      const cr = creatorRowByWallet.get(t.creator_wallet) ?? null;
      const positive = cr ? cr.strongGain + cr.up + cr.activeFlat : 0;
      const bad = cr ? cr.flat + cr.noPrice + cr.down + cr.rugLike : 0;
      const score = scoreCreator(cr);
      const ssEntry = successScoreByCreator.get(t.creator_wallet) ?? null;
      let { decision, reason } = decide(tokenLabel, cr, minLaunches, score, ssEntry?.successScore);

      const holderRisk = holderRiskByMint.get(t.mint) ?? null;
      const holderRiskLabel = holderRisk?.label ?? null;
      const holderRiskReason = holderRisk?.reason ?? null;

      // Block HIGH_PRIORITY_ALERT when holder concentration is HIGH or EXTREME
      if (
        decision === "HIGH_PRIORITY_ALERT" &&
        (holderRiskLabel === "HIGH" || holderRiskLabel === "EXTREME")
      ) {
        decision = "WATCH_ONLY";
        reason = `holder risk ${holderRiskLabel} blocks alert: ${holderRiskReason ?? "see evaluate:holder-risk"}`;
      }

      // Creator tier — hard-reject SPAM and DEAD regardless of earlier decision
      const tierResult = creatorTierByWallet.get(t.creator_wallet) ?? {
        tier: "UNKNOWN_CREATOR" as const,
        reason: "no outcome data for this creator",
      };
      if (tierResult.tier === "SPAM_CREATOR" || tierResult.tier === "DEAD_CREATOR") {
        decision = "REJECT";
        reason = `creatorTier=${tierResult.tier}: ${tierResult.reason}`;
      }

      previews.push({
        token: t,
        tokenLabel,
        creatorRow: cr,
        decision,
        reason,
        positive,
        bad,
        creatorScore: score.creatorScore,
        creatorScoreReason: score.creatorScoreReason,
        previousLaunches: score.previousLaunches,
        positiveOutcomes: score.positiveOutcomes,
        negativeOutcomes: score.negativeOutcomes,
        holderRiskLabel,
        holderRiskReason,
        creatorTier: tierResult.tier,
        creatorTierReason: tierResult.reason,
        successScore: ssEntry?.successScore ?? null,
        successScoreReason: ssEntry?.successScoreReason ?? null,
      });
    }

    previews.sort(comparePreviews);

    let alertCount = 0;
    for (const p of previews) {
      if (p.decision !== "HIGH_PRIORITY_ALERT") continue;
      if (alertCount < maxAlerts) {
        alertCount += 1;
        continue;
      }
      p.decision = "WATCH_ONLY";
      p.reason = `rule 8: cap reached (max=${maxAlerts})`;
    }

    const decisionCounts = new Map<Decision, number>();
    for (const p of previews) {
      decisionCounts.set(p.decision, (decisionCounts.get(p.decision) ?? 0) + 1);
    }

    // Success score distribution
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

    process.stdout.write("\n--- counts ---\n");
    process.stdout.write(`  recentTokensAnalyzed:   ${recentTokens.length}\n`);
    process.stdout.write(
      `  mintsWithOutcomes:      ${mintMetricsByMint.size}\n`,
    );
    process.stdout.write(
      `  creatorsWithOutcomes:   ${creatorRowByWallet.size}\n`,
    );

    process.stdout.write("\n--- decision breakdown ---\n");
    const orderedDecisions: Decision[] = [
      "HIGH_PRIORITY_ALERT",
      "WATCH_ONLY",
      "REJECT",
    ];
    if (previews.length === 0) {
      process.stdout.write("  (no recent tokens)\n");
    } else {
      for (const d of orderedDecisions) {
        process.stdout.write(`  ${pad(d, 20)}  ${decisionCounts.get(d) ?? 0}\n`);
      }
    }

    const highPriorityCount = decisionCounts.get("HIGH_PRIORITY_ALERT") ?? 0;
    if (highPriorityCount === 0) {
      process.stdout.write(
        "\nNo high-confidence alerts. This is expected when data quality/history is still low.\n",
      );
    }

    process.stdout.write("\n--- candidates (strongest first) ---\n");
    if (previews.length === 0) {
      process.stdout.write("  (no tokens in tokens table)\n");
    }
    let idx = 1;
    for (const p of previews) {
      const launchedAtIso = new Date(p.token.launched_at).toISOString();
      const tracked = p.creatorRow?.launchesTracked ?? 0;
      const creatorLabel = p.creatorRow?.creatorOutcomeLabel ?? "UNKNOWN";
      const tokenLabelStr = p.tokenLabel ?? "n/a";
      const avgGain =
        p.creatorRow?.avgGainPercent == null
          ? "n/a"
          : `${p.creatorRow.avgGainPercent.toFixed(2)}%`;
      const cr = p.creatorRow;
      const strg = cr?.strongGain ?? 0;
      const up = cr?.up ?? 0;
      const actv = cr?.activeFlat ?? 0;
      const flat = cr?.flat ?? 0;
      const nopx = cr?.noPrice ?? 0;
      const down = cr?.down ?? 0;
      const rug = cr?.rugLike ?? 0;
      process.stdout.write(
        `  [${idx}] ${launchedAtIso}  symbol=${p.token.symbol}  mint=${shorten(p.token.mint)}  creator=${shorten(p.token.creator_wallet)}\n`,
      );
      process.stdout.write(
        `      tracked=${tracked}  creatorLabel=${creatorLabel}  tokenLabel=${tokenLabelStr}\n`,
      );
      process.stdout.write(
        `      avgCreatorGain=${avgGain}  positive(STRG/UP/ACTV)=${strg}/${up}/${actv}  bad(FLAT/NOPX/DOWN/RUG)=${flat}/${nopx}/${down}/${rug}\n`,
      );
      process.stdout.write(
        `      creatorScore=${p.creatorScore}  previousLaunches=${p.previousLaunches}  positiveOutcomes=${p.positiveOutcomes}  negativeOutcomes=${p.negativeOutcomes}\n`,
      );
      process.stdout.write(
        `      creatorScoreReason=${p.creatorScoreReason.join("; ")}\n`,
      );
      process.stdout.write(
        `      holderRisk=${p.holderRiskLabel ?? "n/a"}  holderRiskReason=${p.holderRiskReason ?? "n/a"}\n`,
      );
      process.stdout.write(
        `      creatorTier=${p.creatorTier}  creatorTierReason=${p.creatorTierReason}\n`,
      );
      process.stdout.write(
        `      successScore=${p.successScore ?? "n/a"}  successScoreReason=${p.successScoreReason ?? "n/a"}\n`,
      );
      process.stdout.write(
        `      finalDecision=${p.decision}  reason=${p.reason}\n`,
      );
      idx++;
    }

    const jsonOut = previews.map((p) => ({
      mint: p.token.mint,
      creatorWallet: p.token.creator_wallet,
      symbol: p.token.symbol,
      launchedAtIso: new Date(p.token.launched_at).toISOString(),
      decision: p.decision,
      finalDecision: p.decision,
      reason: p.reason,
      tracked: p.creatorRow?.launchesTracked ?? 0,
      creatorLabel: p.creatorRow?.creatorOutcomeLabel ?? "UNKNOWN",
      tokenLabel: p.tokenLabel,
      avgGainPercent: p.creatorRow?.avgGainPercent ?? null,
      positive: p.positive,
      bad: p.bad,
      creatorScore: p.creatorScore,
      creatorScoreReason: p.creatorScoreReason,
      previousLaunches: p.previousLaunches,
      positiveOutcomes: p.positiveOutcomes,
      negativeOutcomes: p.negativeOutcomes,
      holderRiskLabel: p.holderRiskLabel,
      holderRiskReason: p.holderRiskReason,
      creatorTier: p.creatorTier,
      creatorTierReason: p.creatorTierReason,
      successScore: p.successScore,
      successScoreReason: p.successScoreReason,
    }));
    const outPath = path.resolve(
      process.cwd(),
      "./data/high-confidence-alerts.json",
    );
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(jsonOut, null, 2));
    process.stdout.write(`\n  wrote: ${outPath}\n`);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `preview:high-confidence:alerts unhandled error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
