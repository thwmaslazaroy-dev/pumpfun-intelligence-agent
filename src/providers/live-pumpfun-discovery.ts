import WebSocket, { RawData } from "ws";
import { logger } from "../utils/logger";
import {
  PumpFunTransactionParser,
  RawTransactionLine,
} from "../parsing/pumpfun-transaction-parser";
import { ParsedPumpFunTransaction } from "../types";
import { RequestBudgetManager } from "../services/request-budget-manager";

export type SolanaCommitment = "processed" | "confirmed" | "finalized";

export interface LivePumpFunDiscoveryConfig {
  wsUrl: string;
  httpUrl: string;
  programId: string;
  parser: PumpFunTransactionParser;
  commitment?: SolanaCommitment;
  rpcTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
  /** Optional budget manager. When present, enforces per-min/hour/day limits and deduplicates signatures across restarts. */
  budgetManager?: RequestBudgetManager;
}

export interface OnCreateEvent {
  parsed: ParsedPumpFunTransaction;
  observedAt: string;
  receivedFromLog: { signature: string; slot: number | null };
  // Best-effort creator wallet (fee-payer signer that's not a mint or a known
  // SPL/system program). null when no candidate survives the denylist.
  creatorWallet: string | null;
  creatorExtractionReason: string;
}

export interface LiveDiscoveryCounters {
  receivedLogs: number;
  fetchedTransactions: number;
  parsedTransactions: number;
  ignoredTransactions: number;
  createDetections: number;
  unknownTransactions: number;
  // Categorised error counters — sum of these fields is the legacy "errors" total.
  rpcFetchErrors: number;       // HTTP transport failure / non-2xx / abort / json-rpc error frame
  rpcNullTransaction: number;    // 200 OK but result === null (e.g. tx not yet finalized)
  rpcRateLimitErrors: number;    // HTTP 429 or "rate limit" / "too many requests" in error text
  parseErrors: number;           // PumpFunTransactionParser.parse() threw
  websocketErrors: number;       // WS constructor throw, ws.on("error"), unparseable frame, send failure
  unknownErrors: number;         // onCreate callback throw, anything not classified above
  // Queue / dedup metrics
  duplicateSignatures: number;       // signature seen before — dropped at the queue boundary
  droppedDueToBackpressure: number;  // queue was full at MAX_QUEUE_SIZE, oldest entry evicted
  // Cheap pre-filter on the WS notification's own logs — skips getTransaction
  // entirely for buys/sells/ATA creates etc. Only CREATE-marker logs survive.
  prefilterIgnoredLogs: number;
}

type ErrorCategory =
  | "rpcFetch"
  | "rpcNull"
  | "rpcRateLimit"
  | "parse"
  | "websocket"
  | "unknown";

const ERROR_SAMPLE_THROTTLE_MS = 30_000;

// Internal rate-limited fetch queue for getTransaction calls.
// Keep this well under QuickNode's documented 15/sec limit to leave headroom
// for the WS subscribe + occasional unsubscribe traffic.
const DEFAULT_MAX_RPS = 8;
// Cap the queue so memory cannot grow unbounded if Pump.fun outpaces fetch rate.
const MAX_QUEUE_SIZE = 5_000;
// Cap the dedup set so it never grows forever during a long-running session.
const MAX_SEEN_SIGNATURES = 50_000;

interface JsonRpcResponse<T> {
  jsonrpc?: string;
  id?: number | string;
  result?: T;
  error?: { code?: number; message?: string };
}

interface LogsNotificationFrame {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  method?: string;
  params?: {
    subscription?: number;
    result?: {
      context?: { slot?: number };
      value?: { signature?: string; err?: unknown; logs?: string[] };
    };
  };
}

const DEFAULT_COMMITMENT: SolanaCommitment = "confirmed";
const DEFAULT_RPC_TIMEOUT_MS = 15_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000;
const DEFAULT_INITIAL_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;
const STOP_CLEANUP_FALLBACK_MS = 2_000;

