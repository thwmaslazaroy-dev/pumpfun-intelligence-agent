# Pump.fun Intelligence Agent

A Crypto Launch Intelligence Agent focused on Pump.fun token launches. It detects new launches, stores them locally, scores them for risk, and sends Telegram alerts.

> **This is NOT a trading bot.** It does not buy, sell, sign transactions, manage wallets, or execute orders.

## What it does

- Detects new Pump.fun token launches in near-real-time
- Stores launch metadata in a local SQLite database
- Aggregates social signals (X / Instagram) tied to a token or creator
- Scores each launch on risk and signal strength
- Sends formatted alerts to a Telegram channel/chat

## MVP scope

The MVP will include:

- A Pump.fun data provider that ingests new token events
- A simple social signal provider (X + Instagram) for early-mention lookup
- A risk scoring service combining on-chain microstructure and social signals
- Local persistence in SQLite (token metadata, signals, scores, alerts sent)
- A Telegram alert service for high-score launches
- Background jobs for polling, scoring, and dispatching alerts
- A small set of utilities (logger, config loader, validation helpers)

## What is intentionally NOT included

- No buying or selling of tokens
- No wallet integration, private keys, seed phrases, or signing
- No auto-execution, sniping, or order routing
- No broker / DEX adapter
- No portfolio management or position sizing
- No paper-trading simulation

These are out of scope for this project.

## Project layout

```
pumpfun-intelligence-agent/
├── src/
│   ├── config/       # env loading, runtime config
│   ├── providers/    # external data sources (Pump.fun, X, Instagram)
│   ├── services/     # core orchestration (alerts, scoring orchestration)
│   ├── scoring/      # risk + signal scoring logic
│   ├── storage/      # SQLite persistence (database init + repository)
│   ├── alerts/       # Telegram dispatch
│   ├── jobs/         # background pollers / workers
│   ├── types/        # shared TypeScript types and interfaces
│   ├── utils/        # logger and small helpers
│   └── index.ts      # entry point
├── package.json
├── tsconfig.json
├── .env.example
└── .gitignore
```

## Install

```bash
npm install
```

## Build / typecheck

```bash
# emit JS to dist/
npm run build

# type-only check (no emit)
npm run typecheck
```

## Configure

Copy the example env file and fill in values:

```bash
cp .env.example .env
```

Required keys:

- `TELEGRAM_BOT_TOKEN` — bot token from BotFather
- `TELEGRAM_CHAT_ID` — destination chat/channel for alerts
- `PUMPFUN_DATA_PROVIDER` — endpoint or provider identifier for Pump.fun data
- `X_API_KEY` — X (Twitter) API key for social lookups
- `INSTAGRAM_ACCESS_TOKEN` — Instagram Graph API token
- `DATABASE_URL` — path to the SQLite database file. Defaults to `./data/pumpfun-agent.sqlite`. A `sqlite:` prefix is also accepted.
- `INGESTION_INTERVAL_SECONDS` — how often `--watch` mode polls the provider. Defaults to `30`.

## Step 2 — local storage + mock ingestion

This step adds:

- A SQLite database (via `better-sqlite3`) initialised on startup at `DATABASE_URL`. The data directory is created automatically.
- Tables: `tokens`, `market_snapshots`, `risk_flags`, `alerts`.
- `SqliteTokenRepository` implementing save/find/list operations on `TokenLaunch`, market snapshots, risk flags, and alert dedup.
- `validateTokenLaunch()` enforcing non-empty mint/name/symbol/creator, non-negative numeric fields, and `bondingCurveProgress` between 0 and 100.
- `MockPumpFunProvider` that returns rotating batches of fake launches — including duplicates across calls (to exercise dedup) and three quality archetypes: a normal token, a suspicious high-volume churning token, and a token with no socials.
- `TokenIngestionJob` that fetches a batch, validates each token, skips duplicates by mint, and persists the rest.

> All Pump.fun data in Step 2 is **mock**. No external Pump.fun, X, or Instagram APIs are called.

### Run a single ingestion

```bash
npm run build
node dist/index.js
```

Or, without a build step:

```bash
npx ts-node src/index.ts
```

### Run watch mode

