import { CreatorLaunchHistory, CreatorProfile, CreatorRepository } from "../types";
import { logger } from "../utils/logger";

export const STRONG_CREATOR_WALLET = "StrongCreator11111111111111111111111111111111";
export const MEDIOCRE_CREATOR_WALLET = "MediocreCreator2222222222222222222222222222222";
export const RUG_CREATOR_WALLET = "RugCreator333333333333333333333333333333333333";
export const UNKNOWN_CREATOR_WALLET = "UnknownCreator44444444444444444444444444444444";

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

interface SeedCreator {
  profile: CreatorProfile;
  history: CreatorLaunchHistory[];
}

const STRONG_CREATOR: SeedCreator = {
  profile: {
    creatorWallet: STRONG_CREATOR_WALLET,
    firstSeenAt: daysAgo(180),
    lastSeenAt: daysAgo(6),
    totalLaunches: 5,
    notes: "mock: consistent, successful creator",
  },
  history: [
    {
      creatorWallet: STRONG_CREATOR_WALLET,
      mint: "StrongHist1111111111111111111111111111111111",
      symbol: "STRONG1",
      launchedAt: daysAgo(180),
      initialMarketCapUsd: 5_000,
      peakMarketCapUsd: 60_000,
      maxGainMultiple: 12,
      timeToPeakMinutes: 35,
      endedBadly: false,
      rugLike: false,
    },
    {
      creatorWallet: STRONG_CREATOR_WALLET,
      mint: "StrongHist2222222222222222222222222222222222",
      symbol: "STRONG2",
      launchedAt: daysAgo(120),
      initialMarketCapUsd: 4_500,
      peakMarketCapUsd: 36_000,
      maxGainMultiple: 8,
      timeToPeakMinutes: 22,
      endedBadly: false,
      rugLike: false,
    },
    {
      creatorWallet: STRONG_CREATOR_WALLET,
      mint: "StrongHist3333333333333333333333333333333333",
      symbol: "STRONG3",
      launchedAt: daysAgo(85),
      initialMarketCapUsd: 6_000,
      peakMarketCapUsd: 30_000,
      maxGainMultiple: 5,
      timeToPeakMinutes: 18,
      endedBadly: false,
      rugLike: false,
    },
    {
      creatorWallet: STRONG_CREATOR_WALLET,
      mint: "StrongHist4444444444444444444444444444444444",
      symbol: "STRONG4",
      launchedAt: daysAgo(45),
      initialMarketCapUsd: 5_500,
      peakMarketCapUsd: 55_000,
      maxGainMultiple: 10,
      timeToPeakMinutes: 28,
      endedBadly: false,
      rugLike: false,
    },
    {
      creatorWallet: STRONG_CREATOR_WALLET,
      mint: "StrongHist5555555555555555555555555555555555",
      symbol: "STRONG5",
      launchedAt: daysAgo(6),
      initialMarketCapUsd: 7_000,
      peakMarketCapUsd: 42_000,
      maxGainMultiple: 6,
      timeToPeakMinutes: 14,
      endedBadly: false,
      rugLike: false,
    },
  ],
};

const MEDIOCRE_CREATOR: SeedCreator = {
  profile: {
    creatorWallet: MEDIOCRE_CREATOR_WALLET,
    firstSeenAt: daysAgo(70),
    lastSeenAt: daysAgo(20),
    totalLaunches: 3,
    notes: "mock: mixed performer",
  },
  history: [
    {
      creatorWallet: MEDIOCRE_CREATOR_WALLET,
      mint: "MediHist1111111111111111111111111111111111111",
      symbol: "MED1",
      launchedAt: daysAgo(70),
      initialMarketCapUsd: 5_500,
      peakMarketCapUsd: 8_250,
      maxGainMultiple: 1.5,
      timeToPeakMinutes: 45,
      endedBadly: false,
      rugLike: false,
    },
    {
      creatorWallet: MEDIOCRE_CREATOR_WALLET,
      mint: "MediHist2222222222222222222222222222222222222",
      symbol: "MED2",
      launchedAt: daysAgo(48),
      initialMarketCapUsd: 6_000,
      peakMarketCapUsd: 4_800,
      maxGainMultiple: 0.8,
      timeToPeakMinutes: 12,
      endedBadly: true,
      rugLike: false,
    },
    {
      creatorWallet: MEDIOCRE_CREATOR_WALLET,
      mint: "MediHist3333333333333333333333333333333333333",
      symbol: "MED3",
      launchedAt: daysAgo(20),
      initialMarketCapUsd: 4_800,
      peakMarketCapUsd: 10_560,
      maxGainMultiple: 2.2,
      timeToPeakMinutes: 60,
      endedBadly: false,
      rugLike: false,
    },
  ],
};

const RUG_CREATOR: SeedCreator = {
  profile: {
    creatorWallet: RUG_CREATOR_WALLET,
    firstSeenAt: daysAgo(95),
    lastSeenAt: daysAgo(8),
    totalLaunches: 4,
    notes: "mock: repeat rug-like behaviour",
  },
  history: [
    {
      creatorWallet: RUG_CREATOR_WALLET,
      mint: "RugHist111111111111111111111111111111111111111",
      symbol: "RUG1",
      launchedAt: daysAgo(95),
      initialMarketCapUsd: 4_000,
      peakMarketCapUsd: 1_200,
      maxGainMultiple: 0.3,
      timeToPeakMinutes: 5,
      endedBadly: true,
      rugLike: true,
    },
    {
      creatorWallet: RUG_CREATOR_WALLET,
      mint: "RugHist222222222222222222222222222222222222222",
      symbol: "RUG2",
      launchedAt: daysAgo(60),
      initialMarketCapUsd: 5_000,
      peakMarketCapUsd: 2_500,
      maxGainMultiple: 0.5,
      timeToPeakMinutes: 8,
      endedBadly: true,
      rugLike: true,
    },
    {
      creatorWallet: RUG_CREATOR_WALLET,
      mint: "RugHist333333333333333333333333333333333333333",
      symbol: "RUG3",
      launchedAt: daysAgo(30),
      initialMarketCapUsd: 4_500,
      peakMarketCapUsd: 1_800,
      maxGainMultiple: 0.4,
      timeToPeakMinutes: 3,
      endedBadly: true,
      rugLike: true,
    },
    {
      creatorWallet: RUG_CREATOR_WALLET,
      mint: "RugHist444444444444444444444444444444444444444",
      symbol: "RUG4",
      launchedAt: daysAgo(8),
      initialMarketCapUsd: 5_200,
      peakMarketCapUsd: 6_240,
      maxGainMultiple: 1.2,
      timeToPeakMinutes: 20,
      endedBadly: false,
      rugLike: false,
    },
  ],
};

const SEED: SeedCreator[] = [STRONG_CREATOR, MEDIOCRE_CREATOR, RUG_CREATOR];

export async function seedMockCreatorHistory(repo: CreatorRepository): Promise<void> {
  let profiles = 0;
  let histories = 0;
  for (const c of SEED) {
    await repo.upsertCreatorProfile(c.profile);
    profiles += 1;
    for (const h of c.history) {
      await repo.saveCreatorLaunchHistory(h);
      histories += 1;
    }
  }
  logger.info("mock creator history seeded", {
    profiles,
    histories,
    note: `unknown creator (${UNKNOWN_CREATOR_WALLET}) intentionally has no history`,
  });
}
