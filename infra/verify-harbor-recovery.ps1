# Prove the station recovers from a dropped harbor connection.
#   pwsh -File infra/verify-harbor-recovery.ps1
#
# The failure this guards against: Liquidsoap drops the source, the publisher
# notices only on the next write, and nothing ever re-opened the upload. The
# engine kept reporting "playing" and Icecast kept serving its last buffered
# audio, so the station was silent with no symptom anywhere in the status.
param([int]$Port = 8099, [int]$TimeoutSec = 180)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$log = Join-Path $env:TEMP "ncsound-harbor-test.log"

# WSL needs a /mnt/... path, and this repo path contains spaces, so it has to be
# quoted inside the shell command rather than passed bare.
$wslRoot = "/mnt/" + ($root -replace '\\', '/').Substring(0,1).ToLower() + ($root -replace '\\', '/').Substring(2)

function Harbor {
  try { return (Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 6).harbor } catch { return $null }
}

Write-Host "== starting ingest =="
if (Test-Path $log) { Remove-Item $log -Force }
$env:NCSOUND_LIBRARY = "C:\Users\User\Music\music"
$proc = Start-Process -FilePath "bun" -ArgumentList "run", "src/main.ts" `
  -WorkingDirectory (Join-Path $root "packages\ingest") `
  -RedirectStandardOutput $log -RedirectStandardError "$log.err" -PassThru -NoNewWindow

try {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) { throw "ingest exited early" }
    $h = Harbor
    if ($h -and $h.connected -and $h.bytesSent -gt 0) { break }
    Start-Sleep -Seconds 1
  }
  $h = Harbor
  if (-not $h) { throw "ingest never reported harbor state" }

  Write-Host ""
  Write-Host "== baseline =="
  "  connected   : $($h.connected)"
  "  bytesSent   : $($h.bytesSent)"
  "  reconnects  : $($h.reconnects)"
  $before = $h.bytesSent
  Start-Sleep -Seconds 4
  $mid = (Harbor).bytesSent
  "  after 4s    : $mid bytes (delta $($mid - $before))"
  if ($mid -le $before) { throw "bytes are not advancing: audio is not reaching Liquidsoap" }
  Write-Host "  AUDIO IS FLOWING"

  Write-Host ""
  Write-Host "== restart Liquidsoap to force a drop =="
  # Through station-up.sh, which drops privileges with setpriv. Running
  # liquidsoap as root just exits with "security exit, root euid & guid" and
  # tests nothing.
  $ls = Start-Job -ScriptBlock {
    param($wsl)
    wsl.exe -u root -e sh -c "'$wsl/infra/station-down.sh'" 2>&1 | Out-Null
    Start-Sleep 2
    wsl.exe -u root -e sh -c "'$wsl/infra/station-up.sh'" 2>&1 | Select-Object -Last 4
  } -ArgumentList $wslRoot
  $d = Wait-Job $ls -Timeout 300
  if ($d) { (Receive-Job $ls) | ForEach-Object { "  $_" } } else { Stop-Job $ls; "  (restart did not report in time)" }
  Remove-Job $ls -Force

  Write-Host ""
  Write-Host "== recovery =="
  $deadline = (Get-Date).AddSeconds(90)
  $recovered = $false
  while ((Get-Date) -lt $deadline) {
    $h = Harbor
    if ($h -and $h.connected -and $h.reconnects -gt 0) { $recovered = $true; break }
    Start-Sleep -Seconds 2
  }

  $h = Harbor
  if (-not $recovered) {
    "  DID NOT RECOVER: connected=$($h.connected) reconnects=$($h.reconnects) nextRetry=$($h.nextRetryAtMs) err=$($h.lastError)"
    throw "harbor did not reconnect after the drop"
  }
  "  recovered   : connected=$($h.connected) reconnects=$($h.reconnects)"
  Start-Sleep -Seconds 5
  $after = (Harbor).bytesSent
  "  bytesSent   : $after (was $before before the drop)"
  if ($after -le 0) { throw "reconnected but no bytes are flowing" }
  Write-Host "  AUDIO IS FLOWING AGAIN"
  Write-Host ""
  Write-Host "== PASS =="
}
finally {
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}