import {
  CandidateTokenReference,
  ParseConfidence,
  ParsedPumpFunTransaction,
  PumpFunTransactionKind,
} from "../types";

export interface RawTransactionLine {
  fetchedAt?: string;
  signature: string;
  slot?: number;
  blockTime?: number | null;
  confirmationStatus?: string | null;
  signatureErr?: unknown;
  transaction?: unknown;
}

interface InstructionLike {
  programId?: string;
  program?: string;
  accounts?: unknown;
  parsed?: { type?: string; info?: Record<string, unknown> };
  data?: string;
}

interface AccountKeyLike {
  pubkey?: string;
  signer?: boolean;
  source?: string;
  writable?: boolean;
}

const INSTRUCTION_LOG_PATTERN = /Program log:\s*Instruction:\s*([A-Za-z][A-Za-z0-9_]*)/i;
const ATA_PROGRAM = "spl-associated-token-account";
const ATA_CREATE_TYPES = new Set(["create", "createIdempotent"]);
const KNOWN_WALLET_INFO_KEYS = ["wallet", "owner", "source", "authority", "fundingAccount"];

// Markers come in already lowercased by collectInstructionMarkers, so set keys
// are stored lowercase. Recognises both the original Pump.fun naming and the
// newer / aggregator-routed variants observed in real on-chain logs:
//   CreateV2, BuyExactSolIn, BuyExactInPumpFunV3, SellExactInPumpFunV3
const CREATE_INSTRUCTION_MARKERS = new Set(["create", "createv2"]);
const BUY_INSTRUCTION_MARKERS = new Set([
  "buy",
  "buyexactsolin",
  "buyexactinpumpfunv3",
]);
const SELL_INSTRUCTION_MARKERS = new Set([
  "sell",
  "sellexactinpumpfunv3",
]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function getProp<T = unknown>(obj: unknown, key: string): T | undefined {
  return isObject(obj) ? (obj[key] as T | undefined) : undefined;
}

function asArray<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}

export class PumpFunTransactionParser {
  constructor(private readonly programId: string) {
    if (!programId) throw new Error("PumpFunTransactionParser requires a non-empty programId");
  }

  parse(line: RawTransactionLine): ParsedPumpFunTransaction {
    const reasons: string[] = [];
    const tx = line.transaction;
    const rawSource = { fetchedAt: line.fetchedAt, signature: line.signature };

    if (!isObject(tx)) {
      return {
        signature: line.signature,
        slot: line.slot ?? null,
        blockTime: line.blockTime ?? null,
        kind: "UNKNOWN",
        confidence: "LOW",
        candidateMints: [],
        candidateWallets: [],
        involvedPrograms: [],
        pumpfunProgramSeen: false,
        logMessages: [],
        reasons: ["transaction body missing or null"],
        rawSource,
      };
    }

    const meta = getProp(tx, "meta");
    const txInner = getProp(tx, "transaction");
    const message = getProp(txInner, "message");

    const slot = asNumber(getProp(tx, "slot")) ?? line.slot ?? null;
    const blockTime = asNumber(getProp(tx, "blockTime")) ?? line.blockTime ?? null;

    const instructions = collectInstructions(tx);
    const logMessages = asArray<unknown>(getProp(meta, "logMessages"))
      .map(asString)
      .filter((s): s is string => typeof s === "string");

    const involvedPrograms = uniq(
      instructions
        .map((i) => i.programId)
        .filter((p): p is string => typeof p === "string"),
    );

    const programIdHits = instructions.filter((i) => i.programId === this.programId).length;
    const accountHits = instructions.filter((i) =>
      asArray<unknown>(i.accounts).some((a) => a === this.programId),
    ).length;
    const logHasProgram = logMessages.some((m) => m.includes(this.programId));
    const pumpfunProgramSeen = programIdHits > 0 || accountHits > 0 || logHasProgram;

    if (programIdHits > 0) {
      reasons.push(`pump.fun programId in ${programIdHits} instruction(s)`);
    }
    if (logHasProgram) {
      reasons.push("pump.fun programId mentioned in logMessages");
    }

    const candidates = collectCandidates(meta, instructions);
    const candidateMints = uniq(candidates.mints.map((c) => c.mint));
    const candidateWalletsFromAccountKeys = collectSignerWallets(message);
    const candidateWalletsFromInstructions = collectInstructionWallets(instructions);
    const candidateWallets = uniq([
      ...candidateWalletsFromAccountKeys,
      ...candidateWalletsFromInstructions,
    ]);

    const ataCreates = collectAtaCreates(instructions);
    if (ataCreates.length > 0) {
      reasons.push(`${ataCreates.length} ATA create instruction(s) observed`);
    }

    const instructionMarkers = collectInstructionMarkers(logMessages);
    if (instructionMarkers.length > 0) {
      reasons.push(`instruction-log markers: ${instructionMarkers.join(", ")}`);
    }

    const { kind, confidence, classificationReasons } = classify({
      pumpfunProgramSeen,
      instructionMarkers,
      candidateMints,
      ataCreatesPresent: ataCreates.length > 0,
    });
    reasons.push(...classificationReasons);

    return {
      signature: line.signature,
      slot,
      blockTime,
      kind,
      confidence,
      candidateMints,
      candidateWallets,
      involvedPrograms,
      pumpfunProgramSeen,
      logMessages,
      reasons,
      rawSource,
    };
  }
}

function collectInstructions(tx: unknown): InstructionLike[] {
  const out: InstructionLike[] = [];
  const message = getProp(getProp(tx, "transaction"), "message");
  for (const ix of asArray<InstructionLike>(getProp(message, "instructions"))) {
    out.push(ix);
  }
  const meta = getProp(tx, "meta");
  for (const group of asArray<{ instructions?: InstructionLike[] }>(
    getProp(meta, "innerInstructions"),
  )) {
    for (const ix of asArray<InstructionLike>(group.instructions)) {
      out.push(ix);
    }
  }
  return out;
}

