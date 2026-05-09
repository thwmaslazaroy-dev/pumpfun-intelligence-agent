import type Database from "better-sqlite3";
import { getDatabase } from "./database";
import { MomentumSnapshot } from "../scoring/momentum-detection-service";

interface MomentumRow {
  id: number;
  mint: string;
  captured_at: number;
  bonding_curve_progress: number;
  buy_count: number;
  sell_count: number;
  volume_usd: number;
  market_cap_usd: number;
}

function rowToSnapshot(row: MomentumRow): MomentumSnapshot {
  return {
    mint: row.mint,
    capturedAt: new Date(row.captured_at),
    bondingCurveProgress: row.bonding_curve_progress,
    buyCount: row.buy_count,
    sellCount: row.sell_count,
    volumeUsd: row.volume_usd,
    marketCapUsd: row.market_cap_usd,
  };
}

export class MomentumRepository {
  private readonly db: Database.Database;

  constructor(db?: Database.Database) {
    this.db = db ?? getDatabase();
  }

  save(snapshot: MomentumSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO momentum_snapshots
          (mint, captured_at, bonding_curve_progress, buy_count, sell_count, volume_usd, market_cap_usd)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        snapshot.mint,
        snapshot.capturedAt.getTime(),
        snapshot.bondingCurveProgress,
        snapshot.buyCount,
        snapshot.sellCount,
        snapshot.volumeUsd,
        snapshot.marketCapUsd,
      );
  }

  getLastTwo(mint: string): [MomentumSnapshot, MomentumSnapshot] | null {
    const rows = this.db
      .prepare(
        "SELECT * FROM momentum_snapshots WHERE mint = ? ORDER BY captured_at DESC LIMIT 2",
      )
      .all(mint) as MomentumRow[];

    if (rows.length < 2) return null;
    // rows[0] is newer, rows[1] is older
    return [rowToSnapshot(rows[1]), rowToSnapshot(rows[0])];
  }

  pruneOlderThan(cutoffMs: number): number {
    const result = this.db
      .prepare("DELETE FROM momentum_snapshots WHERE captured_at < ?")
      .run(cutoffMs);
    return result.changes;
  }
}