```bash
node dist/index.js --watch
```

Polls every `INGESTION_INTERVAL_SECONDS` (default `30`). Stop with Ctrl+C.

### Inspect the database

```bash
sqlite3 ./data/pumpfun-agent.sqlite "SELECT mint, symbol, name, initial_market_cap_usd FROM tokens;"
```

## Step 3 — risk flags + scoring

This step adds heuristic risk evaluation. After every newly-ingested token, the ingestion job runs two services and persists their results.

### Risk flags

`TokenRiskFlagService.evaluate(token)` produces a `TokenRiskFlags` record with boolean flags and a `reasons[]` array explaining each one that fired:

| Flag | Default trigger |
|---|---|
| `missingSocials` | no website, twitter, telegram, instagram, or discord link |
| `highChurn` | `>= 100` total trades **and** `sell/buy >= 0.85` |
| `suspiciousVolumeToMarketCap` | `volumeUsd / initialMarketCapUsd >= 5x` |
| `earlyBondingCurveSpike` | bonding curve `>= 50%` within `10` minutes of launch |
| `lowActivity` | `<= 10` total trades |
| `suspiciousCreator` | **always `false` for now** — creator-history provider is not connected yet |

Thresholds are configurable via `RiskFlagThresholds` passed to the service constructor.

### Risk scoring

`RiskScoringService.score(token, flags)` produces a `TokenScore` with:

- `totalScore` — `0..100`, starts at 100 and subtracts a fixed penalty per fired flag, clamped
- `microstructureScore`, `socialScore`, `anomalyScore` — per-category sub-scores in `0..100`
- `reasons[]` — itemised list of penalties applied (e.g. `-25 microstructure: highChurn`)
- `riskLevel` — bucketed from `totalScore`:

| Range | Level |
|---|---|
| `80..100` | `LOW` |
| `60..79` | `MEDIUM` |
| `40..59` | `HIGH` |
| `0..39` | `EXTREME` |

Default penalty weights (from `DEFAULT_RISK_SCORING_WEIGHTS`): `missingSocials 30`, `highChurn 25`, `suspiciousVolumeToMarketCap 35`, `earlyBondingCurveSpike 20`, `lowActivity 15`, `suspiciousCreator 25`.

> These thresholds and weights are **heuristic**. They are not financial advice and will produce false positives and false negatives. They are intended as triage signals, not buy/sell recommendations.

### Persistence

Both records are written to SQLite by the ingestion job:

- `risk_flags` (one row per mint, upserted)
- `token_scores` (one row per mint, upserted)

Inspect them with:

```bash
sqlite3 ./data/pumpfun-agent.sqlite "SELECT mint, risk_level, total_score FROM token_scores ORDER BY total_score;"
sqlite3 ./data/pumpfun-agent.sqlite "SELECT mint, missing_socials, high_churn, suspicious_volume_to_market_cap, low_activity FROM risk_flags;"
```

### Validate the scoring logic

```bash
npm run validate:step3
```

This runs a small set of in-process assertions: a normal token must out-score a suspicious one, a no-socials token must trigger `missingSocials`, and a high volume/market-cap ratio must trigger `suspiciousVolumeToMarketCap`.

### Mock data archetypes

The mock provider returns tokens that intentionally cover the full risk spectrum so you can see every level on a single run:

- `Sunny Coin (SUN)` — clean fundamentals, full socials → **LOW**
- `Stealth Cat (STC)` — healthy activity but no socials → **MEDIUM**
- `Quiet Launch (QL)` — no socials and very low activity → **HIGH**
- `Moon Rocket Pro (MRP)` — extreme volume/mcap, churn, early bonding spike → **EXTREME**

## Step 3A — creator intelligence

In addition to scoring tokens, the agent now scores **creator wallets** based on their historical launch performance. Each new ingestion produces both a token score and a creator score, then combines them into a final evaluation.

### Creator profile, history, stats

- `creators` — one row per wallet (`firstSeenAt`, `lastSeenAt`, `totalLaunches`, optional notes)
- `creator_launch_history` — past launches with `peakMarketCapUsd`, `maxGainMultiple`, `timeToPeakMinutes`, `endedBadly`, `rugLike`
- `CreatorScoringService.calculatePerformanceStats(...)` derives `successRate`, `averageMaxGain`, `medianMaxGain`, `rugLikeCount`, and `averageTimeToPeakMinutes`