export class LivePumpFunDiscovery {
  private readonly cfg: Required<Omit<LivePumpFunDiscoveryConfig, "budgetManager">> & {
    budgetManager?: RequestBudgetManager;
  };
  private ws: WebSocket | null = null;
  private subscriptionId: number | null = null;
  private wsRequestId = 1;
  private rpcRequestId = 1;
  private startedAt = 0;
  private reconnectAttempts = 0;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopRequested = false;
  private cleanedUp = false;
  private rpcDailyLimitReached = false;
  private resolveStart: (() => void) | null = null;
  private onCreate: ((event: OnCreateEvent) => void | Promise<void>) | null = null;
  private lastSignature: string | null = null;
  private lastCreateSignature: string | null = null;
  private lastErrorSampleAt = 0;
  // Rate-limited fetch queue
  private readonly queueDrainIntervalMs: number = Math.max(
    10,
    Math.round(1000 / DEFAULT_MAX_RPS),
  );
  private pendingQueue: Array<{ signature: string; slot: number | null }> = [];
  private seenSignatures: Set<string> = new Set();
  private seenSignaturesOrder: string[] = [];
  private queueDrainTimer: NodeJS.Timeout | null = null;

  private readonly counters: LiveDiscoveryCounters = {
    receivedLogs: 0,
    fetchedTransactions: 0,
    parsedTransactions: 0,
    ignoredTransactions: 0,
    createDetections: 0,
    unknownTransactions: 0,
    rpcFetchErrors: 0,
    rpcNullTransaction: 0,
    rpcRateLimitErrors: 0,
    parseErrors: 0,
    websocketErrors: 0,
    unknownErrors: 0,
    duplicateSignatures: 0,
    droppedDueToBackpressure: 0,
    prefilterIgnoredLogs: 0,
  };

  constructor(cfg: LivePumpFunDiscoveryConfig) {
    if (!cfg.wsUrl) throw new Error("LivePumpFunDiscovery: wsUrl is required");
    if (!cfg.httpUrl) throw new Error("LivePumpFunDiscovery: httpUrl is required");
    if (!cfg.programId) throw new Error("LivePumpFunDiscovery: programId is required");
    if (!cfg.parser) throw new Error("LivePumpFunDiscovery: parser is required");
    this.cfg = {
      wsUrl: cfg.wsUrl,
      httpUrl: cfg.httpUrl,
      programId: cfg.programId,
      parser: cfg.parser,
      commitment: cfg.commitment ?? DEFAULT_COMMITMENT,
      rpcTimeoutMs: cfg.rpcTimeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
      heartbeatIntervalMs: cfg.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      initialReconnectDelayMs:
        cfg.initialReconnectDelayMs ?? DEFAULT_INITIAL_RECONNECT_DELAY_MS,
      maxReconnectDelayMs: cfg.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS,
      budgetManager: cfg.budgetManager,
    };
  }

  start(opts: {
    onCreate: (event: OnCreateEvent) => void | Promise<void>;
  }): Promise<void> {
    if (this.startedAt !== 0) {
      throw new Error("LivePumpFunDiscovery already started");
    }
    this.onCreate = opts.onCreate;
    this.startedAt = Date.now();
    this.stopRequested = false;
    this.reconnectAttempts = 0;

    logger.info("live discovery starting (read-only)", {
      wsScheme: safeScheme(this.cfg.wsUrl),
      httpScheme: safeScheme(this.cfg.httpUrl),
      programId: this.cfg.programId,
      commitment: this.cfg.commitment,
      heartbeatIntervalMs: this.cfg.heartbeatIntervalMs,
      maxRps: DEFAULT_MAX_RPS,
      queueDrainIntervalMs: this.queueDrainIntervalMs,
      maxQueueSize: MAX_QUEUE_SIZE,
    });

    this.startHeartbeat();
    this.startQueueDrain();
    this.connect();

    return new Promise<void>((resolve) => {
      this.resolveStart = resolve;
    });
  }

