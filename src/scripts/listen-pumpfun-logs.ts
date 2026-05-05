import { config } from "../config";
import { logger } from "../utils/logger";
import { logSanitizedEnvSummary } from "../utils/env-summary";
import { SolanaPumpFunLogListener } from "../providers/solana-pumpfun-log-listener";

const SAFE_MODE_HELP = `
SOLANA_RPC_WS_URL is not set — the Pump.fun log listener cannot run.

This is the LEARNING MODE listener. It is read-only:
  - it does NOT trade, buy, sell, sign, or submit transactions
  - it does NOT send Discord alerts
  - it is NOT wired into TokenIngestionJob
  - it only subscribes to Pump.fun program logs and writes raw events to a JSONL file

To use it, set the following in your .env (or your shell):
  SOLANA_RPC_WS_URL=wss://<your-solana-ws-rpc-endpoint>
  PUMPFUN_PROGRAM_ID=<the Pump.fun program id you want to observe>
  RAW_LOG_MAX_EVENTS=25
  RAW_LOG_OUTPUT_PATH=./data/raw-pumpfun-logs.jsonl

Then run:
  npm run build
  npm run listen:pumpfun:logs

The listener will subscribe via Solana JSON-RPC \`logsSubscribe\`
filtered by the configured program id, write up to RAW_LOG_MAX_EVENTS
raw events as JSONL to RAW_LOG_OUTPUT_PATH, then exit cleanly.
`;

async function main(): Promise<void> {
  logSanitizedEnvSummary({ context: "listen:pumpfun:logs" });

  if (!config.solanaRpcWsUrl) {
    process.stdout.write(SAFE_MODE_HELP);
    process.exit(0);
  }

  if (!config.pumpfunProgramId) {
    logger.error(
      "PUMPFUN_PROGRAM_ID is not set — required for logsSubscribe. Set it in .env and retry.",
    );
    process.exit(1);
  }

  logger.info("listen:pumpfun:logs starting (learning mode, read-only)", {
    maxEvents: config.rawLogMaxEvents,
    outputPath: config.rawLogOutputPath,
  });

  const listener = new SolanaPumpFunLogListener({
    wsUrl: config.solanaRpcWsUrl,
    programId: config.pumpfunProgramId,
    maxEvents: config.rawLogMaxEvents,
    outputPath: config.rawLogOutputPath,
  });

  let interrupted = false;
  const shutdown = async (signal: string) => {
    if (interrupted) return;
    interrupted = true;
    logger.info("listen:pumpfun:logs received signal — stopping", { signal });
    try {
      await listener.stop();
    } catch (err) {
      logger.error("listen:pumpfun:logs stop failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  try {
    const summary = await listener.start();
    logger.info("listen:pumpfun:logs finished", summary);
    process.exit(0);
  } catch (err) {
    logger.error("listen:pumpfun:logs failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    process.exit(1);
  }
}

void main();
