<#
  Lock down the NCSound Cloudflare pieces. Run from the repo root in PowerShell:

      powershell -ExecutionPolicy Bypass -File infra\cloudflare-lockdown.ps1

  What it does, in this order, and stops on the first failure:
    1. makes a random LIBRARY_TOKEN and TRANSCODE_TOKEN (never written to disk),
    2. sets them as Worker secrets and deploys ncsound-api and ncsound-transcode,
    3. checks the live API now answers 401 without the token and 200 with it,
    4. asks before turning off the public r2.dev URL of the ncsound-media bucket,
    5. prints the library token ONCE: paste it into the console, Settings -> R2 library token.

  Needs wrangler logged in (bunx wrangler whoami). NOT yet run: this file was written
  without a Windows shell to test it. Read it before you run it.
#>
$ErrorActionPreference = "Stop"
$root = (Get-Location).Path
if (-not (Test-Path "$root\workers\ncsound-api\wrangler.jsonc")) { throw "Run this from the repo root (the folder that contains workers\)." }

function New-Token {
  $b = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($b)
  return (($b | ForEach-Object { $_.ToString("x2") }) -join "")
}
function Run($what, [scriptblock]$cmd) {
  Write-Host "-> $what"
  & $cmd
  if ($LASTEXITCODE -ne 0) { throw "FAILED: $what (exit $LASTEXITCODE)" }
}

Run "wrangler is logged in" { bunx wrangler whoami | Out-Null }

$lib = New-Token
$tc = New-Token

Push-Location "$root\workers\ncsound-api"
try {
  Run "set LIBRARY_TOKEN on ncsound-api" { $lib | bunx wrangler secret put LIBRARY_TOKEN }
  Run "deploy ncsound-api" { bunx wrangler deploy }
} finally { Pop-Location }

Push-Location "$root\workers\ncsound-transcode"
try {
  Run "set TRANSCODE_TOKEN on ncsound-transcode" { $tc | bunx wrangler secret put TRANSCODE_TOKEN }
  Run "deploy ncsound-transcode (builds the container image; Docker must be running)" { bunx wrangler deploy }
} finally { Pop-Location }

# Verify against the live Worker.
$api = "https://ncsound-api.tap4500.workers.dev"
function Status($url, $headers) {
  try { return (Invoke-WebRequest -Uri $url -Headers $headers -UseBasicParsing -TimeoutSec 30).StatusCode }
  catch { if ($_.Exception.Response) { return [int]$_.Exception.Response.StatusCode } else { throw } }
}
Start-Sleep -Seconds 5
$noTok = Status "$api/library" @{}
$withTok = Status "$api/library" @{ Authorization = "Bearer $lib" }
Write-Host "GET /library without token: $noTok (want 401)"
Write-Host "GET /library with token:    $withTok (want 200)"
if ($noTok -ne 401 -or $withTok -ne 200) { throw "The live Worker is not locked as expected. Do NOT disable r2.dev yet." }

$ans = Read-Host "Turn OFF the public r2.dev URL for ncsound-media now? The console no longer needs it. (yes/no)"
if ($ans -eq "yes") {
  Run "disable r2.dev public access" { bunx wrangler r2 bucket dev-url disable ncsound-media }
  Write-Host "Check: the old pub-...r2.dev link should now stop serving files."
} else {
  Write-Host "Skipped. The bucket is still public until you disable it (Cloudflare dashboard -> R2 -> ncsound-media -> Settings -> Public Development URL)."
}

Write-Host ""
Write-Host "=============================================================="
Write-Host " LIBRARY TOKEN (shown once, not saved anywhere):"
Write-Host "   $lib"
Write-Host " Paste into the console: Settings -> R2 library token."
Write-Host " TRANSCODE TOKEN (nothing uses it yet; keep it if you want it):"
Write-Host "   $tc"
Write-Host "=============================================================="
