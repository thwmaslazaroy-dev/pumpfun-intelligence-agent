import * as fs from "fs";
import * as path from "path";
import { config } from "../config";
import { logger } from "../utils/logger";
import { logSanitizedEnvSummary } from "../utils/env-summary";
import {
  PumpFunTransactionParser,
  RawTransactionLine,
} from "../parsing/pumpfun-transaction-parser";
import { PumpFunTransactionKind } from "../types";

const SAFE_MODE_HELP = `
SOLANA_RPC_HTTP_URL or PUMPFUN_PROGRAM_ID is not set — cannot search for CREATE candidates.

This script is read-only. It calls JSON-RPC getSignaturesForAddress + getTransaction
for the configured Pump.fun program, classifies each transaction with the existing
parser, and writes ONLY CREATE candidates to the configured output path.

It does NOT trade, sign, or send Discord alerts.

To use it, set in your .env:
  SOLANA_RPC_HTTP_URL=https://<your-solana-http-rpc-endpoint>
  PUMPFUN_PROGRAM_ID=<the Pump.fun program id>
  PUMPFUN_SIGNATURE_LIMIT=500                    # optional, default 500
  PUMPFUN_CREATE_SEARCH_OUTPUT_PATH=./data/pumpfun-create-candidates.jsonl

Then:
  npm run build
  npm run find:pumpfun:creates
`;

const REQUEST_TIMEOUT_MS = 15_000;
const PROGRESS_EVERY = 25;
const HIGH_CREATE_TARGET = 5;
const TX_FETCH_DELAY_MS = 50;
const SIGNATURE_PAGE_MAX = 1000;

interface SignatureInfo {
  signature: string;
  slot: number;
  err?: unknown;
  blockTime?: number | null;
  confirmationStatus?: string | null;
}

interface JsonRpcResponse<T> {
  jsonrpc: string;
  id: number | string;
  result?: T;
  error?: { code: number; message: string };
}

let nextRequestId = 1;