A launch counts as **successful** when `maxGainMultiple >= 2x`, `endedBadly !== true`, and `rugLike !== true`.

### Creator score

`CreatorScoringService.score(profile, history)` produces a `CreatorScore` with five sub-scores:

| Sub-score | What it captures |
|---|---|
| `successRateScore` | `successRate * 100` |
| `consistencyScore` | `50 + 25 * (medianMaxGain - 1)` |
| `rugRiskScore` | `100 - rugLikeCount * 30` |
| `activityScore` | recency of `lastSeenAt` (100 ≤ 7d, 80 ≤ 30d, 50 ≤ 90d, else 30) |
| `confidenceScore` | `40` for 1–2 launches, `70` for 3–5, `100` for 6+, `0` for unknown |

Total = weighted sum (default `0.25 / 0.20 / 0.30 / 0.10 / 0.15`), clamped to `0..100`, bucketed into the same `LOW / MEDIUM / HIGH / EXTREME` levels as the token score. **Unknown creators** (no history) get neutral 50/50/75/50/0 sub-scores and a provisional reason.

### Combined evaluation

`CombinedScoringService.combine(token, tokenScore, creatorScore)` blends the two:

```
combined = 0.6 * tokenScore.totalScore + 0.4 * creatorScore.totalScore
if creatorScore.riskLevel === EXTREME    → cap combined at 50
if tokenScore.riskLevel   === EXTREME    → cap combined at 45
if creatorScore.confidenceScore < 30     → combined -= 10  (unknown-creator penalty)
clamp(combined, 0, 100)
```

Result is persisted as a `CombinedTokenEvaluation` in `combined_token_evaluations`.

### Mock creator archetypes

The mock data seeds **3 known creators** plus exercises **1 unknown** wallet:

- `StrongCreator…` — 5 prior launches, gains 12x/8x/5x/10x/6x, no rugs → ~LOW
- `MediocreCreator…` — 3 launches: 1.5x, 0.8x (endedBadly), 2.2x → ~HIGH/MEDIUM
- `RugCreator…` — 4 launches, 3 rug-like → ~EXTREME
- `UnknownCreator…` — no history (confidence penalty applies)

Mock tokens are assigned across these wallets so a single run produces the full `LOW / MEDIUM / HIGH / EXTREME` spread on `combined_token_evaluations`.

### Inspect

```bash
sqlite3 ./data/pumpfun-agent.sqlite "SELECT creator_wallet, risk_level, total_score FROM creator_scores ORDER BY total_score DESC;"
sqlite3 ./data/pumpfun-agent.sqlite "SELECT mint, symbol, token_score, creator_score, combined_score, combined_risk_level FROM combined_token_evaluations ORDER BY combined_score DESC;"
```

> Creator scoring is a **heuristic on past behaviour**. It produces false positives and false negatives, can be gamed by wallet rotation, and is **not financial advice**. Treat it as a triage signal alongside token scoring, not as a buy/sell decision.

## Step 5A — learning-mode Pump.fun raw log listener

This step adds a **standalone, read-only listener** that connects to a Solana WebSocket RPC endpoint, subscribes to Pump.fun program logs via JSON-RPC `logsSubscribe`, and writes every received notification to a JSONL file for later analysis.

> **What this step does NOT do:**
> - It does **not** replace `MockPumpFunProvider` — the ingestion pipeline still uses mock data.
> - It is **not** wired into `TokenIngestionJob` and does **not** trigger Discord alerts.
> - It does **not** trade, buy, sell, sign, or submit transactions.
> - It does **not** require a paid API provider — any plain Solana WebSocket RPC works.

### Configure

```env
SOLANA_RPC_WS_URL=wss://<your-solana-ws-rpc>
PUMPFUN_PROGRAM_ID=<the Pump.fun program id you want to observe>
RAW_LOG_MAX_EVENTS=25
RAW_LOG_OUTPUT_PATH=./data/raw-pumpfun-logs.jsonl
```

