export interface TokenSocialLinks {
  website?: string;
  twitter?: string;
  telegram?: string;
  instagram?: string;
  discord?: string;
}

export interface TokenLaunch {
  mint: string;
  name: string;
  symbol: string;
  creatorWallet: string;
  launchedAt: Date;
  initialMarketCapUsd: number;
  bondingCurveProgress: number;
  buyCount: number;
  sellCount: number;
  volumeUsd: number;
  socialLinks?: TokenSocialLinks;
}

export interface TokenMarketSnapshot {
  mint: string;
  capturedAt: Date;
  priceUsd: number;
  marketCapUsd: number;
  bondingCurveProgress: number;
  buyCount: number;
  sellCount: number;
  volumeUsd: number;
}

export interface TokenRiskFlags {
  mint: string;
  evaluatedAt: Date;
  missingSocials: boolean;
  highChurn: boolean;
  suspiciousVolumeToMarketCap: boolean;
  earlyBondingCurveSpike: boolean;
  lowActivity: boolean;
  suspiciousCreator: boolean;
  reasons: string[];
}

export type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "EXTREME";

export type AlertType = "opportunity" | "warning" | "momentum";

export type PumpFunTransactionKind = "CREATE" | "BUY" | "SELL" | "ATA_CREATE" | "UNKNOWN";

export type ParseConfidence = "LOW" | "MEDIUM" | "HIGH";

export interface CandidateTokenReference {
  mint: string;
  owner?: string;
  source: "preTokenBalances" | "postTokenBalances" | "instructionInfo";
}

export interface ParsedPumpFunTransaction {
  signature: string;
  slot: number | null;
  blockTime: number | null;
  kind: PumpFunTransactionKind;
  confidence: ParseConfidence;
  candidateMints: string[];
  candidateWallets: string[];
  involvedPrograms: string[];
  pumpfunProgramSeen: boolean;
  logMessages: string[];
  reasons: string[];
  rawSource?: { fetchedAt?: string; signature: string };
}

export interface TokenScore {
  mint: string;
  totalScore: number;
  riskLevel: RiskLevel;
  microstructureScore: number;
  socialScore: number;
  anomalyScore: number;
  reasons: string[];
  computedAt: Date;
}

export interface TokenAnalysis {
  token: TokenLaunch;
  flags: TokenRiskFlags | null;
  score: TokenScore | null;
}

export interface SocialSignal {
  source: "x" | "instagram" | "other";
  reference: string;
  authorHandle?: string;
  followerCount?: number;
  postedAt: Date;
  matchedTerm: string;
  rawSnippet?: string;
}

export interface AlertPayload {
  mint: string;
  title: string;
  body: string;
  score: TokenScore;
  links?: string[];
}

export interface PumpFunProvider {
  fetchRecentLaunches(): Promise<TokenLaunch[]>;
}

export interface SocialSignalProvider {
  fetchSignalsForToken(token: TokenLaunch): Promise<SocialSignal[]>;
}

export interface AlertService {
  send(alert: AlertPayload): Promise<void>;
}

export interface TokenRepository {
  saveTokenLaunch(token: TokenLaunch): Promise<void>;
  findTokenByMint(mint: string): Promise<TokenLaunch | null>;
  saveMarketSnapshot(snapshot: TokenMarketSnapshot): Promise<void>;
  saveRiskFlags(mint: string, flags: TokenRiskFlags): Promise<void>;
  saveTokenScore(score: TokenScore): Promise<void>;
  getTokenAnalysis(mint: string): Promise<TokenAnalysis | null>;
  listRecentTokens(limit: number): Promise<TokenLaunch[]>;
  recordAlertSent(mint: string, alertType: AlertType, sentAt: Date): Promise<void>;
  hasAlertBeenSent(mint: string, alertType: AlertType): Promise<boolean>;
}

export interface CreatorProfile {
  creatorWallet: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
  totalLaunches: number;
  notes?: string;
}

export interface CreatorLaunchHistory {
  creatorWallet: string;
  mint: string;
  symbol: string;
  launchedAt: Date;
  initialMarketCapUsd: number;
  peakMarketCapUsd?: number;
  maxGainMultiple?: number;
  timeToPeakMinutes?: number;
  endedBadly?: boolean;
  rugLike?: boolean;
}

export interface CreatorPerformanceStats {
  creatorWallet: string;
  totalLaunches: number;
  successfulLaunches: number;
  failedLaunches: number;
  successRate: number;
  averageMaxGain: number;
  medianMaxGain: number;
  rugLikeCount: number;
  averageTimeToPeakMinutes?: number;
}

export interface CreatorScore {
  creatorWallet: string;
  totalScore: number;
  riskLevel: RiskLevel;
  successRateScore: number;
  consistencyScore: number;
  rugRiskScore: number;
  activityScore: number;
  confidenceScore: number;
  reasons: string[];
  scoredAt: Date;
}

export interface CombinedTokenEvaluation {
  mint: string;
  symbol: string;
  tokenScore: number;
  creatorScore: number;
  combinedScore: number;
  combinedRiskLevel: RiskLevel;
  reasons: string[];
  evaluatedAt: Date;
}

export interface TokenOutcome {
  mint: string;
  observedAt: Date;
  usdPrice: number | null;
  swapCount: number | null;
  firstSwapType: string | null;
  firstSwapExchange: string | null;
  rawSourceProvider: string;
  createdAt: Date;
}

export interface TokenOutcomeRepository {
  saveOutcome(outcome: TokenOutcome): Promise<void>;
  listOutcomesByMint(mint: string): Promise<TokenOutcome[]>;
  getLatestOutcome(mint: string): Promise<TokenOutcome | null>;
}

export interface CreatorRepository {
  upsertCreatorProfile(profile: CreatorProfile): Promise<void>;
  findCreatorProfile(creatorWallet: string): Promise<CreatorProfile | null>;
  saveCreatorLaunchHistory(history: CreatorLaunchHistory): Promise<void>;
  listLaunchHistoryByCreator(creatorWallet: string): Promise<CreatorLaunchHistory[]>;
  saveCreatorScore(score: CreatorScore): Promise<void>;
  getCreatorScore(creatorWallet: string): Promise<CreatorScore | null>;
  saveCombinedEvaluation(evaluation: CombinedTokenEvaluation): Promise<void>;
  getCombinedEvaluation(mint: string): Promise<CombinedTokenEvaluation | null>;
}
