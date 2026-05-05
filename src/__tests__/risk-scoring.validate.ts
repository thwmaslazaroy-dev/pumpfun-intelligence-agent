import { strict as assert } from "node:assert";
import {
  CreatorLaunchHistory,
  CreatorProfile,
  TokenLaunch,
} from "../types";
import { TokenRiskFlagService } from "../services";
import {
  CombinedScoringService,
  CreatorScoringService,
  RiskScoringService,
} from "../scoring";

const baseToken = (overrides: Partial<TokenLaunch>): TokenLaunch => ({
  mint: "TestMint",
  name: "Test Token",
  symbol: "TST",
  creatorWallet: "TestCreator",
  launchedAt: new Date(Date.now() - 5 * 60_000),
  initialMarketCapUsd: 5_000,
  bondingCurveProgress: 5,
  buyCount: 25,
  sellCount: 5,
  volumeUsd: 1_000,
  socialLinks: { twitter: "https://x.com/tst" },
  ...overrides,
});

const flagService = new TokenRiskFlagService();
const scoringService = new RiskScoringService();
const creatorScoringService = new CreatorScoringService();
const combinedScoringService = new CombinedScoringService();

const dayMs = 24 * 60 * 60 * 1000;
const daysAgo = (n: number) => new Date(Date.now() - n * dayMs);

const profile = (
  wallet: string,
  totalLaunches: number,
  lastSeenDaysAgo: number,
): CreatorProfile => ({
  creatorWallet: wallet,
  firstSeenAt: daysAgo(120),
  lastSeenAt: daysAgo(lastSeenDaysAgo),
  totalLaunches,
});

const histEntry = (
  wallet: string,
  i: number,
  overrides: Partial<CreatorLaunchHistory>,
): CreatorLaunchHistory => ({
  creatorWallet: wallet,
  mint: `${wallet}-mint-${i}`,
  symbol: `T${i}`,
  launchedAt: daysAgo(60 - i * 5),
  initialMarketCapUsd: 5_000,
  ...overrides,
});

