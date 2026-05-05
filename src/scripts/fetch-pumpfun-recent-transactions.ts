import * as fs from "fs";
import * as path from "path";
import { config } from "../config";
import { logger } from "../utils/logger";
import { logSanitizedEnvSummary } from "../utils/env-summary";

const SAFE_MODE_HELP = `
SOLANA_RPC_HTTP_URL or PUMPFUN_PROGRAM_ID is not set — cannot fetch recent transactions.

This is the LEARNING-MODE HTTP fallback for the WebSocket listener. It is read-only:
  - it does NOT trade, sign, or submit transactions
  - it does NOT send Discord alerts
  - it is NOT wired into TokenIngestionJob
  - it only fetches the most recent transactions involving PUMPFUN_PROGRAM_ID
    via JSON-RPC getSignaturesForAddress + getTransaction, and writes raw
    transaction payloads to a JSONL file for inspection.

To use it, set the following in your .env:
  SOLANA_RPC_HTTP_URL=https://<your-solana-http-rpc-endpoint>
  PUMPFUN_PROGRAM_ID=<the Pump.fun program id you want to inspect>

Then:
  npm run build
  npm run fetch:pumpfun:txs
`;

const OUTPUT_PATH = "./data/raw-pumpfun-transactions.jsonl";
const SIGNATURE_LIMIT = 10;
const REQUEST_TIMEOUT_MS = 15_000;

interface JsonRpcResponse<T> {
  jsonrpc: string;
  id: number | string;
  result?: T;
  error?: { code: number; message: string };
}

interface SignatureInfo {
  signature: string;
  slot: number;
  err?: unknown;
  blockTime?: number | null;
  confirmationStatus?: string;
  memo?: string | null;
}

let nextRequestId = 1;

async function rpc<T>(
  url: string,
  method: string,
  params: unknown,
): Promise<JsonRpcResponse<T>> {
  const body = {
    jsonrpc: "2.0",
    id: nextRequestId++,
    method,
    params,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    return (await res.json()) as JsonRpcResponse<T>;
  } finally {
    clearTimeout(timer);
  }
}

function ensureOutputDir(file: string): void {
  const dir = path.dirname(file);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    logger.info("created output directory", { dir });
  }
}

function safeScheme(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol.replace(":", "");
  } catch {
    return "(unparseable)";
  }
}

async function main(): Promise<void> {
  logSanitizedEnvSummary({ context: "fetch:pumpfun:txs" });

  if (!config.solanaRpcHttpUrl || !config.pumpfunProgramId) {
    process.stdout.write(SAFE_MODE_HELP);
    process.exit(0);
  }

  const url = config.solanaRpcHttpUrl;
  const programId = config.pumpfunProgramId;

  ensureOutputDir(OUTPUT_PATH);
  const stream = fs.createWriteStream(OUTPUT_PATH, { flags: "a" });

  logger.info("fetch:pumpfun:txs starting (read-only, learning mode)", {
    httpScheme: safeScheme(url),
    programId,
    signatureLimit: SIGNATURE_LIMIT,
    outputPath: OUTPUT_PATH,
  });

  let signatures: SignatureInfo[] = [];
  try {
    const sigsRes = await rpc<SignatureInfo[]>(url, "getSignaturesForAddress", [
      programId,
      { limit: SIGNATURE_LIMIT },
    ]);
    if (sigsRes.error) {
      logger.error("getSignaturesForAddress rpc error", { error: sigsRes.error });
      stream.end();
      process.exit(1);
    }
    signatures = sigsRes.result ?? [];
  } catch (err) {
    logger.error("getSignaturesForAddress failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    stream.end();
    process.exit(1);
  }

  logger.info("signatures fetched", { count: signatures.length });

  if (signatures.length === 0) {
    logger.warn("no signatures returned — verify PUMPFUN_PROGRAM_ID and that the endpoint exposes recent program activity");
    stream.end();
    return;
  }

  let saved = 0;
  let nullTransactions = 0;
  let errors = 0;

  for (const sig of signatures) {
    try {
      const txRes = await rpc<unknown>(url, "getTransaction", [
        sig.signature,
        {
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        },
      ]);
      if (txRes.error) {
        errors += 1;
        logger.warn("getTransaction rpc error", {
          signature: sig.signature,
          error: txRes.error,
        });
        continue;
      }
      const result = txRes.result ?? null;
      if (result === null) nullTransactions += 1;
      const line = JSON.stringify({
        fetchedAt: new Date().toISOString(),
        signature: sig.signature,
        slot: sig.slot,
        blockTime: sig.blockTime ?? null,
        confirmationStatus: sig.confirmationStatus ?? null,
        signatureErr: sig.err ?? null,
        transaction: result,
      });
      stream.write(line + "\n");
      saved += 1;
      logger.info("transaction saved", {
        index: saved,
        of: signatures.length,
        signature: sig.signature,
        slot: sig.slot,
        wasNull: result === null,
      });
    } catch (err) {
      errors += 1;
      logger.warn("getTransaction failed", {
        signature: sig.signature,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  await new Promise<void>((resolve) => stream.end(() => resolve()));

  logger.info("fetch:pumpfun:txs finished", {
    signatures: signatures.length,
    transactionsSaved: saved,
    nullTransactions,
    errors,
    outputPath: OUTPUT_PATH,
  });
}

void main().catch((err) => {
  logger.error("fetch:pumpfun:txs unhandled error", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
