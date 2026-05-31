import { logger } from "../utils/logger";
import { AlertDecision } from "./alert-policy";
import { RequestBudgetManager } from "../services/request-budget-manager";

interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

interface DiscordEmbed {
  title: string;
  description?: string;
  color: number;
  fields: DiscordEmbedField[];
  timestamp: string;
}

interface DiscordWebhookBody {
  username?: string;
  embeds: DiscordEmbed[];
}

const COLOR_OPPORTUNITY = 0x57f287;
const COLOR_WARNING = 0xed4245;
const REQUEST_TIMEOUT_MS = 5_000;

export interface DiscordAlertResult {
  delivered: boolean;
  preview: boolean;
  status?: number;
}

export class DiscordAlertService {
  private readonly budget?: RequestBudgetManager;

  constructor(
    private readonly webhookUrl: string,
    private readonly fetchImpl: typeof fetch | undefined = typeof fetch !== "undefined"
      ? fetch
      : undefined,
    opts: { budgetManager?: RequestBudgetManager } = {},
  ) {
    this.budget = opts.budgetManager;
  }

  async send(decision: AlertDecision): Promise<DiscordAlertResult> {
    // Budget gate — alerts are HIGH priority (important but not CRITICAL)
    if (this.budget) {
      const check = this.budget.allowRequest("discord", "HIGH");
      if (!check.allowed) {
        logger.warn("budget: discord blocked alert", {
          reason: check.reason,
          mint: decision.context.token.mint,
          alertType: decision.alertType,
        });
        return { delivered: false, preview: false };
      }
    }

    const body = renderDiscordPayload(decision);

    if (!this.webhookUrl) {
      logger.info("alert preview (no DISCORD_WEBHOOK_URL configured)", {
        mint: decision.context.token.mint,
        symbol: decision.context.token.symbol,
        alertType: decision.alertType,
        title: body.embeds[0].title,
        description: body.embeds[0].description,
        fields: body.embeds[0].fields,
      });
      return { delivered: false, preview: true };
    }

    if (!this.fetchImpl) {
      logger.error("alert: fetch is unavailable in this runtime — cannot POST to webhook", {
        mint: decision.context.token.mint,
      });
      return { delivered: false, preview: false };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        logger.error("alert: discord webhook rejected", {
          status: res.status,
          body: text.slice(0, 500),
          mint: decision.context.token.mint,
        });
        if (res.status === 429) {
          this.budget?.recordRateLimit("discord", "webhook");
        } else {
          this.budget?.recordRequest("discord", "webhook", { statusCode: res.status, relatedMint: decision.context.token.mint });
        }
        return { delivered: false, preview: false, status: res.status };
      }
      this.budget?.recordRequest("discord", "webhook", { statusCode: res.status, relatedMint: decision.context.token.mint });
      return { delivered: true, preview: false, status: res.status };
    } catch (err) {
      logger.error("alert: discord webhook POST failed", {
        mint: decision.context.token.mint,
        error: err instanceof Error ? err.message : String(err),
      });
      return { delivered: false, preview: false };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function renderDiscordPayload(decision: AlertDecision): DiscordWebhookBody {
  const { token, tokenScore, creatorScore, combined } = decision.context;
  const isOpportunity = decision.alertType === "opportunity";
  const heading = isOpportunity ? "OPPORTUNITY" : "RUG WARNING";
  const color = isOpportunity ? COLOR_OPPORTUNITY : COLOR_WARNING;

  const description =
    `${decision.reason}\n` +
    (combined.reasons.length > 0 ? combined.reasons.map((r) => `- ${r}`).join("\n") : "");

  const embed: DiscordEmbed = {
    title: `${heading}: ${token.name} (${token.symbol})`,
    description,
    color,
    fields: [
      {
        name: "Combined",
        value: `${combined.combinedScore} — ${combined.combinedRiskLevel}`,
        inline: true,
      },
      {
        name: "Token",
        value: `${tokenScore.totalScore} — ${tokenScore.riskLevel}`,
        inline: true,
      },
      {
        name: "Creator",
        value: `${creatorScore.totalScore} — ${creatorScore.riskLevel}`,
        inline: true,
      },
      {
        name: "Mint",
        value: "`" + token.mint + "`",
      },
      {
        name: "Creator wallet",
        value: "`" + token.creatorWallet + "`",
      },
    ],
    timestamp: new Date().toISOString(),
  };

  return {
    username: "pumpfun-intelligence-agent",
    embeds: [embed],
  };
}
