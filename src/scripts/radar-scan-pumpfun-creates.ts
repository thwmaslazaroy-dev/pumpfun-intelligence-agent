import * as fs from "fs";
import * as path from "path";
import { config } from "../config";
import { logger } from "../utils/logger";
import { logSanitizedEnvSummary } from "../utils/env-summary";
import {
  PumpFunTransactionParser,
  RawTransactionLine,
} from "../parsing/pumpfun-transaction-parser";
import {
  closeDatabase,
  initDatabase,
  SqliteTokenRepository,
} from "../storage";
import { TokenLaunch } from "../types";

const SAFE_MODE_HELP = `
SOLANA_RPC_HTTP_URL or PUMPFUN_PROGRAM_ID is not set — radar:scan cannot run.

This script is read-only on Solana (no signing, no trading) and only writes
new TokenLaunch rows to SQLite. It does NOT send Discord alerts. It uses HTTP
JSON-RPC only — no persistent WebSocket.

To use it, set in your .env:
  SOLANA_RPC_HTTP_URL=https://<your-solana-http-rpc-endpoint>
  PUMPFUN_PROGRAM_ID=<the Pump.fun program id>
  RADAR_SIGNATURE_LIMIT=50      # optional, default 50
  RADAR_TX_FETCH_LIMIT=20       # optional, default 20

Then:
  npm run radar:scan
`;

const REQUEST_TIMEOUT_MS = 15_000;
const TX_FETCH_DELAY_MS = 50;
const SEEN_SIGS_PATH = "./data/radar-seen-signatures.json";
const SEEN_SIGS_CAP = 5_000;

const KNOWN_NON_CREATOR_PROGRAM_IDS: ReadonlySet<string> = new Set<string>([
  "11111111111111111111111111111111",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
  "ComputeBudget111111111111111111111111111111",
  "SysvarRent111111111111111111111111111111111",
  "SysvarC1ock11111111111111111111111111111111",
  "Sysvar1nstructions1111111111111111111111111",
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
]);

function extractCreatorWallet(
  candidateWallets: readonly string[],
  candidateMints: readonly string[],
  programId: string,
): string | null {
  if (candidateWallets.length === 0) return null;
  const denylist = new Set<string>(KNOWN_NON_CREATOR_PROGRAM_IDS);
  denylist.add(programId);
  for (const m of candidateMints) {
    if (typeof m === "string" && m.length > 0) denylist.add(m);
  }
  for (const w of candidateWallets) {
    if (typeof w !== "string" || w.length === 0) continue;
    if (denylist.has(w)) continue;
    return w;
  }
  return null;
}

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

// True only for hard provider quota / rate-limit / daily-limit signals.
// Transient connectivity issues, parser errors, null transactions, and
// per-item RPC errors are NOT limits and must NOT trigger exit 88.
function isLimitErrorText(s: string): boolean {
  if (!s) return false;
  return (
    /rate[-_\s]?limit/i.test(s) ||
    /too many requests/i.test(s) ||
    /\b429\b/.test(s) ||
    /HTTP\s*429/i.test(s) ||
    /daily request limit/i.test(s) ||
    /daily limit/i.test(s) ||
    /quota exceeded/i.test(s) ||
    /request limit reached/i.test(s) ||
    /credits exhausted/i.test(s) ||
    /\brpm[-_\s]?limit\b/i.test(s) ||
    /\brps[-_\s]?limit\b/i.test(s) ||
    /upgrade your account/i.test(s)
  );
}

function isLimitErrorCode(code: number | undefined): boolean {
  return code === 429 || code === -32005;
}

// True for errors that warrant retrying with the backup RPC: 429 status,
// timeout/abort, and connection-level failures.
function isRetryableError(msg: string, code?: number): boolean {
  if (code !== undefined && isLimitErrorCode(code)) return true;
  return (
    /HTTP\s*429/i.test(msg) ||
    /too many requests/i.test(msg) ||
    /rate[-_\s]?limit/i.test(msg) ||
    /\b429\b/.test(msg) ||
    /aborted/i.test(msg) ||
    /timed?\s*out/i.test(msg) ||
    /ECONNREFUSED/.test(msg) ||
    /ENOTFOUND/.test(msg) ||
    /fetch failed/i.test(msg) ||
    /socket hang up/i.test(msg) ||
    /network error/i.test(msg)
  );
}

