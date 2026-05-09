import { config } from "../config";
import { logger } from "../utils/logger";
import { initDatabase, closeDatabase, SqliteTokenRepository, SqliteCreatorRepository } from "../storage";
import { MomentumRepository } from "../storage/momentum-repository";
import { FeedPumpFunProvider } from "../providers/feed-pumpfun-provider";
import { TokenRiskFlagService } from "../services";
import { RiskScoringService, CreatorScoringService, CombinedScoringService } from "../scoring";
import { MomentumDetectionService } from "../scoring/momentum-detection-service";
import { MomentumMonitorJob } from "../jobs/momentum-monitor-job";
import { DiscordMomentumAlertService } from "../alerts/discord-momentum-alert-service";

function readFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : fallback;
}

function readPosInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const pollIntervalSeconds = readPosInt("MOMENTUM_POLL_INTERVAL_SECONDS", 60);
const tokenMaxAgeHours = readPosInt("MOMENTUM_TOKEN_MAX_AGE_HOURS", 4);
const minCombinedScore = readFloat("MOMENTUM_MIN_COMBINED_SCORE", 40);
const minBcVelocityPerMin = readFloat("MOMENTUM_BC_VELOCITY_PER_MIN", 0.02);
const minBuyPressure = readFloat("MOMENTUM_MIN_BUY_PRESSURE", 0.65);
const minNewBuys = readPosInt("MOMENTUM_MIN_NEW_BUYS", 3);

async function main(): Promise<void> {
  logger.info("monitor:momentum starting", {
    pollIntervalSeconds,
    tokenMaxAgeHours,
    minCombinedScore,
    minBcVelocityPerMin,
    minBuyPressure,
    minNewBuys,
    webhookConfigured: Boolean(config.discordWebhookUrl),
  });

  initDatabase(config.databaseUrl);

  const repo = new SqliteTokenRepository();
  const creatorRepo = new SqliteCreatorRepository();
  const momentumRepo = new MomentumRepository();

  const job = new MomentumMonitorJob(
    new FeedPumpFunProvider(),
    repo,
    creatorRepo,
    momentumRepo,
    new TokenRiskFlagService(),
    new RiskScoringService(),
    new CreatorScoringService(),
    new CombinedScoringService(),
    new MomentumDetectionService({ minBcVelocityPerMin, minBuyPressure, minNewBuys, maxSnapshotGapMinutes: 5 }),
    new DiscordMomentumAlertService(config.discordWebhookUrl),
    {
      minCombinedScore,
      tokenMaxAgeMs: tokenMaxAgeHours * 60 * 60 * 1000,
      pruneOlderThanMs: (tokenMaxAgeHours + 2) * 60 * 60 * 1000,
    },
  );

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("shutdown signal received", { signal });
    closeDatabase();
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  await job.runOnce();

  setInterval(() => {
    if (stopping) return;
    job.runOnce().catch((err) => {
      logger.error("momentum tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, pollIntervalSeconds * 1000);
}

main().catch((err) => {
  logger.error("monitor:momentum fatal", { error: err instanceof Error ? err.message : String(err) });
  closeDatabase();
  process.exit(1);
});
