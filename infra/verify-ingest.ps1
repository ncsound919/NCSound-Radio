# NCSound Radio - end-to-end check of the ingest service.
#
#   pwsh -File infra/verify-ingest.ps1
#
# The ingest service is a WINDOWS process (it owns the node-web-audio-api
# engine); only Liquidsoap and Icecast live in WSL. So this whole check runs
# on Windows, and talks to Icecast through the WSL localhost relay on :8010.

param(
  [int]$Port = 8099,
  [int]$TimeoutSec = 90
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$ingest = "http://127.0.0.1:$Port"
$log = Join-Path $env:TEMP "ncsound-ingest.log"

Write-Host "== starting ingest =="
if (Test-Path $log) { Remove-Item $log -Force }
$env:NCSOUND_LIBRARY = Join-Path $root "library"
$proc = Start-Process -FilePath "bun" `
  -ArgumentList "run", "src/main.ts" `
  -WorkingDirectory (Join-Path $root "packages\ingest") `
  -RedirectStandardOutput $log -RedirectStandardError "$log.err" `
  -PassThru -NoNewWindow

try {
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $health = $null
  while ((Get-Date) -lt $deadline) {
    if ($proc.HasExited) { throw "ingest exited early with code $($proc.ExitCode)" }
    try {
      $h = Invoke-RestMethod "$ingest/health" -TimeoutSec 3
      # Wait for readiness, not just for the port: the crate takes time to decode.
      if ($h.ready) { $health = $h; break }
    } catch {}
    Start-Sleep -Seconds 1
  }
  if (-not $health) { throw "ingest never became ready within $TimeoutSec s" }

  Write-Host "== health =="
  $health | ConvertTo-Json -Compress

  Write-Host "== engine state + stream state =="
  $s = Invoke-RestMethod "$ingest/status" -TimeoutSec 10
  $e = $s.engine
  "  state          : {0}" -f $e.state
  "  onAir track    : {0}" -f (($e.onAir.current.track | ForEach-Object { $_.title }) -join "")
  "  onAir artist   : {0}" -f $e.onAir.current.track.artist
  "  onAir progress : {0:N3}" -f $e.onAir.current.progress
  "  deck0 bpm      : {0}" -f $e.telemetry.decks[0].bpm
  "  deck0 key      : {0}" -f $e.telemetry.decks[0].key
  "  deck0 playing  : {0}" -f $e.telemetry.decks[0].playing
  "  crateSize      : {0}" -f $e.autopilot.crateSize
  "  spectrum bins  : {0}" -f $e.telemetry.spectrum.Count
  "  cpuMsPerBlock  : {0:N3}" -f $e.telemetry.cpuMsPerBlock
  "  listeners      : {0} (source={1}, peak24h={2})" -f $e.listeners.current, $e.listeners.source, $e.listeners.peak24h
  "  uptimeSec      : {0:N1}" -f $e.uptimeSec
  if ($s.stream) {
    "  icecast        : {0} reachable={1}" -f $s.stream.icecast.version, $s.stream.icecast.reachable
    foreach ($m in $s.stream.mounts) {
      "    mount        : {0} {1}kbps listeners={2} peak={3} meta={4}" -f $m.mount, $m.bitrateKbps, $m.listeners, $m.peakListeners24h, $m.lastMetadata
    }
  } else {
    "  stream         : (no poll yet)"
  }

  Write-Host "== command over HTTP =="
  $cmd = Invoke-RestMethod "$ingest/command" -Method Post -ContentType "application/json" -Body (@{
      actor   = @{ id = "probe"; role = "ops"; label = "probe" }
      command = @{ type = "mix.setCrossfader"; position = 0.25 }
    } | ConvertTo-Json -Depth 5)
  "  ok={0} applied={1} live={2}" -f $cmd.ok, $cmd.result.applied, $cmd.result.live

  Write-Host "== a bad command fails loudly =="
  try {
    Invoke-RestMethod "$ingest/command" -Method Post -ContentType "application/json" -Body (@{
        actor   = @{ id = "probe"; role = "ops"; label = "probe" }
        command = @{ type = "cue.track"; trackId = "nope" }
      } | ConvertTo-Json -Depth 5) | Out-Null
    throw "expected the request to fail"
  } catch {
    $body = $_.ErrorDetails.Message | ConvertFrom-Json
    "  rejected       : ok={0} code={1} error={2}" -f $body.ok, $body.code, $body.error
  }

  Write-Host "== command over WebSocket =="
  $py = @"
import asyncio, base64, json, os, sys
import websockets
async def main():
    async with websockets.connect('ws://127.0.0.1:$Port/ws') as ws:
        ready = json.loads(await asyncio.wait_for(ws.recv(), 10))
        print('  first frame    :', ready['type'])
        await ws.send(json.dumps({'actor': {'id': 'console', 'label': 'probe'},
                                  'command': {'type': 'sync.masterBpm', 'bpm': 126}}))
        got = None
        for _ in range(5):
            msg = json.loads(await asyncio.wait_for(ws.recv(), 10))
            if msg['type'] == 'command.result':
                got = msg['result']; break
        print('  ws result ok  :', got['ok'] if got else 'NO RESULT')
        print('  ws result     :', json.dumps(got)[:160] if got else '-')
asyncio.run(main())
"@
  $pyFile = Join-Path $env:TEMP "ncsound_ws_probe.py"
  Set-Content -LiteralPath $pyFile -Value $py -Encoding utf8
  & python $pyFile
  if ($LASTEXITCODE -ne 0) { "  (websockets module unavailable; skipped)" }

  Write-Host ""
  Write-Host "== ingest log tail =="
  if (Test-Path $log) { Get-Content $log -Tail 12 }

  Write-Host "== PASS =="
}
finally {
  if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}