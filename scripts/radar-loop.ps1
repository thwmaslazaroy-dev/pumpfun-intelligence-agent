# radar-loop.ps1
# Full 24/7 pipeline loop. Runs every $SLEEP_SECONDS.
# A single step failure logs the error and continues to the next step.
# Exit code 88 from any step = API/RPC limit hit → stops the loop entirely.

$ErrorActionPreference = "Continue"
$SLEEP_SECONDS = 600

# ── Logging ───────────────────────────────────────────────────────────────────

function Write-Log([string]$msg) {
    $ts = Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ"
    Write-Host "[$ts] $msg"
}

# ── Step runner ───────────────────────────────────────────────────────────────

function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Command
    )

    Write-Log ">>> START $Name"
    $sw = [System.Diagnostics.Stopwatch]::StartNew()

    try {
        & $Command
        $code = if ($null -ne $LASTEXITCODE) { $LASTEXITCODE } else { 0 }
    } catch {
        $code = 1
        Write-Log "!!! EXCEPTION in $Name : $_"
    }

    $sw.Stop()
    $elapsed = [math]::Round($sw.Elapsed.TotalSeconds, 1)

    if ($code -eq 88) {
        Write-Log "!!! $Name returned code 88 (API/RPC rate limit). Stopping loop."
        exit 88
    }

    if ($code -ne 0) {
        Write-Log "!!! FAIL $Name (exit=$code, elapsed=${elapsed}s) — continuing cycle"
    } else {
        Write-Log "<<< OK   $Name (elapsed=${elapsed}s)"
    }
}

# ── Main loop ─────────────────────────────────────────────────────────────────

Write-Log "=== radar-loop starting (sleep=${SLEEP_SECONDS}s between cycles) ==="

while ($true) {
    $cycleStart = [System.Diagnostics.Stopwatch]::StartNew()
    Write-Log "--- CYCLE START ---"

    # Step 1: Fetch newly created tokens from Pump.fun created-feed (primary ingestion)
    Invoke-Step "fetch:pumpfun:created-feed" {
        npm run radar:fetch:pumpfun:created-feed
    }

    # Step 2: Optional on-chain RPC scan (secondary / diagnostic)
    Invoke-Step "radar:scan" {
        npm run radar:scan
    }

    # Step 3: Select tokens worth tracking for outcome measurement
    Invoke-Step "generate:budgeted:watchlist" {
        npm run generate:budgeted:watchlist
    }

    # Step 4: Track price/swap outcomes for watchlist tokens (via Moralis)
    Invoke-Step "track:batch:outcomes" {
        $env:OUTCOME_WATCHLIST_PATH = "./data/budgeted-outcome-watchlist.txt"
        npm run track:batch:outcomes
    }

    # Step 5: Evaluate holder concentration via Helius RPC (skips gracefully if no API key)
    Invoke-Step "evaluate:holder-risk" {
        $env:OUTCOME_WATCHLIST_PATH  = "./data/budgeted-outcome-watchlist.txt"
        $env:HOLDER_RISK_MAX_TOKENS  = "5"
        npm run evaluate:holder-risk
    }

    # Step 6: Score every recent token and produce alert candidates
    Invoke-Step "preview:high-confidence:alerts" {
        npm run preview:high-confidence:alerts
    }

    # Step 7: Send any HIGH_PRIORITY_ALERT to Discord (no-op if none)
    Invoke-Step "send:discord:high-confidence" {
        npm run send:discord:high-confidence
    }

    $cycleStart.Stop()
    $cycleSec = [math]::Round($cycleStart.Elapsed.TotalSeconds, 1)
    Write-Log "--- CYCLE DONE (${cycleSec}s total) — sleeping ${SLEEP_SECONDS}s ---"
    Start-Sleep -Seconds $SLEEP_SECONDS
}
