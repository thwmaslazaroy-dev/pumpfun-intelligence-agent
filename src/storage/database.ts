import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { logger } from "../utils/logger";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tokens (
  mint TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  symbol TEXT NOT NULL,
  creator_wallet TEXT NOT NULL,
  launched_at INTEGER NOT NULL,
  initial_market_cap_usd REAL NOT NULL,
  bonding_curve_progress REAL NOT NULL,
  buy_count INTEGER NOT NULL,
  sell_count INTEGER NOT NULL,
  volume_usd REAL NOT NULL,
  social_links_json TEXT,
  inserted_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tokens_launched_at ON tokens(launched_at DESC);
CREATE INDEX IF NOT EXISTS idx_tokens_creator ON tokens(creator_wallet);
CREATE INDEX IF NOT EXISTS idx_tokens_name_normalized ON tokens(lower(trim(name)), inserted_at);

CREATE TABLE IF NOT EXISTS market_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  price_usd REAL NOT NULL,
  market_cap_usd REAL NOT NULL,
  bonding_curve_progress REAL NOT NULL,
  buy_count INTEGER NOT NULL,
  sell_count INTEGER NOT NULL,
  volume_usd REAL NOT NULL,
  FOREIGN KEY (mint) REFERENCES tokens(mint)
);

CREATE INDEX IF NOT EXISTS idx_snapshots_mint_time ON market_snapshots(mint, captured_at DESC);

CREATE TABLE IF NOT EXISTS risk_flags (
  mint TEXT PRIMARY KEY,
  evaluated_at INTEGER NOT NULL,
  missing_socials INTEGER NOT NULL,
  high_churn INTEGER NOT NULL,
  suspicious_volume_to_market_cap INTEGER NOT NULL,
  early_bonding_curve_spike INTEGER NOT NULL,
  low_activity INTEGER NOT NULL,
  suspicious_creator INTEGER NOT NULL,
  reasons_json TEXT NOT NULL,
  FOREIGN KEY (mint) REFERENCES tokens(mint)
);

CREATE TABLE IF NOT EXISTS token_scores (
  mint TEXT PRIMARY KEY,
  total_score REAL NOT NULL,
  risk_level TEXT NOT NULL,
  microstructure_score REAL NOT NULL,
  social_score REAL NOT NULL,
  anomaly_score REAL NOT NULL,
  reasons_json TEXT NOT NULL,
  computed_at INTEGER NOT NULL,
  FOREIGN KEY (mint) REFERENCES tokens(mint)
);

CREATE INDEX IF NOT EXISTS idx_token_scores_risk_level ON token_scores(risk_level, total_score);

CREATE TABLE IF NOT EXISTS alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  alert_type TEXT NOT NULL DEFAULT 'legacy',
  sent_at INTEGER NOT NULL,
  FOREIGN KEY (mint) REFERENCES tokens(mint)
);

CREATE TABLE IF NOT EXISTS creators (
  creator_wallet TEXT PRIMARY KEY,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  total_launches INTEGER NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS creator_launch_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  creator_wallet TEXT NOT NULL,
  mint TEXT NOT NULL,
  symbol TEXT NOT NULL,
  launched_at INTEGER NOT NULL,
  initial_market_cap_usd REAL NOT NULL,
  peak_market_cap_usd REAL,
  max_gain_multiple REAL,
  time_to_peak_minutes REAL,
  ended_badly INTEGER,
  rug_like INTEGER,
  UNIQUE(creator_wallet, mint)
);

CREATE INDEX IF NOT EXISTS idx_creator_history_wallet ON creator_launch_history(creator_wallet);

CREATE TABLE IF NOT EXISTS creator_scores (
  creator_wallet TEXT PRIMARY KEY,
  total_score REAL NOT NULL,
  risk_level TEXT NOT NULL,
  success_rate_score REAL NOT NULL,
  consistency_score REAL NOT NULL,
  rug_risk_score REAL NOT NULL,
  activity_score REAL NOT NULL,
  confidence_score REAL NOT NULL,
  reasons_json TEXT NOT NULL,
  scored_at INTEGER NOT NULL,
  FOREIGN KEY (creator_wallet) REFERENCES creators(creator_wallet)
);

CREATE INDEX IF NOT EXISTS idx_creator_scores_risk ON creator_scores(risk_level, total_score);

CREATE TABLE IF NOT EXISTS combined_token_evaluations (
  mint TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  token_score REAL NOT NULL,
  creator_score REAL NOT NULL,
  combined_score REAL NOT NULL,
  combined_risk_level TEXT NOT NULL,
  reasons_json TEXT NOT NULL,
  evaluated_at INTEGER NOT NULL,
  FOREIGN KEY (mint) REFERENCES tokens(mint)
);

CREATE INDEX IF NOT EXISTS idx_combined_eval_risk ON combined_token_evaluations(combined_risk_level, combined_score);

