import { CombinedTokenEvaluation, TokenLaunch } from "../types";
import { MomentumSignals } from "../scoring/momentum-detection-service";
import { logger } from "../utils/logger";

const COLOR_MOMENTUM = 0xfee75c;
const REQUEST_TIMEOUT_MS = 5_000;

export interface MomentumAlertResult {
  delivered: boolean;
  preview: boolean;
  status?: number;
}

export class DiscordMomentumAlertService {
  constructor(private readonly webhookUrl: string) {}

  async send(
    token: TokenLaunch,
    signals: MomentumSignals,
    combined: CombinedTokenEvaluation,
  ): Promise<MomentumAlertResult> {
    const payload = buildPayload(token, signals, combined);

    if (!this.webhookUrl) {
      logger.info("momentum alert preview (no DISCORD_WEBHOOK_URL)", {
        mint: token.mint,
        symbol: token.symbol,
        bcVelocity: signals.bcVelocityPerMin,
        buyPressure: signals.buyPressure,
        combinedScore: combined.combinedScore,
      });
      return { delivered: false, preview: true };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        logger.error("momentum alert: webhook rejected", { status: res.status, body: text.slice(0, 200) });
        return { delivered: false, preview: false, status: res.status };
      }
      return { delivered: true, preview: false, status: res.status };
    } catch (err) {
      logger.error("momentum alert: webhook POST failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return { delivered: false, preview: false };
    } finally {
      clearTimeout(timer);
    }
  }
}

function buildPayload(
  token: TokenLaunch,
  signals: MomentumSignals,
  combined: CombinedTokenEvaluation,
) {
  const bcPct = (token.bondingCurveProgress * 100).toFixed(1);
  const velocityPct = (signals.bcVelocityPerMin * 100).toFixed(2);
  const pressurePct = (signals.buyPressure * 100).toFixed(0);
  const volumeDelta = signals.volumeDeltaUsd.toFixed(2);

  return {
    username: "pumpfun-momentum",
    embeds: [
      {
        title: `PUMP: ${token.name} (${token.symbol})`,
        description: signals.reasons.join(" | "),
        color: COLOR_MOMENTUM,
        fields: [
          {
            name: "Bonding Curve",
            value: `${bcPct}% (+${velocityPct}%/min)`,
            inline: true,
          },
          {
            name: "Buy Pressure",
            value: `${pressurePct}% (${signals.newBuys}B / ${signals.newSells}S)`,
            inline: true,
          },
          {
            name: "Volume Δ",
            value: `$${volumeDelta}`,
            inline: true,
          },
          {
            name: "Anti-scam Score",
            value: `${combined.combinedScore} — ${combined.combinedRiskLevel}`,
            inline: true,
          },
          {
            name: "Mint",
            value: `[\`${token.mint.slice(0, 8)}...\`](https://pump.fun/coin/${token.mint})`,
          },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  };
}
