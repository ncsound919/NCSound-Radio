#!/bin/sh
# NCSound Radio - prove the delivery chain actually works.
#
#   sh infra/station-verify.sh
#
# Checks both daemons, live Icecast sources on each mount, that the public
# mounts serve real MPEG audio, ICY now-playing metadata, and real listener
# counts read back from Icecast (the value the station app used to invent).
#
# Note: the mounts are infinite streams, so curl is bounded with --max-time
# (not `timeout`), otherwise curl is SIGKILLed and never flushes %{http_code}.

HOST=127.0.0.1
PORT=8010
SECS=6
fail=0
ok()  { echo "  PASS  $1"; }
bad() { echo "  FAIL  $1"; fail=1; }

echo "== 1. daemons =="
if pgrep -u icecast2 -x icecast2 >/dev/null; then ok "icecast running"
else bad "icecast NOT running"; fi
if pgrep -u liquidsoap -x liquidsoap >/dev/null; then ok "liquidsoap running"
else bad "liquidsoap NOT running"; fi
if [ "$fail" -ne 0 ]; then
  echo
  echo "run infra/station-up.sh first"
  exit 1
fi

echo
echo "== 2. icecast has a live source on each mount =="
for m in live.mp3 mobile.mp3; do
  if curl -s -u admin:REDACTED "http://$HOST:$PORT/admin/listmounts" | grep -q "/$m"; then
    ok "/$m is mounted"
  else
    bad "/$m is NOT mounted"
  fi
done

echo
echo "== 3. public mounts serve MPEG audio =="
for m in live.mp3 mobile.mp3; do
  rm -f "/tmp/pull-$m" "/tmp/hdr-$m"
  # -D captures the Icecast response headers (icy-name, icy-metaint, type).
  # curl exits 28 when --max-time fires, which is expected for an endless
  # stream, so the exit status is deliberately ignored and only the
  # %{http_code} it already printed is used.
  code=$(curl -s --max-time "$SECS" -D "/tmp/hdr-$m" -o "/tmp/pull-$m" \
    -w '%{http_code}' -H 'Icy-MetaData: 1' "http://$HOST:$PORT/$m")
  [ -n "$code" ] || code=000
  bytes=$(wc -c < "/tmp/pull-$m" 2>/dev/null | tr -d ' ')
  ctype=$(grep -i '^content-type:' "/tmp/hdr-$m" | tr -d '\r' | head -1)
  name=$(grep -i '^icy-name:'   "/tmp/hdr-$m" | tr -d '\r' | head -1 | cut -d' ' -f2-)
  echo "    /$m  HTTP $code  ${bytes}B  ${name}"
  echo "         $ctype"
  if [ "$code" = "200" ] && [ "$bytes" -gt 20000 ]; then
    ok "/$m delivered audio"
  else
    bad "/$m delivered nothing (HTTP $code, ${bytes}B)"
  fi
  case "$ctype" in
    *mpeg*|*MPEG*) ok "/$m content-type is MPEG" ;;
    *) bad "/$m content-type not MPEG: $ctype" ;;
  esac
done

echo
echo "== 4. ICY now-playing metadata =="
# Interleave offset comes from the icy-metaint response header, not a guess.
if python3 - /tmp/hdr-live.mp3 /tmp/pull-live.mp3 <<'PY'
import sys, re
hdr = open(sys.argv[1], 'rb').read().decode('latin-1', 'replace')
m = re.search(r'icy-metaint:\s*(\d+)', hdr, re.I)
if not m:
    print("    no icy-metaint header -> server not advertising metadata")
    raise SystemExit(1)
interval = int(m.group(1))
data = open(sys.argv[2], 'rb').read()
found, i = [], interval
while i < len(data) and len(found) < 4:
    n = data[i] * 256
    if n:
        found.append(data[i+1:i+1+n].decode('utf-8', 'replace').strip())
    i += interval + n
if not found:
    print("    metaint=%d but no metadata block found in %d bytes" % (interval, len(data)))
    raise SystemExit(1)
print("    metaint=%d" % interval)
for f in found:
    print("    ICY:", f)
PY
then ok "ICY StreamTitle present"
else bad "no usable ICY metadata"
fi

echo
echo "== 5. real listener counts from icecast (replaces the fake sine wave) =="
if timeout 6 curl -s -u admin:REDACTED -o /tmp/stats.xml \
     "http://$HOST:$PORT/admin/stats" && [ -s /tmp/stats.xml ]; then
  ok "admin/stats returned data"
  python3 - <<'PY'
import xml.etree.ElementTree as ET
r = ET.parse('/tmp/stats.xml').getroot()
print("    server: %s | sources: %s" % (r.findtext('server_id'), r.findtext('sources')))
for s in r.findall('source'):
    print("    mount %-13s listeners=%-4s peak=%-4s %s" % (
        s.get('mount'),
        s.findtext('listeners'),
        s.findtext('listener_peak'),
        s.findtext('audio_info')))
PY
else
  bad "admin/stats unreachable"
fi

echo
echo "== 6. engine ingest endpoint is listening on 8008 =="
if timeout 4 bash -c 'exec 3<>/dev/tcp/127.0.0.1/8008' 2>/dev/null; then
  ok "127.0.0.1:8008 accepts connections (engine can ingest here)"
else
  bad "127.0.0.1:8008 refused a connection"
fi

echo
if [ "$fail" -eq 0 ]; then echo "RESULT: delivery chain OK"
else echo "RESULT: FAILURES ABOVE"; fi
exit $fail