function collectCandidates(
  meta: unknown,
  instructions: InstructionLike[],
): { mints: CandidateTokenReference[] } {
  const mints: CandidateTokenReference[] = [];

  for (const source of ["preTokenBalances", "postTokenBalances"] as const) {
    for (const b of asArray<{ mint?: unknown; owner?: unknown }>(getProp(meta, source))) {
      const mint = asString(b.mint);
      if (!mint) continue;
      mints.push({ mint, owner: asString(b.owner), source });
    }
  }
  for (const ix of instructions) {
    const info = ix.parsed?.info ?? {};
    const mint = asString(info["mint"]);
    if (!mint) continue;
    const owner =
      asString(info["wallet"]) ??
      asString(info["owner"]) ??
      asString(info["authority"]) ??
      undefined;
    mints.push({ mint, owner, source: "instructionInfo" });
  }
  return { mints };
}

function collectSignerWallets(message: unknown): string[] {
  return asArray<AccountKeyLike>(getProp(message, "accountKeys"))
    .filter((k) => k.signer === true)
    .map((k) => asString(k.pubkey))
    .filter((s): s is string => typeof s === "string");
}

function collectInstructionWallets(instructions: InstructionLike[]): string[] {
  const out: string[] = [];
  for (const ix of instructions) {
    const info = ix.parsed?.info ?? {};
    for (const key of KNOWN_WALLET_INFO_KEYS) {
      const v = asString(info[key]);
      if (v) out.push(v);
    }
  }
  return out;
}

function collectAtaCreates(
  instructions: InstructionLike[],
): Array<{ mint?: string; wallet?: string }> {
  const out: Array<{ mint?: string; wallet?: string }> = [];
  for (const ix of instructions) {
    if (ix.program !== ATA_PROGRAM) continue;
    const type = ix.parsed?.type;
    if (!type || !ATA_CREATE_TYPES.has(type)) continue;
    const info = ix.parsed?.info ?? {};
    out.push({
      mint: asString(info["mint"]),
      wallet: asString(info["wallet"]) ?? asString(info["owner"]) ?? asString(info["source"]),
    });
  }
  return out;
}

function collectInstructionMarkers(logMessages: string[]): string[] {
  const names: string[] = [];
  for (const m of logMessages) {
    const match = m.match(INSTRUCTION_LOG_PATTERN);
    if (match) names.push(match[1].toLowerCase());
  }
  return names;
}

interface ClassifyInput {
  pumpfunProgramSeen: boolean;
  instructionMarkers: string[];
  candidateMints: string[];
  ataCreatesPresent: boolean;
}

interface ClassifyResult {
  kind: PumpFunTransactionKind;
  confidence: ParseConfidence;
  classificationReasons: string[];
}

function classify(input: ClassifyInput): ClassifyResult {
  const reasons: string[] = [];
  const hasCreateMarker = input.instructionMarkers.some((n) =>
    CREATE_INSTRUCTION_MARKERS.has(n),
  );
  const hasBuyMarker = input.instructionMarkers.some((n) =>
    BUY_INSTRUCTION_MARKERS.has(n),
  );
  const hasSellMarker = input.instructionMarkers.some((n) =>
    SELL_INSTRUCTION_MARKERS.has(n),
  );

  if (input.pumpfunProgramSeen && hasCreateMarker && input.candidateMints.length >= 1) {
    reasons.push("CREATE: pump.fun program present + 'Instruction: Create' marker + candidate mint observed");
    return { kind: "CREATE", confidence: "HIGH", classificationReasons: reasons };
  }
  if (input.pumpfunProgramSeen && hasBuyMarker) {
    reasons.push("BUY: pump.fun program present + 'Instruction: Buy' marker");
    return { kind: "BUY", confidence: "HIGH", classificationReasons: reasons };
  }
  if (input.pumpfunProgramSeen && hasSellMarker) {
    reasons.push("SELL: pump.fun program present + 'Instruction: Sell' marker");
    return { kind: "SELL", confidence: "HIGH", classificationReasons: reasons };
  }

  if (input.pumpfunProgramSeen && hasCreateMarker) {
    reasons.push("CREATE (medium): pump.fun program present + 'Instruction: Create' marker but no candidate mint extracted");
    return { kind: "CREATE", confidence: "MEDIUM", classificationReasons: reasons };
  }

  if (hasBuyMarker || hasSellMarker || hasCreateMarker) {
    const kind: PumpFunTransactionKind = hasCreateMarker ? "CREATE" : hasBuyMarker ? "BUY" : "SELL";
    reasons.push(`${kind} (low): instruction marker present but pump.fun program not detected — coincidence or unrelated program`);
    return { kind, confidence: "LOW", classificationReasons: reasons };
  }

  if (input.ataCreatesPresent && !input.pumpfunProgramSeen) {
    reasons.push("ATA_CREATE: associated-token-account create observed, no pump.fun program detected");
    return { kind: "ATA_CREATE", confidence: "MEDIUM", classificationReasons: reasons };
  }
  if (input.ataCreatesPresent) {
    reasons.push("ATA_CREATE (low): ATA create alongside pump.fun program but no buy/sell/create marker");
    return { kind: "ATA_CREATE", confidence: "LOW", classificationReasons: reasons };
  }

  reasons.push("UNKNOWN: no clear instruction marker observed; classifying conservatively as UNKNOWN");
  return { kind: "UNKNOWN", confidence: "LOW", classificationReasons: reasons };
}
