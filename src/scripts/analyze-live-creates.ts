import * as fs from "fs";
import * as readline from "readline";
import { config } from "../config";
import { logger } from "../utils/logger";
import { logSanitizedEnvSummary } from "../utils/env-summary";

const INPUT_PATH = "./data/live-pumpfun-creates.jsonl";
const SAMPLE_SIZE = 10;
const TOP_N = 20;

const KNOWN_PROGRAM_IDS: Record<string, string> = {
  "11111111111111111111111111111111": "System",
  TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA: "SPL Token",
  TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb: "Token-2022",
  ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL: "Associated Token Account",
  ComputeBudget111111111111111111111111111111: "Compute Budget",
  pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ: "Pump.fun fee program",
};

interface RowLike {
  observedAt?: string;
  signature?: string;
  slot?: number;
  kind?: string;
  confidence?: string;
  candidateMints?: unknown;
  creatorWallet?: unknown;
  creatorExtractionReason?: unknown;
  candidateWallets?: unknown;
  involvedPrograms?: unknown;
}

interface SampleEntry {
  signature: string | undefined;
  mint: string | null;
  creatorWallet: string | null;
  creatorExtractionReason: string | null;
}

function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
}

async function main(): Promise<void> {
  logSanitizedEnvSummary({
    context: "analyze:live:creates",
    extras: { INPUT_PATH, PUMPFUN_PROGRAM_ID_set: Boolean(config.pumpfunProgramId) },
  });

  if (!fs.existsSync(INPUT_PATH)) {
    logger.error("input file missing", {
      path: INPUT_PATH,
      hint: "run 'npm run live:detect:creates' first to populate it",
    });
    process.exit(1);
  }

  const pumpfunProgramId = config.pumpfunProgramId || "(PUMPFUN_PROGRAM_ID unset)";

  let totalRows = 0;
  let parseErrors = 0;
  let rowsWithCandidateMints = 0;
  let rowsWithCreatorWallet = 0;
  let rowsCreatorIsNull = 0;
  let rowsCreatorEqualsCandidateMint = 0;
  let rowsCreatorEqualsPumpfunProgram = 0;
  let rowsCreatorIsKnownProgram = 0;
  const knownProgramHitCounts: Record<string, number> = {};
  const creatorCounts = new Map<string, number>();
  let mintsTotal = 0;
  let mintsEndingPump = 0;
  let mintsEndingOther = 0;
  const samples: SampleEntry[] = [];

  const rl = readline.createInterface({
    input: fs.createReadStream(INPUT_PATH, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    totalRows += 1;

    let row: RowLike;
    try {
      row = JSON.parse(line) as RowLike;
    } catch {
      parseErrors += 1;
      continue;
    }

    const candidateMints = asStringArray(row.candidateMints);
    if (candidateMints.length > 0) rowsWithCandidateMints += 1;
    const firstMint = candidateMints[0] ?? null;

    for (const m of candidateMints) {
      mintsTotal += 1;
      if (m.toLowerCase().endsWith("pump")) mintsEndingPump += 1;
      else mintsEndingOther += 1;
    }

    const creatorWallet = asString(row.creatorWallet);
    const creatorExtractionReason = asString(row.creatorExtractionReason);

    if (creatorWallet === null) {
      rowsCreatorIsNull += 1;
    } else {
      rowsWithCreatorWallet += 1;
      if (candidateMints.includes(creatorWallet)) rowsCreatorEqualsCandidateMint += 1;
      if (creatorWallet === pumpfunProgramId) rowsCreatorEqualsPumpfunProgram += 1;
      if (Object.prototype.hasOwnProperty.call(KNOWN_PROGRAM_IDS, creatorWallet)) {
        rowsCreatorIsKnownProgram += 1;
        const label = KNOWN_PROGRAM_IDS[creatorWallet];
        knownProgramHitCounts[label] = (knownProgramHitCounts[label] ?? 0) + 1;
      }
      creatorCounts.set(creatorWallet, (creatorCounts.get(creatorWallet) ?? 0) + 1);
    }

    if (samples.length < SAMPLE_SIZE) {
      samples.push({
        signature: asString(row.signature) ?? undefined,
        mint: firstMint,
        creatorWallet,
        creatorExtractionReason,
      });
    }
  }

  const topCreators = [...creatorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_N);

  process.stdout.write("\n=== analyze:live:creates summary ===\n");
  process.stdout.write(`input file:                       ${INPUT_PATH}\n`);
  process.stdout.write(`total rows:                       ${totalRows}\n`);
  process.stdout.write(`unparseable rows:                 ${parseErrors}\n`);
  process.stdout.write(`rows with candidateMints:         ${rowsWithCandidateMints}\n`);
  process.stdout.write(`rows with creatorWallet (non-null): ${rowsWithCreatorWallet}\n`);
  process.stdout.write(`rows where creatorWallet === null: ${rowsCreatorIsNull}\n`);
  process.stdout.write(
    `rows where creatorWallet === a candidateMint: ${rowsCreatorEqualsCandidateMint}\n`,
  );
  process.stdout.write(
    `rows where creatorWallet === Pump.fun program id: ${rowsCreatorEqualsPumpfunProgram}\n`,
  );
  process.stdout.write(
    `rows where creatorWallet is a known program id:   ${rowsCreatorIsKnownProgram}\n`,
  );
  if (Object.keys(knownProgramHitCounts).length > 0) {
    for (const [label, n] of Object.entries(knownProgramHitCounts)) {
      process.stdout.write(`    ${label.padEnd(30)} ${n}\n`);
    }
  }
  process.stdout.write(`unique creatorWallets:            ${creatorCounts.size}\n`);

  process.stdout.write(`\n=== mint suffix pattern (across all candidateMints) ===\n`);
  process.stdout.write(`mints total:                      ${mintsTotal}\n`);
  process.stdout.write(`ending in 'pump':                 ${mintsEndingPump}\n`);
  process.stdout.write(`other:                            ${mintsEndingOther}\n`);

  process.stdout.write(`\n=== top ${TOP_N} creators by launch count ===\n`);
  if (topCreators.length === 0) {
    process.stdout.write(`  (none)\n`);
  } else {
    for (const [wallet, count] of topCreators) {
      process.stdout.write(`  ${String(count).padStart(4)}  ${wallet}\n`);
    }
  }

  process.stdout.write(`\n=== sample ${samples.length} rows ===\n`);
  for (const s of samples) {
    process.stdout.write(
      JSON.stringify(
        {
          signature: s.signature ?? null,
          mint: s.mint,
          creatorWallet: s.creatorWallet,
          creatorExtractionReason: s.creatorExtractionReason,
        },
        null,
        2,
      ),
    );
    process.stdout.write("\n");
  }

  logger.info("analyze:live:creates finished", {
    totalRows,
    parseErrors,
    rowsWithCreatorWallet,
    rowsCreatorIsNull,
    rowsCreatorEqualsCandidateMint,
    rowsCreatorEqualsPumpfunProgram,
    rowsCreatorIsKnownProgram,
    uniqueCreators: creatorCounts.size,
    mintsTotal,
    mintsEndingPump,
  });
}

void main().catch((err) => {
  logger.error("analyze:live:creates unhandled error", {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
