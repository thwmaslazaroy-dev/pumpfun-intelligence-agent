import { PumpFunProvider, TokenLaunch } from "../types";
import { LivePumpFunDiscovery, OnCreateEvent } from "./live-pumpfun-discovery";
import { logger } from "../utils/logger";

export interface LivePumpFunProviderOptions {
  maxBufferSize?: number;
}

const DEFAULT_MAX_BUFFER = 1_000;

export class LivePumpFunProvider implements PumpFunProvider {
  private readonly discovery: LivePumpFunDiscovery;
  private readonly maxBufferSize: number;
  private buffer: TokenLaunch[] = [];
  private started = false;
  private droppedDueToBufferOverflow = 0;

  constructor(discovery: LivePumpFunDiscovery, opts: LivePumpFunProviderOptions = {}) {
    this.discovery = discovery;
    this.maxBufferSize = opts.maxBufferSize ?? DEFAULT_MAX_BUFFER;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    void this.discovery.start({
      onCreate: (event) => this.handleCreateEvent(event),
    });
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.discovery.stop();
  }

  async fetchRecentLaunches(): Promise<TokenLaunch[]> {
    const drained = this.buffer;
    this.buffer = [];
    return drained;
  }

  private handleCreateEvent(event: OnCreateEvent): void {
    const launch = mapEventToTokenLaunch(event);
    if (!launch) return;

    this.buffer.push(launch);
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
      this.droppedDueToBufferOverflow += 1;
      logger.warn("live provider: buffer overflow, dropping oldest", {
        droppedTotal: this.droppedDueToBufferOverflow,
        maxBufferSize: this.maxBufferSize,
      });
    }
  }

}

function mapEventToTokenLaunch(event: OnCreateEvent): TokenLaunch | null {
  if (!event.creatorWallet) return null;
  const mint = pickPrimaryMint(event.parsed.candidateMints);
  if (!mint) return null;

  const launchedAt = blockTimeToDate(event.parsed.blockTime) ?? new Date(event.observedAt);

  return {
    mint,
    name: "Unknown",
    symbol: "UNKNOWN",
    creatorWallet: event.creatorWallet,
    launchedAt,
    initialMarketCapUsd: 0,
    bondingCurveProgress: 0,
    buyCount: 0,
    sellCount: 0,
    volumeUsd: 0,
    socialLinks: {},
  };
}

function pickPrimaryMint(candidates: readonly string[]): string | null {
  for (const m of candidates) {
    if (typeof m === "string" && m.length > 0) return m;
  }
  return null;
}

function blockTimeToDate(blockTime: number | null): Date | null {
  if (typeof blockTime !== "number" || !Number.isFinite(blockTime)) return null;
  return new Date(blockTime * 1000);
}
