import { initDatabase, closeDatabase } from "../storage/database";

interface OutcomeRow {
  id: number;
  mint: string;
  observed_at: number;
}

const WHERE_CLAUSE = `(
  mint LIKE '% %'
  OR mint LIKE '%' || char(9) || '%'
  OR mint LIKE '%' || char(10) || '%'
  OR mint LIKE '%' || char(13) || '%'
  OR LENGTH(mint) > 50
  OR mint LIKE '%eyJ%'
)`;

function truncateMint(mint: string): string {
  if (mint.length <= 30) return `${mint} (len=${mint.length})`;
  return `${mint.slice(0, 20)}...${mint.slice(-10)} (len=${mint.length})`;
}

function reasonsFor(mint: string): string[] {
  const reasons: string[] = [];
  if (/\s/.test(mint)) reasons.push("whitespace");
  if (mint.length > 50) reasons.push("too_long");
  if (mint.includes("eyJ")) reasons.push("jwt_like");
  return reasons;
}

function main(): void {
  const databaseUrl = process.env.DATABASE_URL ?? "./data/pumpfun-agent.sqlite";
  const confirm = process.env.CONFIRM_CLEANUP_INVALID_OUTCOMES === "true";

  process.stdout.write("\n=== cleanup invalid token_outcomes ===\n");
  process.stdout.write(`  databaseUrl:  ${databaseUrl}\n`);
  process.stdout.write(`  mode:         ${confirm ? "DELETE" : "DRY RUN"}\n`);

  const db = initDatabase(databaseUrl);

  try {
    const matches = db
      .prepare(
        `SELECT id, mint, observed_at FROM token_outcomes WHERE ${WHERE_CLAUSE} ORDER BY observed_at DESC`,
      )
      .all() as OutcomeRow[];

    process.stdout.write(`\n  matchedRows:  ${matches.length}\n`);

    if (matches.length > 0) {
      process.stdout.write("\n--- matched rows (mint redacted) ---\n");
      for (const row of matches) {
        const observedAt = new Date(row.observed_at).toISOString();
        const reasons = reasonsFor(row.mint).join(",") || "n/a";
        process.stdout.write(
          `  id=${row.id}  observedAt=${observedAt}  reasons=${reasons}  mint=${truncateMint(row.mint)}\n`,
        );
      }
    }

    if (!confirm) {
      process.stdout.write(
        `\n  dry run only — no rows deleted. To delete, set CONFIRM_CLEANUP_INVALID_OUTCOMES=true and re-run.\n`,
      );
      process.stdout.write(`  deletedRows:  0\n`);
      return;
    }

    if (matches.length === 0) {
      process.stdout.write(`\n  no rows to delete.\n`);
      process.stdout.write(`  deletedRows:  0\n`);
      return;
    }

    const result = db
      .prepare(`DELETE FROM token_outcomes WHERE ${WHERE_CLAUSE}`)
      .run();
    process.stdout.write(`\n  deletedRows:  ${result.changes}\n`);
  } finally {
    closeDatabase();
  }
}

try {
  main();
} catch (err) {
  process.stderr.write(
    `cleanup:invalid:outcomes unhandled error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  closeDatabase();
  process.exit(1);
}