CREATE TABLE IF NOT EXISTS token_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  usd_price REAL,
  swap_count INTEGER,
  first_swap_type TEXT,
  first_swap_exchange TEXT,
  raw_source_provider TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_token_outcomes_mint_observed ON token_outcomes(mint, observed_at DESC);

CREATE TABLE IF NOT EXISTS holder_risk_evaluations (
  mint TEXT PRIMARY KEY,
  holder_risk_label TEXT NOT NULL,
  holder_risk_reason TEXT NOT NULL,
  creator_hold_percent REAL,
  largest_wallet_percent REAL,
  top10_holder_percent REAL,
  evaluated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS momentum_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  captured_at INTEGER NOT NULL,
  bonding_curve_progress REAL NOT NULL,
  buy_count INTEGER NOT NULL,
  sell_count INTEGER NOT NULL,
  volume_usd REAL NOT NULL,
  market_cap_usd REAL NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_momentum_mint_time ON momentum_snapshots(mint, captured_at DESC);

CREATE TABLE IF NOT EXISTS api_request_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  window_type TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  rate_limit_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(service, window_type, window_start)
);

CREATE INDEX IF NOT EXISTS idx_api_usage_service_window
  ON api_request_usage(service, window_type, window_start DESC);

CREATE TABLE IF NOT EXISTS api_request_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET',
  status_code INTEGER,
  cache_hit INTEGER NOT NULL DEFAULT 0,
  requested_at INTEGER NOT NULL,
  reason TEXT,
  related_mint TEXT,
  related_signature TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_log_service_time ON api_request_log(service, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_api_log_time ON api_request_log(requested_at DESC);

CREATE TABLE IF NOT EXISTS processed_signatures (
  signature TEXT PRIMARY KEY,
  processed_at INTEGER NOT NULL,
  result_kind TEXT
);

CREATE TABLE IF NOT EXISTS token_enrichment_cache (
  mint TEXT PRIMARY KEY,
  name TEXT,
  symbol TEXT,
  market_cap_usd REAL,
  bonding_curve_progress REAL,
  buy_count INTEGER,
  sell_count INTEGER,
  volume_usd REAL,
  social_links_json TEXT,
  fetched_at INTEGER NOT NULL,
  ttl_ms INTEGER NOT NULL DEFAULT 21600000
);

CREATE TABLE IF NOT EXISTS enrichment_filter_stats (
  day_start INTEGER NOT NULL PRIMARY KEY,
  filtered_by_rule_a INTEGER NOT NULL DEFAULT 0,
  filtered_by_rule_b INTEGER NOT NULL DEFAULT 0,
  filtered_by_rule_c INTEGER NOT NULL DEFAULT 0,
  filtered_by_rule_d INTEGER NOT NULL DEFAULT 0,
  sampled_unknown_creators INTEGER NOT NULL DEFAULT 0,
  enrichments_performed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS enrichment_metrics (
  day_start INTEGER NOT NULL PRIMARY KEY,
  successful_enrichments INTEGER NOT NULL DEFAULT 0,
  mint_mismatches INTEGER NOT NULL DEFAULT 0,
  enrichment_retries INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
`;

let db: Database.Database | null = null;

export function initDatabase(databaseUrl: string): Database.Database {
  if (db) return db;

  const filePath = resolveDbPath(databaseUrl);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    logger.info("created database directory", { dir });
  }

  const conn = new Database(filePath);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.exec(SCHEMA);
  migrateAlertsTable(conn);
  migrateEnrichmentFilterStats(conn);

  logger.info("database ready", { filePath });
  db = conn;
  return conn;
}

function migrateEnrichmentFilterStats(conn: Database.Database): void {
  // conn.exec(SCHEMA) already created the table (CREATE TABLE IF NOT EXISTS).
  // For existing databases that predate Rule D, add the missing column.
  const cols = conn
    .prepare("PRAGMA table_info(enrichment_filter_stats)")
    .all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "filtered_by_rule_d")) {
    conn.exec(
      "ALTER TABLE enrichment_filter_stats ADD COLUMN filtered_by_rule_d INTEGER NOT NULL DEFAULT 0",
    );
    logger.info("migration: added enrichment_filter_stats.filtered_by_rule_d column");
  }
}

function migrateAlertsTable(conn: Database.Database): void {
  const cols = conn.prepare("PRAGMA table_info(alerts)").all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === "alert_type")) {
    conn.exec(
      "ALTER TABLE alerts ADD COLUMN alert_type TEXT NOT NULL DEFAULT 'legacy'",
    );
    logger.info("migration: added alerts.alert_type column");
  }
  conn.exec("DROP INDEX IF EXISTS idx_alerts_mint");
  conn.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_mint_type ON alerts(mint, alert_type)",
  );
}

export function getDatabase(): Database.Database {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

function resolveDbPath(databaseUrl: string): string {
  const stripped = databaseUrl.startsWith("sqlite:")
    ? databaseUrl.slice("sqlite:".length)
    : databaseUrl;
  return path.isAbsolute(stripped) ? stripped : path.resolve(process.cwd(), stripped);
}
