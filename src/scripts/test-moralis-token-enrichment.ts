import * as fs from "fs";
import * as path from "path";
import { config } from "../config";
import { logger } from "../utils/logger";
import { logSanitizedEnvSummary } from "../utils/env-summary";
import { MoralisTokenEnrichmentService } from "../services";

const SAFE_MODE_HELP = `
MORALIS_API_KEY or MORALIS_TEST_TOKEN_MINT is not set — cannot run Moralis enrichment test.

This is a read-only research script. It does NOT trade, does NOT send Discord
alerts, and does NOT replace the mock provider. It calls two Moralis Solana
gateway endpoints (token price + token swaps) for a single configured mint
and saves the raw responses for inspection.

To use it, set in your .env:
  MORALIS_API_KEY=<your moralis api key>
  MORALIS_TEST_TOKEN_MINT=<a Solana mainnet mint to enrich>

Then:
  npm run build
  npm run test:moralis:token

The API key is sent only in the X-API-Key request header; it is never printed
to the console or written to disk.
`;

const OUTPUT_PATH = "./data/moralis-token-enrichment-sample.json";

function ensureOutputDir(file: string): void {
  const dir = path.dirname(file);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function main(): Promise<void> {
  logSanitizedEnvSummary({
    context: "test:moralis:token",
    extras: {
      MORALIS_API_KEY_set: Boolean(config.moralisApiKey),
      MORALIS_TEST_TOKEN_MINT_set: Boolean(config.moralisTestTokenMint),
    },
  });

  if (!config.moralisApiKey || !config.moralisTestTokenMint) {
    process.stdout.write(SAFE_MODE_HELP);
    process.exit(0);
  }

  ensureOutputDir(OUTPUT_PATH);
  const service = new MoralisTokenEnrichmentService({ apiKey: config.moralisApiKey });
  const mint = config.moralisTestTokenMint;

  logger.info("test:moralis:token starting (read-only)", {
    provider: service.providerName,
    mint,
    output: OUTPUT_PATH,
  });

  const snapshot = await service.getTokenEnrichmentSnapshot(mint);

  logger.info("moralis price call", {
    ok: snapshot.priceCall.ok,
    status: snapshot.priceCall.status,
    error: snapshot.priceCall.errorMessage,
  });
  logger.info("moralis swaps call", {
    ok: snapshot.swapsCall.ok,
    status: snapshot.swapsCall.status,
    error: snapshot.swapsCall.errorMessage,
  });

  const fullPayload = {
    fetchedAt: snapshot.observedAt.toISOString(),
    mint: snapshot.mint,
    network: "mainnet",
    price: {
      ok: snapshot.priceCall.ok,
      status: snapshot.priceCall.status,
      errorMessage: snapshot.priceCall.errorMessage,
      body: snapshot.rawPriceBody,
    },
    swaps: {
      ok: snapshot.swapsCall.ok,
      status: snapshot.swapsCall.status,
      errorMessage: snapshot.swapsCall.errorMessage,
      body: snapshot.rawSwapsBody,
    },
  };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(fullPayload, null, 2));

  const summary = {
    mint,
    network: "mainnet",
    priceCallOk: snapshot.priceCall.ok,
    priceCallStatus: snapshot.priceCall.status,
    usdPrice: snapshot.usdPrice,
    swapsCallOk: snapshot.swapsCall.ok,
    swapsCallStatus: snapshot.swapsCall.status,
    swapCount: snapshot.swapCount,
    firstSwapType: snapshot.firstSwapType,
    firstSwapExchange: snapshot.firstSwapExchange,
    rawSavedTo: OUTPUT_PATH,
    rawFileExists: fs.existsSync(OUTPUT_PATH),
  };

  logger.info("test:moralis:token finished", summary);

  process.stdout.write("\n=== sanitized summary ===\n");
  for (const [k, v] of Object.entries(summary)) {
    process.stdout.write(`  ${k}: ${JSON.stringify(v)}\n`);
  }
}

void main().catch((err) => {
  logger.error("test:moralis:token unhandled error", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
