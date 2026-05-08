import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import {
  computeCreatorSuccessScore,
  computeCreatorTier,
  computeMinBurstWindowSec,
  CreatorSuccessScoreInput,
  CreatorSuccessScoreResult,
  CreatorTierResult,
  tokenHasActivity,
} from "../lib/budgeted-watchlist-core";

// ── Row shapes from SQLite ─────────────────────────────────────────────────────

interface TokenRow {
  mint: string;
  creator_wallet: string;
  launched_at: number;
  symbol: string;
  // Feed-level counters stored at ingest time (from Pump.fun created feed)
  buy_count: number;
  sell_count: number;
  volume_usd: number;
  initial_market_cap_usd: number;
  bonding_curve_progress: number;
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

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(2)}`;
}

// ── Outcome classification ─────────────────────────────────────────────────────

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

// ── Creator scoring ───────────────────────────────────────────────────────────

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

  if (previousLaunches >= 5 && negativeOutcomes / previousLaunches >= 0.7) {
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

  return { creatorScore: score, creatorScoreReason: reasons, previousLaunches, positiveOutcomes, negativeOutcomes };
}

// ── Decision logic ────────────────────────────────────────────────────────────

type Decision = "HIGH_PRIORITY_ALERT" | "WATCH_ONLY" | "REJECT";

/**
 * Core per-token decision function. Returns the initial decision before
 * post-decision overrides (holder risk, tier hard-reject, WATCH_ONLY gate).
 *
 * tokenHasRealFeedActivity: true when the token's feed-level counters
 * (buy_count, sell_count, volume_usd) show genuine on-chain activity —
 * required for HIGH_PRIORITY_ALERT so we don't fire on Moralis swap_count alone.
 */
function decide(
  tokenLabel: string | null,
  creatorRow: CreatorRow | null,
  minLaunches: number,
  scoreResult: CreatorScoreResult,
  successScore: number | undefined,
  tokenHasRealFeedActivity: boolean,
): { decision: Decision; reason: string; rejectedByMinLaunches: boolean } {
  // Rule 0: success score confirms spam / rug farm — hard reject before anything else
  if (successScore !== undefined && successScore < 20) {
    return {
      decision: "REJECT",
      reason: `rule 0: successScore=${successScore}<20 (confirmed spam/rug pattern)`,
      rejectedByMinLaunches: false,
    };
  }

  if (scoreResult.creatorScore <= -8) {
    return {
      decision: "REJECT",
      reason: `rule 9: very negative creatorScore=${scoreResult.creatorScore}`,
      rejectedByMinLaunches: false,
    };
  }

  if (creatorRow === null) {
    return { decision: "REJECT", reason: "rule 1: no creator history", rejectedByMinLaunches: false };
  }

  const creatorLabel = creatorRow.creatorOutcomeLabel;
  if (creatorLabel === "SPAMMY" || creatorLabel === "RISKY") {
    return {
      decision: "REJECT",
      reason: `rule 1: creator label is ${creatorLabel}`,
      rejectedByMinLaunches: false,
    };
  }

  if (creatorRow.launchesTracked < minLaunches) {
    return {
      decision: "REJECT",
      reason: `rule 2: creatorLaunchesTracked=${creatorRow.launchesTracked} < min=${minLaunches}`,
      rejectedByMinLaunches: true,
    };
  }

  const positive = creatorRow.strongGain + creatorRow.up + creatorRow.activeFlat;
  const bad = creatorRow.flat + creatorRow.noPrice + creatorRow.down + creatorRow.rugLike;

  if (positive === 0) {
    return { decision: "REJECT", reason: "rule 3: creator has 0 positive outcomes", rejectedByMinLaunches: false };
  }

  if (bad > positive) {
    return {
      decision: "REJECT",
      reason: `rule 4: bad=${bad} > positive=${positive}`,
      rejectedByMinLaunches: false,
    };
  }

  if (tokenLabel !== null && BAD_CURRENT_TOKEN_LABELS.has(tokenLabel)) {
    return {
      decision: "REJECT",
      reason: `rule 5: current tokenLabel is ${tokenLabel}`,
      rejectedByMinLaunches: false,
    };
  }

  const eligibleByCreator = creatorLabel === "PROMISING" || (positive >= 2 && bad <= positive);
  const tokenOk = tokenLabel === null || OK_CURRENT_TOKEN_LABELS.has(tokenLabel);
  const tokenStrictOk = tokenLabel !== null && OK_CURRENT_TOKEN_LABELS.has(tokenLabel);

  if (eligibleByCreator && tokenOk) {
    // HIGH_PRIORITY_ALERT requires:
    //   • strong creatorScore
    //   • confirmed token momentum (strict label)
    //   • successScore >= 45 (blocks borderline spam farms)
    //   • real feed-level activity on the current token (not just Moralis swap_count)
    const successScoreOk = successScore === undefined || successScore >= 45;
    if (scoreResult.creatorScore >= 8 && tokenStrictOk && successScoreOk && tokenHasRealFeedActivity) {
      return {
        decision: "HIGH_PRIORITY_ALERT",
        reason: `rule 6: creatorLabel=${creatorLabel} positive=${positive} bad=${bad} tokenLabel=${tokenLabel ?? "n/a"} creatorScore=${scoreResult.creatorScore} successScore=${successScore ?? "n/a"}`,
        rejectedByMinLaunches: false,
      };
    }
    const gateBlocks: string[] = [];
    if (scoreResult.creatorScore < 8) gateBlocks.push(`creatorScore=${scoreResult.creatorScore}<8`);
    if (!tokenStrictOk) gateBlocks.push(`tokenLabel=${tokenLabel ?? "n/a"} not in OK set`);
    if (!successScoreOk) gateBlocks.push(`successScore=${successScore}<45`);
    if (!tokenHasRealFeedActivity) gateBlocks.push("no real feed activity (buy/sell/vol=0)");
    return {
      decision: "WATCH_ONLY",
      reason: `rule 6b: high-priority gate not met (${gateBlocks.join("; ")}); held at watch-only`,
      rejectedByMinLaunches: false,
    };
  }

  return {
    decision: "WATCH_ONLY",
    reason: `rule 7: passed filters but not strong enough (creatorLabel=${creatorLabel} positive=${positive} bad=${bad} tokenLabel=${tokenLabel ?? "n/a"})`,
    rejectedByMinLaunches: false,
  };
}

// ── Preview record ────────────────────────────────────────────────────────────

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
  // Current token feed signals
  hasRealFeedActivity: boolean;
  isOnBudgetedWatchlist: boolean;
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

// ── Main ──────────────────────────────────────────────────────────────────────

function main(): void {
  const databaseUrl = process.env.DATABASE_URL ?? "./data/pumpfun-agent.sqlite";
  const limit = parseLimit(process.env.HIGH_CONFIDENCE_ALERT_LIMIT, 100);
  const minLaunches = parseLimit(process.env.HIGH_CONFIDENCE_MIN_CREATOR_LAUNCHES, 3);
  const maxAlerts = parseLimit(process.env.HIGH_CONFIDENCE_MAX_ALERTS, 2);
  const filePath = resolveDbPath(databaseUrl);

  process.stdout.write("\n=== high-confidence early alert preview ===\n");
  process.stdout.write(`  databaseUrl:                    ${databaseUrl}\n`);
  process.stdout.write(`  resolvedPath:                   ${filePath}\n`);
  process.stdout.write(`  highConfidenceAlertLimit:       ${limit}\n`);
  process.stdout.write(`  highConfidenceMinLaunches:      ${minLaunches}\n`);
  process.stdout.write(`  highConfidenceMaxAlerts:        ${maxAlerts}\n`);

  if (!fs.existsSync(filePath)) {
    process.stdout.write(`\nSQLite file not found at ${filePath}. Run ingestion first.\n`);
    process.exit(1);
  }

  // Load budgeted-watchlist mints (optional — used as WATCH_ONLY activity signal)
  const budgetedMints = new Set<string>();
  const watchlistPath = process.env.OUTCOME_WATCHLIST_PATH ?? "./data/budgeted-outcome-watchlist.txt";
  try {
    const wlContent = fs.readFileSync(
      path.isAbsolute(watchlistPath) ? watchlistPath : path.resolve(process.cwd(), watchlistPath),
      "utf8",
    );
    for (const line of wlContent.split("\n")) {
      const t = line.trim();
      if (t && !t.startsWith("#")) budgetedMints.add(t);
    }
  } catch { /* file not yet generated — budgetedMints stays empty */ }

  let db: Database.Database;
  try {
    db = new Database(filePath, { readonly: true, fileMustExist: true });
  } catch (err) {
    process.stdout.write(
      `\nfailed to open SQLite read-only: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  }

  // Load holder risk evaluations (table may not exist on first run)
  const holderRiskByMint = new Map<string, HolderRiskEval>();
  try {
    const hrRows = db
      .prepare("SELECT mint, holder_risk_label, holder_risk_reason FROM holder_risk_evaluations")
      .all() as { mint: string; holder_risk_label: string; holder_risk_reason: string }[];
    for (const r of hrRows) {
      holderRiskByMint.set(r.mint, { label: r.holder_risk_label, reason: r.holder_risk_reason });
    }
  } catch { /* table not yet created */ }

  try {
    // ── Outcomes → per-mint metrics ────────────────────────────────────────────
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
      if (!bucket) { bucket = []; byMint.set(r.mint, bucket); }
      bucket.push(r);
      if (!mintCreator.has(r.mint)) mintCreator.set(r.mint, r.creator_wallet);
    }

    const mintMetricsByMint = new Map<string, MintMetrics>();
    for (const [mint, rows] of byMint.entries()) {
      const creator = mintCreator.get(mint) ?? "";
      mintMetricsByMint.set(mint, computeMintMetrics(mint, creator, rows));
    }

    // ── Per-creator outcome aggregation ───────────────────────────────────────
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
        agg = { creatorWallet: m.creatorWallet, launchesTracked: 0, gainSum: 0, gainCount: 0, swapDeltaSum: 0, swapDeltaCount: 0, labelCounts: {}, totalSwaps: 0, pricedRows: 0 };
        byCreator.set(m.creatorWallet, agg);
      }
      agg.launchesTracked += 1;
      if (typeof m.gainFromStartPercent === "number") { agg.gainSum += m.gainFromStartPercent; agg.gainCount += 1; }
      if (typeof m.swapCountDelta === "number") { agg.swapDeltaSum += m.swapCountDelta; agg.swapDeltaCount += 1; }
      agg.labelCounts[m.outcomeLabel] = (agg.labelCounts[m.outcomeLabel] ?? 0) + 1;
      agg.totalSwaps += m.latestSwapCount ?? 0;
      agg.pricedRows += m.pricedObservationCount;
    }

    const creatorRowByWallet = new Map<string, CreatorRow>();
    for (const agg of byCreator.values()) {
      const avgGainPercent = agg.gainCount > 0 ? agg.gainSum / agg.gainCount : null;
      const avgSwapDelta = agg.swapDeltaCount > 0 ? agg.swapDeltaSum / agg.swapDeltaCount : null;
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

    // ── Per-creator structural data ────────────────────────────────────────────
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
    } catch { /* safeguard */ }

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
    } catch { /* holder_risk_evaluations may not exist */ }

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
    } catch { /* holder_risk_evaluations may not exist */ }

    // ── Burst & zero-activity data ─────────────────────────────────────────────
    const timestampsByCreator = new Map<string, number[]>();
    try {
      const tsRows = db
        .prepare("SELECT creator_wallet, launched_at FROM tokens ORDER BY creator_wallet ASC, launched_at ASC")
        .all() as { creator_wallet: string; launched_at: number }[];
      for (const r of tsRows) {
        let arr = timestampsByCreator.get(r.creator_wallet);
        if (!arr) { arr = []; timestampsByCreator.set(r.creator_wallet, arr); }
        arr.push(r.launched_at);
      }
    } catch { /* safeguard */ }

    const minBurstWindowSecByCreator = new Map<string, number>();
    for (const [wallet, ts] of timestampsByCreator.entries()) {
      const w = computeMinBurstWindowSec(ts);
      if (w !== null) minBurstWindowSecByCreator.set(wallet, w);
    }

    // Per-creator zero-activity stats — computed in TypeScript using tokenHasActivity()
    // so that realActivity=true and zeroFeedActivity can never contradict each other.
    interface ZeroActivityStats { count: number; totalVolumeUsd: number; activeByBcCount: number }
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
          entry = { count: 0, totalVolumeUsd: 0, activeByBcCount: 0 };
          zeroActivityByCreator.set(r.creator_wallet, entry);
        }
        entry.totalVolumeUsd += r.volume_usd ?? 0;
        const active = tokenHasActivity({
          buyCount: r.buy_count,
          sellCount: r.sell_count,
          volumeUsd: r.volume_usd,
          bondingCurveProgress: r.bonding_curve_progress,
        });
        if (!active) {
          entry.count++;
        } else {
          const bc = r.bonding_curve_progress ?? 0;
          const bcActive = bc > 1 ? bc > 38 : bc > 0.38;
          const feedZero = (r.buy_count ?? 0) === 0 && (r.sell_count ?? 0) === 0 && (r.volume_usd ?? 0) <= 0.001;
          if (bcActive && feedZero) entry.activeByBcCount++;
        }
      }
    } catch { /* safeguard */ }

    // ── Success score (computed before tier so tier can use it) ────────────────
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

    // ── Creator tier (uses successScore + burst/activity signals) ─────────────
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

    // ── Recent tokens (includes feed-level counters for real-activity check) ───
    const recentTokens = db
      .prepare(
        `SELECT mint, creator_wallet, launched_at, symbol,
                buy_count, sell_count, volume_usd,
                initial_market_cap_usd, bonding_curve_progress
         FROM tokens
         ORDER BY launched_at DESC
         LIMIT ?`,
      )
      .all(limit) as TokenRow[];

    // ── Per-token decision loop ────────────────────────────────────────────────
    // Counters — all rejection reasons are tracked separately for diagnostics
    let rejectedSpamCreator = 0;       // tier = SPAM_CREATOR (any sub-reason)
    let rejectedDeadCreator = 0;       // tier = DEAD_CREATOR
    let rejectedBurstCreator = 0;      // SPAM_CREATOR specifically via launchBurst
    let rejectedZeroActivityCreator = 0; // SPAM_CREATOR specifically via zeroFeedActivity
    let rejectedHighHolderRisk = 0;    // HIGH or EXTREME holder concentration
    let rejectedNoCurrentTokenActivity = 0; // WATCH_ONLY gate: no feed activity & not budgeted
    let watchOnlyLimitedHistoryPromoted = 0; // REJECT→WATCH_ONLY for ACTIVE/PROMISING
    let highPriorityPassed = 0;        // final HIGH_PRIORITY_ALERT count (after cap)

    const previews: PreviewRow[] = [];

    for (const t of recentTokens) {
      const m = mintMetricsByMint.get(t.mint) ?? null;
      const tokenLabel = m?.outcomeLabel ?? null;
      const cr = creatorRowByWallet.get(t.creator_wallet) ?? null;
      const positive = cr ? cr.strongGain + cr.up + cr.activeFlat : 0;
      const bad = cr ? cr.flat + cr.noPrice + cr.down + cr.rugLike : 0;
      const score = scoreCreator(cr);
      const ssEntry = successScoreByCreator.get(t.creator_wallet) ?? null;

      // Real activity: uses tokenHasActivity() (same helper as zeroFeedActivity calculation)
      // so realActivity=true and zeroFeedActivity can never contradict each other.
      // Supplemented by Moralis swap_count from token_outcomes as an independent signal.
      const outcomeSwapCount = m?.latestSwapCount ?? 0;
      const hasRealFeedActivity =
        tokenHasActivity({
          buyCount: t.buy_count,
          sellCount: t.sell_count,
          volumeUsd: t.volume_usd,
          bondingCurveProgress: t.bonding_curve_progress,
        }) || outcomeSwapCount > 0;
      const isOnBudgetedWatchlist = budgetedMints.has(t.mint);

      let { decision, reason, rejectedByMinLaunches } = decide(
        tokenLabel, cr, minLaunches, score, ssEntry?.successScore, hasRealFeedActivity,
      );

      const holderRisk = holderRiskByMint.get(t.mint) ?? null;
      const holderRiskLabel = holderRisk?.label ?? null;
      const holderRiskReason = holderRisk?.reason ?? null;

      // Holder risk: HIGH or EXTREME blocks both HIGH_PRIORITY_ALERT and WATCH_ONLY.
      // We want WATCH_ONLY reserved for clean-holder creators only.
      if (holderRiskLabel === "HIGH" || holderRiskLabel === "EXTREME") {
        if (decision === "HIGH_PRIORITY_ALERT" || decision === "WATCH_ONLY") {
          decision = "REJECT";
          reason = `holderRisk=${holderRiskLabel} blocks decision: ${holderRiskReason ?? "see evaluate:holder-risk"}`;
          rejectedHighHolderRisk++;
        }
      }

      // Creator tier: SPAM and DEAD are always hard-rejected.
      const tierResult = creatorTierByWallet.get(t.creator_wallet) ?? {
        tier: "UNKNOWN_CREATOR" as const,
        reason: "no outcome data for this creator",
      };
      if (tierResult.tier === "SPAM_CREATOR" || tierResult.tier === "DEAD_CREATOR") {
        decision = "REJECT";
        reason = `creatorTier=${tierResult.tier}: ${tierResult.reason}`;
        if (tierResult.tier === "SPAM_CREATOR") {
          rejectedSpamCreator++;
          if (tierResult.reason.includes("launchBurst")) rejectedBurstCreator++;
          if (tierResult.reason.includes("zeroFeedActivity")) rejectedZeroActivityCreator++;
        } else {
          rejectedDeadCreator++;
        }
      }

      // Promote REJECT → WATCH_ONLY for ACTIVE/PROMISING creators blocked only by
      // limited tracked outcomes (rule 2). HIGH_PRIORITY_ALERT is never produced here.
      if (
        rejectedByMinLaunches &&
        decision === "REJECT" &&
        (tierResult.tier === "ACTIVE_CREATOR" || tierResult.tier === "PROMISING_CREATOR") &&
        (ssEntry?.successScore ?? 0) >= 45 &&
        holderRiskLabel !== "HIGH" &&
        holderRiskLabel !== "EXTREME" &&
        tokenLabel !== "DOWN" &&
        tokenLabel !== "RUG_LIKE"
      ) {
        decision = "WATCH_ONLY";
        reason = `watch_only: active/promising creator (tier=${tierResult.tier} successScore=${ssEntry?.successScore}) with limited tracked outcomes (tracked=${cr?.launchesTracked ?? 0} < min=${minLaunches})`;
        watchOnlyLimitedHistoryPromoted++;
      }

      // WATCH_ONLY quality gate: require ACTIVE/PROMISING tier + successScore >= 45
      // + at least some activity signal (real feed or on budgeted watchlist).
      // This keeps WATCH_ONLY rare and meaningful rather than a catch-all.
      if (decision === "WATCH_ONLY") {
        const tierOk =
          tierResult.tier === "ACTIVE_CREATOR" || tierResult.tier === "PROMISING_CREATOR";
        const ssOk = (ssEntry?.successScore ?? 0) >= 45;
        const activityOk = hasRealFeedActivity || isOnBudgetedWatchlist;

        if (!tierOk || !ssOk || !activityOk) {
          let gateReason: string;
          if (!tierOk) {
            gateReason = `tier=${tierResult.tier} (ACTIVE/PROMISING required for WATCH_ONLY)`;
          } else if (!ssOk) {
            gateReason = `successScore=${ssEntry?.successScore ?? 0}<45`;
          } else {
            gateReason = `no real feed activity (buy=${t.buy_count} sell=${t.sell_count} vol=${t.volume_usd.toFixed(4)}) and not on budgeted watchlist`;
            rejectedNoCurrentTokenActivity++;
          }
          decision = "REJECT";
          reason = `watch_only gate: ${gateReason}`;
        }
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
        hasRealFeedActivity,
        isOnBudgetedWatchlist,
      });
    }

    previews.sort(comparePreviews);

    // Apply alert cap — demote excess HIGH_PRIORITY_ALERT to WATCH_ONLY
    let alertCount = 0;
    for (const p of previews) {
      if (p.decision !== "HIGH_PRIORITY_ALERT") continue;
      if (alertCount < maxAlerts) {
        alertCount++;
        highPriorityPassed++;
        continue;
      }
      p.decision = "WATCH_ONLY";
      p.reason = `rule 8: alert cap reached (max=${maxAlerts})`;
    }

    const decisionCounts = new Map<Decision, number>();
    for (const p of previews) {
      decisionCounts.set(p.decision, (decisionCounts.get(p.decision) ?? 0) + 1);
    }

    // ── Success score distribution ─────────────────────────────────────────────
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

    // ── Counters ──────────────────────────────────────────────────────────────
    // Activity diagnostic across all creators
    let dbgTotalZero = 0;
    let dbgActiveByBc = 0;
    for (const s of zeroActivityByCreator.values()) {
      dbgTotalZero += s.count;
      dbgActiveByBc += s.activeByBcCount;
    }

    process.stdout.write("\n--- counts ---\n");
    process.stdout.write(`  recentTokensAnalyzed:              ${recentTokens.length}\n`);
    process.stdout.write(`  mintsWithOutcomes:                 ${mintMetricsByMint.size}\n`);
    process.stdout.write(`  creatorsWithOutcomes:              ${creatorRowByWallet.size}\n`);
    process.stdout.write(`  budgetedWatchlistMints:            ${budgetedMints.size}\n`);
    process.stdout.write("\n--- activity diagnostics (all tokens in DB) ---\n");
    process.stdout.write(`  zeroActivityCount:                 ${dbgTotalZero}\n`);
    process.stdout.write(`  activeByBondingCurveCount:         ${dbgActiveByBc}\n`);
    process.stdout.write("\n--- rejection counters ---\n");
    process.stdout.write(`  rejectedSpamCreator:               ${rejectedSpamCreator}\n`);
    process.stdout.write(`  rejectedDeadCreator:               ${rejectedDeadCreator}\n`);
    process.stdout.write(`  rejectedBurstCreator:              ${rejectedBurstCreator}\n`);
    process.stdout.write(`  rejectedZeroActivityCreator:       ${rejectedZeroActivityCreator}\n`);
    process.stdout.write(`  rejectedHighHolderRisk:            ${rejectedHighHolderRisk}\n`);
    process.stdout.write(`  rejectedNoCurrentTokenActivity:    ${rejectedNoCurrentTokenActivity}\n`);
    process.stdout.write(`  watchOnlyLimitedHistoryPromoted:   ${watchOnlyLimitedHistoryPromoted}\n`);
    process.stdout.write(`  highPriorityPassed:                ${highPriorityPassed}\n`);

    // ── Decision breakdown ────────────────────────────────────────────────────
    process.stdout.write("\n--- decision breakdown ---\n");
    const orderedDecisions: Decision[] = ["HIGH_PRIORITY_ALERT", "WATCH_ONLY", "REJECT"];
    if (previews.length === 0) {
      process.stdout.write("  (no recent tokens)\n");
    } else {
      for (const d of orderedDecisions) {
        process.stdout.write(`  ${pad(d, 20)}  ${decisionCounts.get(d) ?? 0}\n`);
      }
    }

    if ((decisionCounts.get("HIGH_PRIORITY_ALERT") ?? 0) === 0) {
      process.stdout.write(
        "\nNo high-confidence alerts. This is expected when data quality/history is still low.\n",
      );
    }

    // ── Full candidate detail (strongest first) ────────────────────────────────
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
      process.stdout.write(
        `  [${idx}] ${launchedAtIso}  symbol=${p.token.symbol}  mint=${shorten(p.token.mint)}  creator=${shorten(p.token.creator_wallet)}\n`,
      );
      process.stdout.write(
        `      feed: buy=${p.token.buy_count}  sell=${p.token.sell_count}  vol=${fmtUsd(p.token.volume_usd)}  mcap=${fmtUsd(p.token.initial_market_cap_usd)}  bc=${(p.token.bonding_curve_progress * 100).toFixed(1)}%  realActivity=${p.hasRealFeedActivity}  budgeted=${p.isOnBudgetedWatchlist}\n`,
      );
      process.stdout.write(
        `      tracked=${tracked}  creatorLabel=${creatorLabel}  tokenLabel=${tokenLabelStr}\n`,
      );
      process.stdout.write(
        `      avgCreatorGain=${avgGain}  positive(STRG/UP/ACTV)=${cr?.strongGain ?? 0}/${cr?.up ?? 0}/${cr?.activeFlat ?? 0}  bad(FLAT/NOPX/DOWN/RUG)=${cr?.flat ?? 0}/${cr?.noPrice ?? 0}/${cr?.down ?? 0}/${cr?.rugLike ?? 0}\n`,
      );
      process.stdout.write(
        `      creatorScore=${p.creatorScore}  previousLaunches=${p.previousLaunches}  positiveOutcomes=${p.positiveOutcomes}  negativeOutcomes=${p.negativeOutcomes}\n`,
      );
      process.stdout.write(`      creatorScoreReason=${p.creatorScoreReason.join("; ")}\n`);
      process.stdout.write(`      holderRisk=${p.holderRiskLabel ?? "n/a"}  holderRiskReason=${p.holderRiskReason ?? "n/a"}\n`);
      process.stdout.write(`      creatorTier=${p.creatorTier}  creatorTierReason=${p.creatorTierReason}\n`);
      process.stdout.write(`      successScore=${p.successScore ?? "n/a"}  successScoreReason=${p.successScoreReason ?? "n/a"}\n`);
      process.stdout.write(`      finalDecision=${p.decision}  reason=${p.reason}\n`);
      idx++;
    }

    // ── Dry-run report: compact table for quick scanning ──────────────────────
    process.stdout.write("\n--- dry-run report (recent tokens, compact) ---\n");
    process.stdout.write(
      `  ${"SYMBOL".padEnd(12)} ${"MINT".padEnd(18)} ${"CREATOR".padEnd(18)} ${"BUY".padStart(4)} ${"SELL".padStart(4)} ${"VOL".padStart(10)} ${"TIER".padEnd(20)} ${"SS".padStart(3)} ${"HOLDER".padEnd(8)} ${"DECISION".padEnd(20)} REASON\n`,
    );
    process.stdout.write(`  ${"-".repeat(150)}\n`);
    for (const p of previews) {
      const sym = pad(p.token.symbol, 12);
      const mint = pad(shorten(p.token.mint), 18);
      const creator = pad(shorten(p.token.creator_wallet), 18);
      const buy = String(p.token.buy_count).padStart(4);
      const sell = String(p.token.sell_count).padStart(4);
      const vol = fmtUsd(p.token.volume_usd).padStart(10);
      const tier = pad(p.creatorTier, 20);
      const ss = (p.successScore !== null ? String(p.successScore) : "n/a").padStart(3);
      const hr = pad(p.holderRiskLabel ?? "n/a", 8);
      const dec = pad(p.decision, 20);
      // Truncate reason for compact display
      const reasonShort = p.reason.length > 60 ? p.reason.slice(0, 57) + "..." : p.reason;
      process.stdout.write(`  ${sym} ${mint} ${creator} ${buy} ${sell} ${vol} ${tier} ${ss} ${hr} ${dec} ${reasonShort}\n`);
    }

    // ── JSON output ───────────────────────────────────────────────────────────
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
      // Feed signals
      tokenBuyCount: p.token.buy_count,
      tokenSellCount: p.token.sell_count,
      tokenVolumeUsd: p.token.volume_usd,
      tokenInitialMcapUsd: p.token.initial_market_cap_usd,
      tokenBondingCurveProgress: p.token.bonding_curve_progress,
      hasRealFeedActivity: p.hasRealFeedActivity,
      isOnBudgetedWatchlist: p.isOnBudgetedWatchlist,
    }));
    const outPath = path.resolve(process.cwd(), "./data/high-confidence-alerts.json");
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
