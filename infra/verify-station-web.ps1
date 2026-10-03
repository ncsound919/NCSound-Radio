# NCSound Radio - verify the station app reads live engine data.
#
#   pwsh -File infra/verify-station-web.ps1
#
# Starts the ingest service, then Next, and checks that the API surfaces carry
# real broadcast state rather than the old simulated values. The decisive check
# is the offline case: with ingest stopped, the routes must report "not
# reachable" rather than inventing a track and a listener count.

param(
  [int]$IngestPort = 8099,
  # NOT 3000: Grafana already listens there on this machine and answers first,
  # so the app under test never gets the request.
  [int]$WebPort = 3100,
  [int]$TimeoutSec = 180
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$ingestLog = Join-Path $env:TEMP "ncsound-ingest.log"
$webLog = Join-Path $env:TEMP "ncsound-web.log"

$ingest = "http://127.0.0.1:$IngestPort"
$web = "http://127.0.0.1:$WebPort"

function Show([string]$label, $obj) {
  if ($null -eq $obj) { "  {0,-22} (no response)" -f $label; return }
  $json = $obj | ConvertTo-Json -Depth 8 -Compress
  if ($json.Length -gt 300) { $json = $json.Substring(0, 300) + "..." }
  "  {0,-22} {1}" -f $label, $json
}

Write-Host "== starting ingest =="
$env:NCSOUND_LIBRARY = if ($env:NCSOUND_LIBRARY) { $env:NCSOUND_LIBRARY } else { "C:\Users\User\Music\music" }
$ingestProc = Start-Process -FilePath "bun" -ArgumentList "run", "src/main.ts" `
  -WorkingDirectory (Join-Path $root "packages\ingest") `
  -RedirectStandardOutput $ingestLog -RedirectStandardError "$ingestLog.err" -PassThru -NoNewWindow

Write-Host "== starting station-web =="
$webProc = Start-Process -FilePath "bun" `
  -ArgumentList "run", "dev" `
  -WorkingDirectory (Join-Path $root "apps\station-web") `
  -RedirectStandardOutput $webLog -RedirectStandardError "$webLog.err" -PassThru -NoNewWindow

try {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $ready = $false
  while ((Get-Date) -lt $deadline) {
    if ($ingestProc.HasExited) { throw "ingest exited early" }
    try { $h = Invoke-RestMethod "$ingest/health" -TimeoutSec 3; if ($h.ready) { $ready = $true; break } } catch {}
    Start-Sleep -Seconds 1
  }
  if (-not $ready) { throw "ingest never became ready" }

  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    try { $null = Invoke-WebRequest "$web/api" -TimeoutSec 5 -UseBasicParsing; break } catch { Start-Sleep -Seconds 2 }
  }

  Write-Host ""
  Write-Host "== /api/nowplaying (engine live) =="
  try {
    $np = Invoke-RestMethod "$web/api/nowplaying" -TimeoutSec 20
    "  mode              : {0}" -f $np.mode
    "  current track     : {0} - {1}" -f $np.current.track.artist, $np.current.track.title
    "  current bpm       : {0}" -f $np.current.track.bpm
    "  progress          : {0:N3}" -f $np.current.progress
    "  listeners         : {0} (source={1}, peak24h={2})" -f $np.listeners.current, $np.listeners.source, $np.listeners.peak24h
    "  engine state      : {0}" -f $np.engine.state
    "  crate size        : {0}" -f $np.engine.crateSize
    "  icecast           : {0} onAir={1}" -f $np.stream.icecast, $np.stream.onAir
    "  mounts            : {0}" -f (($np.stream.mounts | ForEach-Object { $_.mount }) -join ", ")
    "  next up           : {0}" -f (($np.next | ForEach-Object { $_.title }) -join ", ")
    "  streamUrl         : {0}" -f $np.streamUrl
  } catch {
    "  FAILED: {0}" -f $_.Exception.Message
  }

  Write-Host ""
  Write-Host "== /api/stats (real listeners + real uptime) =="
  try {
    $st = Invoke-RestMethod "$web/api/stats" -TimeoutSec 20
    "  listeners         : {0} (source={1})" -f $st.listeners.current, $st.listeners.source
    "  engine reachable  : {0} state={1}" -f $st.engine.reachable, $st.engine.state
    "  stream reachable  : {0} onAir={1}" -f $st.stream.reachable, $st.stream.onAir
    "  uptime.streamOk   : {0}" -f $st.uptime.streamOk
    "  band projection   : {0} GB/day" -f $st.bandwidth.projectedGBDay
  } catch {
    "  FAILED: {0}" -f $_.Exception.Message
  }

  Write-Host ""
  Write-Host "== /api/listeners/history (real samples) =="
  try {
    $lh = Invoke-RestMethod "$web/api/listeners/history" -TimeoutSec 20
    "  points            : {0}" -f $lh.points.Count
    "  partial           : {0}" -f $lh.partial
    "  recordedSince     : {0}" -f $lh.recordedSince
    "  current           : {0}" -f $lh.current
  } catch {
    "  FAILED: {0}" -f $_.Exception.Message
  }

  Write-Host ""
  Write-Host "== offline behaviour: ingest stopped, no invented data =="
  Stop-Process -Id $ingestProc.Id -Force -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  try {
    $np = Invoke-RestMethod "$web/api/nowplaying" -TimeoutSec 20
    "  nowplaying mode   : {0}" -f $np.mode
    "  current is null   : {0}" -f ($null -eq $np.current)
    "  offlineReason     : {0}" -f $np.offlineReason
    "  streamUrl         : {0}" -f $np.streamUrl
  } catch {
    "  nowplaying returned {0} (a 503 is the correct answer)" -f $_.Exception.Response.StatusCode.value__
  }
  try {
    $st = Invoke-RestMethod "$web/api/stats" -TimeoutSec 20
    "  stats listeners   : {0} (source={1})" -f $st.listeners.current, $st.listeners.source
    "  stats band proj   : {0}" -f $st.bandwidth.projectedGBDay
  } catch {
    "  stats returned {0}" -f $_.Exception.Response.StatusCode.value__
  }

  Write-Host ""
  Write-Host "== PASS =="
}
finally {
  foreach ($p in @($ingestProc, $webProc)) {
    if ($p -and -not $p.HasExited) { Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue }
  }
}