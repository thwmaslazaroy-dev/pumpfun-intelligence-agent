export interface MomentumSnapshot {
  mint: string;
  capturedAt: Date;
  bondingCurveProgress: number;
  buyCount: number;
  sellCount: number;
  volumeUsd: number;
  marketCapUsd: number;
}

export interface MomentumThresholds {
  minBcVelocityPerMin: number;
  minBuyPressure: number;
  minNewBuys: number;
  maxSnapshotGapMinutes: number;
}

export const DEFAULT_MOMENTUM_THRESHOLDS: MomentumThresholds = {
  minBcVelocityPerMin: 0.02,
  minBuyPressure: 0.65,
  minNewBuys: 3,
  maxSnapshotGapMinutes: 5,
};

export interface MomentumSignals {
  bcVelocityPerMin: number;
  newBuys: number;
  newSells: number;
  buyPressure: number;
  volumeDeltaUsd: number;
  intervalMinutes: number;
  isMomentum: boolean;
  reasons: string[];
}

export class MomentumDetectionService {
  constructor(
    private readonly thresholds: MomentumThresholds = DEFAULT_MOMENTUM_THRESHOLDS,
  ) {}

  detect(older: MomentumSnapshot, newer: MomentumSnapshot): MomentumSignals {
    const intervalMs = newer.capturedAt.getTime() - older.capturedAt.getTime();
    const intervalMinutes = intervalMs / 60_000;

    if (intervalMinutes <= 0 || intervalMinutes > this.thresholds.maxSnapshotGapMinutes) {
      return {
        bcVelocityPerMin: 0,
        newBuys: 0,
        newSells: 0,
        buyPressure: 0,
        volumeDeltaUsd: 0,
        intervalMinutes,
        isMomentum: false,
        reasons: [`snapshot gap ${intervalMinutes.toFixed(1)}min out of valid range`],
      };
    }

    const bcDelta = newer.bondingCurveProgress - older.bondingCurveProgress;
    const bcVelocityPerMin = bcDelta / intervalMinutes;

    const newBuys = Math.max(0, newer.buyCount - older.buyCount);
    const newSells = Math.max(0, newer.sellCount - older.sellCount);
    const totalNew = newBuys + newSells;
    const buyPressure = totalNew > 0 ? newBuys / totalNew : 0;
    const volumeDeltaUsd = Math.max(0, newer.volumeUsd - older.volumeUsd);

    const meetsVelocity = bcVelocityPerMin >= this.thresholds.minBcVelocityPerMin;
    const meetsBuyPressure = buyPressure >= this.thresholds.minBuyPressure;
    const meetsMinBuys = newBuys >= this.thresholds.minNewBuys;

    const reasons: string[] = [];
    if (meetsVelocity)
      reasons.push(`bcVelocity=${(bcVelocityPerMin * 100).toFixed(2)}%/min`);
    if (meetsBuyPressure)
      reasons.push(`buyPressure=${(buyPressure * 100).toFixed(0)}%`);
    if (meetsMinBuys)
      reasons.push(`newBuys=${newBuys}`);

    return {
      bcVelocityPerMin,
      newBuys,
      newSells,
      buyPressure,
      volumeDeltaUsd,
      intervalMinutes,
      isMomentum: meetsVelocity && meetsBuyPressure && meetsMinBuys,
      reasons,
    };
  }
}
