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
}

export function computeCreatorTier(input: CreatorTierInput): CreatorTierResult {
  const { launches: l, totalSwaps: sw, pricedRows: pr, extremeHolderCount: ex } = input;

  // SPAM: many launches, no swap activity at all
  if (l >= 8 && sw === 0) {
    return { tier: "SPAM_CREATOR", reason: `launches=${l}>=8 totalSwaps=0` };
  }

  // DEAD: significant launches, zero price data
  if (l >= 5 && pr === 0) {
    return { tier: "DEAD_CREATOR", reason: `launches=${l}>=5 pricedRows=0` };
  }

  // PROMISING — superset of ACTIVE, check first
  if (l >= 5 && sw >= 100 && pr >= 2 && ex === 0) {
    return {
      tier: "PROMISING_CREATOR",
      reason: `launches=${l}>=5 totalSwaps=${sw}>=100 pricedRows=${pr}>=2 extreme=0`,
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
    reason: `launches=${l} totalSwaps=${sw} pricedRows=${pr} extreme=${ex}`,
  };
}