async function rpcWithFallback<T>(
  primary: string,
  backup: string | null,
  method: string,
  params: unknown,
): Promise<JsonRpcResponse<T>> {
  let primaryThrown: unknown = null;

  try {
    const res = await rpc<T>(primary, method, params);
    const bodyRetryable =
      backup &&
      res.error &&
      isRetryableError(res.error.message ?? "", res.error.code);
    if (!bodyRetryable) {
      return res;
    }
    primaryThrown = new Error(res.error!.message);
    logger.warn("rpc primary body error, retrying with backup", {
      rpcProvider: "primary",
      method,
      fallbackUsed: true,
      fallbackReason: res.error!.message,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!backup || !isRetryableError(msg)) {
      throw err;
    }
    primaryThrown = err;
    logger.warn("rpc primary failed, retrying with backup", {
      rpcProvider: "primary",
      method,
      fallbackUsed: true,
      fallbackReason: msg,
    });
  }

  try {
    const res = await rpc<T>(backup!, method, params);
    logger.info("rpc backup succeeded", {
      rpcProvider: "backup",
      method,
      fallbackUsed: true,
    });
    return res;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error("rpc backup also failed", {
      rpcProvider: "backup",
      method,
      fallbackUsed: true,
      error: msg,
    });
    throw primaryThrown ?? err;
  }
}

const LIMIT_EXIT_CODE = 88;

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
}

function ensureDir(file: string): void {
  const dir = path.dirname(file);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function readPosInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function readNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function loadSeenSignatures(): Set<string> {
  try {
    if (!fs.existsSync(SEEN_SIGS_PATH)) return new Set();
    const raw = fs.readFileSync(SEEN_SIGS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((s) => typeof s === "string"));
    }
  } catch {
    // fall through — corrupt cache is non-fatal
  }
  return new Set();
}

function saveSeenSignatures(seen: Set<string>): void {
  ensureDir(SEEN_SIGS_PATH);
  const arr = Array.from(seen);
  const trimmed =
    arr.length > SEEN_SIGS_CAP ? arr.slice(arr.length - SEEN_SIGS_CAP) : arr;
  fs.writeFileSync(SEEN_SIGS_PATH, JSON.stringify(trimmed));
}

function safeScheme(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol.replace(":", "");
  } catch {
    return "(unparseable)";
  }
}

interface ScanCounters {
  signaturesFetched: number;
  candidatesFound: number;
  transactionsFetched: number;
  newLaunchesSaved: number;
  duplicateSignaturesSkipped: number;
  duplicateMintsSkipped: number;
  rpcErrors: number;
  parseErrors: number;
  // Single counter for any provider quota / rate-limit / daily-limit signal.
  // When > 0, the script exits with LIMIT_EXIT_CODE (88) so the radar loop stops.
  limitHits: number;
  nullTransactions: number;
}

