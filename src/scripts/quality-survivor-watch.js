require("dotenv").config();

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

// ── Config / env ──────────────────────────────────────────────────────────────
function resolveDbPath(databaseUrl) {
  const stripped = databaseUrl.startsWith("sqlite:")
    ? databaseUrl.slice("sqlite:".length)
    : databaseUrl;
  return path.isAbsolute(stripped) ? stripped : path.resolve(process.cwd(), stripped);
}

const DB_PATH = resolveDbPath(process.env.DATABASE_URL || "./data/pumpfun-agent.sqlite");
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || "";

// ── CFG thresholds ────────────────────────────────────────────────────────────
const EVAL_INTERVAL_MS = 60_000; // run every 60s

// Age window (based on created_timestamp_ms)
const MIN_AGE_MIN = 20;
const MAX_AGE_MIN = 90;

// Survivor thresholds
const MIN_MARKET_CAP_USD = 5_000;        // current MC floor
const MAX_DRAWDOWN_FROM_ATH = 0.40;      // current MC must be >= 60% of ATH
const MIN_SNAPSHOTS = 8;                 // at least 8 observations on record
const BEST_RANK_EVER_MAX = 8;            // must have hit top-8 rank at some point
const CURRENT_RANK_MAX = 25;             // still ranked reasonably now
const MIN_MC_GROWTH_FROM_FIRST = 0.50;   // +50% growth from first observed snapshot

// Duplicate name/symbol filter
const DUPLICATE_NAME_WINDOW_MS = 48 * 60 * 60 * 1000;

// Alert spam protection
const ALERT_DEDUPE_WINDOW_MS = 6 * 60 * 60 * 1000; // don't re-alert the same mint within 6h
const MAX_ALERTS_PER_HOUR = 3;

// ── State (in-memory) ─────────────────────────────────────────────────────────
const alertedAt = new Map();   // mint -> timestamp of last alert
const alertTimestamps = [];    // recent alert send times, for the hourly cap

// ── Logging ───────────────────────────────────────────────────────────────────
function log(msg, extra) {
  const line = extra ? `${msg} ${JSON.stringify(extra)}` : msg;
  process.stdout.write(`[${new Date().toISOString()}] ${line}\n`);
}

// Debug aid for threshold tuning: logs which specific check eliminated a candidate
function logRejected(mint, name, reason, detail) {
  log("[REJECTED]", { mint: mint.slice(0, 8) + "…", name, reason, ...detail });
}