let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${name}`);
    console.error(err instanceof Error ? err.message : String(err));
  }
}

check("normal token scores higher than suspicious token", () => {
  const normal = baseToken({
    mint: "Normal",
    initialMarketCapUsd: 6_500,
    volumeUsd: 4_000,
    buyCount: 38,
    sellCount: 9,
    bondingCurveProgress: 12,
    socialLinks: {
      website: "https://x.example",
      twitter: "https://x.com/x",
      telegram: "https://t.me/x",
    },
  });
  const suspicious = baseToken({
    mint: "Suspicious",
    launchedAt: new Date(Date.now() - 2 * 60_000),
    initialMarketCapUsd: 4_200,
    volumeUsd: 184_000,
    buyCount: 612,
    sellCount: 587,
    bondingCurveProgress: 79,
    socialLinks: { twitter: "https://x.com/sus" },
  });

  const normalScore = scoringService.score(normal, flagService.evaluate(normal));
  const susScore = scoringService.score(suspicious, flagService.evaluate(suspicious));

  assert.ok(
    normalScore.totalScore > susScore.totalScore,
    `expected normal (${normalScore.totalScore}) > suspicious (${susScore.totalScore})`,
  );
  assert.equal(normalScore.riskLevel, "LOW");
  assert.ok(
    ["HIGH", "EXTREME"].includes(susScore.riskLevel),
    `expected suspicious riskLevel HIGH or EXTREME, got ${susScore.riskLevel}`,
  );
});

check("token with no socials triggers missingSocials", () => {
  const noSocials = baseToken({ mint: "NoSocials", socialLinks: undefined });
  const flags = flagService.evaluate(noSocials);
  assert.equal(flags.missingSocials, true);
  assert.ok(
    flags.reasons.some((r) => r.startsWith("missingSocials")),
    "expected missingSocials reason",
  );
});

check("suspicious volume/marketCap ratio triggers suspiciousVolumeToMarketCap", () => {
  const susVol = baseToken({
    mint: "SusVol",
    initialMarketCapUsd: 4_000,
    volumeUsd: 80_000, // 20x ratio
  });
  const flags = flagService.evaluate(susVol);
  assert.equal(flags.suspiciousVolumeToMarketCap, true);
  assert.ok(
    flags.reasons.some((r) => r.startsWith("suspiciousVolumeToMarketCap")),
    "expected suspiciousVolumeToMarketCap reason",
  );
});

check("suspiciousCreator stays false and is documented", () => {
  const flags = flagService.evaluate(baseToken({}));
  assert.equal(flags.suspiciousCreator, false);
  assert.ok(
    flags.reasons.some((r) => r.startsWith("suspiciousCreator")),
    "expected suspiciousCreator stub reason",
  );
});

check("clean token scores 100 and is LOW", () => {
  const clean = baseToken({
    mint: "Clean",
    initialMarketCapUsd: 7_000,
    volumeUsd: 2_000,
    buyCount: 25,
    sellCount: 5,
    bondingCurveProgress: 10,
    socialLinks: {
      website: "https://example.com",
      twitter: "https://x.com/x",
      telegram: "https://t.me/x",
    },
  });
  const score = scoringService.score(clean, flagService.evaluate(clean));
  assert.equal(score.totalScore, 100);
  assert.equal(score.riskLevel, "LOW");
});

check("score is clamped to 0..100", () => {
  const worst = baseToken({
    mint: "Worst",
    launchedAt: new Date(Date.now() - 1 * 60_000),
    initialMarketCapUsd: 1_000,
    volumeUsd: 999_999,
    buyCount: 500,
    sellCount: 500,
    bondingCurveProgress: 95,
    socialLinks: undefined,
  });
  const score = scoringService.score(worst, flagService.evaluate(worst));
  assert.ok(score.totalScore >= 0 && score.totalScore <= 100);
  assert.ok(score.microstructureScore >= 0 && score.microstructureScore <= 100);
  assert.ok(score.socialScore >= 0 && score.socialScore <= 100);
  assert.ok(score.anomalyScore >= 0 && score.anomalyScore <= 100);
});

check("strong creator scores higher than rug creator", () => {
  const strongWallet = "StrongTest";
  const strongHistory: CreatorLaunchHistory[] = [
    histEntry(strongWallet, 1, { maxGainMultiple: 12, timeToPeakMinutes: 30 }),
    histEntry(strongWallet, 2, { maxGainMultiple: 8, timeToPeakMinutes: 20 }),
    histEntry(strongWallet, 3, { maxGainMultiple: 5, timeToPeakMinutes: 18 }),
    histEntry(strongWallet, 4, { maxGainMultiple: 10, timeToPeakMinutes: 25 }),
  ];
  const rugWallet = "RugTest";
  const rugHistory: CreatorLaunchHistory[] = [
    histEntry(rugWallet, 1, { maxGainMultiple: 0.3, rugLike: true, endedBadly: true }),
    histEntry(rugWallet, 2, { maxGainMultiple: 0.5, rugLike: true, endedBadly: true }),
    histEntry(rugWallet, 3, { maxGainMultiple: 0.4, rugLike: true, endedBadly: true }),
  ];

  const strongScore = creatorScoringService.score(profile(strongWallet, 4, 5), strongHistory);
  const rugScore = creatorScoringService.score(profile(rugWallet, 3, 5), rugHistory);

  assert.ok(
    strongScore.totalScore > rugScore.totalScore,
    `expected strong (${strongScore.totalScore}) > rug (${rugScore.totalScore})`,
  );
  assert.equal(rugScore.riskLevel, "EXTREME");
});

check("unknown creator gets confidenceScore = 0", () => {
  const unknownProfile: CreatorProfile = {
    creatorWallet: "UnknownTest",
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    totalLaunches: 1,
  };
  const score = creatorScoringService.score(unknownProfile, []);
  assert.equal(score.confidenceScore, 0);
  assert.ok(
    score.reasons.some((r) => r.includes("no on-chain launch history")),
    "expected provisional reason",
  );
});

check("combined caps at 50 when creator is EXTREME", () => {
  const token: TokenLaunch = baseToken({ mint: "CapToken", symbol: "CAP" });
  const tokenScore = scoringService.score(token, flagService.evaluate(token));
  assert.equal(tokenScore.riskLevel, "LOW");

  const rugWallet = "RugCap";
  const rugHistory: CreatorLaunchHistory[] = [
    histEntry(rugWallet, 1, { maxGainMultiple: 0.3, rugLike: true, endedBadly: true }),
    histEntry(rugWallet, 2, { maxGainMultiple: 0.4, rugLike: true, endedBadly: true }),
    histEntry(rugWallet, 3, { maxGainMultiple: 0.5, rugLike: true, endedBadly: true }),
  ];
  const creatorScore = creatorScoringService.score(profile(rugWallet, 3, 5), rugHistory);
  assert.equal(creatorScore.riskLevel, "EXTREME");

  const combined = combinedScoringService.combine(token, tokenScore, creatorScore);
  assert.ok(
    combined.combinedScore <= 50,
    `expected combined <= 50, got ${combined.combinedScore}`,
  );
});

check("combined caps at 45 when token is EXTREME", () => {
  const token: TokenLaunch = baseToken({
    mint: "ExtremeToken",
    symbol: "EXT",
    launchedAt: new Date(Date.now() - 1 * 60_000),
    initialMarketCapUsd: 1_000,
    volumeUsd: 999_999,
    buyCount: 500,
    sellCount: 500,
    bondingCurveProgress: 95,
    socialLinks: undefined,
  });
  const tokenScore = scoringService.score(token, flagService.evaluate(token));
  assert.equal(tokenScore.riskLevel, "EXTREME");

  const strongWallet = "StrongCap";
  const strongHistory: CreatorLaunchHistory[] = [
    histEntry(strongWallet, 1, { maxGainMultiple: 12 }),
    histEntry(strongWallet, 2, { maxGainMultiple: 8 }),
    histEntry(strongWallet, 3, { maxGainMultiple: 5 }),
    histEntry(strongWallet, 4, { maxGainMultiple: 10 }),
  ];
  const creatorScore = creatorScoringService.score(profile(strongWallet, 4, 5), strongHistory);

  const combined = combinedScoringService.combine(token, tokenScore, creatorScore);
  assert.ok(
    combined.combinedScore <= 45,
    `expected combined <= 45 (token EXTREME), got ${combined.combinedScore}`,
  );
});

check("unknown-creator confidence penalty subtracts from clean token", () => {
  const token: TokenLaunch = baseToken({ mint: "CleanForUnknown", symbol: "CFU" });
  const tokenScore = scoringService.score(token, flagService.evaluate(token));

  const unknownProfile: CreatorProfile = {
    creatorWallet: "UnknownCombined",
    firstSeenAt: new Date(),
    lastSeenAt: new Date(),
    totalLaunches: 1,
  };
  const creatorScore = creatorScoringService.score(unknownProfile, []);

  const combined = combinedScoringService.combine(token, tokenScore, creatorScore);

  const baseline = 0.6 * tokenScore.totalScore + 0.4 * creatorScore.totalScore;
  assert.ok(
    combined.combinedScore < baseline,
    `expected penalty applied (combined=${combined.combinedScore} < baseline=${baseline})`,
  );
  assert.ok(
    combined.reasons.some((r) => r.includes("confidence penalty")),
    "expected confidence-penalty reason",
  );
});

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall risk-scoring checks passed");
