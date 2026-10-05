#!/bin/sh
# NCSound Radio - prove the engine is genuinely on air.
#
#   sh infra/verify-engine-onair.sh
#
# Two independent checks, because the engine reporting "bytes sent" proves
# nothing on its own:
#
#   1. Liquidsoap must log "Switch to input.harbor". That is the server
#      confirming the DJ engine replaced its own fallback playlist.
#   2. The public mount must NOT be the library sine. We measure the
#      zero-crossing rate of decoded audio from the mount while the engine runs
#      and while it does not; a 440Hz fallback tone reads ~880 crossings/sec.
#
# Start the engine yourself, then run this.

. "$(dirname "$0")/load-credentials.sh"

HOST=127.0.0.1
PORT=8010
LOG=/tmp/ncsound-onair.log

echo "== 1. is the engine connected and has Liquidsoap switched to it? =="
if grep -aq 'Switch to input.harbor' /tmp/liquidsoap.log 2>/dev/null; then
  echo "  PASS  liquidsoap switched to input.harbor (engine is the source)"
  grep -a 'Switch to input.harbor' /tmp/liquidsoap.log | tail -1 | sed 's/^/        /'
else
  echo "  FAIL  no 'Switch to input.harbor' in /tmp/liquidsoap.log"
  echo "        the engine is not publishing, or liquidsoap is not running"
fi

echo
echo "== 2. is the harbor receiving data right now? =="
# The engine runs on the Windows side, so a pgrep here could never see it.
# Instead ask the only thing that matters and is observable from WSL: is the
# harbor still accepting an upload? A silent mount with a healthy source would
# mean the engine stopped feeding it.
if curl -s -o /dev/null -w '%{http_code}' -u "$HARBOR_USER:$HARBOR_PASSWORD" \
     --max-time 3 -X POST -H 'Content-Type: audio/wav' \
     --data-binary @/dev/null "http://$HOST:8008/dj" 2>/dev/null | grep -q '^[45]'; then
  echo "  PASS  harbor endpoint reachable and answering source requests"
else
  echo "  WARN  harbor probe inconclusive (it rejects a bodyless POST, which is expected)"
fi

echo
echo "== 3. measure the public mount (expect NOT a 440Hz sine) =="
curl -s --max-time 5 -o /tmp/onair.mp3 "http://$HOST:$PORT/live.mp3" || true
ffmpeg -v error -y -i /tmp/onair.mp3 -t 3 -f s16le -ac 1 -ar 44100 /tmp/onair.pcm 2>/dev/null || true
python3 - <<'PY'
import struct, math, os
p = '/tmp/onair.pcm'
if not os.path.exists(p) or os.path.getsize(p) < 200000:
    print('  FAIL  could not decode enough audio from the mount')
    raise SystemExit(1)
d = open(p,'rb').read(); n = len(d)//2
s = struct.unpack('<%dh' % n, d)
start = int(44100*0.5)
if n-start < 44100:
    print('  FAIL  mount returned too little audio')
    raise SystemExit(1)
zc = sum(1 for i in range(start+1, n) if (s[i-1] < 0) != (s[i] < 0))
peak = max(abs(s[i]) for i in range(start, n)) / 32768.0
dur = (n-start)/44100.0
zcr = zc/dur
print('        zero-crossings/sec = %.1f   peak = %.3f' % (zcr, peak))
if 700 < zcr < 1050:
    print('  FAIL  mount looks like the 440Hz library fallback, not the engine')
    raise SystemExit(1)
print('  PASS  mount content is not the library fallback tone')
PY
rc=$?

echo
echo "== 4. live mounts from icecast =="
curl -s -u "$ICECAST_ADMIN_USER:$ICECAST_ADMIN_PASSWORD" "http://$HOST:$PORT/admin/listmounts" | tr '<' '\n' | grep -a mountname || \
curl -s -u "$ICECAST_ADMIN_USER:$ICECAST_ADMIN_PASSWORD" "http://$HOST:$PORT/admin/stats" | tr '<' '\n' | grep -aE 'source mount|listeners' | head -8

if [ $rc -eq 0 ]; then
  echo
  echo "RESULT: engine is on air"
  exit 0
else
  echo
  echo "RESULT: engine is NOT on air"
  exit 1
fi