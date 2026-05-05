import type Database from "better-sqlite3";
import { getDatabase } from "./database";
import { TokenOutcome, TokenOutcomeRepository } from "../types";

interface OutcomeRow {
  id: number;
  mint: string;
  observed_at: number;
  usd_price: number | null;
  swap_count: number | null;
  first_swap_type: string | null;
  first_swap_exchange: string | null;
  raw_source_provider: string;
  created_at: number;
}

function rowToOutcome(row: OutcomeRow): TokenOutcome {
  return {
    mint: row.mint,
    observedAt: new Date(row.observed_at),
    usdPrice: row.usd_price,
    swapCount: row.swap_count,
    firstSwapType: row.first_swap_type,
    firstSwapExchange: row.first_swap_exchange,
    rawSourceProvider: row.raw_source_provider,
    createdAt: new Date(row.created_at),
  };
}

export class SqliteTokenOutcomeRepository implements TokenOutcomeRepository {
  private readonly db: Database.Database;

  constructor(db?: Database.Database) {
    this.db = db ?? getDatabase();
  }

  async saveOutcome(o: TokenOutcome): Promise<void> {
    this.db
      .prepare(
        `INSERT INTO token_outcomes (
          mint, observed_at, usd_price, swap_count,
          first_swap_type, first_swap_exchange, raw_source_provider, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.mint,
        o.observedAt.getTime(),
        o.usdPrice,
        o.swapCount,
        o.firstSwapType,
        o.firstSwapExchange,
        o.rawSourceProvider,
        o.createdAt.getTime(),
      );
  }

  async listOutcomesByMint(mint: string): Promise<TokenOutcome[]> {
    const rows = this.db
      .prepare("SELECT * FROM token_outcomes WHERE mint = ? ORDER BY observed_at ASC")
      .all(mint) as OutcomeRow[];
    return rows.map(rowToOutcome);
  }

  async getLatestOutcome(mint: string): Promise<TokenOutcome | null> {
    const row = this.db
      .prepare(
        "SELECT * FROM token_outcomes WHERE mint = ? ORDER BY observed_at DESC LIMIT 1",
      )
      .get(mint) as OutcomeRow | undefined;
    return row ? rowToOutcome(row) : null;
  }
}
