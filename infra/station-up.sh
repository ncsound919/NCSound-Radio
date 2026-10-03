#!/bin/sh
# WAVC 91.3 - start Icecast + Liquidsoap in WSL2.
#
#   sh infra/station-up.sh          # start both
#   sh infra/station-down.sh        # stop both
#
# Liquidsoap encodes and ingests; Icecast serves the public mounts. The DJ
# engine pushes audio into Liquidsoap on :8008 (see infra/liquidsoap/wavc.liq).
#
# Both daemons are detached with setsid so they survive this script, and
# Liquidsoap gets ~6s to boot its stdlib before we judge it up.

set -e

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
LIB=/srv/wavc/library
ICECAST_CFG=/etc/icecast2/icecast.xml

echo "== preparing paths =="
mkdir -p "$LIB" /usr/local/icecast/logs /var/log/icecast2
chown -R icecast2:icecast /usr/local/icecast /var/log/icecast2 2>/dev/null || true

# This Icecast build resolves <webroot>/<adminroot> against its compiled-in
# prefix (/usr/local/icecast) rather than the config values, so seed those
# directories from the packaged XSLs.
mkdir -p /usr/local/icecast/webroot /usr/local/icecast/admin
cp -f /usr/share/icecast2/web/*.xsl   /usr/local/icecast/webroot/ 2>/dev/null || true
cp -f /usr/share/icecast2/web/*.css   /usr/local/icecast/webroot/ 2>/dev/null || true
cp -f /usr/share/icecast2/admin/*.xsl /usr/local/icecast/admin/   2>/dev/null || true
chown -R icecast2:icecast /usr/local/icecast

if [ -z "$(ls -A "$LIB" 2>/dev/null)" ]; then
  echo "   library empty - generating a 10s placeholder tone"
  sox -n -r 44100 -c 2 -b 16 "$LIB/placeholder.wav" synth 10 sine 220 2>/dev/null || true
fi

echo "== starting icecast =="
cp "$REPO_DIR/infra/icecast/icecast.xml" "$ICECAST_CFG"
pkill -u icecast2 -x icecast2 2>/dev/null || true
sleep 1
setsid setpriv --reuid=icecast2 --regid=icecast --clear-groups \
  icecast2 -c "$ICECAST_CFG" > /tmp/icecast.log 2>&1 < /dev/null &
sleep 3
pgrep -u icecast2 -x icecast2 > /dev/null \
  || { echo "   icecast FAILED:"; tail -20 /tmp/icecast.log; exit 1; }
echo "   icecast up (pid $(pgrep -u icecast2 -x icecast2 | head -1))"

echo "== validating liquidsoap config =="
if liquidsoap --check "$REPO_DIR/infra/liquidsoap/wavc.liq" > /tmp/ls-check.log 2>&1; then
  echo "   wavc.liq ok"
else
  echo "   liquidsoap config INVALID:"; cat /tmp/ls-check.log; exit 1
fi

echo "== starting liquidsoap =="
pkill -u liquidsoap -x liquidsoap 2>/dev/null || true
sleep 1
setsid setpriv --reuid=liquidsoap --regid=liquidsoap --clear-groups \
  liquidsoap "$REPO_DIR/infra/liquidsoap/wavc.liq" > /tmp/liquidsoap.log 2>&1 < /dev/null &

# Liquidsoap loads its stdlib and typechecks the script: ~6s.
i=0
while [ $i -lt 30 ]; do
  pgrep -u liquidsoap -x liquidsoap > /dev/null && break
  i=$((i + 1))
  sleep 1
done
sleep 4
pgrep -u liquidsoap -x liquidsoap > /dev/null \
  || { echo "   liquidsoap FAILED:"; tail -25 /tmp/liquidsoap.log; exit 1; }

# The harbor mountpoint is the last thing to come up.
i=0
while [ $i -lt 20 ]; do
  if grep -q "Adding mountpoint '/dj'" /tmp/liquidsoap.log 2>/dev/null; then break; fi
  i=$((i + 1))
  sleep 1
done
echo "   liquidsoap up (pid $(pgrep -u liquidsoap -x liquidsoap | head -1))"

echo
echo "== live mounts =="
curl -s -u admin:REDACTED http://127.0.0.1:8000/admin/status.xml \
  | tr '<' '\n' | grep -Ei 'source_name|listenurl|listener_peak' | sed 's/^/   /' || true
echo
echo "   curl http://127.0.0.1:8000/live.mp3    # 128k"
echo "   curl http://127.0.0.1:8000/mobile.mp3  # 64k"
echo "   telnet 127.0.0.1 1234                  # liquidsoap control"
echo "   engine ingests to 127.0.0.1:8008/dj"