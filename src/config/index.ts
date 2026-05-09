import * as dotenv from "dotenv";
import { RiskLevel } from "../types";

dotenv.config();

export type IngestionSource = "mock" | "live";

export interface AppConfig {
  telegramBotToken: string;
  telegramChatId: string;
  pumpfunDataProvider: string;
  xApiKey: string;
  instagramAccessToken: string;
  databaseUrl: string;
  ingestionIntervalSeconds: number;
  ingestionSource: IngestionSource;
  discordWebhookUrl: string;
  discordAlertsEnabled: boolean;
  minCombinedAlertScore: number;
  alertCombinedRiskLevels: RiskLevel[];
  alertExtremeRiskEnabled: boolean;
  solanaRpcWsUrl: string;
  solanaRpcHttpUrl: string;
  solanaRpcHttpUrlBackup: string;
  pumpfunProgramId: string;
  rawLogMaxEvents: number;
  rawLogOutputPath: string;
  pumpfunSignatureLimit: number;
  pumpfunCreateSearchOutputPath: string;
  moralisApiKey: string;
  moralisTestTokenMint: string;
  outcomeTestTokenMint: string;
  outcomeWatchlistPath: string;
  outcomeBatchDelayMs: number;
  momentumPollIntervalSeconds: number;
  momentumTokenMaxAgeHours: number;
  momentumMinCombinedScore: number;
  momentumBcVelocityPerMin: number;
  momentumMinBuyPressure: number;
  momentumMinNewBuys: number;
}

function read(name: string, fallback = ""): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.length === 0) return fallback;
  const v = raw.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(v)) return true;
  if (["false", "0", "no", "off"].includes(v)) return false;
  return fallback;
}

const VALID_RISK_LEVELS: ReadonlySet<RiskLevel> = new Set(["LOW", "MEDIUM", "HIGH", "EXTREME"]);

function readIngestionSource(name: string, fallback: IngestionSource): IngestionSource {
  const raw = process.env[name];
  if (!raw) return fallback;
  const v = raw.trim().toLowerCase();
  if (v === "live") return "live";
  if (v === "mock") return "mock";
  return fallback;
}

function readRiskLevels(name: string, fallback: RiskLevel[]): RiskLevel[] {
  const raw = process.env[name];
  if (!raw || raw.length === 0) return fallback;
  const parts = raw
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter((s) => s.length > 0);
  const valid = parts.filter((p): p is RiskLevel => VALID_RISK_LEVELS.has(p as RiskLevel));
  return valid.length > 0 ? valid : fallback;
}

export const config: AppConfig = {
  telegramBotToken: read("TELEGRAM_BOT_TOKEN"),
  telegramChatId: read("TELEGRAM_CHAT_ID"),
  pumpfunDataProvider: read("PUMPFUN_DATA_PROVIDER"),
  xApiKey: read("X_API_KEY"),
  instagramAccessToken: read("INSTAGRAM_ACCESS_TOKEN"),
  databaseUrl: read("DATABASE_URL", "./data/pumpfun-agent.sqlite"),
  ingestionIntervalSeconds: readInt("INGESTION_INTERVAL_SECONDS", 30),
  ingestionSource: readIngestionSource("INGESTION_SOURCE", "mock"),
  discordWebhookUrl: read("DISCORD_WEBHOOK_URL"),
  discordAlertsEnabled: readBool("DISCORD_ALERTS_ENABLED", false),
  minCombinedAlertScore: readInt("MIN_COMBINED_ALERT_SCORE", 80),
  alertCombinedRiskLevels: readRiskLevels("ALERT_COMBINED_RISK_LEVELS", ["LOW", "MEDIUM"]),
  alertExtremeRiskEnabled: readBool("ALERT_EXTREME_RISK_ENABLED", true),
  solanaRpcWsUrl: read("SOLANA_RPC_WS_URL"),
  solanaRpcHttpUrl: read("SOLANA_RPC_HTTP_URL"),
  solanaRpcHttpUrlBackup: read("SOLANA_RPC_HTTP_URL_BACKUP"),
  pumpfunProgramId: read("PUMPFUN_PROGRAM_ID"),
  rawLogMaxEvents: readInt("RAW_LOG_MAX_EVENTS", 25),
  rawLogOutputPath: read("RAW_LOG_OUTPUT_PATH", "./data/raw-pumpfun-logs.jsonl"),
  pumpfunSignatureLimit: readInt("PUMPFUN_SIGNATURE_LIMIT", 500),
  pumpfunCreateSearchOutputPath: read(
    "PUMPFUN_CREATE_SEARCH_OUTPUT_PATH",
    "./data/pumpfun-create-candidates.jsonl",
  ),
  moralisApiKey: read("MORALIS_API_KEY"),
  moralisTestTokenMint: read("MORALIS_TEST_TOKEN_MINT"),
  outcomeTestTokenMint: read("OUTCOME_TEST_TOKEN_MINT"),
  outcomeWatchlistPath: read("OUTCOME_WATCHLIST_PATH", "./data/watchlist-mints.txt"),
  outcomeBatchDelayMs: readInt("OUTCOME_BATCH_DELAY_MS", 500),
  momentumPollIntervalSeconds: readInt("MOMENTUM_POLL_INTERVAL_SECONDS", 60),
  momentumTokenMaxAgeHours: readInt("MOMENTUM_TOKEN_MAX_AGE_HOURS", 4),
  momentumMinCombinedScore: readInt("MOMENTUM_MIN_COMBINED_SCORE", 40),
  momentumBcVelocityPerMin: (() => {
    const raw = process.env["MOMENTUM_BC_VELOCITY_PER_MIN"];
    if (!raw) return 0.02;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : 0.02;
  })(),
  momentumMinBuyPressure: (() => {
    const raw = process.env["MOMENTUM_MIN_BUY_PRESSURE"];
    if (!raw) return 0.65;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? n : 0.65;
  })(),
  momentumMinNewBuys: readInt("MOMENTUM_MIN_NEW_BUYS", 3),
};
