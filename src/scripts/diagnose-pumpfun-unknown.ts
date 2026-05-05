import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { config } from "../config";
import { logger } from "../utils/logger";
import { logSanitizedEnvSummary } from "../utils/env-summary";
import {
  PumpFunTransactionParser,
  RawTransactionLine,
} from "../parsing/pumpfun-transaction-parser";

const INPUT_PATH = "./data/raw-pumpfun-transactions.jsonl";
const OUTPUT_PATH = "./data/unknown-pumpfun-diagnostics.jsonl";
const SAMPLE_LIMIT = 20;
const LOG_TRUNCATE = 20;
const EXAMPLE_LIMIT = 2;
const KEYWORDS = [
  "create",
  "initialize",
  "mint",
  "buy",
  "sell",
  "trade",
  "bonding",
  "curve",
] as const;

type Keyword = (typeof KEYWORDS)[number];

interface InstructionShape {
  programId?: string;
  program?: string;
  parsedType?: string;
}

interface UnknownDiagnostic {
  signature: string;
  slot: number | null;
  candidateMints: string[];
  involvedPrograms: string[];
  logMessagesFirst20: string[];
  instructionProgramIds: string[];
  parsedInstructionTypes: string[];
  keywordHits: Record<Keyword, boolean>;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}
function asArray<T = unknown>(v: unknown): T[] {
  return Array.isArray(v) ? (v as T[]) : [];
}
function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function getProp<T = unknown>(obj: unknown, key: string): T | undefined {
  return isObject(obj) ? (obj[key] as T | undefined) : undefined;
}

function collectInstructionShapes(tx: unknown): InstructionShape[] {
  const out: InstructionShape[] = [];
  const message = getProp(getProp(tx, "transaction"), "message");
  for (const ix of asArray<Record<string, unknown>>(getProp(message, "instructions"))) {
    out.push({
      programId: asString(ix.programId),
      program: asString(ix.program),
      parsedType: asString(getProp(ix.parsed, "type")),
    });
  }
  const meta = getProp(tx, "meta");
  for (const group of asArray<{ instructions?: unknown }>(
    getProp(meta, "innerInstructions"),
  )) {
    for (const ix of asArray<Record<string, unknown>>(group.instructions)) {
      out.push({
        programId: asString(ix.programId),
        program: asString(ix.program),
        parsedType: asString(getProp(ix.parsed, "type")),
      });
    }
  }
  return out;
}

function ensureOutputDir(file: string): void {
  const dir = path.dirname(file);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function main(): Promise<void> {
  logSanitizedEnvSummary({ context: "diagnose:pumpfun:unknown" });

  if (!config.pumpfunProgramId) {
    logger.error(
      "PUMPFUN_PROGRAM_ID is not set in .env — required to detect pump.fun involvement",
    );
    process.exit(1);
  }
  if (!fs.existsSync(INPUT_PATH)) {
    logger.error("input file missing", {
      path: INPUT_PATH,
      hint: "run 'npm run fetch:pumpfun:txs' first to populate it",
    });
    process.exit(1);
  }

  ensureOutputDir(OUTPUT_PATH);
  const parser = new PumpFunTransactionParser(config.pumpfunProgramId);
  const out = fs.createWriteStream(OUTPUT_PATH, { flags: "w" });

  const keywordCounts: Record<Keyword, number> = Object.fromEntries(
    KEYWORDS.map((k) => [k, 0]),
  ) as Record<Keyword, number>;
  const examples: UnknownDiagnostic[] = [];
  let totalLines = 0;
  let unknownCount = 0;
  let sampled = 0;

  logger.info("diagnose:pumpfun:unknown starting", {
    input: INPUT_PATH,
    output: OUTPUT_PATH,
    sampleLimit: SAMPLE_LIMIT,
    keywords: KEYWORDS,
  });

  const rl = readline.createInterface({
    input: fs.createReadStream(INPUT_PATH, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    totalLines += 1;

    let raw: RawTransactionLine;
    try {
      raw = JSON.parse(line) as RawTransactionLine;
    } catch {
      continue;
    }

    const parsed = parser.parse(raw);
    if (parsed.kind !== "UNKNOWN") continue;
    unknownCount += 1;

    const logsLower = parsed.logMessages.map((m) => m.toLowerCase());
    const hits = {} as Record<Keyword, boolean>;
    for (const kw of KEYWORDS) {
      const match = logsLower.some((m) => m.includes(kw));
      hits[kw] = match;
      if (match) keywordCounts[kw] += 1;
    }

    if (sampled >= SAMPLE_LIMIT) continue;

    const ixs = collectInstructionShapes(raw.transaction);
    const instructionProgramIds = Array.from(
      new Set(ixs.map((i) => i.programId).filter((s): s is string => !!s)),
    );
    const parsedInstructionTypes = Array.from(
      new Set(ixs.map((i) => i.parsedType).filter((s): s is string => !!s)),
    );

    const diag: UnknownDiagnostic = {
      signature: parsed.signature,
      slot: parsed.slot,
      candidateMints: parsed.candidateMints,
      involvedPrograms: parsed.involvedPrograms,
      logMessagesFirst20: parsed.logMessages.slice(0, LOG_TRUNCATE),
      instructionProgramIds,
      parsedInstructionTypes,
      keywordHits: hits,
    };
    out.write(JSON.stringify(diag) + "\n");
    if (examples.length < EXAMPLE_LIMIT) examples.push(diag);
    sampled += 1;
  }

  await new Promise<void>((resolve) => out.end(() => resolve()));

  logger.info("diagnose:pumpfun:unknown finished", {
    totalLines,
    unknownCount,
    sampled,
    keywordCounts,
    output: OUTPUT_PATH,
  });

  process.stdout.write("\n=== summary ===\n");
  process.stdout.write(`input lines:        ${totalLines}\n`);
  process.stdout.write(`UNKNOWN tx total:   ${unknownCount}\n`);
  process.stdout.write(`UNKNOWN sampled:    ${sampled} (cap ${SAMPLE_LIMIT})\n`);
  process.stdout.write(
    "keyword hits across ALL UNKNOWN tx (each value = number of UNKNOWN tx with >=1 logMessage containing it):\n",
  );
  for (const k of KEYWORDS) {
    process.stdout.write(`  ${k.padEnd(12)} ${keywordCounts[k]}\n`);
  }

  process.stdout.write(`\n=== examples (up to ${EXAMPLE_LIMIT}) ===\n\n`);
  for (const ex of examples) {
    process.stdout.write(JSON.stringify(ex, null, 2));
    process.stdout.write("\n\n");
  }
}

void main().catch((err) => {
  logger.error("diagnose:pumpfun:unknown unhandled error", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