The canonical public Pump.fun program id on Solana mainnet is `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` (verify before use). For a free WS endpoint you can start with `wss://api.mainnet-beta.solana.com`, but expect rate limits — for serious learning use a free-tier provider of your choice. **No API key is required for this listener to run.**

### Run

```bash
npm run build
npm run listen:pumpfun:logs
```

Behavior:
- Connects to `SOLANA_RPC_WS_URL`.
- Sends a `logsSubscribe` request with `mentions: [PUMPFUN_PROGRAM_ID]` at `confirmed` commitment.
- For each `logsNotification`, appends one JSON object per line to `RAW_LOG_OUTPUT_PATH` containing `{ receivedAt, signature, logs, raw }`.
- Stops automatically after `RAW_LOG_MAX_EVENTS` events, sends `logsUnsubscribe`, closes the WebSocket cleanly, and exits.
- If the WebSocket drops before the cap, retries up to 3 times with 1s/2s/4s exponential backoff.

### Safe mode (no env)

Run without `SOLANA_RPC_WS_URL`:

```bash
npm run listen:pumpfun:logs
```

The script prints a help message explaining what to set and exits with status 0 — it does not crash. Use this to confirm the listener was built correctly before you point it at a real endpoint.

### Inspect captured data

```bash
wc -l ./data/raw-pumpfun-logs.jsonl
head -1 ./data/raw-pumpfun-logs.jsonl | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.stringify(JSON.parse(s),null,2)))"
```

> The captured logs are intentionally **raw** — Step 5A does not parse Pump.fun event types. Parsing, decoding, and connecting this stream to `TokenIngestionJob` happens in a later step.

### HTTP fallback: `fetch:pumpfun:txs`

`logsSubscribe` may emit nothing for a given session — depending on the RPC endpoint's tier, the chosen commitment level, and the actual on-chain activity for the configured program id. To inspect real transaction shapes regardless, use the HTTP fallback:

```env
SOLANA_RPC_HTTP_URL=https://<your-solana-http-rpc-endpoint>
PUMPFUN_PROGRAM_ID=<the Pump.fun program id you want to inspect>
```

```bash
npm run build
npm run fetch:pumpfun:txs
```

It calls JSON-RPC `getSignaturesForAddress(programId, { limit: 10 })` followed by `getTransaction(sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" })` for each signature, and writes one transaction per line to `./data/raw-pumpfun-transactions.jsonl`. Read-only, not wired into the ingestion pipeline, no alerts. The script never logs the full RPC URL or any API key.

### Live CREATE detector — `live:detect:creates`

Standalone prototype combining a fresh WebSocket subscription with the verified Step 5B parser. Subscribes to Pump.fun program logs, fetches each notified transaction via JSON-RPC `getTransaction` (`encoding: "jsonParsed"`, `commitment: "confirmed"`), classifies via `PumpFunTransactionParser`, and **only** writes `CREATE`-classified detections (HIGH or MEDIUM confidence) to `./data/live-pumpfun-creates.jsonl`.

Heartbeats every 60 s with `uptime`, full counters (`receivedLogs`, `fetchedTransactions`, `parsedTransactions`, `ignoredTransactions`, `createDetections`, `unknownTransactions`, `errors`), `lastSignature`, and `lastCreateSignature`. Reconnect is **infinite** with capped exponential backoff and ±20 % jitter (1 s → 30 s).

> **Not wired into `TokenIngestionJob`. No Discord alerts. No SQLite writes. No trading or signing.**

```bash
npm run build
npm run live:detect:creates
```

Stop with Ctrl+C. Inspect:

```bash
wc -l ./data/live-pumpfun-creates.jsonl
head -1 ./data/live-pumpfun-creates.jsonl | node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>console.log(JSON.stringify(JSON.parse(s),null,2)))"
```

If `SOLANA_RPC_WS_URL`, `SOLANA_RPC_HTTP_URL`, or `PUMPFUN_PROGRAM_ID` is missing, the script prints a safe-mode help block and exits 0.

## Step 5B — conservative transaction parser

