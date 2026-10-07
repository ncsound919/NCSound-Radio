#!/bin/bash
# One-shot real-chain go-live test (Icecast + Liquidsoap + ingest + console).
# Paths are for the test VM: user-space Icecast 2.4.4 (Ubuntu deb) and
# Liquidsoap 2.2.5 (official jammy build), rendered configs in $STATION.
# Usage: scripts/station-run.sh <reportDir>
set -u
OUT=${1:-/tmp/e2e}; mkdir -p "$OUT"; rm -f "$OUT"/*
STATION=${STATION:-$HOME/station}; R=$HOME/radio-pkgs/root; L=$HOME/ls22/root
CONSOLE=$(cd "$(dirname "$0")/.." && pwd)
export LD_LIBRARY_PATH_CHAIN=$R/usr/lib/x86_64-linux-gnu
pids=()
cleanup() { for p in "${pids[@]}"; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; }
trap cleanup EXIT
rm -f "$STATION"/log/*
LD_LIBRARY_PATH=$LD_LIBRARY_PATH_CHAIN "$R/usr/bin/icecast2" -c "$STATION/icecast.xml" >"$OUT/icecast.out" 2>&1 & pids+=($!)
sleep 1.5
(cd "$L/usr/share/liquidsoap/libs" && LD_LIBRARY_PATH=$LD_LIBRARY_PATH_CHAIN exec "$L/usr/bin/liquidsoap" --no-stdlib stdlib.liq "$STATION/ncsound.liq") >"$OUT/liquidsoap.log" 2>&1 & pids+=($!)
# Wait for the harbor to listen before connecting the autopilot stand-in
# (a first version raced it, got "connection refused", and measured nothing).
for i in $(seq 1 60); do (exec 3<>/dev/tcp/127.0.0.1/8008) 2>/dev/null && break; sleep 0.25; done
ffmpeg -nostdin -loglevel error -re -f lavfi -i "sine=f=660" -c:a libmp3lame -b:a 128k -content_type audio/mpeg -f mp3 icecast://engine:harborpw-sandbox@127.0.0.1:8008/dj >"$OUT/autopilot-standin.log" 2>&1 & ENGINE=$!; pids+=($ENGINE)
python3 "$CONSOLE/scripts/station-probe.py" http://127.0.0.1:8010/live.mp3 "$OUT/probe.jsonl" & pids+=($!)
cd "$CONSOLE"
LIVE_HARBOR_PASSWORD=livepw-sandbox "$HOME/.bunpkg/node_modules/.bin/bun" scripts/live-harness.ts 8299 "$OUT/unused.wav" --real >"$OUT/ingest.log" 2>&1 & pids+=($!)
export PATH=$CONSOLE/node_modules/.bin:$PATH
INGEST_URL=http://127.0.0.1:8299 vite --port 3102 --host 127.0.0.1 >"$OUT/vite.log" 2>&1 & pids+=($!)
sleep 4
# The engine harbor pre-buffers 12 s (ncsound.liq buffer=12.); start once the
# listener actually hears the autopilot tone, so fallbacks have it to land on.
for i in $(seq 1 100); do grep -q '"dom": 660' "$OUT/probe.jsonl" 2>/dev/null && break; sleep 0.25; done
grep -q '"dom": 660' "$OUT/probe.jsonl" && echo "autopilot stand-in on air" || echo "WARNING: autopilot stand-in never reached the listener"
export LD_LIBRARY_PATH=$(ls -d $HOME/libs/*/usr/lib/x86_64-linux-gnu 2>/dev/null | tr '\n' ':')$HOME/libs/lib
export PW_CHROMIUM=$HOME/pw-browsers/chromium-1140/chrome-linux/chrome
node scripts/station-e2e.mjs http://127.0.0.1:3102 8300 "$OUT/events.json"
# Last: kill the autopilot feed and see the library take over.
KILLED=$(date +%s%3N); kill $ENGINE
sleep 22
unset LD_LIBRARY_PATH
python3 scripts/station-e2e-report.py "$OUT/events.json" "$OUT/probe.jsonl" "$KILLED"
echo "--- liquidsoap source switches ---"
grep -E "Switch to|connected|disconnect|timeout|Timeout" "$OUT/liquidsoap.log" | grep -v "need more buffering" | tail -40