// ── Database ──────────────────────────────────────────────────────────────────
if (!fs.existsSync(DB_PATH)) {
  log(`ERROR: database file not found: ${DB_PATH}`);
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

const candidateMintsStmt = db.prepare(`
  SELECT DISTINCT mint
  FROM pump_momentum_snapshots
  WHERE created_timestamp_ms BETWEEN ? AND ?
`);

const latestSnapshotStmt = db.prepare(`
  SELECT *
  FROM pump_momentum_snapshots
  WHERE mint = ?
  ORDER BY observed_at_ms DESC
  LIMIT 1
`);

const firstSnapshotStmt = db.prepare(`
  SELECT *
  FROM pump_momentum_snapshots
  WHERE mint = ?
  ORDER BY observed_at_ms ASC
  LIMIT 1
`);

const snapshotStatsStmt = db.prepare(`
  SELECT COUNT(*) AS count, MIN(recommendation_rank) AS bestRank
  FROM pump_momentum_snapshots
  WHERE mint = ?
`);

const duplicateNameStmt = db.prepare(`
  SELECT 1
  FROM pump_momentum_snapshots
  WHERE mint != ?
    AND created_timestamp_ms >= ?
    AND ((? != '' AND lower(trim(name)) = ?) OR (? != '' AND lower(trim(symbol)) = ?))
  LIMIT 1
`);

// ── Discord alert ─────────────────────────────────────────────────────────────
async function sendAlert(latest, info) {
  const { mint, name, symbol, market_cap_usd, ath_market_cap, recommendation_rank } = latest;

  const payload = {
    username: "quality-survivor-watch",
    embeds: [
      {
        title: `🛡️ SURVIVOR SIGNAL: $${symbol}`,
        color: 0x5865f2,
        fields: [
          { name: "📍 Mint", value: `\`${mint}\``, inline: false },
          { name: "🏷 Name", value: name || "Unknown", inline: true },
          { name: "⏱ Age", value: `${info.ageMin}m`, inline: true },
          { name: "💰 Current MC", value: `$${market_cap_usd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`, inline: true },
          { name: "🚀 ATH MC", value: `$${ath_market_cap.toLocaleString("en-US", { maximumFractionDigits: 0 })}`, inline: true },
          { name: "📉 Drawdown", value: `-${info.drawdownPct.toFixed(0)}%`, inline: true },
          { name: "🏆 Best rank", value: `#${info.bestRank}`, inline: true },
          { name: "📊 Snapshots", value: String(info.snapshotCount), inline: true },
          { name: "🎯 Current rank", value: `#${recommendation_rank}`, inline: true },
          { name: "🔗 Link", value: `https://pump.fun/coin/${mint}`, inline: false },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };

  if (!DISCORD_WEBHOOK_URL) {
    log("[ALERT-NO-WEBHOOK]", { mint, symbol });
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (res.ok) {
      log("[ALERT-SENT]", { mint, symbol, drawdownPct: info.drawdownPct.toFixed(0) });
    } else {
      log("[ALERT-FAILED]", { status: res.status });
    }
  } catch (err) {
    log("[ALERT-ERROR]", { error: String(err) });
  } finally {
    clearTimeout(timer);
  }
}

// ── Evaluation loop ───────────────────────────────────────────────────────────
async function evaluate() {
  const now = Date.now();

  // Prune in-memory trackers
  for (const [mint, ts] of alertedAt) {
    if (now - ts > ALERT_DEDUPE_WINDOW_MS) alertedAt.delete(mint);
  }
  const oneHourAgo = now - 60 * 60 * 1000;
  while (alertTimestamps.length > 0 && alertTimestamps[0] < oneHourAgo) {
    alertTimestamps.shift();
  }

  const minCreatedAt = now - MAX_AGE_MIN * 60_000;
  const maxCreatedAt = now - MIN_AGE_MIN * 60_000;
  const candidates = candidateMintsStmt.all(minCreatedAt, maxCreatedAt);

  let evaluated = 0;
  let sent = 0;

  for (const { mint } of candidates) {
    if (alertedAt.has(mint)) continue;

    const latest = latestSnapshotStmt.get(mint);
    if (!latest) continue;

    const ageMin = (now - latest.created_timestamp_ms) / 60_000;
    if (ageMin < MIN_AGE_MIN || ageMin > MAX_AGE_MIN) {
      logRejected(mint, latest.name, "age", { ageMin: ageMin.toFixed(1) });
      continue;
    }

    if (latest.complete !== 0) {
      logRejected(mint, latest.name, "complete", { complete: latest.complete });
      continue;
    }
    if (latest.market_cap_usd < MIN_MARKET_CAP_USD) {
      logRejected(mint, latest.name, "mc", { marketCapUsd: latest.market_cap_usd, minRequired: MIN_MARKET_CAP_USD });
      continue;
    }
    if (!latest.ath_market_cap || latest.ath_market_cap <= 0
      || latest.market_cap_usd < latest.ath_market_cap * (1 - MAX_DRAWDOWN_FROM_ATH)) {
      const drawdownPct = latest.ath_market_cap > 0
        ? ((1 - latest.market_cap_usd / latest.ath_market_cap) * 100).toFixed(0)
        : null;
      logRejected(mint, latest.name, "drawdown", {
        marketCapUsd: latest.market_cap_usd,
        athMarketCap: latest.ath_market_cap,
        drawdownPct,
      });
      continue;
    }
    if (latest.recommendation_rank == null || latest.recommendation_rank > CURRENT_RANK_MAX) {
      logRejected(mint, latest.name, "rank", { currentRank: latest.recommendation_rank, maxAllowed: CURRENT_RANK_MAX });
      continue;
    }

    const stats = snapshotStatsStmt.get(mint);
    if (!stats || stats.count < MIN_SNAPSHOTS) {
      logRejected(mint, latest.name, "snapshots", { count: stats ? stats.count : 0, minRequired: MIN_SNAPSHOTS });
      continue;
    }
    if (stats.bestRank == null || stats.bestRank > BEST_RANK_EVER_MAX) {
      logRejected(mint, latest.name, "rank", { bestRankEver: stats.bestRank, maxAllowed: BEST_RANK_EVER_MAX });
      continue;
    }

    const first = firstSnapshotStmt.get(mint);
    if (!first || first.market_cap_usd <= 0) {
      logRejected(mint, latest.name, "growth", { firstMarketCapUsd: first ? first.market_cap_usd : null });
      continue;
    }
    const growth = (latest.market_cap_usd - first.market_cap_usd) / first.market_cap_usd;
    if (growth < MIN_MC_GROWTH_FROM_FIRST) {
      logRejected(mint, latest.name, "growth", { growthPct: (growth * 100).toFixed(0), minRequiredPct: MIN_MC_GROWTH_FROM_FIRST * 100 });
      continue;
    }

    const nameKey = (latest.name || "").trim().toLowerCase();
    const symbolKey = (latest.symbol || "").trim().toLowerCase();
    const dup = duplicateNameStmt.get(mint, now - DUPLICATE_NAME_WINDOW_MS, nameKey, nameKey, symbolKey, symbolKey);
    if (dup) {
      log("[DUPLICATE]", { mint: mint.slice(0, 8) + "…", name: latest.name, symbol: latest.symbol });
      continue;
    }

    evaluated += 1;

    if (alertTimestamps.length >= MAX_ALERTS_PER_HOUR) {
      log("[SUPPRESSED-CAP]", { mint: mint.slice(0, 8) + "…", symbol: latest.symbol });
      continue;
    }

    const drawdownPct = (1 - latest.market_cap_usd / latest.ath_market_cap) * 100;

    alertedAt.set(mint, now);
    alertTimestamps.push(now);
    await sendAlert(latest, {
      ageMin: Math.floor(ageMin),
      drawdownPct,
      bestRank: stats.bestRank,
      snapshotCount: stats.count,
    });
    sent += 1;
  }

  log("[EVAL]", {
    candidates: candidates.length,
    evaluated,
    sent,
    tracked: alertedAt.size,
    alertsThisHour: alertTimestamps.length,
  });
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  log("[STARTING] quality-survivor-watch", {
    dbPath: DB_PATH,
    evalIntervalMs: EVAL_INTERVAL_MS,
    ageWindow: `${MIN_AGE_MIN}-${MAX_AGE_MIN}min`,
    minMarketCapUsd: MIN_MARKET_CAP_USD,
    maxDrawdownFromAth: MAX_DRAWDOWN_FROM_ATH,
    minSnapshots: MIN_SNAPSHOTS,
    bestRankEverMax: BEST_RANK_EVER_MAX,
    currentRankMax: CURRENT_RANK_MAX,
    minMcGrowthFromFirst: MIN_MC_GROWTH_FROM_FIRST,
    maxAlertsPerHour: MAX_ALERTS_PER_HOUR,
    webhookConfigured: Boolean(DISCORD_WEBHOOK_URL),
  });

  setInterval(() => {
    evaluate().catch((err) => log("[EVAL-ERR]", { error: err.message }));
  }, EVAL_INTERVAL_MS);

  const shutdown = () => {
    log("shutting down");
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