`parse:pumpfun:txs` reads `./data/raw-pumpfun-transactions.jsonl`, runs each transaction through `PumpFunTransactionParser`, and writes a summarised, classified record to `./data/parsed-pumpfun-transactions.jsonl`.

Each output record (`ParsedPumpFunTransaction`) contains:

- `signature`, `slot`, `blockTime`
- `kind` ∈ `CREATE | BUY | SELL | ATA_CREATE | UNKNOWN`
- `confidence` ∈ `LOW | MEDIUM | HIGH`
- `candidateMints[]`, `candidateWallets[]`, `involvedPrograms[]`
- `pumpfunProgramSeen` boolean
- `logMessages[]` and `reasons[]` (human-readable explanations)

### Conservative rules

- **`CREATE` is only HIGH-confidence** when the Pump.fun program is present **and** the logs contain `Program log: Instruction: Create` **and** at least one candidate mint was extracted from token balances or instruction info. No log marker → no `CREATE`.
- `BUY` / `SELL` are HIGH-confidence only when the Pump.fun program is present **and** the matching `Instruction: Buy` / `Instruction: Sell` log marker is present.
- If a buy/sell/create marker appears **without** the Pump.fun program ID, the parser still classifies but downgrades to LOW confidence — the marker may belong to an unrelated program.
- When only an ATA create is present (no Pump.fun, no other markers), the kind is `ATA_CREATE`.
- Otherwise: `UNKNOWN`.

### What the parser does NOT claim

- A `candidateMint` is not necessarily the launched token — it's any mint that appeared in token balances or instruction info.
- A `candidateWallet` is not necessarily the creator — it's any signer or any wallet/owner/authority field. Distinguishing the actual creator requires HIGH-confidence `CREATE` classification and additional pattern checks.
- This parser is **not wired into `TokenIngestionJob`** and does **not** trigger Discord alerts. Before integration, `CREATE` classifications should be spot-checked against a real explorer to confirm the rule is accurate for the current Pump.fun deployment.

### Run

```bash
npm run build
npm run parse:pumpfun:txs
```

Prints summary counts by kind and confidence, plus up to 3 example summaries. Read-only, no network calls, no DB writes, no alerts.

### CREATE discovery: `find:pumpfun:creates`

The latest 10 signatures for a program almost always look like `BUY` / `SELL` — there is exactly one `CREATE` per launched token but a continuous stream of trades against the bonding curve afterwards, so a small window will normally contain zero `CREATE` transactions. This script searches a larger historical window:

```env
PUMPFUN_SIGNATURE_LIMIT=500
PUMPFUN_CREATE_SEARCH_OUTPUT_PATH=./data/pumpfun-create-candidates.jsonl
```

```bash
npm run build
npm run find:pumpfun:creates
```

Behaviour:

- Paginates `getSignaturesForAddress(programId, { limit, before })` (page size capped at 1000) until `PUMPFUN_SIGNATURE_LIMIT` signatures are collected.
- For each signature, calls `getTransaction(sig, { encoding: "jsonParsed", maxSupportedTransactionVersion: 0, commitment: "confirmed" })` with a 50 ms inter-call delay to be polite to free-tier RPC endpoints.
- Runs each transaction through the existing `PumpFunTransactionParser` and writes **only** `CREATE`-classified records (any confidence) to `PUMPFUN_CREATE_SEARCH_OUTPUT_PATH`.
- Logs progress every 25 transactions and emits an explicit log line every time a `HIGH`-confidence `CREATE` is found.
- Stops early once **5** `HIGH`-confidence `CREATE` transactions have been observed.
- Never logs the full RPC URL or any API key — only the URL scheme.

> The discovered `CREATE` candidates are **not** wired into `TokenIngestionJob` and do **not** trigger Discord alerts. They exist for visual inspection of real CREATE shapes so the parser's CREATE rule can be ground-truthed before integration.

## Moralis read-only enrichment (research only)

Moralis is currently used **only as a read-only enrichment source** for a single configured mint, behind the `npm run test:moralis:token` script. Specifically:

- The script calls `GET https://solana-gateway.moralis.io/token/mainnet/{mint}/price` and `GET .../swaps` for `MORALIS_TEST_TOKEN_MINT`.
- The API key is sent only via the `X-API-Key` request header — never printed, never written to disk.
- Raw responses are saved to `./data/moralis-token-enrichment-sample.json`. A sanitized summary (mint, price, swap count, first-swap type/exchange, file-saved flag) is printed to the console.

