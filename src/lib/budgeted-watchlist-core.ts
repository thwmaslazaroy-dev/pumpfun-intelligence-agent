export interface JoinRow {
  mint: string;
  creator_wallet: string;
  observed_at: number;
  usd_price: number | null;
  swap_count: number | null;
}

export interface MintMetrics {
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

export interface CreatorRow {
  creatorWallet: string;
  launchesTracked: number;
  avgGainPercent: number | null;
  strongGain: number;
  up: number;
  activeFlat: number;
  flat: number;
  noPrice: number;
  down: number;
  rugLike: number;
  creatorOutcomeLabel: string;
}

export interface Candidate {
  mint: string;
  symbol: string;
  creatorWallet: string;
  launchedAt: number;
  outcomeCount: number;
  creatorRow: CreatorRow | null;
  positive: number;
  bad: number;
  score: number;
  scoreBreakdown: string;
}

export type BudgetedRejectionReason =
  | "spammyRiskyCreator"
  | "alreadyEnoughSnapshots"
  | "tokenLabelDownOrRug"
  | "tokenNoPriceWithOutcomes"
  | "tokenFlatWithoutPositive"
  | "creatorBadOnly"
  | "creatorMoreBadThanPositive"
  | "creatorAvgGainNegative";

export interface BudgetedRejection {
  reason: BudgetedRejectionReason;
  detail: string;
}

export interface BudgetedRejectInput {
  creatorLabel: string;
  tokenLabel: string | null;
  outcomeCount: number;
  positive: number;
  bad: number;
  avgCreatorGain: number | null;
  fullnessThreshold: number;
}

export function evaluateBudgetedReject(
  input: BudgetedRejectInput,
): BudgetedRejection | null {
  const {
    creatorLabel,
    tokenLabel,
    outcomeCount,
    positive,
    bad,
    avgCreatorGain,
    fullnessThreshold,
  } = input;

  if (creatorLabel === "SPAMMY" || creatorLabel === "RISKY") {
    return {
      reason: "spammyRiskyCreator",
      detail: `creatorLabel=${creatorLabel}`,
    };
  }
  if (outcomeCount >= fullnessThreshold) {
    return {
      reason: "alreadyEnoughSnapshots",
      detail: `outcomeCount=${outcomeCount} >= fullnessThreshold=${fullnessThreshold}`,
    };
  }
  if (tokenLabel === "DOWN" || tokenLabel === "RUG_LIKE") {
    return {
      reason: "tokenLabelDownOrRug",
      detail: `tokenLabel=${tokenLabel}`,
    };
  }
  if (tokenLabel === "NO_PRICE" && outcomeCount > 0) {
    return {
      reason: "tokenNoPriceWithOutcomes",
      detail: `tokenLabel=NO_PRICE outcomeCount=${outcomeCount}`,
    };
  }
  if (tokenLabel === "FLAT" && positive === 0) {
    return {
      reason: "tokenFlatWithoutPositive",
      detail: "tokenLabel=FLAT and creator positive=0",
    };
  }
  if (positive === 0 && bad > 0) {
    return {
      reason: "creatorBadOnly",
      detail: `creator positive=0 bad=${bad}`,
    };
  }
  if (bad > positive) {
    return {
      reason: "creatorMoreBadThanPositive",
      detail: `creator bad=${bad} > positive=${positive}`,
    };
  }
  if (avgCreatorGain !== null && avgCreatorGain < -10) {
    return {
      reason: "creatorAvgGainNegative",
      detail: `avgCreatorGain=${avgCreatorGain.toFixed(2)}% < -10%`,
    };
  }
  return null;
}

export function classifyOutcome(m: {
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

export function classifyCreator(c: CreatorRow): string {
  const promising =
    c.strongGain + c.up + c.activeFlat >= 2 &&
    c.avgGainPercent !== null &&
    c.avgGainPercent >= 0;
  if (promising) return "PROMISING";
  if (c.flat + c.noPrice >= 3) return "SPAMMY";
  if (c.rugLike + c.down >= 2) return "RISKY";
  return "UNKNOWN";
}

export function computeMintMetrics(
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

  return {
    mint,
    creatorWallet,
    observationCount,
    pricedObservationCount,
    gainFromStartPercent,
    maxDrawdownPercent,
    swapCountDelta,
    latestSwapCount,
    outcomeLabel: classifyOutcome({
      pricedObservationCount,
      latestSwapCount,
      maxDrawdownPercent,
      gainFromStartPercent,
      swapCountDelta,
    }),
  };
}

export function scoreCandidate(
  c: Omit<Candidate, "score" | "scoreBreakdown">,
  minLaunches: number,
): { score: number; breakdown: string } {
  const parts: string[] = [];
  let score = 0;

  const creatorLabel = c.creatorRow?.creatorOutcomeLabel ?? "UNKNOWN";
  const launchesTracked = c.creatorRow?.launchesTracked ?? 0;

  if (creatorLabel === "PROMISING") {
    score += 50;
    parts.push("creator=PROMISING(+50)");
  } else if (c.positive >= 2) {
    score += 35;
    parts.push("creator=positive>=2(+35)");
  } else if (c.positive >= 1 && c.bad === 0) {
    score += 25;
    parts.push("creator=positive>=1,bad=0(+25)");
  } else if (c.positive >= 1) {
    score += 15;
    parts.push(`creator=positive=${c.positive},bad=${c.bad}(+15)`);
  } else if (launchesTracked === 0) {
    score += 10;
    parts.push("creator=new(+10)");
  } else {
    parts.push("creator=trackedNoPositive(+0)");
  }

  if (launchesTracked >= 1) {
    const distance = Math.abs(launchesTracked - minLaunches);
    if (distance <= 2) {
      const bonus = 30 - distance * 10;
      if (bonus > 0) {
        score += bonus;
        parts.push(`thresholdDistance=${distance}(+${bonus})`);
      }
    }
  }

  if (
    minLaunches >= 1 &&
    launchesTracked === minLaunches - 1 &&
    c.positive > 0 &&
    c.bad === 0
  ) {
    score += 10;
    parts.push("nearMinLaunchesClean(+10)");
  }

  const ageHours = Math.max(0, (Date.now() - c.launchedAt) / (60 * 60 * 1000));
  let recencyBonus = 0;
  let recencyTag = "";
  if (ageHours < 24) {
    recencyBonus = 5;
    recencyTag = "<24h";
  } else if (ageHours < 72) {
    recencyBonus = 3;
    recencyTag = "<72h";
  } else if (ageHours < 168) {
    recencyBonus = 1;
    recencyTag = "<168h";
  }
  if (recencyBonus > 0) {
    score += recencyBonus;
    parts.push(`recency${recencyTag}(+${recencyBonus})`);
  }

  if (c.bad > 0) {
    const penalty = Math.min(c.bad, 5) * 10;
    score -= penalty;
    parts.push(`bad=${c.bad}(-${penalty})`);
  }

  return { score, breakdown: parts.join(" ") };
}

// ── Creator Quality Tiers ─────────────────────────────────────────────────────

export type CreatorTier =
  | "SPAM_CREATOR"
  | "DEAD_CREATOR"
  | "ACTIVE_CREATOR"
  | "PROMISING_CREATOR"
  | "UNKNOWN_CREATOR";

export interface CreatorTierResult {
  tier: CreatorTier;
  reason: string;
}

export interface CreatorTierInput {
  /** All launches in the tokens table for this creator (includes those without outcomes). */
  launches: number;
  /** Sum of latestSwapCount across mints that have outcome rows. */
  totalSwaps: number;
  /** Sum of pricedObservationCount across mints that have outcome rows. */
  pricedRows: number;
  /** Count of this creator's mints with holder_risk_label = EXTREME. */
  extremeHolderCount: number;
  /** Optional 0–100 success score. When provided, used to boost or penalise tier. */
  successScore?: number;
  /** Smallest window in seconds that contains any 3 consecutive launches; null if < 3 launches. */
  minBurstWindowSec?: number | null;
  /** Proportion of launches with buy_count=0, sell_count=0, volume_usd≈0; null if no launches. */
  zeroActivityRate?: number | null;
}

export function computeCreatorTier(input: CreatorTierInput): CreatorTierResult {
  const {
    launches: l, totalSwaps: sw, pricedRows: pr, extremeHolderCount: ex,
    successScore: ss, minBurstWindowSec: burst, zeroActivityRate: zar,
  } = input;

  // SPAM: rapid launch burst — token factory bot signal
  if (burst !== undefined && burst !== null && burst <= 120 && l >= 3) {
    return { tier: "SPAM_CREATOR", reason: `launchBurst:${l}launches within ${burst.toFixed(0)}s` };
  }

  // SPAM: most launches have zero feed activity (no buys/sells/volume)
  if (zar !== undefined && zar !== null && l >= 5 && zar >= 0.8) {
    return {
      tier: "SPAM_CREATOR",
      reason: `zeroFeedActivity:${Math.round(zar * l)}/${l}launches zero-activity`,
    };
  }

  // SPAM: many launches, no swap activity at all
  if (l >= 8 && sw === 0) {
    return { tier: "SPAM_CREATOR", reason: `launches=${l}>=8 totalSwaps=0` };
  }

  // SPAM: success score confirms spam / rug farm pattern with sufficient evidence
  if (ss !== undefined && ss < 20 && l >= 5) {
    return { tier: "SPAM_CREATOR", reason: `successScore=${ss}<20 launches=${l}>=5` };
  }

  // DEAD: significant launches, zero price data
  if (l >= 5 && pr === 0) {
    return { tier: "DEAD_CREATOR", reason: `launches=${l}>=5 pricedRows=0` };
  }

  // PROMISING (structural) — superset of ACTIVE, check first
  if (l >= 5 && sw >= 100 && pr >= 2 && ex === 0) {
    return {
      tier: "PROMISING_CREATOR",
      reason: `launches=${l}>=5 totalSwaps=${sw}>=100 pricedRows=${pr}>=2 extreme=0`,
    };
  }

  // PROMISING (success-score driven) — high quality outcomes even with lower structural bar
  if (ss !== undefined && ss >= 70 && l >= 3 && sw >= 30 && ex === 0) {
    return {
      tier: "PROMISING_CREATOR",
      reason: `successScore=${ss}>=70 launches=${l}>=3 totalSwaps=${sw}>=30 extreme=0`,
    };
  }

  // ACTIVE
  if (l >= 3 && sw >= 50 && ex === 0) {
    return {
      tier: "ACTIVE_CREATOR",
      reason: `launches=${l}>=3 totalSwaps=${sw}>=50 extreme=0`,
    };
  }

  return {
    tier: "UNKNOWN_CREATOR",
    reason: `launches=${l} totalSwaps=${sw} pricedRows=${pr} extreme=${ex}${ss !== undefined ? ` successScore=${ss}` : ""}`,
  };
}

// ── Creator Success Score v1 ───────────────────────────────────────────────────

export interface CreatorSuccessScoreInput {
  /** Total launches from tokens table (includes mints without outcome rows). */
  launches: number;
  /** Launches that have at least one outcome row. */
  launchesTracked: number;
  strongGain: number;
  up: number;
  activeFlat: number;
  noPrice: number;
  down: number;
  rugLike: number;
  /** Count of this creator's mints with holder_risk_label = EXTREME. */
  extremeHolderCount: number;
  /** Count of this creator's mints with holder_risk_label = HIGH. */
  highHolderCount: number;
  /** Unix-ms timestamp of this creator's earliest token launch (from tokens table). */
  firstLaunchAt: number | null;
  /** Unix-ms timestamp of this creator's most recent token launch (from tokens table). */
  lastLaunchAt: number | null;
  /** Smallest window in seconds that contains any 3 consecutive launches; null if < 3 launches. */
  minBurstWindowSec: number | null;
  /** Count of this creator's tokens with buy_count=0, sell_count=0, volume_usd≈0. */
  zeroActivityCount: number;
  /** Sum of volume_usd across all this creator's tokens (from tokens table). */
  totalVolumeUsd: number;
}

export interface CreatorSuccessScoreResult {
  /** 0–100. Higher is better. */
  successScore: number;
  successScoreReason: string;
}

export function computeCreatorSuccessScore(
  input: CreatorSuccessScoreInput,
): CreatorSuccessScoreResult {
  const {
    launches,
    launchesTracked,
    strongGain,
    up,
    activeFlat,
    noPrice,
    down,
    rugLike,
    extremeHolderCount,
    highHolderCount,
    firstLaunchAt,
    lastLaunchAt,
    minBurstWindowSec,
    zeroActivityCount,
    totalVolumeUsd,
  } = input;

  const parts: string[] = [];
  let score = 50;

  // Positive: good outcome labels
  if (strongGain > 0) {
    const pts = strongGain * 6;
    score += pts;
    parts.push(`STRONG_GAIN×${strongGain}(+${pts})`);
  }
  if (up > 0) {
    const pts = up * 4;
    score += pts;
    parts.push(`UP×${up}(+${pts})`);
  }
  if (activeFlat > 0) {
    const pts = activeFlat * 2;
    score += pts;
    parts.push(`ACTIVE_FLAT×${activeFlat}(+${pts})`);
  }

  // Positive: clean holder history across all tracked launches
  if (extremeHolderCount === 0 && highHolderCount === 0 && launchesTracked >= 2) {
    score += 5;
    parts.push("cleanHolders(+5)");
  }

  // Negative: bad outcome labels
  if (noPrice > 0) {
    const pts = noPrice * 3;
    score -= pts;
    parts.push(`NO_PRICE×${noPrice}(-${pts})`);
  }
  if (down > 0) {
    const pts = down * 5;
    score -= pts;
    parts.push(`DOWN×${down}(-${pts})`);
  }
  if (rugLike > 0) {
    const pts = rugLike * 8;
    score -= pts;
    parts.push(`RUG_LIKE×${rugLike}(-${pts})`);
  }

  // Negative: holder concentration
  if (extremeHolderCount > 0) {
    const pts = extremeHolderCount * 6;
    score -= pts;
    parts.push(`extremeHolder×${extremeHolderCount}(-${pts})`);
  }
  if (highHolderCount > 0) {
    const pts = highHolderCount * 3;
    score -= pts;
    parts.push(`highHolder×${highHolderCount}(-${pts})`);
  }

  // Negative: spam farm — many launches, almost no positive outcomes
  const positiveCount = strongGain + up + activeFlat;
  const positiveRate = launchesTracked > 0 ? positiveCount / launchesTracked : 0;
  if (launches >= 8 && positiveCount < 2) {
    score -= 30;
    parts.push(`spamFarm:${launches}launches<2positive(-30)`);
  } else if (launches >= 5 && launchesTracked >= 3 && positiveRate < 0.2) {
    score -= 15;
    parts.push(`spamPattern:positiveRate=${(positiveRate * 100).toFixed(0)}%(-15)`);
  }

  // Negative: high NO_PRICE rate (price data never materialised)
  if (launchesTracked >= 3 && noPrice / launchesTracked >= 0.7) {
    score -= 15;
    parts.push(`highNoPriceRate:${noPrice}/${launchesTracked}(-15)`);
  }

  // Negative: high rug rate
  if (launchesTracked >= 3 && rugLike / launchesTracked >= 0.4) {
    score -= 20;
    parts.push(`highRugRate:${rugLike}/${launchesTracked}(-20)`);
  }

  // Negative: excessive launch rate (spam factory signal)
  if (
    launches >= 5 &&
    firstLaunchAt !== null &&
    lastLaunchAt !== null &&
    lastLaunchAt > firstLaunchAt
  ) {
    const spanHours = (lastLaunchAt - firstLaunchAt) / (60 * 60 * 1000);
    if (spanHours > 0) {
      const launchesPerHour = launches / spanHours;
      if (launchesPerHour >= 3) {
        score -= 25;
        parts.push(`excessiveLaunchRate:${launchesPerHour.toFixed(1)}/hr(-25)`);
      } else if (launchesPerHour >= 1) {
        score -= 10;
        parts.push(`highLaunchRate:${launchesPerHour.toFixed(1)}/hr(-10)`);
      }
    }
  }

  // Negative: rapid launch burst (token factory bot signal)
  if (minBurstWindowSec !== null && minBurstWindowSec <= 120 && launches >= 3) {
    score -= 30;
    parts.push(`launchBurst:${launches}launches_within_${minBurstWindowSec.toFixed(0)}s(-30)`);
  }

  // Negative: majority of tokens have zero feed activity (buy=0, sell=0, volume=0)
  const zeroRate = launches > 0 ? zeroActivityCount / launches : 0;
  if (launches >= 5 && zeroRate >= 0.8) {
    score -= 20;
    parts.push(`zeroFeedActivity:${zeroActivityCount}/${launches}zero(-20)`);
  }

  // Negative: mass launches within 2 hours with near-zero total volume
  if (
    launches >= 10 &&
    totalVolumeUsd <= 1.0 &&
    firstLaunchAt !== null &&
    lastLaunchAt !== null &&
    lastLaunchAt - firstLaunchAt <= 2 * 60 * 60 * 1000
  ) {
    score -= 30;
    parts.push(`massLaunch+zeroVolume:${launches}launches_vol=$${totalVolumeUsd.toFixed(2)}_within2hr(-30)`);
  }

  const finalScore = Math.max(0, Math.min(100, Math.round(score)));
  if (parts.length === 0) parts.push("baseline=50");
  return {
    successScore: finalScore,
    successScoreReason: `score=${finalScore}; base=50; ${parts.join("; ")}`,
  };
}

// ── Burst detection utility ───────────────────────────────────────────────────

/**
 * Given timestamps (ms, sorted ascending) for one creator's launches,
 * returns the smallest window in seconds that contains any 3 consecutive
 * launches, or null if there are fewer than 3 launches.
 */
export function computeMinBurstWindowSec(sortedTimestampsMs: number[]): number | null {
  if (sortedTimestampsMs.length < 3) return null;
  let minMs = Infinity;
  for (let i = 0; i <= sortedTimestampsMs.length - 3; i++) {
    const span = sortedTimestampsMs[i + 2] - sortedTimestampsMs[i];
    if (span < minMs) minMs = span;
  }
  return minMs === Infinity ? null : minMs / 1000;
}
