import * as fs from "fs";
import * as path from "path";
import WebSocket, { RawData } from "ws";
import { logger } from "../utils/logger";

export type SolanaCommitment = "processed" | "confirmed" | "finalized";

export interface SolanaLogListenerConfig {
  wsUrl: string;
  programId: string;
  maxEvents: number;
  outputPath: string;
  commitment?: SolanaCommitment;
  maxReconnectAttempts?: number;
  initialReconnectDelayMs?: number;
  maxReconnectDelayMs?: number;
}

export interface RawLogEvent {
  receivedAt: string;
  signature: string | null;
  logs: string[] | null;
  raw: unknown;
}

interface JsonRpcFrame {
  jsonrpc?: string;
  id?: number;
  result?: unknown;
  error?: { code?: number; message?: string };
  method?: string;
  params?: {
    subscription?: number;
    result?: {
      context?: { slot?: number };
      value?: { signature?: string; err?: unknown; logs?: string[] };
    };
  };
}

const DEFAULT_RECONNECT_ATTEMPTS = 3;
const DEFAULT_INITIAL_RECONNECT_DELAY_MS = 1_000;
const DEFAULT_MAX_RECONNECT_DELAY_MS = 30_000;

export class SolanaPumpFunLogListener {
  private ws: WebSocket | null = null;
  private subscriptionId: number | null = null;
  private requestId = 1;
  private eventsWritten = 0;
  private writeStream: fs.WriteStream | null = null;
  private reconnectAttempts = 0;
  private cleanShutdown = false;
  private resolveDone: (() => void) | null = null;
  private rejectDone: ((err: Error) => void) | null = null;

  constructor(private readonly cfg: SolanaLogListenerConfig) {}

  async start(): Promise<{ eventsWritten: number; outputPath: string }> {
    if (this.cfg.maxEvents <= 0) {
      throw new Error("maxEvents must be > 0");
    }
    if (!this.cfg.wsUrl) {
      throw new Error("wsUrl is required");
    }
    if (!this.cfg.programId) {
      throw new Error("programId is required");
    }

    this.ensureOutputDir();
    this.writeStream = fs.createWriteStream(this.cfg.outputPath, { flags: "a" });

    logger.info("solana log listener: starting", {
      wsScheme: safeScheme(this.cfg.wsUrl),
      programId: this.cfg.programId,
      maxEvents: this.cfg.maxEvents,
      outputPath: this.cfg.outputPath,
    });

    return new Promise<{ eventsWritten: number; outputPath: string }>((resolve, reject) => {
      this.resolveDone = () =>
        resolve({ eventsWritten: this.eventsWritten, outputPath: this.cfg.outputPath });
      this.rejectDone = reject;
      this.connect();
    });
  }

  async stop(): Promise<void> {
    this.cleanShutdown = true;
    try {
      this.unsubscribe();
    } catch {
      // ignore
    }
    try {
      this.ws?.close(1000, "stop requested");
    } catch {
      // ignore
    }
  }

  private connect(): void {
    const ws = new WebSocket(this.cfg.wsUrl);
    this.ws = ws;
    this.subscriptionId = null;

    ws.on("open", () => {
      logger.info("solana log listener: ws open — subscribing");
      this.reconnectAttempts = 0;
      this.subscribe();
    });

    ws.on("message", (data: RawData) => this.onMessage(data));

    ws.on("error", (err: Error) => {
      logger.error("solana log listener: ws error", { error: err.message });
    });

    ws.on("close", (code: number, reasonBuf: Buffer) => {
      const reason = reasonBuf.toString();
      logger.info("solana log listener: ws closed", { code, reason });
      if (this.cleanShutdown || this.eventsWritten >= this.cfg.maxEvents) {
        this.cleanup();
        this.resolveDone?.();
        return;
      }
      this.scheduleReconnect();
    });
  }

  private scheduleReconnect(): void {
    const max = this.cfg.maxReconnectAttempts ?? DEFAULT_RECONNECT_ATTEMPTS;
    if (this.reconnectAttempts >= max) {
      this.cleanup();
      this.rejectDone?.(
        new Error(`websocket failed after ${max} reconnect attempts`),
      );
      return;
    }
    const initial = this.cfg.initialReconnectDelayMs ?? DEFAULT_INITIAL_RECONNECT_DELAY_MS;
    const cap = this.cfg.maxReconnectDelayMs ?? DEFAULT_MAX_RECONNECT_DELAY_MS;
    const delay = Math.min(cap, initial * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    logger.info("solana log listener: reconnecting", {
      attempt: this.reconnectAttempts,
      delayMs: delay,
    });
    setTimeout(() => this.connect(), delay);
  }

  private subscribe(): void {
    const id = this.nextId();
    const req = {
      jsonrpc: "2.0",
      id,
      method: "logsSubscribe",
      params: [
        { mentions: [this.cfg.programId] },
        { commitment: this.cfg.commitment ?? "confirmed" },
      ],
    };
    this.ws?.send(JSON.stringify(req));
  }

  private unsubscribe(): void {
    if (this.subscriptionId == null || !this.ws) return;
    const id = this.nextId();
    const req = {
      jsonrpc: "2.0",
      id,
      method: "logsUnsubscribe",
      params: [this.subscriptionId],
    };
    try {
      this.ws.send(JSON.stringify(req));
    } catch {
      // socket may already be closing
    }
    this.subscriptionId = null;
  }

  private onMessage(data: RawData): void {
    let parsed: JsonRpcFrame;
    try {
      parsed = JSON.parse(data.toString()) as JsonRpcFrame;
    } catch {
      logger.warn("solana log listener: ignored unparseable frame");
      return;
    }

    if (parsed.error) {
      logger.error("solana log listener: rpc error frame", { error: parsed.error });
      return;
    }

    if (
      this.subscriptionId === null &&
      parsed.method === undefined &&
      typeof parsed.result === "number"
    ) {
      this.subscriptionId = parsed.result;
      logger.info("solana log listener: subscribed", {
        subscriptionId: this.subscriptionId,
      });
      return;
    }

    if (parsed.method === "logsNotification") {
      const value = parsed.params?.result?.value;
      const event: RawLogEvent = {
        receivedAt: new Date().toISOString(),
        signature: typeof value?.signature === "string" ? value.signature : null,
        logs: Array.isArray(value?.logs) ? (value!.logs as string[]) : null,
        raw: parsed,
      };
      this.writeEvent(event);
    }
  }

  private writeEvent(event: RawLogEvent): void {
    if (!this.writeStream) return;
    this.writeStream.write(JSON.stringify(event) + "\n");
    this.eventsWritten += 1;
    logger.info("solana log listener: event saved", {
      eventNumber: this.eventsWritten,
      maxEvents: this.cfg.maxEvents,
      signature: event.signature,
      logCount: event.logs?.length ?? 0,
    });
    if (this.eventsWritten >= this.cfg.maxEvents) {
      this.shutdownAfterMax();
    }
  }

  private shutdownAfterMax(): void {
    logger.info("solana log listener: max events reached, closing", {
      eventsWritten: this.eventsWritten,
    });
    this.cleanShutdown = true;
    this.unsubscribe();
    setTimeout(() => {
      try {
        this.ws?.close(1000, "max events reached");
      } catch {
        // ignore
      }
    }, 100);
  }

  private cleanup(): void {
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
    }
  }

  private ensureOutputDir(): void {
    const dir = path.dirname(this.cfg.outputPath);
    if (dir && !fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
      logger.info("solana log listener: created output directory", { dir });
    }
  }

  private nextId(): number {
    return this.requestId++;
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
