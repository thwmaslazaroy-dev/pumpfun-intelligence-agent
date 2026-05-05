import { config } from "../config";
import { logger } from "../utils/logger";
import { logSanitizedEnvSummary } from "../utils/env-summary";
import {
  closeDatabase,
  initDatabase,
  SqliteTokenOutcomeRepository,
} from "../storage";
import { MoralisTokenEnrichmentService } from "../services";
import { TokenOutcome } from "../types";

const SAFE_MODE_HELP = `
MORALIS_API_KEY or OUTCOME_TEST_TOKEN_MINT is not set — cannot track token outcome.

This is a read-only outcome tracker for backtesting. It does NOT trade, does
NOT send Discord alerts, and does NOT replace the mock provider. It calls
Moralis Solana token endpoints, normalises a snapshot, and writes one row to
the local SQLite 'token_outcomes' table.

To use it, set in your .env:
  MORALIS_API_KEY=<your moralis api key>
  OUTCOME_TEST_TOKEN_MINT=<a Solana mainnet mint to track>

Then:
  npm run build
  npm run track:token:outcome

The API key is sent only in the X-API-Key request header; it is never printed
to the console or written to disk.
`;

async function main(): Promise<void> {
  logSanitizedEnvSummary({
    context: "track:token:outcome",
    extras: {
      MORALIS_API_KEY_set: Boolean(config.moralisApiKey),
      OUTCOME_TEST_TOKEN_MINT_set: Boolean(config.outcomeTestTokenMint),
    },
  });

  if (!config.moralisApiKey || !config.outcomeTestTokenMint) {
    process.stdout.write(SAFE_MODE_HELP);
    process.exit(0);
  }

  initDatabase(config.databaseUrl);

  const service = new MoralisTokenEnrichmentService({ apiKey: config.moralisApiKey });
  const repo = new SqliteTokenOutcomeRepository();
  const mint = config.outcomeTestTokenMint;

  logger.info("track:token:outcome starting (read-only)", {
    mint,
    provider: service.providerName,
  });

  let saved = false;
  let usdPrice: number | null = null;
  let swapCount: number | null = null;
  let firstSwapType: string | null = null;
  let firstSwapExchange: string | null = null;

  try {
    const snapshot = await service.getTokenEnrichmentSnapshot(mint);
    usdPrice = snapshot.usdPrice;
    swapCount = snapshot.swapCount;
    firstSwapType = snapshot.firstSwapType;
    firstSwapExchange = snapshot.firstSwapExchange;

    logger.info("moralis snapshot fetched", {
      mint,
      priceCall: snapshot.priceCall,
      swapsCall: snapshot.swapsCall,
      usdPrice,
      swapCount,
      firstSwapType,
      firstSwapExchange,
    });

    const outcome: TokenOutcome = {
      mint: snapshot.mint,
      observedAt: snapshot.observedAt,
      usdPrice,
      swapCount,
      firstSwapType,
      firstSwapExchange,
      rawSourceProvider: service.providerName,
      createdAt: new Date(),
    };

    await repo.saveOutcome(outcome);
    saved = true;

    const latest = await repo.getLatestOutcome(mint);
    const total = (await repo.listOutcomesByMint(mint)).length;
    logger.info("track:token:outcome saved", {
      mint,
      observedAt: outcome.observedAt.toISOString(),
      totalOutcomesForMint: total,
      latestUsdPrice: latest?.usdPrice ?? null,
    });
  } catch (err) {
    logger.error("track:token:outcome failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    closeDatabase();
  }

  process.stdout.write("\n=== outcome ===\n");
  process.stdout.write(`  mint:              ${JSON.stringify(mint)}\n`);
  process.stdout.write(`  usdPrice:          ${JSON.stringify(usdPrice)}\n`);
  process.stdout.write(`  swapCount:         ${JSON.stringify(swapCount)}\n`);
  process.stdout.write(`  firstSwapType:     ${JSON.stringify(firstSwapType)}\n`);
  process.stdout.write(`  firstSwapExchange: ${JSON.stringify(firstSwapExchange)}\n`);
  process.stdout.write(`  saved:             ${JSON.stringify(saved)}\n`);
}

void main().catch((err) => {
  logger.error("track:token:outcome unhandled error", {
    error: err instanceof Error ? err.message : String(err),
  });
  closeDatabase();
  process.exit(1);
});
