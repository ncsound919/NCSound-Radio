#!/bin/sh
# NCSound Radio - start the broadcast engine.
#
#   sh infra/engine-up.sh          # detached, verifies /status answers
#   sh infra/engine-up.sh -f       # foreground
#
# WHY THIS SCRIPT USES WINDOWS BUN
#
# It used to run `bun packages/dj-engine/src/run.ts` inside WSL and had never
# worked: WSL has no bun on PATH, so every attempt died immediately with
# `nohup: failed to run command 'bun': No such file or directory`, and the log
# said so while the station carried on in silence. (WSL's HOME is also the
# mangled string `C:UsersUser` on this machine, so a stray Windows PATH lookup
# resolves nowhere.)
#
# The deeper point is that this script was starting the wrong process. The
# broadcast engine is not a separate daemon here — it runs in-process inside the
# ingest service, which is what owns the harbor upload and publishes /status.
# Starting dj-engine/src/run.ts produced a second, headless engine that nothing
# supervised and that could not report status; the README already warned that it
# exposes no /status.
#
# So the thing to start is ingest, and ingest must run on Windows because that is
# where bun, ffmpeg and the operator's music library are.

set -e

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
WINDOWS_BUN=/mnt/c/Users/User/.bun/bin/bun.exe
PORT=8099
LOG=/tmp/ingest.log

# WSL interop has to be able to launch Windows binaries at all.
if [ ! -x "$WINDOWS_BUN" ]; then
  echo "engine-up: cannot find bun.exe at $WINDOWS_BUN" >&2
  echo "  This script starts the Windows-side ingest service, which owns the" >&2
  echo "  broadcast engine. Run it from Windows instead:" >&2
  echo "    bun run --cwd packages/ingest start" >&2
  exit 1
fi

# Refuse to double-start. Two ingests means two engines, two harbor uploads and
# two sets of answers to "are we on air".
#
# The probe runs through bun.exe rather than WSL's curl on purpose: WSL2's
# localhost relay does not reliably reach a listener bound on the Windows side,
# so a curl here reports "not running" about a service that is plainly running.
# Asking from the same side as the listener is the only honest check.
probe() {
  "$WINDOWS_BUN" -e "const r = await fetch('http://127.0.0.1:$PORT/$1').catch(() => null); if (!r || !r.ok) process.exit(1); const j = await r.json().catch(() => null); console.log(JSON.stringify(j));"
}

if probe health >/dev/null 2>&1; then
  echo "engine-up: already running on :$PORT (health answered) - not starting a second"
  probe status | tr ',' '\n' | grep -E '"(state|onAir|reason)"' | head -6
  exit 0
fi

cd "$REPO_DIR"

if [ "$1" = "-f" ]; then
  exec "$WINDOWS_BUN" run --cwd packages/ingest src/main.ts
fi

echo "== starting ingest (owns the broadcast engine) =="
setsid "$WINDOWS_BUN" run --cwd packages/ingest src/main.ts > "$LOG" 2>&1 < /dev/null &
echo $! > /tmp/ncsound-ingest.pid

# The engine decodes the library before it is useful, so this is not a formality:
# answering /health too early reports a station that cannot yet play anything.
i=0
while [ "$i" -lt 90 ]; do
  if probe status >/dev/null 2>&1; then
    echo "engine up (pid $(cat /tmp/ncsound-ingest.pid)), log $LOG"
    echo "  status:"
    probe status | tr ',' '\n' | grep -E '"(state|onAir|reason|crateSize)"' | head -8
    exit 0
  fi
  sleep 1
  i=$((i + 1))
done

echo "engine FAILED to answer /status within ${i}s:" >&2
tail -20 "$LOG" >&2
exit 1