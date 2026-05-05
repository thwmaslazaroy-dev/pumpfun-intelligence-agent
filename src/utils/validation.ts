import { TokenLaunch } from "../types";

export class ValidationError extends Error {
  constructor(message: string, public readonly field?: string) {
    super(message);
    this.name = "ValidationError";
  }
}

function nonEmpty(value: unknown, field: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError(`${field} cannot be empty`, field);
  }
}

function nonNegative(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(`${field} cannot be negative`, field);
  }
}

export function validateTokenLaunch(token: TokenLaunch): void {
  nonEmpty(token.mint, "mint");
  nonEmpty(token.name, "name");
  nonEmpty(token.symbol, "symbol");
  nonEmpty(token.creatorWallet, "creatorWallet");

  nonNegative(token.initialMarketCapUsd, "initialMarketCapUsd");
  nonNegative(token.buyCount, "buyCount");
  nonNegative(token.sellCount, "sellCount");
  nonNegative(token.volumeUsd, "volumeUsd");

  if (
    typeof token.bondingCurveProgress !== "number" ||
    !Number.isFinite(token.bondingCurveProgress) ||
    token.bondingCurveProgress < 0 ||
    token.bondingCurveProgress > 100
  ) {
    throw new ValidationError(
      "bondingCurveProgress must be between 0 and 100",
      "bondingCurveProgress",
    );
  }

  if (!(token.launchedAt instanceof Date) || Number.isNaN(token.launchedAt.getTime())) {
    throw new ValidationError("launchedAt must be a valid Date", "launchedAt");
  }
}
