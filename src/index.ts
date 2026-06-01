import { config } from "./config";
import { logger } from "./utils/logger";
import {
  closeDatabase,
  initDatabase,
  SqliteCreatorRepository,
  SqliteTokenRepository,
} from "./storage";
import { MockPumpFunProvider } from "./providers/mock-pumpfun-provider";
import { seedMockCreatorHistory } from "./providers/mock-creator-history";
import { LivePumpFunDiscovery } from "./providers/live-pumpfun-discovery";
import { LivePumpFunProvider } from "./providers/live-pumpfun-provider";
import { PumpFunTransactionParser } from "./parsing/pumpfun-transaction-parser";
import { TokenIngestionJob } from "./jobs/token-ingestion-job";
import {
  TokenRiskFlagService,
  initRequestBudgetManager,
  PumpFunCoinEnrichmentService,
  EnrichmentFilter,
} from "./services";
import {
  CombinedScoringService,
  CreatorScoringService,
  RiskScoringService,
} from "./scoring";
import { AlertPolicy, DiscordAlertService } from "./alerts";
import { PumpFunProvider } from "./types";

interface CliOptions {
  watch: boolean;
}

function parseArgs(argv: string[]): CliOptions {
  return { watch: argv.includes("--watch") };
}

async function runOnce(job: TokenIngestionJob): Promise<void> {
  await job.runOnce();
}

