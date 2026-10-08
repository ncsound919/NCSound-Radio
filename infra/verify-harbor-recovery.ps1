# Prove the station recovers from a dropped harbor connection.
#   pwsh -File infra/verify-harbor-recovery.ps1
#
# The failure this guards against: Liquidsoap drops the source, the publisher
# notices only on the next write, and nothing ever re-opened the upload. The
# engine kept reporting "playing" and Icecast kept serving its last buffered
# audio, so the station was silent with no symptom anywhere in the status.
param([int]$Port = 8137, [int]$TimeoutSec = 180)

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
  Write-Host "== kill Liquidsoap outright, and wait for the port to actually close =="
  # A restart that lands after the publisher has already reconnected tests
  # nothing. Wait until :8008 refuses connections so the drop is real.
  $ls = Start-Job -ScriptBlock {
    param($wsl)
    wsl.exe -u root -e sh -c "pkill -u liquidsoap -x liquidsoap" 2>&1 | Out-Null
    "killed"
  } -ArgumentList $wslRoot
  $d = Wait-Job $ls -Timeout 120
  if ($d) { (Receive-Job $ls) | ForEach-Object { "  $_" } } else { Stop-Job $ls }
  Remove-Job $ls -Force

  $deadline = (Get-Date).AddSeconds(60)
  $down = $false
  while ((Get-Date) -lt $deadline) {
    $open = (Test-NetConnection -ComputerName 127.0.0.1 -Port 8008 -WarningAction SilentlyContinue).TcpTestSucceeded
    if (-not $open) { $down = $true; break }
    Start-Sleep -Seconds 2
  }
  if (-not $down) { throw "harbor port never closed; the drop was not real" }
  Write-Host "  harbor port is closed - the source really dropped"

  Write-Host ""
  Write-Host "== bring Liquidsoap back =="
  $ls2 = Start-Job -ScriptBlock {
    param($wsl)
    wsl.exe -u root -e sh -c "'$wsl/infra/station-up.sh'" 2>&1 | Select-Object -Last 2
  } -ArgumentList $wslRoot
  $d2 = Wait-Job $ls2 -Timeout 300
  if ($d2) { (Receive-Job $ls2) | ForEach-Object { "  $_" } } else { Stop-Job $ls2 }
  Remove-Job $ls2 -Force

  Write-Host ""
  Write-Host "== recovery: assert audio resumes, not that a counter moved =="
  # The outcome that matters is audible output again. Whether that happened via
  # the publisher reconnecting or the socket surviving is an implementation
  # detail; a test that only watches `reconnects` fails when the OS transparently
  # reaps a dead socket and the station never notices.
  $deadline = (Get-Date).AddSeconds(120)
  $resumed = $false
  $last = (Harbor).bytesSent
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5
    $now = (Harbor)
    if ($now -and $now.connected -and $now.bytesSent -gt $last) { $resumed = $true; break }
    $last = if ($now) { $now.bytesSent } else { 0 }
  }

  $h = Harbor
  if (-not $resumed) {
    "  DID NOT RESUME: connected=$($h.connected) reconnects=$($h.reconnects) err=$($h.lastError)"
    throw "audio did not resume after a real harbor drop"
  }
  "  audio flowing   : connected=$($h.connected) reconnects=$($h.reconnects) bytes=$($h.bytesSent)"
  Write-Host ""
  Write-Host "== PASS =="
}
finally {
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}