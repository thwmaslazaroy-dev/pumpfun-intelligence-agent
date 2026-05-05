import * as fs from "fs";
import * as path from "path";
import { config } from "../config";
import { logger } from "../utils/logger";
import { logSanitizedEnvSummary } from "../utils/env-summary";
import { PumpFunTransactionParser } from "../parsing/pumpfun-transaction-parser";
import {
  LivePumpFunDiscovery,
  OnCreateEvent,
} from "../providers/live-pumpfun-discovery";

const SAFE_MODE_HELP = `
SOLANA_RPC_WS_URL, SOLANA_RPC_HTTP_URL, or PUMPFUN_PROGRAM_ID is not set —
the live CREATE detector cannot run.

This is a STANDALONE prototype (read-only). It does NOT trade, does NOT send
Discord alerts, does NOT write to SQLite, and is NOT wired into the
TokenIngestionJob pipeline. It only:
  - subscribes to Pump.fun program logs via Solana JSON-RPC logsSubscribe
  - fetches each notified transaction via getTransaction (encoding: jsonParsed)
  - classifies via the existing PumpFunTransactionParser
  - appends CREATE detections (HIGH or MEDIUM confidence) to:
      ./data/live-pumpfun-creates.jsonl

To use it, set in your .env:
  SOLANA_RPC_WS_URL=wss://<your-solana-ws-rpc>
  SOLANA_RPC_HTTP_URL=https://<your-solana-http-rpc>
  PUMPFUN_PROGRAM_ID=<the Pump.fun program id>

Then:
  npm run build
  npm run live:detect:creates

Stop with Ctrl+C.
`;

const OUTPUT_PATH = "./data/live-pumpfun-creates.jsonl";

function ensureOutputDir(file: string): void {
  const dir = path.dirname(file);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    logger.info("live:detect:creates created output directory", { dir });
  }
}

async function main(): Promise<void> {
  logSanitizedEnvSummary({ context: "live:detect:creates" });

  if (
    !config.solanaRpcWsUrl ||
    !config.solanaRpcHttpUrl ||
    !config.pumpfunProgramId
  ) {
    process.stdout.write(SAFE_MODE_HELP);
    process.exit(0);
  }

  ensureOutputDir(OUTPUT_PATH);
  const writeStream = fs.createWriteStream(OUTPUT_PATH, { flags: "a" });

  const parser = new PumpFunTransactionParser(config.pumpfunProgramId);
  const discovery = new LivePumpFunDiscovery({
    wsUrl: config.solanaRpcWsUrl,
    httpUrl: config.solanaRpcHttpUrl,
    programId: config.pumpfunProgramId,
    parser,
  });

  const onCreate = (event: OnCreateEvent): void => {
    const { parsed, observedAt, receivedFromLog, creatorWallet, creatorExtractionReason } =
      event;
    const logMarkerSample = parsed.logMessages
      .filter((m) => /Program log:\s*Instruction:/i.test(m))
      .slice(0, 4);
    const row = {
      observedAt,
      signature: parsed.signature,
      slot: parsed.slot,
      kind: parsed.kind,
      confidence: parsed.confidence,
      candidateMints: parsed.candidateMints,
      creatorWallet,
      creatorExtractionReason,
      candidateWallets: parsed.candidateWallets,
      involvedPrograms: parsed.involvedPrograms,
      reasons: parsed.reasons,
      debug: {
        logMarkerSample,
        blockTime: parsed.blockTime,
        receivedFromLog,
      },
    };
    writeStream.write(JSON.stringify(row) + "\n");
    logger.info("LIVE CREATE detected", {
      signature: parsed.signature,
      slot: parsed.slot,
      candidateMints: parsed.candidateMints,
      creatorWallet,
      creatorExtractionReason,
      candidateWallets: parsed.candidateWallets,
      confidence: parsed.confidence,
    });
  };

  let interrupted = false;
  const shutdown = async (signal: string) => {
    if (interrupted) return;
    interrupted = true;
    logger.info("live:detect:creates received signal — stopping", { signal });
    try {
      await discovery.stop();
    } catch (err) {
      logger.error("live:detect:creates stop failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    await discovery.start({ onCreate });
  } catch (err) {
    logger.error("live:detect:creates failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    await new Promise<void>((resolve) => writeStream.end(() => resolve()));
    process.exit(1);
  }

  await new Promise<void>((resolve) => writeStream.end(() => resolve()));
  logger.info("live:detect:creates exited cleanly");
  process.exit(0);
}

void main();