async function runWatch(
  job: TokenIngestionJob,
  intervalSeconds: number,
  liveProvider: LivePumpFunProvider | null,
): Promise<void> {
  logger.info("watch mode enabled", { intervalSeconds });

  let stopping = false;
  const stop = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info("shutdown signal received", { signal });
    if (liveProvider) {
      void liveProvider.stop();
    }
    closeDatabase();
    process.exit(0);
  };
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("SIGTERM", () => stop("SIGTERM"));

  await job.runOnce();
  setInterval(() => {
    job.runOnce().catch((err) => {
      logger.error("watch tick failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }, intervalSeconds * 1000);
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  logger.info("pumpfun-intelligence-agent starting", { mode: opts.watch ? "watch" : "once" });

  initDatabase(config.databaseUrl);

  const budget = initRequestBudgetManager({
    limits: {
      helius_http: { perMinute: config.budgetHeliusHttpPerMin, perHour: config.budgetHeliusHttpPerHour, perDay: config.budgetHeliusHttpPerDay },
      helius_ws: { perMinute: 120, perHour: 5_000, perDay: 50_000 },
      pumpfun_frontend: { perMinute: config.budgetPumpfunFrontendPerMin, perHour: config.budgetPumpfunFrontendPerHour, perDay: config.budgetPumpfunFrontendPerDay },
      moralis: { perMinute: config.budgetMoralisPerMin, perHour: config.budgetMoralisPerHour, perDay: config.budgetMoralisPerDay },
      discord: { perMinute: config.budgetDiscordPerMin, perHour: config.budgetDiscordPerHour, perDay: config.budgetDiscordPerDay },
    },
    warnPct: config.budgetWarnPct,
    pausePct: config.budgetPausePct,
    emergencyPct: config.budgetEmergencyPct,
  });
  logger.info("request budget manager ready", {
    helius_http_day: config.budgetHeliusHttpPerDay,
    moralis_day: config.budgetMoralisPerDay,
    pumpfun_frontend_day: config.budgetPumpfunFrontendPerDay,
  });

  const repo = new SqliteTokenRepository();
  const creatorRepo = new SqliteCreatorRepository();

  await seedMockCreatorHistory(creatorRepo);

  const flagService = new TokenRiskFlagService();
  const scoringService = new RiskScoringService();
  const creatorScoringService = new CreatorScoringService();
  const combinedScoringService = new CombinedScoringService();

  // Enrichment service — only instantiated when the feature flag is on
  let enrichmentService: PumpFunCoinEnrichmentService | undefined;
  let enrichmentFilter: EnrichmentFilter | undefined;

  if (config.enableTokenEnrichment) {
    enrichmentService = new PumpFunCoinEnrichmentService({
      budgetManager: budget,
      cacheTtlMs: config.cacheEnrichmentTtlMs,
    });
    enrichmentFilter = new EnrichmentFilter(config.enrichUnknownCreatorPercent);
    logger.info("token enrichment enabled", {
      cacheTtlMs: config.cacheEnrichmentTtlMs,
      budgetPerDay: config.budgetPumpfunFrontendPerDay,
      unknownCreatorSamplePct: config.enrichUnknownCreatorPercent,
    });
  } else {
    logger.info("token enrichment disabled (set ENABLE_TOKEN_ENRICHMENT=true to enable)");
  }

  let provider: PumpFunProvider;
  let liveProvider: LivePumpFunProvider | null = null;
  let alertPolicy: AlertPolicy | undefined;
  let alertService: DiscordAlertService | undefined;

  if (config.ingestionSource === "live") {
    if (!config.solanaRpcWsUrl || !config.solanaRpcHttpUrl || !config.pumpfunProgramId) {
      throw new Error(
        "INGESTION_SOURCE=live requires SOLANA_RPC_WS_URL, SOLANA_RPC_HTTP_URL, and PUMPFUN_PROGRAM_ID",
      );
    }
    logger.info("ingestion source: live");
    const parser = new PumpFunTransactionParser(config.pumpfunProgramId);
    const discovery = new LivePumpFunDiscovery({
      wsUrl: config.solanaRpcWsUrl,
      httpUrl: config.solanaRpcHttpUrl,
      programId: config.pumpfunProgramId,
      parser,
      budgetManager: budget,
    });
    liveProvider = new LivePumpFunProvider(discovery);
    await liveProvider.start();
    provider = liveProvider;
  } else {
    logger.info("ingestion source: mock");
    provider = new MockPumpFunProvider();
  }

  // Wire Discord alerts when DISCORD_ALERTS_ENABLED=true (both modes).
  // ALERT_PREVIEW_ONLY=true (default) logs renders but never POSTs to Discord.
  // Real sends only happen when ALERT_PREVIEW_ONLY=false AND webhook is set.
  if (config.discordAlertsEnabled) {
    alertPolicy = new AlertPolicy({
      minCombinedAlertScore: config.minCombinedAlertScore,
      alertCombinedRiskLevels: config.alertCombinedRiskLevels,
      alertExtremeRiskEnabled: config.alertExtremeRiskEnabled,
      highPriorityAlertsEnabled: config.highPriorityAlertsEnabled,
      highPriorityMinTokenScore: config.highPriorityMinTokenScore,
      highPriorityMinCombinedScore: config.highPriorityMinCombinedScore,
      highPriorityMinCreatorScore: config.highPriorityMinCreatorScore,
      watchOnlyAlertsEnabled: config.watchOnlyAlertsEnabled,
      watchOnlyMinTokenScore: config.watchOnlyMinTokenScore,
      watchOnlyMinCombinedScore: config.watchOnlyMinCombinedScore,
      watchOnlyMinCreatorScore: config.watchOnlyMinCreatorScore,
      alertMinMarketCapUsd: config.alertMinMarketCapUsd,
    });
    alertService = new DiscordAlertService(config.discordWebhookUrl, undefined, {
      budgetManager: budget,
      previewOnly: config.alertPreviewOnly,
    });
    logger.info("discord alerts enabled", {
      webhookConfigured: Boolean(config.discordWebhookUrl),
      previewOnly: config.alertPreviewOnly,
      highPriorityEnabled: config.highPriorityAlertsEnabled,
      highPriorityThresholds: {
        token: config.highPriorityMinTokenScore,
        combined: config.highPriorityMinCombinedScore,
        creator: config.highPriorityMinCreatorScore,
      },
      watchOnlyEnabled: config.watchOnlyAlertsEnabled,
      watchOnlyThresholds: {
        token: config.watchOnlyMinTokenScore,
        combined: config.watchOnlyMinCombinedScore,
        creator: config.watchOnlyMinCreatorScore,
      },
      minMarketCapUsd: config.alertMinMarketCapUsd,
      extremeRugWarningEnabled: config.alertExtremeRiskEnabled,
    });
  } else {
    logger.info("discord alerts disabled (set DISCORD_ALERTS_ENABLED=true to enable)");
  }

  const job = new TokenIngestionJob(
    provider,
    repo,
    creatorRepo,
    flagService,
    scoringService,
    creatorScoringService,
    combinedScoringService,
    alertPolicy,
    alertService,
    enrichmentService,
    enrichmentFilter,
  );

  if (opts.watch) {
    await runWatch(job, config.ingestionIntervalSeconds, liveProvider);
  } else {
    await runOnce(job);
    if (liveProvider) await liveProvider.stop();
    closeDatabase();
  }
}

main().catch((err) => {
  logger.error("fatal", { error: err instanceof Error ? err.message : String(err) });
  closeDatabase();
  process.exit(1);
});
