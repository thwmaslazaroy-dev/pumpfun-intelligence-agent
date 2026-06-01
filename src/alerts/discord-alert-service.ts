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
  color: number;
  fields: DiscordEmbedField[];
  timestamp: string;
}

interface DiscordWebhookBody {
  username?: string;
  embeds: DiscordEmbed[];
}

const COLOR_HIGH_PRIORITY = 0xfee75c; // Gold
const COLOR_WATCH_ONLY    = 0x5865f2; // Blurple
const COLOR_OPPORTUNITY   = 0x57f287; // Green
const COLOR_WARNING       = 0xed4245; // Red
const REQUEST_TIMEOUT_MS  = 5_000;

export interface DiscordAlertResult {
  delivered: boolean;
  preview: boolean;
  status?: number;
}

export class DiscordAlertService {
  private readonly budget?: RequestBudgetManager;
  private readonly previewOnly: boolean;

  constructor(
    private readonly webhookUrl: string,
    private readonly fetchImpl: typeof fetch | undefined = typeof fetch !== "undefined"
      ? fetch
      : undefined,
    opts: { budgetManager?: RequestBudgetManager; previewOnly?: boolean } = {},
  ) {
    this.budget = opts.budgetManager;
    this.previewOnly = opts.previewOnly ?? false;
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

    // Preview-only mode: log the full render but do not POST to Discord
    if (this.previewOnly) {
      const embed = body.embeds[0];
      logger.info("alert preview (ALERT_PREVIEW_ONLY=true — not sent)", {
        alertType: decision.alertType,
        mint: decision.context.token.mint,
        symbol: decision.context.token.symbol,
        title: embed.title,
        reason: decision.reason,
        fields: embed.fields.map((f) => `${f.name}: ${f.value}`),
      });
      return { delivered: false, preview: true };
    }

    // No webhook URL configured
    if (!this.webhookUrl) {
      logger.info("alert preview (no DISCORD_WEBHOOK_URL configured)", {
        alertType: decision.alertType,
        mint: decision.context.token.mint,
        symbol: decision.context.token.symbol,
        title: body.embeds[0].title,
        reason: decision.reason,
      });
      return { delivered: false, preview: true };
    }

    if (!this.fetchImpl) {
      logger.error("alert: fetch unavailable in this runtime — cannot POST to webhook", {
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
          this.budget?.recordRequest("discord", "webhook", {
            statusCode: res.status,
            relatedMint: decision.context.token.mint,
          });
        }
        return { delivered: false, preview: false, status: res.status };
      }
      this.budget?.recordRequest("discord", "webhook", {
        statusCode: res.status,
        relatedMint: decision.context.token.mint,
      });
      logger.info("alert sent to Discord", {
        alertType: decision.alertType,
        mint: decision.context.token.mint,
        symbol: decision.context.token.symbol,
        status: res.status,
      });
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
  const { alertType, reason } = decision;

  let color: number;
  let tierLabel: string;

  switch (alertType) {
    case "HIGH_PRIORITY":
      color = COLOR_HIGH_PRIORITY;
      tierLabel = "🔥 HIGH PRIORITY";
      break;
    case "WATCH_ONLY":
      color = COLOR_WATCH_ONLY;
      tierLabel = "👁 WATCH ONLY";
      break;
    case "opportunity":
      color = COLOR_OPPORTUNITY;
      tierLabel = "✅ OPPORTUNITY";
      break;
    case "warning":
      color = COLOR_WARNING;
      tierLabel = "⚠️ RUG WARNING";
      break;
    default:
      color = COLOR_WATCH_ONLY;
      tierLabel = String(alertType).toUpperCase();
  }

  const shortCreator =
    token.creatorWallet.length > 12
      ? `${token.creatorWallet.slice(0, 6)}…${token.creatorWallet.slice(-4)}`
      : token.creatorWallet;

  const marketCapDisplay =
    token.initialMarketCapUsd > 0
      ? `$${token.initialMarketCapUsd.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
      : "—";

  const embed: DiscordEmbed = {
    title: `${tierLabel}: ${token.name} ($${token.symbol})`,
    color,
    fields: [
      { name: "🏷 Tier",          value: tierLabel,                                    inline: true },
      { name: "⚡ Risk",           value: combined.combinedRiskLevel,                  inline: true },
      { name: "💰 Market Cap",     value: marketCapDisplay,                             inline: true },
      { name: "📊 Combined Score", value: String(combined.combinedScore),              inline: true },
      { name: "🪙 Token Score",    value: String(tokenScore.totalScore),               inline: true },
      { name: "👤 Creator Score",  value: String(creatorScore.totalScore),             inline: true },
      { name: "📍 Mint",           value: `\`${token.mint}\``,                         inline: false },
      { name: "🧑‍💻 Creator",       value: `\`${shortCreator}\``,                       inline: true },
      { name: "🔗 pump.fun",       value: `https://pump.fun/coin/${token.mint}`,       inline: false },
      { name: "📝 Reason",         value: reason.slice(0, 1024),                       inline: false },
    ],
    timestamp: new Date().toISOString(),
  };

  return {
    username: "pumpfun-intelligence-agent",
    embeds: [embed],
  };
}
