import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

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

const GOOD_TOKEN_LABELS = new Set(["ACTIVE_FLAT", "UP", "STRONG_GAIN"]);

function resolveDbPath(databaseUrl: string): string {
  const stripped = databaseUrl.startsWith("sqlite:")
    ? databaseUrl.slice("sqlite:".length)
    : databaseUrl;
  return path.isAbsolute(stripped) ? stripped : path.resolve(process.cwd(), stripped);
}

function parseIntEnv(raw: string | undefined, def: number): number {
  if (!raw) return def;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return def;
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

function decide(
  tokenLabel: string,
  creatorRow: CreatorRow | null,
): { decision: string; reason: string } {
  const creatorLabel = creatorRow?.creatorOutcomeLabel ?? "UNKNOWN";
  const launchesTracked = creatorRow?.launchesTracked ?? 0;
  const tokenLabelGood = GOOD_TOKEN_LABELS.has(tokenLabel);

  if (creatorLabel === "SPAMMY" || creatorLabel === "RISKY") {
    return {
      decision: "WOULD_SKIP",
      reason: `rule 1: creator label is ${creatorLabel}`,
    };
  }
  if (tokenLabel === "NO_PRICE" || tokenLabel === "DEAD_OR_NO_ACTIVITY") {
    return {
      decision: "WOULD_SKIP",
      reason: `rule 2: token label is ${tokenLabel}`,
    };
  }
  if (creatorLabel === "PROMISING" && tokenLabelGood) {
    return {
      decision: "WOULD_ALERT",
      reason: `rule 3: creator PROMISING and token ${tokenLabel}`,
    };
  }
  if (creatorLabel === "UNKNOWN" && tokenLabelGood) {
    return {
      decision: "WOULD_WATCH",
      reason: `rule 4: creator UNKNOWN and token ${tokenLabel}`,
    };
  }
  if (launchesTracked < 3 && tokenLabelGood) {
    return {
      decision: "WOULD_WATCH",
      reason: `rule 5: creatorLaunchesTracked=${launchesTracked} < 3 and token ${tokenLabel}`,
    };
  }
  if (tokenLabel === "FLAT") {
    return {
      decision: "WOULD_SKIP",
      reason: `rule 6: token label is FLAT`,
    };
  }
  return {
    decision: "WOULD_SKIP",
    reason: `rule 7: no rule matched (creator=${creatorLabel}, token=${tokenLabel})`,
  };
}

function main(): void {
  const databaseUrl = process.env.DATABASE_URL ?? "./data/pumpfun-agent.sqlite";
  const limit = parseIntEnv(process.env.DELAYED_ALERT_PREVIEW_LIMIT, 50);
  const minAgeMinutes = parseIntEnv(process.env.MIN_TOKEN_AGE_MINUTES, 5);
  const filePath = resolveDbPath(databaseUrl);

  process.stdout.write("\n=== delayed alert preview ===\n");
  process.stdout.write(`  databaseUrl:                ${databaseUrl}\n`);
  process.stdout.write(`  resolvedPath:               ${filePath}\n`);
  process.stdout.write(`  delayedAlertPreviewLimit:   ${limit}\n`);
  process.stdout.write(`  minTokenAgeMinutes:         ${minAgeMinutes}\n`);
  process.stdout.write(
    `  alertSink:                  NONE (Discord disabled, read-only)\n`,
  );

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

    const candidates = db
      .prepare(
        `SELECT mint, creator_wallet, launched_at, symbol
         FROM tokens
         ORDER BY launched_at DESC
         LIMIT ?`,
      )
      .all(limit) as TokenRow[];

    const ageThresholdMs = minAgeMinutes * 60 * 1000;
    const now = Date.now();
    let skippedTooNew = 0;
    let skippedNoOutcome = 0;
    const decisionCounts = new Map<string, number>();

    interface PreviewRow {
      token: TokenRow;
      tokenLabel: string;
      creatorRow: CreatorRow | null;
      decision: string;
      reason: string;
    }
    const previews: PreviewRow[] = [];

    for (const t of candidates) {
      const ageMs = now - t.launched_at;
      if (ageMs < ageThresholdMs) {
        skippedTooNew += 1;
        continue;
      }
      const m = mintMetricsByMint.get(t.mint);
      if (!m) {
        skippedNoOutcome += 1;
        continue;
      }
      const cr = creatorRowByWallet.get(t.creator_wallet) ?? null;
      const { decision, reason } = decide(m.outcomeLabel, cr);
      previews.push({
        token: t,
        tokenLabel: m.outcomeLabel,
        creatorRow: cr,
        decision,
        reason,
      });
      decisionCounts.set(decision, (decisionCounts.get(decision) ?? 0) + 1);
    }

    process.stdout.write("\n--- counts ---\n");
    process.stdout.write(`  totalCandidates:          ${candidates.length}\n`);
    process.stdout.write(`  skippedBecauseTooNew:     ${skippedTooNew}\n`);
    process.stdout.write(`  skippedBecauseNoOutcome:  ${skippedNoOutcome}\n`);
    process.stdout.write(`  evaluated:                ${previews.length}\n`);

    process.stdout.write("\n--- decision breakdown ---\n");
    if (decisionCounts.size === 0) {
      process.stdout.write("  (no evaluated tokens)\n");
    } else {
      const sorted = [...decisionCounts.entries()].sort((a, b) => b[1] - a[1]);
      for (const [d, c] of sorted) {
        process.stdout.write(`  ${pad(d, 14)}  ${c}\n`);
      }
    }

    process.stdout.write("\n--- evaluated tokens ---\n");
    if (previews.length === 0) {
      process.stdout.write("  (no evaluated tokens)\n");
    } else {
      process.stdout.write(
        `  ${pad("createdAt", 24)}  ${pad("mint", 17)}  ${pad("creator", 17)}  ${pad("tokenLabel", 20)}  ${pad("creatorLabel", 9)}  ${pad("decision", 12)}  reason\n`,
      );
      for (const p of previews) {
        const ts = new Date(p.token.launched_at).toISOString();
        const cl = p.creatorRow?.creatorOutcomeLabel ?? "UNKNOWN";
        process.stdout.write(
          `  ${pad(ts, 24)}  ${pad(shorten(p.token.mint), 17)}  ${pad(shorten(p.token.creator_wallet), 17)}  ${pad(p.tokenLabel, 20)}  ${pad(cl, 9)}  ${pad(p.decision, 12)}  ${p.reason}\n`,
        );
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
    `preview:delayed:alerts unhandled error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
