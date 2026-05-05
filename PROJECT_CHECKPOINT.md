# Pumpfun Intelligence Agent — Checkpoint

## Current status
- Parser fixed and validated against real Pump.fun CREATE transactions.
- Standalone live discovery works.
- Pre-filter is active: fetch only logs containing CREATE markers.
- Clean live validation run:
  - total live CREATE rows: 29
  - creatorWallet non-null: 29
  - creatorWallet is not mint/program id
  - rpcRateLimitErrors: 0
  - parseErrors: 0
  - queueLength: 0
- Mock pipeline must remain working.

## Completed
- Step A: parser fixed.
- Step B: standalone live detector.
- Step B.1: categorized errors.
- Step B.2: pre-filter to avoid useless RPC requests.
- Step C: creatorWallet extraction + validation script.

## Next
Step D:
Live CREATE events → TokenLaunch provider → dry-run scoring/storage.

## Safety rules
- Default ingestion source must remain mock.
- Live mode must be explicit.
- Discord alerts disabled in live dry-run.
- No trading.
- No wallet/private key/signing.
- Do not modify scoring logic unless explicitly asked.
- Do not modify alert logic unless explicitly asked.
- Do not scan the full repository.
- Ask for allowed files before reading or editing.
