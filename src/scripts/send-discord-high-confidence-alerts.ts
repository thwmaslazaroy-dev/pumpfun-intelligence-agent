import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import { URL } from "url";
import { config } from "../config";

interface PreviewAlert {
  mint: string;
  creatorWallet: string;
  symbol: string;
  launchedAtIso: string;
  decision: "HIGH_PRIORITY_ALERT" | "WATCH_ONLY" | "REJECT";
  reason: string;
  tracked: number;
  creatorLabel: string;
  tokenLabel: string | null;
  avgGainPercent: number | null;
  positive: number;
  bad: number;
}

interface SentAlert {
  mint: string;
  sentAt: string;
  decision: string;
}

const HIGH_CONFIDENCE_FILE = "./data/high-confidence-alerts.json";
const SENT_FILE = "./data/discord-sent-alerts.json";

function readSent(filePath: string): SentAlert[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as SentAlert[]) : [];
  } catch {
    return [];
  }
}

function writeSent(filePath: string, sent: SentAlert[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(sent, null, 2));
}

interface PostResult {
  ok: boolean;
  status: number;
  body: string;
}

function postJson(targetUrl: string, payload: unknown): Promise<PostResult> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch (err) {
      reject(err);
      return;
    }

    if (parsed.protocol !== "https:") {
      reject(new Error(`webhook URL must use https (got ${parsed.protocol})`));
      return;
    }

    const body = JSON.stringify(payload);
    const req = https.request(
      {
        method: "POST",
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body).toString(),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          const status = res.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status, body: text });
        });
      },
    );

    req.on("error", (err) => reject(err));
    req.setTimeout(10000, () => {
      req.destroy(new Error("webhook request timed out after 10s"));
    });
    req.write(body);
    req.end();
  });
}

function buildEmbed(a: PreviewAlert): Record<string, unknown> {
  const fields = [
    { name: "Mint", value: a.mint, inline: false },
    { name: "Creator", value: a.creatorWallet, inline: false },
    { name: "Creator label", value: a.creatorLabel, inline: true },
    { name: "Token label", value: a.tokenLabel ?? "n/a", inline: true },
    { name: "Tracked launches", value: String(a.tracked), inline: true },
    {
      name: "Avg creator gain",
      value:
        a.avgGainPercent === null ? "n/a" : `${a.avgGainPercent.toFixed(2)}%`,
      inline: true,
    },
    { name: "Reason", value: a.reason, inline: false },
    { name: "Launched at", value: a.launchedAtIso, inline: false },
  ];
  return {
    title: `HIGH_PRIORITY_ALERT: ${a.symbol || "UNKNOWN"}`,
    color: 0x00aa55,
    fields,
    timestamp: new Date().toISOString(),
  };
}

async function main(): Promise<void> {
  process.stdout.write("\n=== send:discord:high-confidence ===\n");

  if (!config.discordAlertsEnabled) {
    process.stdout.write("Discord alerts disabled\n");
    return;
  }

  if (!config.discordWebhookUrl) {
    process.stdout.write(
      "WARN: DISCORD_ALERTS_ENABLED=true but DISCORD_WEBHOOK_URL is missing. Skipping.\n",
    );
    return;
  }

  const filePath = path.resolve(process.cwd(), HIGH_CONFIDENCE_FILE);
  if (!fs.existsSync(filePath)) {
    process.stdout.write(
      `No alerts file at ${filePath}. Run preview:high-confidence:alerts first.\n`,
    );
    return;
  }

  let candidates: PreviewAlert[] = [];
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    candidates = Array.isArray(parsed) ? (parsed as PreviewAlert[]) : [];
  } catch (err) {
    process.stdout.write(
      `WARN: failed to parse ${filePath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return;
  }

  const highConfidence = candidates.filter(
    (c) => c.decision === "HIGH_PRIORITY_ALERT",
  );
  process.stdout.write(`  candidatesInFile:    ${candidates.length}\n`);
  process.stdout.write(`  highPriorityFound:   ${highConfidence.length}\n`);

  if (highConfidence.length === 0) {
    process.stdout.write("No HIGH_PRIORITY_ALERT candidates. Nothing to send.\n");
    return;
  }

  const sentPath = path.resolve(process.cwd(), SENT_FILE);
  const sent = readSent(sentPath);
  const sentMints = new Set(sent.map((s) => s.mint));

  const toSend = highConfidence.filter((a) => !sentMints.has(a.mint));
  process.stdout.write(
    `  alreadySent:         ${highConfidence.length - toSend.length}\n`,
  );
  process.stdout.write(`  toSend:              ${toSend.length}\n`);

  if (toSend.length === 0) {
    process.stdout.write(
      "All HIGH_PRIORITY_ALERT mints already sent. Nothing to do.\n",
    );
    return;
  }

  let successes = 0;
  let failures = 0;
  for (const a of toSend) {
    const payload = {
      content: `HIGH_PRIORITY_ALERT: \`${a.mint}\``,
      embeds: [buildEmbed(a)],
    };
    try {
      const result = await postJson(config.discordWebhookUrl, payload);
      if (result.ok) {
        successes += 1;
        sent.push({
          mint: a.mint,
          sentAt: new Date().toISOString(),
          decision: a.decision,
        });
        process.stdout.write(`  sent OK: ${a.mint}\n`);
      } else {
        failures += 1;
        process.stdout.write(
          `  WARN: webhook returned ${result.status} for ${a.mint}: ${result.body.slice(0, 200)}\n`,
        );
      }
    } catch (err) {
      failures += 1;
      process.stdout.write(
        `  WARN: webhook failed for ${a.mint}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  if (successes > 0) {
    writeSent(sentPath, sent);
  }

  process.stdout.write(
    `\nsuccesses: ${successes}  failures: ${failures}\n`,
  );
}

main().catch((err) => {
  process.stderr.write(
    `send:discord:high-confidence unhandled error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(0);
});