async function rpc<T>(
  url: string,
  method: string,
  params: unknown,
): Promise<JsonRpcResponse<T>> {
  const body = { jsonrpc: "2.0", id: nextRequestId++, method, params };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureOutputDir(file: string): void {
  const dir = path.dirname(file);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
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

async function fetchSignatures(
  url: string,
  programId: string,
  totalLimit: number,
): Promise<SignatureInfo[]> {
  const out: SignatureInfo[] = [];
  let before: string | undefined;
  while (out.length < totalLimit) {
    const remaining = totalLimit - out.length;
    const pageLimit = Math.min(remaining, SIGNATURE_PAGE_MAX);
    const opts: Record<string, unknown> = { limit: pageLimit };
    if (before) opts.before = before;
    const res = await rpc<SignatureInfo[]>(url, "getSignaturesForAddress", [programId, opts]);
    if (res.error) {
      throw new Error(`getSignaturesForAddress: ${res.error.message}`);
    }
    const page = res.result ?? [];
    out.push(...page);
    if (page.length < pageLimit) break;
    before = page[page.length - 1].signature;
    logger.info("signatures: page fetched", {
      pageSize: page.length,
      totalSoFar: out.length,
      target: totalLimit,
    });
  }
  return out;
}

async function main(): Promise<void> {
  logSanitizedEnvSummary({
    context: "find:pumpfun:creates",
    extras: {
      PUMPFUN_SIGNATURE_LIMIT: config.pumpfunSignatureLimit,
      PUMPFUN_CREATE_SEARCH_OUTPUT_PATH: config.pumpfunCreateSearchOutputPath,
    },
  });

  if (!config.solanaRpcHttpUrl || !config.pumpfunProgramId) {
    process.stdout.write(SAFE_MODE_HELP);
    process.exit(0);
  }

  const url = config.solanaRpcHttpUrl;
  const programId = config.pumpfunProgramId;
  const limit = config.pumpfunSignatureLimit;
  const outputPath = config.pumpfunCreateSearchOutputPath;

  ensureOutputDir(outputPath);
  const out = fs.createWriteStream(outputPath, { flags: "w" });
  const parser = new PumpFunTransactionParser(programId);

  logger.info("find:pumpfun:creates starting (read-only)", {
    httpScheme: safeScheme(url),
    programId,
    signatureLimit: limit,
    outputPath,
    earlyStopHighCreates: HIGH_CREATE_TARGET,
    progressEvery: PROGRESS_EVERY,
    txFetchDelayMs: TX_FETCH_DELAY_MS,
  });

  let signatures: SignatureInfo[];
  try {
    signatures = await fetchSignatures(url, programId, limit);
  } catch (err) {
    logger.error("signature fetch failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    out.end();
    process.exit(1);
  }

  logger.info("signature batch ready", { count: signatures.length });

  const counts: Record<PumpFunTransactionKind, number> = {
    CREATE: 0,
    BUY: 0,
    SELL: 0,
    ATA_CREATE: 0,
    UNKNOWN: 0,
  };
  let processed = 0;
  let rpcErrors = 0;
  let nullTransactions = 0;
  let createCandidatesSaved = 0;
  let highCreates = 0;
  let earlyStopped = false;

  for (const sig of signatures) {
    if (highCreates >= HIGH_CREATE_TARGET) {
      logger.info("early stop: HIGH-confidence CREATE target reached", {
        highCreates,
        target: HIGH_CREATE_TARGET,
        processed,
        ofTotal: signatures.length,
      });
      earlyStopped = true;
      break;
    }

    let txRes: JsonRpcResponse<unknown>;
    try {
      txRes = await rpc<unknown>(url, "getTransaction", [
        sig.signature,
        {
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        },
      ]);
    } catch (err) {
      rpcErrors += 1;
      processed += 1;
      logger.warn("getTransaction failed", {
        signature: sig.signature,
        error: err instanceof Error ? err.message : String(err),
      });
      if (TX_FETCH_DELAY_MS > 0) await sleep(TX_FETCH_DELAY_MS);
      continue;
    }

    if (txRes.error) {
      rpcErrors += 1;
      processed += 1;
      logger.warn("getTransaction rpc error", {
        signature: sig.signature,
        error: txRes.error,
      });
      if (TX_FETCH_DELAY_MS > 0) await sleep(TX_FETCH_DELAY_MS);
      continue;
    }

    const result = txRes.result ?? null;
    if (result === null) nullTransactions += 1;

    const raw: RawTransactionLine = {
      fetchedAt: new Date().toISOString(),
      signature: sig.signature,
      slot: sig.slot,
      blockTime: sig.blockTime ?? null,
      confirmationStatus: sig.confirmationStatus ?? null,
      signatureErr: sig.err ?? null,
      transaction: result,
    };
    const parsed = parser.parse(raw);
    counts[parsed.kind] += 1;
    processed += 1;

    if (parsed.kind === "CREATE") {
      out.write(JSON.stringify(parsed) + "\n");
      createCandidatesSaved += 1;
      if (parsed.confidence === "HIGH") {
        highCreates += 1;
        logger.info("HIGH-confidence CREATE found", {
          signature: parsed.signature,
          slot: parsed.slot,
          candidateMints: parsed.candidateMints,
          progressIndex: processed,
          ofTotal: signatures.length,
          highCreatesSoFar: highCreates,
          earlyStopTarget: HIGH_CREATE_TARGET,
        });
      } else {
        logger.info("CREATE candidate (lower confidence)", {
          signature: parsed.signature,
          confidence: parsed.confidence,
          progressIndex: processed,
          ofTotal: signatures.length,
        });
      }
    }

    if (processed % PROGRESS_EVERY === 0) {
      logger.info("progress", {
        processed,
        ofTotal: signatures.length,
        counts,
        highCreates,
        rpcErrors,
        nullTransactions,
      });
    }

    if (TX_FETCH_DELAY_MS > 0) await sleep(TX_FETCH_DELAY_MS);
  }

  await new Promise<void>((resolve) => out.end(() => resolve()));

  logger.info("find:pumpfun:creates finished", {
    signatures: signatures.length,
    processed,
    rpcErrors,
    nullTransactions,
    counts,
    createCandidatesSaved,
    highCreates,
    earlyStopped,
    output: outputPath,
  });

  process.stdout.write("\n=== summary ===\n");
  process.stdout.write(`signatures fetched:          ${signatures.length}\n`);
  process.stdout.write(`transactions processed:      ${processed}\n`);
  process.stdout.write(`rpc errors:                  ${rpcErrors}\n`);
  process.stdout.write(`null/archived transactions:  ${nullTransactions}\n`);
  process.stdout.write(`counts by kind:              ${JSON.stringify(counts)}\n`);
  process.stdout.write(`CREATE candidates saved:     ${createCandidatesSaved}\n`);
  process.stdout.write(`HIGH-confidence CREATE:      ${highCreates}\n`);
  process.stdout.write(`early stopped at target ${HIGH_CREATE_TARGET}: ${earlyStopped}\n`);
}

void main().catch((err) => {
  logger.error("find:pumpfun:creates unhandled error", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
