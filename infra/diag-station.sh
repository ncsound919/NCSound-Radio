#!/bin/sh
# Why is liquidsoap up but not connected to Icecast?
cd "$(dirname "$0")/.." || exit 1
echo "== processes =="
pgrep -a -x icecast2 || echo "  icecast2: NOT RUNNING"
pgrep -a liquidsoap || echo "  liquidsoap: NOT RUNNING"

echo
echo "== liquidsoap log (tail 40) =="
tail -40 /tmp/liquidsoap.log 2>/dev/null || echo "  (no log)"

echo
echo "== liquidsoap log: any auth/error/mount line =="
grep -inE 'auth|denied|401|403|password|error|fail|icecast|mount' /tmp/liquidsoap.log 2>/dev/null | tail -25 || echo "  (none)"

echo
echo "== icecast log (tail 25) =="
tail -25 /tmp/icecast.log 2>/dev/null || echo "  (no log)"

echo
echo "== what does icecast see on the mounts? =="
. infra/load-credentials.sh
curl -s -m 5 -u "$ICECAST_ADMIN_USER:$ICECAST_ADMIN_PASSWORD" \
  http://127.0.0.1:8010/admin/listmounts 2>&1 | head -c 300
echo
echo "== port 8008 (harbor) =="
(ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -E ':8008|:8010' || echo "  neither 8008 nor 8010 listening"