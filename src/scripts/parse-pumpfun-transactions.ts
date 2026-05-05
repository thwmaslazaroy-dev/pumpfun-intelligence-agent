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
import {
  ParseConfidence,
  ParsedPumpFunTransaction,
  PumpFunTransactionKind,
} from "../types";

const INPUT_PATH = "./data/raw-pumpfun-transactions.jsonl";
const OUTPUT_PATH = "./data/parsed-pumpfun-transactions.jsonl";
const EXAMPLE_LIMIT = 3;

function ensureOutputDir(file: string): void {
  const dir = path.dirname(file);
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

async function main(): Promise<void> {
  logSanitizedEnvSummary({ context: "parse:pumpfun:txs" });

  if (!config.pumpfunProgramId) {
    logger.error(
      "PUMPFUN_PROGRAM_ID is not set in .env — required to identify pump.fun involvement during parsing",
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

  const countsByKind: Record<PumpFunTransactionKind, number> = {
    CREATE: 0,
    BUY: 0,
    SELL: 0,
    ATA_CREATE: 0,
    UNKNOWN: 0,
  };
  const countsByConfidence: Record<ParseConfidence, number> = {
    LOW: 0,
    MEDIUM: 0,
    HIGH: 0,
  };
  const examples: ParsedPumpFunTransaction[] = [];
  let highConfidenceCreates = 0;
  let lineNumber = 0;
  let parseErrors = 0;

  logger.info("parse:pumpfun:txs starting", {
    input: INPUT_PATH,
    output: OUTPUT_PATH,
    pumpfunProgramId: config.pumpfunProgramId,
  });

  const rl = readline.createInterface({
    input: fs.createReadStream(INPUT_PATH, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    lineNumber += 1;

    let raw: RawTransactionLine;
    try {
      raw = JSON.parse(line) as RawTransactionLine;
    } catch {
      parseErrors += 1;
      logger.warn("skipping unparseable input line", { lineNumber });
      continue;
    }

    const parsed = parser.parse(raw);
    countsByKind[parsed.kind] += 1;
    countsByConfidence[parsed.confidence] += 1;
    if (parsed.kind === "CREATE" && parsed.confidence === "HIGH") {
      highConfidenceCreates += 1;
    }

    out.write(JSON.stringify(parsed) + "\n");

    if (examples.length < EXAMPLE_LIMIT) {
      examples.push(parsed);
    }
  }

  await new Promise<void>((resolve) => out.end(() => resolve()));

  logger.info("parse:pumpfun:txs finished", {
    inputLines: lineNumber,
    parseErrors,
    countsByKind,
    countsByConfidence,
    highConfidenceCreates,
    output: OUTPUT_PATH,
  });

  process.stdout.write("\n=== summary ===\n");
  process.stdout.write(`input lines: ${lineNumber}\n`);
  process.stdout.write(`parse errors: ${parseErrors}\n`);
  process.stdout.write(`by kind:       ${JSON.stringify(countsByKind)}\n`);
  process.stdout.write(`by confidence: ${JSON.stringify(countsByConfidence)}\n`);
  process.stdout.write(`HIGH-confidence CREATE transactions: ${highConfidenceCreates}\n`);

  process.stdout.write(`\n=== examples (up to ${EXAMPLE_LIMIT}) ===\n\n`);
  for (const ex of examples) {
    process.stdout.write(JSON.stringify(toSummaryView(ex), null, 2));
    process.stdout.write("\n\n");
  }
}

function toSummaryView(p: ParsedPumpFunTransaction) {
  return {
    signature: p.signature,
    slot: p.slot,
    kind: p.kind,
    confidence: p.confidence,
    pumpfunProgramSeen: p.pumpfunProgramSeen,
    candidateMints: p.candidateMints,
    candidateWallets: p.candidateWallets,
    involvedPrograms: p.involvedPrograms,
    logMarkerSample: p.logMessages
      .filter((m) => /Program log:\s*Instruction:/i.test(m))
      .slice(0, 4),
    reasons: p.reasons,
  };
}

void main().catch((err) => {
  logger.error("parse:pumpfun:txs unhandled error", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
