import * as fs from "fs";
import * as path from "path";
import { config } from "../config";
import { logger } from "./logger";

export interface EnvSummaryOptions {
  context?: string;
  extras?: Record<string, unknown>;
}

export function logSanitizedEnvSummary(opts: EnvSummaryOptions = {}): void {
  const envFilePath = path.resolve(process.cwd(), ".env");
  const envFileExists = fs.existsSync(envFilePath);

  logger.info("env summary (sanitized — booleans for secret-bearing vars only)", {
    context: opts.context,
    cwd: process.cwd(),
    envFilePath,
    envFileExists,
    nodeEnv: process.env.NODE_ENV ?? "(unset)",
    SOLANA_RPC_WS_URL_set: Boolean(config.solanaRpcWsUrl),
    SOLANA_RPC_HTTP_URL_set: Boolean(config.solanaRpcHttpUrl),
    PUMPFUN_PROGRAM_ID_set: Boolean(config.pumpfunProgramId),
    RAW_LOG_MAX_EVENTS: config.rawLogMaxEvents,
    RAW_LOG_OUTPUT_PATH: config.rawLogOutputPath,
    DISCORD_WEBHOOK_URL_set: Boolean(config.discordWebhookUrl),
    DATABASE_URL: config.databaseUrl,
    INGESTION_INTERVAL_SECONDS: config.ingestionIntervalSeconds,
    MIN_COMBINED_ALERT_SCORE: config.minCombinedAlertScore,
    ALERT_COMBINED_RISK_LEVELS: config.alertCombinedRiskLevels,
    ALERT_EXTREME_RISK_ENABLED: config.alertExtremeRiskEnabled,
    ...(opts.extras ?? {}),
  });
}