What Moralis is **not** doing in this project:

- It is **not** used to discover new Pump.fun launches — launch discovery is still mock data, with the read-only Solana RPC scripts (`fetch:pumpfun:txs`, `find:pumpfun:creates`) for sampling real transactions.
- It is **not** wired into `TokenIngestionJob` and does **not** drive Discord alerts.
- It is **not** part of any trading, signing, or execution path.

```bash
npm run build
npm run test:moralis:token
```

If `MORALIS_API_KEY` or `MORALIS_TEST_TOKEN_MINT` is missing, the script prints a safe-mode help block and exits 0.

### Outcome tracker — `track:token:outcome`

Built on the same `MoralisTokenEnrichmentService`, the outcome tracker persists a normalised snapshot of a configured mint into the local SQLite `token_outcomes` table. Each row captures `usdPrice`, `swapCount`, `firstSwapType`, `firstSwapExchange`, the `observedAt` timestamp, and the source provider name. Multiple runs accumulate rows per mint, which is what enables **backtesting** later (e.g. "did `LOW`-combined-risk tokens deliver positive `usdPrice` movement after detection?").

```env
MORALIS_API_KEY=<your moralis api key>
OUTCOME_TEST_TOKEN_MINT=<a Solana mainnet mint to track>
```

```bash
npm run build
npm run track:token:outcome
```

Inspect the persisted rows:
```bash
sqlite3 ./data/pumpfun-agent.sqlite "SELECT mint, datetime(observed_at/1000, 'unixepoch') AS observed_at, usd_price, swap_count, first_swap_type, first_swap_exchange, raw_source_provider FROM token_outcomes ORDER BY observed_at DESC LIMIT 20;"
```

The tracker is **read-only**: it does not buy, sell, sign, or submit transactions, does not send Discord alerts, and is not wired into `TokenIngestionJob`. Moralis is used here purely for enrichment and outcome capture, not for discovering new launches.

### Batch outcome tracker — `track:batch:outcomes`

Same persistence path as the single-mint tracker, but driven by a plain-text watchlist file so you can capture snapshots for many mints in one run.

```env
OUTCOME_WATCHLIST_PATH=./data/watchlist-mints.txt
OUTCOME_BATCH_DELAY_MS=500
```

**Create the watchlist** (the script will auto-create an empty template the first time you run it if the file is missing). Each non-empty, non-`#` line is treated as a Solana mint:

```
# data/watchlist-mints.txt
# One mint per line. Lines starting with # are comments.
5Bx97ZJSicb9GhNkKEPSJeSBvm3TVKznE7weotqqpump
2LXBtfu9z54fvESGSYSfCneRUbkMthirE7UeEihxpump
```

```bash
npm run build
npm run track:batch:outcomes
```

For each mint the script calls `MoralisTokenEnrichmentService.getTokenEnrichmentSnapshot(mint)`, writes one row to `token_outcomes`, logs a compact line (`mint`, `usdPrice`, `swapCount`, `saved`), and waits `OUTCOME_BATCH_DELAY_MS` (default 500 ms) before the next call. Failures on individual mints are logged with `saved: false` and the script keeps going.

**This consumes Moralis API quota** — every line in the watchlist costs one price call plus one swaps call, run on every invocation. Keep the watchlist scoped to the mints you actually want backtested, and re-run on whatever cadence makes sense for your tier (e.g. hourly via cron, or manually after each detection).

Run analysis later for any mint:

```bash
OUTCOME_TEST_TOKEN_MINT=<mint> npm run analyze:token:outcomes
```

This script is **read-only**: no trades, no signing, no Discord alerts, no changes to scoring/creator/ingestion logic.

## Next steps (Step 4 was implemented above; Step 5B and beyond — not implemented yet)

Step 5B will parse the raw log stream into `TokenLaunch` candidates and (behind a feature flag) replace `MockPumpFunProvider` for live ingestion. Trading, wallets, signing, and order execution remain explicitly out of scope.
