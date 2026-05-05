import { PumpFunProvider, TokenLaunch } from "../types";
import {
  MEDIOCRE_CREATOR_WALLET,
  RUG_CREATOR_WALLET,
  STRONG_CREATOR_WALLET,
  UNKNOWN_CREATOR_WALLET,
} from "./mock-creator-history";

const FIXED_NOW = () => new Date();

function minutesAgo(min: number): Date {
  return new Date(FIXED_NOW().getTime() - min * 60_000);
}

const NORMAL_TOKEN: TokenLaunch = {
  mint: "Mock1111NormalQualityTokenAaaaaaaaaaaaaaaa",
  name: "Sunny Coin",
  symbol: "SUN",
  creatorWallet: STRONG_CREATOR_WALLET,
  launchedAt: minutesAgo(7),
  initialMarketCapUsd: 6_500,
  bondingCurveProgress: 12.4,
  buyCount: 38,
  sellCount: 9,
  volumeUsd: 4_120.55,
  socialLinks: {
    website: "https://sunny.example",
    twitter: "https://x.com/sunnycoin",
    telegram: "https://t.me/sunnycoin",
  },
};

const SUSPICIOUS_TOKEN: TokenLaunch = {
  mint: "Mock2222SuspiciousHighVolumeTokenBbbbbbbbbb",
  name: "Moon Rocket Pro",
  symbol: "MRP",
  creatorWallet: RUG_CREATOR_WALLET,
  launchedAt: minutesAgo(2),
  initialMarketCapUsd: 4_200,
  bondingCurveProgress: 78.9,
  buyCount: 612,
  sellCount: 587,
  volumeUsd: 184_300.0,
  socialLinks: {
    twitter: "https://x.com/moon_rocket_pro_official",
  },
};

const NO_SOCIALS_TOKEN: TokenLaunch = {
  mint: "Mock3333NoSocialsAtAllTokenCcccccccccccccc",
  name: "Quiet Launch",
  symbol: "QL",
  creatorWallet: UNKNOWN_CREATOR_WALLET,
  launchedAt: minutesAgo(15),
  initialMarketCapUsd: 5_900,
  bondingCurveProgress: 3.1,
  buyCount: 5,
  sellCount: 1,
  volumeUsd: 220.4,
};

const MEDIUM_RISK_TOKEN: TokenLaunch = {
  mint: "Mock6666MediumRiskTokenFffffffffffffffffff",
  name: "Stealth Cat",
  symbol: "STC",
  creatorWallet: MEDIOCRE_CREATOR_WALLET,
  launchedAt: minutesAgo(20),
  initialMarketCapUsd: 8_200,
  bondingCurveProgress: 22.5,
  buyCount: 27,
  sellCount: 6,
  volumeUsd: 1_900.0,
};

const FRESH_TOKEN_A: TokenLaunch = {
  mint: "Mock4444FreshTokenADdddddddddddddddddddddd",
  name: "Pixel Dog",
  symbol: "PXD",
  creatorWallet: STRONG_CREATOR_WALLET,
  launchedAt: minutesAgo(1),
  initialMarketCapUsd: 5_100,
  bondingCurveProgress: 0.8,
  buyCount: 3,
  sellCount: 0,
  volumeUsd: 75.0,
  socialLinks: {
    twitter: "https://x.com/pixeldog",
  },
};

const FRESH_TOKEN_B: TokenLaunch = {
  mint: "Mock5555FreshTokenBEeeeeeeeeeeeeeeeeeeeeee",
  name: "Coffee Bean DAO",
  symbol: "CBD",
  creatorWallet: MEDIOCRE_CREATOR_WALLET,
  launchedAt: minutesAgo(4),
  initialMarketCapUsd: 7_300,
  bondingCurveProgress: 18.0,
  buyCount: 21,
  sellCount: 4,
  volumeUsd: 2_410.0,
  socialLinks: {
    website: "https://cbean.example",
    telegram: "https://t.me/cbean",
  },
};

const BATCHES: TokenLaunch[][] = [
  [NORMAL_TOKEN, MEDIUM_RISK_TOKEN, SUSPICIOUS_TOKEN, NO_SOCIALS_TOKEN, FRESH_TOKEN_A],
  [NORMAL_TOKEN, MEDIUM_RISK_TOKEN, SUSPICIOUS_TOKEN, FRESH_TOKEN_B],
  [FRESH_TOKEN_A, FRESH_TOKEN_B, NORMAL_TOKEN, MEDIUM_RISK_TOKEN, NO_SOCIALS_TOKEN, SUSPICIOUS_TOKEN],
];

export class MockPumpFunProvider implements PumpFunProvider {
  private callCount = 0;

  async fetchRecentLaunches(): Promise<TokenLaunch[]> {
    const batch = BATCHES[this.callCount % BATCHES.length];
    this.callCount += 1;
    return batch.map((t) => ({ ...t, launchedAt: new Date(t.launchedAt) }));
  }
}