async function main(): Promise<void> {
  const signatureLimit = readPosInt("RADAR_SIGNATURE_LIMIT", 50);
  const txFetchLimit = readPosInt("RADAR_TX_FETCH_LIMIT", 20);
  const txFetchDelayMs = readNonNegativeInt("RADAR_TX_FETCH_DELAY_MS", 0);

  logSanitizedEnvSummary({
    context: "radar:scan",
    extras: {
      RADAR_SIGNATURE_LIMIT: signatureLimit,
      RADAR_TX_FETCH_LIMIT: txFetchLimit,
      RADAR_TX_FETCH_DELAY_MS: txFetchDelayMs,
    },
  });

  if (!config.solanaRpcHttpUrl || !config.pumpfunProgramId) {
    process.stdout.write(SAFE_MODE_HELP);
    process.exit(0);
  }

  const url = config.solanaRpcHttpUrl;
  const backupUrl = config.solanaRpcHttpUrlBackup || null;
  const programId = config.pumpfunProgramId;

  const seenSignatures = loadSeenSignatures();
  const seenAtStart = seenSignatures.size;

  initDatabase(config.databaseUrl);
  const repo = new SqliteTokenRepository();
  const parser = new PumpFunTransactionParser(programId);

  const counters: ScanCounters = {
    signaturesFetched: 0,
    candidatesFound: 0,
    transactionsFetched: 0,
    newLaunchesSaved: 0,
    duplicateSignaturesSkipped: 0,
    duplicateMintsSkipped: 0,
    rpcErrors: 0,
    parseErrors: 0,
    limitHits: 0,
    nullTransactions: 0,
  };

  logger.info("radar:scan starting (HTTP-only, low-request)", {
    httpScheme: safeScheme(url),
    programId,
    signatureLimit,
    txFetchLimit,
    txFetchDelayMs,
    seenSignaturesAtStart: seenAtStart,
    databaseUrl: config.databaseUrl,
  });

  let signatures: SignatureInfo[];
  try {
    const sigsRes = await rpcWithFallback<SignatureInfo[]>(url, backupUrl, "getSignaturesForAddress", [
      programId,
      { limit: signatureLimit },
    ]);
    if (sigsRes.error) {
      const msg = sigsRes.error.message ?? `code ${sigsRes.error.code}`;
      if (isLimitErrorText(msg) || isLimitErrorCode(sigsRes.error.code)) {
        counters.limitHits += 1;
      } else {
        counters.rpcErrors += 1;
      }
      logger.error("getSignaturesForAddress error", { error: sigsRes.error });
      endWith(counters, seenSignatures);
    }
    signatures = sigsRes.result ?? [];
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isLimitErrorText(msg)) counters.limitHits += 1;
    else counters.rpcErrors += 1;
    logger.error("getSignaturesForAddress failed", { error: msg });
    endWith(counters, seenSignatures);
  }

  counters.signaturesFetched = signatures.length;

  for (const sig of signatures) {
    if (counters.transactionsFetched >= txFetchLimit) {
      logger.info("radar:scan tx fetch budget exhausted", {
        txFetched: counters.transactionsFetched,
        budget: txFetchLimit,
      });
      break;
    }

    if (seenSignatures.has(sig.signature)) {
      counters.duplicateSignaturesSkipped += 1;
      continue;
    }

    let txRes: JsonRpcResponse<unknown>;
    try {
      if (txFetchDelayMs > 0) await sleep(txFetchDelayMs);
      txRes = await rpcWithFallback<unknown>(url, backupUrl, "getTransaction", [
        sig.signature,
        {
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        },
      ]);
      if (txFetchDelayMs > 0) await sleep(txFetchDelayMs);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isLimitErrorText(msg)) {
        counters.limitHits += 1;
        logger.error("provider limit reached — stopping radar:scan", { msg });
        break;
      }
      counters.rpcErrors += 1;
      logger.warn("getTransaction failed", { signature: sig.signature, msg });
      await sleep(TX_FETCH_DELAY_MS);
      continue;
    }

    if (txRes.error) {
      const msg = txRes.error.message ?? `code ${txRes.error.code}`;
      if (isLimitErrorText(msg) || isLimitErrorCode(txRes.error.code)) {
        counters.limitHits += 1;
        logger.error("provider limit reached — stopping radar:scan", { msg });
        break;
      }
      counters.rpcErrors += 1;
      logger.warn("getTransaction rpc error", {
        signature: sig.signature,
        error: txRes.error,
      });
      await sleep(TX_FETCH_DELAY_MS);
      continue;
    }

    counters.transactionsFetched += 1;
    seenSignatures.add(sig.signature);

    const result = txRes.result ?? null;
    if (result === null) {
      counters.nullTransactions += 1;
      await sleep(TX_FETCH_DELAY_MS);
      continue;
    }

    const raw: RawTransactionLine = {
      fetchedAt: new Date().toISOString(),
      signature: sig.signature,
      slot: sig.slot,
      blockTime: sig.blockTime ?? null,
      confirmationStatus: sig.confirmationStatus ?? null,
      signatureErr: sig.err ?? null,
      transaction: result,
    };

    let parsed;
    try {
      parsed = parser.parse(raw);
    } catch (err) {
      counters.parseErrors += 1;
      logger.warn("parser threw", {
        signature: sig.signature,
        error: err instanceof Error ? err.message : String(err),
      });
      await sleep(TX_FETCH_DELAY_MS);
      continue;
    }

    const isCreate =
      parsed.kind === "CREATE" &&
      (parsed.confidence === "HIGH" || parsed.confidence === "MEDIUM");
    if (!isCreate) {
      await sleep(TX_FETCH_DELAY_MS);
      continue;
    }

    counters.candidatesFound += 1;

    const mint = parsed.candidateMints[0];
    if (!mint) {
      logger.info("CREATE detected without candidateMint — skipping save", {
        signature: parsed.signature,
        confidence: parsed.confidence,
      });
      await sleep(TX_FETCH_DELAY_MS);
      continue;
    }

    const creatorWallet = extractCreatorWallet(
      parsed.candidateWallets,
      parsed.candidateMints,
      programId,
    );
    if (!creatorWallet) {
      logger.info("CREATE detected without resolvable creator wallet — skipping", {
        signature: parsed.signature,
        candidateWallets: parsed.candidateWallets,
      });
      await sleep(TX_FETCH_DELAY_MS);
      continue;
    }

    const existing = await repo.findTokenByMint(mint);
    if (existing) {
      counters.duplicateMintsSkipped += 1;
      await sleep(TX_FETCH_DELAY_MS);
      continue;
    }

    const launchedAt =
      typeof parsed.blockTime === "number"
        ? new Date(parsed.blockTime * 1000)
        : new Date();

    const token: TokenLaunch = {
      mint,
      name: "Unknown",
      symbol: "UNKNOWN",
      creatorWallet,
      launchedAt,
      initialMarketCapUsd: 0,
      bondingCurveProgress: 0,
      buyCount: 0,
      sellCount: 0,
      volumeUsd: 0,
    };

    try {
      await repo.saveTokenLaunch(token);
      counters.newLaunchesSaved += 1;
      logger.info("radar:scan saved new token", {
        mint,
        creatorWallet,
        signature: parsed.signature,
        slot: parsed.slot,
        confidence: parsed.confidence,
      });
    } catch (err) {
      counters.rpcErrors += 1;
      logger.warn("saveTokenLaunch failed", {
        mint,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    await sleep(TX_FETCH_DELAY_MS);
  }

  endWith(counters, seenSignatures);
}

function endWith(counters: ScanCounters, seen: Set<string>): never {
  try {
    saveSeenSignatures(seen);
  } catch (err) {
    logger.warn("failed to persist seen-signatures cache", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  closeDatabase();

  logger.info("radar:scan finished", { counters });

  process.stdout.write("\n=== radar:scan summary ===\n");
  process.stdout.write(`  signaturesFetched:           ${counters.signaturesFetched}\n`);
  process.stdout.write(`  candidatesFound:             ${counters.candidatesFound}\n`);
  process.stdout.write(`  transactionsFetched:         ${counters.transactionsFetched}\n`);
  process.stdout.write(`  newLaunchesSaved:            ${counters.newLaunchesSaved}\n`);
  process.stdout.write(
    `  duplicateSignaturesSkipped:  ${counters.duplicateSignaturesSkipped}\n`,
  );
  process.stdout.write(
    `  duplicateMintsSkipped:       ${counters.duplicateMintsSkipped}\n`,
  );
  process.stdout.write(`  nullTransactions:            ${counters.nullTransactions}\n`);
  process.stdout.write(`  rpcErrors:                   ${counters.rpcErrors}\n`);
  process.stdout.write(`  parseErrors:                 ${counters.parseErrors}\n`);
  process.stdout.write(`  limitHits:                   ${counters.limitHits}\n`);

  const exitCode = counters.limitHits > 0 ? LIMIT_EXIT_CODE : 0;
  if (counters.limitHits > 0) {
    process.stdout.write(
      `\n  NOTE: provider rate-limit / quota / daily-limit hit — exiting ${LIMIT_EXIT_CODE} so the radar loop can stop.\n`,
    );
  }
  process.exit(exitCode);
}

void main().catch((err) => {
  logger.error("radar:scan unhandled error", {
    error: err instanceof Error ? err.message : String(err),
  });
  closeDatabase();
  process.exit(1);
});
