#!/bin/sh
# WAVC 91.3 - run the headless DJ engine.
#
#   sh infra/engine-up.sh      # foreground
#   sh infra/engine-up.sh -d   # detached, logs to /tmp/dj-engine.log
#
# The engine renders Party DJ's mixer with no audio device and publishes PCM
# into Liquidsoap's harbor on :8008. Requires liquidsoap to already be up
# (infra/station-up.sh) or the harbor connection is refused and the engine
# keeps rendering locally.

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
ENGINE="$REPO_DIR/packages/dj-engine/src/run.ts"

cd "$REPO_DIR"

if [ "$1" = "-d" ]; then
  pkill -f 'dj-engine/src/run.ts' 2>/dev/null || true
  sleep 1
  setsid bun "$ENGINE" > /tmp/dj-engine.log 2>&1 < /dev/null &
  sleep 4
  if pgrep -f 'dj-engine/src/run.ts' > /dev/null; then
    echo "engine up (pid $(pgrep -f 'dj-engine/src/run.ts' | head -1)), log /tmp/dj-engine.log"
    tail -6 /tmp/dj-engine.log
  else
    echo "engine FAILED:"
    cat /tmp/dj-engine.log
    exit 1
  fi
else
  exec bun "$ENGINE"
fi