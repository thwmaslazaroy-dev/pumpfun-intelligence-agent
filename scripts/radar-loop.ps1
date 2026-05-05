$ErrorActionPreference = "Continue"

function Invoke-Step {
    param (
        [string]$Name,
        [scriptblock]$Command
    )

    Write-Host ""
    Write-Host "=== $Name ==="

    & $Command
    $code = $LASTEXITCODE

    if ($null -eq $code) {
        $code = 0
    }

    if ($code -eq 88) {
        Write-Host "API/RPC limit reached. Stopping radar loop."
        exit 88
    }

    if ($code -ne 0) {
        Write-Warning "$Name exited with code $code. Non-limit error, continuing."
    }
}

while ($true) {
    Invoke-Step "radar scan" {
        npm run radar:scan
    }

    Invoke-Step "generate budgeted watchlist" {
        npm run generate:budgeted:watchlist
    }

    Invoke-Step "track batch outcomes" {
        $env:OUTCOME_WATCHLIST_PATH = "./data/budgeted-outcome-watchlist.txt"
        npm run track:batch:outcomes
    }

    Invoke-Step "preview high-confidence alerts" {
        npm run preview:high-confidence:alerts
    }

    Invoke-Step "send discord high-confidence alerts" {
        npm run send:discord:high-confidence
    }

    Write-Host ""
    Write-Host "--- sleeping 600s ---"
    Start-Sleep -Seconds 600
}