  async stop(): Promise<void> {
    if (this.stopRequested) return;
    this.stopRequested = true;
    logger.info("live discovery: stop requested");
    this.unsubscribeIfAny();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close(1000, "stop requested");
      } catch {
        // ignore — close handler will or won't fire
      }
    }
    setTimeout(() => this.cleanup(), STOP_CLEANUP_FALLBACK_MS);
  }

  private connect(): void {
    if (this.stopRequested) {
      this.cleanup();
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.cfg.wsUrl);
    } catch (err) {
      this.recordError("websocket", err, "ws constructor threw");
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    this.subscriptionId = null;

    ws.on("open", () => {
      logger.info("live discovery: ws open — subscribing");
      this.reconnectAttempts = 0;
      this.subscribe();
    });
    ws.on("message", (data: RawData) => this.onMessage(data));
    ws.on("error", (err: Error) => {
      this.recordError("websocket", err, "ws error event");
    });
    ws.on("close", (code: number, reasonBuf: Buffer) => {
      const reason = reasonBuf.toString();
      logger.info("live discovery: ws closed", {
        code,
        reason,
        stopRequested: this.stopRequested,
      });
      this.subscriptionId = null;
      this.ws = null;
      if (this.stopRequested) {
        this.cleanup();
        return;
      }
      this.scheduleReconnect();
    });
  }

  private cleanup(): void {
    if (this.cleanedUp) return;
    this.cleanedUp = true;
    this.stopHeartbeat();
    this.stopQueueDrain();
    this.pendingQueue.length = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const uptimeSec = Math.round((Date.now() - this.startedAt) / 1000);
    logger.info("live discovery stopped", {
      uptimeSec,
      counters: { ...this.counters },
      lastSignature: this.lastSignature,
      lastCreateSignature: this.lastCreateSignature,
      rpcDailyLimitReached: this.rpcDailyLimitReached,
    });
    if (this.resolveStart) {
      const r = this.resolveStart;
      this.resolveStart = null;
      r();
    }
  }

  private triggerDailyLimitShutdown(reason: string): void {
    if (this.rpcDailyLimitReached) return;
    this.rpcDailyLimitReached = true;
    this.stopRequested = true;
    const truncated = reason.length > 200 ? reason.slice(0, 200) + "…" : reason;
    logger.error("RPC daily request limit reached; stopping live discovery", {
      reason: truncated,
    });
    this.unsubscribeIfAny();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.pendingQueue.length = 0;
    if (this.ws) {
      try {
        this.ws.close(1011, "rpc daily limit reached");
      } catch {
        // ignore — close handler may or may not fire
      }
    }
    setTimeout(() => this.cleanup(), STOP_CLEANUP_FALLBACK_MS);
  }

  private scheduleReconnect(): void {
    if (this.stopRequested) {
      this.cleanup();
      return;
    }
    const initial = this.cfg.initialReconnectDelayMs;
    const cap = this.cfg.maxReconnectDelayMs;
    const exp = initial * 2 ** this.reconnectAttempts;
    const base = Math.min(cap, exp);
    const jitter = 0.8 + Math.random() * 0.4;
    const delay = Math.round(base * jitter);
    this.reconnectAttempts += 1;
    logger.info("live discovery: reconnecting", {
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private subscribe(): void {
    const id = this.nextWsId();
    const req = {
      jsonrpc: "2.0",
      id,
      method: "logsSubscribe",
      params: [
        { mentions: [this.cfg.programId] },
        { commitment: this.cfg.commitment },
      ],
    };
    try {
      this.ws?.send(JSON.stringify(req));
    } catch (err) {
      this.recordError("websocket", err, "subscribe send failed");
    }
  }

  private unsubscribeIfAny(): void {
    if (this.subscriptionId == null || !this.ws) return;
    const id = this.nextWsId();
    const req = {
      jsonrpc: "2.0",
      id,
      method: "logsUnsubscribe",
      params: [this.subscriptionId],
    };
    try {
      this.ws.send(JSON.stringify(req));
      logger.info("live discovery: logsUnsubscribe sent", {
        subscriptionId: this.subscriptionId,
      });
    } catch {
      // socket may be closing already
    }
    this.subscriptionId = null;
  }

  private onMessage(data: RawData): void {
    let frame: LogsNotificationFrame;
    try {
      frame = JSON.parse(data.toString()) as LogsNotificationFrame;
    } catch (err) {
      this.recordError("websocket", err, "unparseable frame");
      return;
    }

    if (
      this.subscriptionId === null &&
      frame.method === undefined &&
      typeof frame.result === "number"
    ) {
      this.subscriptionId = frame.result;
      logger.info("live discovery: subscribed", {
        subscriptionId: this.subscriptionId,
      });
      return;
    }

    if (frame.method === "logsNotification") {
      const value = frame.params?.result?.value;
      const ctx = frame.params?.result?.context;
      const signature = typeof value?.signature === "string" ? value.signature : null;
      const slot = typeof ctx?.slot === "number" ? ctx.slot : null;
      if (!signature) return;
      this.counters.receivedLogs += 1;
      this.lastSignature = signature;

      const logs = Array.isArray(value?.logs) ? (value!.logs as string[]) : [];
      if (!hasCreateMarkerInLogs(logs)) {
        this.counters.prefilterIgnoredLogs += 1;
        return;
      }

      this.enqueue(signature, slot);
    }
  }

  private enqueue(signature: string, slot: number | null): void {
    if (this.seenSignatures.has(signature)) {
      this.counters.duplicateSignatures += 1;
      return;
    }
    this.seenSignatures.add(signature);
    this.seenSignaturesOrder.push(signature);
    if (this.seenSignaturesOrder.length > MAX_SEEN_SIGNATURES) {
      const evicted = this.seenSignaturesOrder.shift();
      if (evicted !== undefined) this.seenSignatures.delete(evicted);
    }
    this.pendingQueue.push({ signature, slot });
    if (this.pendingQueue.length > MAX_QUEUE_SIZE) {
      // FIFO eviction — drop oldest pending so newer launches can still be processed.
      this.pendingQueue.shift();
      this.counters.droppedDueToBackpressure += 1;
    }
  }

  private startQueueDrain(): void {
    this.stopQueueDrain();
    this.queueDrainTimer = setInterval(
      () => this.drainOne(),
      this.queueDrainIntervalMs,
    );
  }

  private stopQueueDrain(): void {
    if (this.queueDrainTimer) {
      clearInterval(this.queueDrainTimer);
      this.queueDrainTimer = null;
    }
  }

  private drainOne(): void {
    if (this.stopRequested) return;
    const next = this.pendingQueue.shift();
    if (!next) return;
    void this.processNotification(next.signature, next.slot);
  }

  private async processNotification(
    signature: string,
    slot: number | null,
  ): Promise<void> {
    const budget = this.cfg.budgetManager;

    // Cross-session signature dedup — skip if already processed in a prior run
    if (budget?.hasProcessedSignature(signature)) {
      this.counters.duplicateSignatures += 1;
      return;
    }

    // Budget gate — CRITICAL priority since this is live detection
    if (budget) {
      const check = budget.allowRequest("helius_http", "CRITICAL");
      if (!check.allowed) {
        logger.warn("budget: helius_http blocked getTransaction", {
          reason: check.reason,
          dayUsagePct: check.dayUsagePct.toFixed(1),
          signature,
        });
        return;
      }
    }

    let txResult: unknown = null;
    try {
      const res = await this.rpcGetTransaction(signature);
      if (res.error) {
        const msg = res.error.message ?? String(res.error.code ?? "rpc error");
        if (isDailyLimitText(msg)) {
          this.triggerDailyLimitShutdown(msg);
          return;
        }
        if (isRateLimitText(msg) || res.error.code === 429 || res.error.code === -32005) {
          this.counters.rpcRateLimitErrors += 1;
          this.maybeLogErrorSample("rpcRateLimit", msg, { signature });
          budget?.recordRateLimit("helius_http", "getTransaction");
        } else {
          this.counters.rpcFetchErrors += 1;
          this.maybeLogErrorSample("rpcFetch", msg, { signature });
          budget?.recordRequest("helius_http", "getTransaction", { statusCode: res.error.code ?? 500, relatedSignature: signature });
        }
        return;
      }
      txResult = res.result ?? null;
      if (txResult === null) {
        this.counters.rpcNullTransaction += 1;
        // Null is common (tx not yet finalized). Sample only when throttle window allows.
        this.maybeLogErrorSample("rpcNull", "getTransaction returned null", { signature });
        budget?.recordRequest("helius_http", "getTransaction", { statusCode: null, reason: "result-null", relatedSignature: signature });
        return;
      }
      this.counters.fetchedTransactions += 1;
      budget?.recordRequest("helius_http", "getTransaction", { statusCode: 200, relatedSignature: signature });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isDailyLimitText(msg)) {
        this.triggerDailyLimitShutdown(msg);
        budget?.recordRateLimit("helius_http", "getTransaction");
        return;
      }
      if (isRateLimitText(msg)) {
        this.counters.rpcRateLimitErrors += 1;
        this.maybeLogErrorSample("rpcRateLimit", msg, { signature });
        budget?.recordRateLimit("helius_http", "getTransaction");
      } else {
        this.counters.rpcFetchErrors += 1;
        this.maybeLogErrorSample("rpcFetch", msg, { signature });
        budget?.recordRequest("helius_http", "getTransaction", { statusCode: 500, reason: msg.slice(0, 100), relatedSignature: signature });
      }
      return;
    }

    const blockTime = (() => {
      if (txResult && typeof txResult === "object" && "blockTime" in txResult) {
        const v = (txResult as { blockTime?: unknown }).blockTime;
        return typeof v === "number" ? v : null;
      }
      return null;
    })();

    const rawLine: RawTransactionLine = {
      fetchedAt: new Date().toISOString(),
      signature,
      slot: slot ?? undefined,
      blockTime,
      transaction: txResult,
    };

    let parsed: ParsedPumpFunTransaction;
    try {
      parsed = this.cfg.parser.parse(rawLine);
    } catch (err) {
      this.counters.parseErrors += 1;
      this.maybeLogErrorSample("parse", err instanceof Error ? err.message : String(err), {
        signature,
      });
      return;
    }
    this.counters.parsedTransactions += 1;

    // Persist the signature so we skip it on restart
    budget?.markSignatureProcessed(signature, parsed.kind);

    if (parsed.kind === "UNKNOWN") {
      this.counters.unknownTransactions += 1;
      this.counters.ignoredTransactions += 1;
      return;
    }

    if (
      parsed.kind === "CREATE" &&
      (parsed.confidence === "HIGH" || parsed.confidence === "MEDIUM")
    ) {
      this.counters.createDetections += 1;
      this.lastCreateSignature = parsed.signature;
      const { creatorWallet, creatorExtractionReason } = extractCreatorWallet(
        parsed.candidateWallets,
        parsed.candidateMints,
        this.cfg.programId,
      );
      try {
        if (this.onCreate) {
          await this.onCreate({
            parsed,
            observedAt: new Date().toISOString(),
            receivedFromLog: { signature, slot },
            creatorWallet,
            creatorExtractionReason,
          });
        }
      } catch (err) {
        this.counters.unknownErrors += 1;
        this.maybeLogErrorSample(
          "unknown",
          err instanceof Error ? err.message : String(err),
          { signature: parsed.signature, where: "onCreate" },
        );
      }
      return;
    }

    this.counters.ignoredTransactions += 1;
  }

  private rpcGetTransaction(signature: string): Promise<JsonRpcResponse<unknown>> {
    return rpcCall<unknown>(
      this.cfg.httpUrl,
      "getTransaction",
      [
        signature,
        {
          encoding: "jsonParsed",
          maxSupportedTransactionVersion: 0,
          commitment: this.cfg.commitment,
        },
      ],
      this.cfg.rpcTimeoutMs,
      () => this.rpcRequestId++,
    );
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      const uptimeSec = Math.round((Date.now() - this.startedAt) / 1000);
      logger.info("live discovery heartbeat", {
        uptimeSec,
        counters: { ...this.counters },
        queueLength: this.pendingQueue.length,
        seenSignaturesSize: this.seenSignatures.size,
        lastSignature: this.lastSignature,
        lastCreateSignature: this.lastCreateSignature,
        subscriptionId: this.subscriptionId,
        reconnectAttempts: this.reconnectAttempts,
        rpcDailyLimitReached: this.rpcDailyLimitReached,
      });
    }, this.cfg.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private nextWsId(): number {
    return this.wsRequestId++;
  }

  private recordError(category: ErrorCategory, err: unknown, where: string): void {
    const msg = err instanceof Error ? err.message : String(err);
    if (isDailyLimitText(msg)) {
      this.triggerDailyLimitShutdown(msg);
      return;
    }
    switch (category) {
      case "websocket":
        this.counters.websocketErrors += 1;
        break;
      case "rpcFetch":
        this.counters.rpcFetchErrors += 1;
        break;
      case "rpcNull":
        this.counters.rpcNullTransaction += 1;
        break;
      case "rpcRateLimit":
        this.counters.rpcRateLimitErrors += 1;
        break;
      case "parse":
        this.counters.parseErrors += 1;
        break;
      case "unknown":
      default:
        this.counters.unknownErrors += 1;
        break;
    }
    this.maybeLogErrorSample(category, msg, { where });
  }

  private maybeLogErrorSample(
    category: ErrorCategory,
    message: string,
    meta?: Record<string, unknown>,
  ): void {
    const now = Date.now();
    if (now - this.lastErrorSampleAt < ERROR_SAMPLE_THROTTLE_MS) return;
    this.lastErrorSampleAt = now;
    const truncated = message.length > 200 ? message.slice(0, 200) + "…" : message;
    logger.warn("live discovery error sample", {
      category,
      message: truncated,
      ...(meta ?? {}),
      throttleMs: ERROR_SAMPLE_THROTTLE_MS,
    });
  }
}

function isRateLimitText(s: string): boolean {
  return /HTTP\s*429|rate[-_\s]?limit|too many requests/i.test(s);
}

// Detects fatal "daily request quota exhausted" responses from the RPC provider.
// These must NOT trigger reconnect — the next call would just hit the same wall.
function isDailyLimitText(s: string): boolean {
  if (!s) return false;
  if (/daily request limit reached/i.test(s)) return true;
  if (/upgrade your account/i.test(s)) return true;
  if (/HTTP\s*429/i.test(s) && /daily/i.test(s)) return true;
  return false;
}

// Cheap WS-notification pre-filter. Matches the canonical Pump.fun create
// instruction-log markers ONLY ("Instruction: Create" / "Instruction: CreateV2"),
// not lookalikes such as CreateAccount, CreateIdempotent, CreateTokenAccount,
// or CreateFeeSharingConfig.
const CREATE_MARKER_REGEX = /instruction:\s*create(v2)?(\b|$)/i;

function hasCreateMarkerInLogs(logs: string[]): boolean {
  for (const m of logs) {
    if (typeof m !== "string") continue;
    if (CREATE_MARKER_REGEX.test(m)) return true;
  }
  return false;
}

// Best-effort creator-wallet extraction. We never want to pick:
//   - the launched mint (often appears in candidateWallets via SetAuthority etc.)
//   - the Pump.fun program id itself
//   - any SPL/system/sysvar/compute program
//   - the Pump.fun fee program observed in real txs
const KNOWN_NON_CREATOR_PROGRAM_IDS: ReadonlySet<string> = new Set<string>([
  "11111111111111111111111111111111",                  // System
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",       // SPL Token
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",       // Token-2022
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",      // Associated Token Account
  "ComputeBudget111111111111111111111111111111",       // Compute Budget
  "SysvarRent111111111111111111111111111111111",       // Sysvar: Rent
  "SysvarC1ock11111111111111111111111111111111",       // Sysvar: Clock
  "Sysvar1nstructions1111111111111111111111111",       // Sysvar: Instructions
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",       // Memo
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",       // Pump.fun fee program
]);

export function extractCreatorWallet(
  candidateWallets: readonly string[],
  candidateMints: readonly string[],
  programId: string,
): { creatorWallet: string | null; creatorExtractionReason: string } {
  if (candidateWallets.length === 0) {
    return {
      creatorWallet: null,
      creatorExtractionReason: "no candidate wallets in parsed transaction",
    };
  }
  const denylist = new Set<string>(KNOWN_NON_CREATOR_PROGRAM_IDS);
  denylist.add(programId);
  for (const m of candidateMints) {
    if (typeof m === "string" && m.length > 0) denylist.add(m);
  }
  for (let i = 0; i < candidateWallets.length; i++) {
    const w = candidateWallets[i];
    if (typeof w !== "string" || w.length === 0) continue;
    if (denylist.has(w)) continue;
    return {
      creatorWallet: w,
      creatorExtractionReason:
        i === 0
          ? "first candidate wallet (likely fee-payer signer) survived mint+program denylist"
          : `candidate wallet at index ${i} survived mint+program denylist (earlier indices were mint or known program)`,
    };
  }
  return {
    creatorWallet: null,
    creatorExtractionReason: "all candidate wallets matched mint or known program denylist",
  };
}

async function rpcCall<T>(
  url: string,
  method: string,
  params: unknown,
  timeoutMs: number,
  getNextId: () => number,
): Promise<JsonRpcResponse<T>> {
  const body = { jsonrpc: "2.0", id: getNextId(), method, params };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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

function safeScheme(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol.replace(":", "");
  } catch {
    return "(unparseable)";
  }
}
