#!/bin/sh
# NCSound Radio - start Icecast + Liquidsoap in WSL2.
#
#   sh infra/station-up.sh          # start both
#   sh infra/station-down.sh        # stop both
#
# Liquidsoap encodes and ingests; Icecast serves the public mounts. The DJ
# engine pushes audio into Liquidsoap on :8008 (see infra/liquidsoap/ncsound.liq).
#
# Both daemons are detached with setsid so they survive this script, and
# Liquidsoap gets ~6s to boot its stdlib before we judge it up.

set -e

REPO_DIR=$(cd "$(dirname "$0")/.." && pwd)
LIB=/srv/ncsound/library
ICECAST_CFG=/etc/icecast2/icecast.xml
CRED_ENV="$REPO_DIR/infra/icecast/.env"

# ---- credentials ---------------------------------------------------------
# Loaded and EXPORTED before anything starts, because Liquidsoap reads them via
# getenv() and Icecast's XML has no substitution of its own. Both daemons must
# agree: change the source password without changing ncsound.liq and Liquidsoap
# authenticates with a stale value, the mount goes silent, and Icecast reports
# the mount as healthy with no source on it.
echo "== loading credentials =="
if [ ! -f "$CRED_ENV" ]; then
  echo "   MISSING $CRED_ENV"
  echo "   generate it:  node infra/rotate-icecast-credentials.cjs"
  echo "   refusing to start: without credentials the mounts would come up unauthenticated."
  exit 1
fi
set -a; . "$CRED_ENV"; set +a
for v in ICECAST_SOURCE_PASSWORD ICECAST_ADMIN_PASSWORD HARBOR_PASSWORD LIVE_HARBOR_PASSWORD; do
  eval "val=\$$v"
  [ -n "$val" ] || { echo "   $v is empty in $CRED_ENV -- refusing to start"; exit 1; }
done
echo "   four credentials loaded (values not echoed)"

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
# Render the template into the live config. Hex passwords contain no sed
# metacharacters, which is the second reason they are hex.
sed -e "s|__ICECAST_SOURCE_PASSWORD__|$ICECAST_SOURCE_PASSWORD|g" \
    -e "s|__ICECAST_ADMIN_PASSWORD__|$ICECAST_ADMIN_PASSWORD|g" \
    "$REPO_DIR/infra/icecast/icecast.xml" > "$ICECAST_CFG"
# An unrendered placeholder is worse than a weak password: Icecast would accept
# the placeholder text itself as the password. Match only inside a password
# element -- a bare marker search also matches this file's own documentation
# comment, which is how the first version of this guard refused to start a
# station that was configured perfectly.
if grep -qE '<(source|admin)-password>__' "$ICECAST_CFG"; then
  echo "   RENDER FAILED - unrendered password placeholder in $ICECAST_CFG"; exit 1
fi
chmod 600 "$ICECAST_CFG"
# Ownership matters as much as the mode. This script runs as root, so sed leaves
# the file root-owned; Icecast drops to the icecast2 user and then cannot read a
# 0600 root-owned config. It fails with a bare "I/O error : Permission denied"
# followed by "failed to load external entity", which does not name permissions at
# all. chown to the service user so 0600 is readable by exactly one account.
chown icecast2:icecast "$ICECAST_CFG"
pkill -u icecast2 -x icecast2 2>/dev/null || true
sleep 1
setsid setpriv --reuid=icecast2 --regid=icecast --clear-groups \
  icecast2 -c "$ICECAST_CFG" > /tmp/icecast.log 2>&1 < /dev/null &
sleep 3
pgrep -u icecast2 -x icecast2 > /dev/null \
  || { echo "   icecast FAILED:"; tail -20 /tmp/icecast.log; exit 1; }
echo "   icecast up (pid $(pgrep -u icecast2 -x icecast2 | head -1))"

echo "== validating liquidsoap config =="
# ncsound.liq is rendered to a private copy for two reasons.
#
# 1. Secrets. The tracked source uses getenv(); the rendered copy holds literals.
# 2. liquidsoap --check does NOT resolve getenv(). Probed: with HARBOR_PASSWORD
#    exported, `--check` fails "Error 15: Missing arguments ... string" while a
#    real run starts fine and keeps running. So the gate has to run against a
#    rendered file, or it rejects a config that would have worked -- and since
#    this gate sits AFTER icecast starts, that rejection would leave icecast up
#    with no authenticated source on either mount: mounts healthy, station silent.
#    That is the "two surfaces, two definitions of on air" shape, so it is worth
#    stating plainly rather than rediscovering it during an incident.
LIQ_SRC="$REPO_DIR/infra/liquidsoap/ncsound.liq"
LIQ_RUN=/run/ncsound/ncsound.rendered.liq
mkdir -p /run/ncsound
# The substituted value MUST be re-quoted. An unquoted 32-char hex token is not
# a Liquidsoap string, and `--check` rejects it with "Error 2: Parse error" --
# caught by infra/preflight.sh before any daemon was restarted.
sed -e "s|getenv(\"HARBOR_PASSWORD\")|\"$HARBOR_PASSWORD\"|g" \
    -e "s|getenv(\"LIVE_HARBOR_PASSWORD\")|\"$LIVE_HARBOR_PASSWORD\"|g" \
    -e "s|getenv(\"ICECAST_SOURCE_PASSWORD\")|\"$ICECAST_SOURCE_PASSWORD\"|g" \
    "$LIQ_SRC" > "$LIQ_RUN"
chmod 600 "$LIQ_RUN"
# Same ownership trap as the Icecast config, and the failure is a bare
# "Sys_error(... Permission denied)" that never mentions the config or the user.
# Liquidsoap runs under setpriv as `liquidsoap`, so a 0600 root-owned script is
# unreadable and it exits before opening a single source.
chown liquidsoap:liquidsoap "$LIQ_RUN"
if grep -q 'password=getenv(' "$LIQ_RUN"; then
  echo "   RENDER FAILED - unrendered getenv() password in $LIQ_RUN"; exit 1
fi

if liquidsoap --check "$LIQ_RUN" > /tmp/ls-check.log 2>&1; then
  echo "   ncsound.liq ok (rendered)"
else
  echo "   liquidsoap config INVALID:"; cat /tmp/ls-check.log; exit 1
fi

echo "== starting liquidsoap =="
pkill -u liquidsoap -x liquidsoap 2>/dev/null || true
sleep 1
setsid setpriv --reuid=liquidsoap --regid=liquidsoap --clear-groups \
  liquidsoap "$LIQ_RUN" > /tmp/liquidsoap.log 2>&1 < /dev/null &

# Liquidsoap's stdlib load is SLOW on this host and the old comment here claimed
# ~6s. Measured 2026-10-05: "Standard library loaded in 33.94 seconds." The
# readiness budget was 30s + 20s, so station-up.sh gave up and reported failure
# while Liquidsoap was still booting normally -- and on the credential rotation
# that produced a false "liquidsoap up" followed by a silent station.
#
# Budget is now generous and evidence-based: wait for the real log markers rather
# than for a PID. A PID is not evidence (see the check below).
LS_STDLIB_WAIT=120
LS_MOUNT_WAIT=90
echo "   waiting for liquidsoap (up to ${LS_STDLIB_WAIT}s for stdlib, ${LS_MOUNT_WAIT}s for mountpoints)"
i=0
while [ $i -lt $LS_STDLIB_WAIT ]; do
  grep -q 'Standard library loaded' /tmp/liquidsoap.log 2>/dev/null && break
  pgrep -u liquidsoap -x liquidsoap > /dev/null || { echo "   liquidsoap EXITED during stdlib load:"; tail -25 /tmp/liquidsoap.log; exit 1; }
  i=$(( $i + 1 ))
  sleep 1
done
grep -q 'Standard library loaded' /tmp/liquidsoap.log 2>/dev/null \
  || { echo "   liquidsoap never finished loading stdlib within ${LS_STDLIB_WAIT}s:"; tail -25 /tmp/liquidsoap.log; exit 1; }

# A PID existing is NOT evidence that the config loaded. During the credential
# rotation this check printed "liquidsoap up" for a process that had already died
# on a permission error, and the script exited 0 over a dead station. Require
# BOTH a live process AND a positive log marker from the config itself.
if ! pgrep -u liquidsoap -x liquidsoap > /dev/null; then
  echo "   liquidsoap NOT RUNNING:"; tail -25 /tmp/liquidsoap.log; exit 1
fi
if grep -qiE 'fatal error|exception ' /tmp/liquidsoap.log; then
  echo "   liquidsoap DIED during startup:"; tail -25 /tmp/liquidsoap.log; exit 1
fi

# The harbor mountpoint and the icecast mounts are the last things to come up.
i=0
while [ $i -lt $LS_MOUNT_WAIT ]; do
  if grep -q "Adding mountpoint '/dj'" /tmp/liquidsoap.log 2>/dev/null; then break; fi
  i=$(( $i + 1 ))
  sleep 1
done
# Unconditional "liquidsoap up" was the false pass. Only claim it on evidence.
if ! grep -q "Adding mountpoint '/dj'" /tmp/liquidsoap.log 2>/dev/null; then
  echo "   liquidsoap running but NEVER registered the /dj mountpoint within ${LS_MOUNT_WAIT}s:"
  tail -25 /tmp/liquidsoap.log; exit 1
fi
echo "   liquidsoap up (pid $(pgrep -u liquidsoap -x liquidsoap | head -1)), harbor mountpoint registered"

# Wait for Icecast to actually list each mount with a live source. Liquidsoap
# logs "Connecting mount /live.mp3" before the source is authenticated and
# serving; Icecast is the only thing that knows whether the ingest succeeded.
i=0
while [ $i -lt $LS_MOUNT_WAIT ]; do
  n=$(curl -s -m 5 -u "$ICECAST_ADMIN_USER:$ICECAST_ADMIN_PASSWORD" \
        http://127.0.0.1:8010/admin/listmounts 2>/dev/null | grep -c '<mount>')
  [ "$n" -ge 2 ] && break
  i=$(( $i + 1 ))
  sleep 1
done
n=$(curl -s -m 5 -u "$ICECAST_ADMIN_USER:$ICECAST_ADMIN_PASSWORD" \
      http://127.0.0.1:8010/admin/listmounts 2>/dev/null | grep -c '<mount>')
if [ "$n" -ge 2 ]; then
  echo "   icecast is serving $n mounts (ingest authenticated)"
else
  echo "   liquidsoap is up but icecast lists $n mount(s); ingest did NOT authenticate."
  echo "   This is the silent-mount failure: the mount reads as healthy with no source."
  grep -iE 'auth|denied|401|403|password' /tmp/liquidsoap.log | tail -10
  exit 1
fi

echo
echo "== live mounts =="
# Poll the JSON status page at the webroot. /admin/... is parsed as a source
# command and answers "400 - Unrecognised command" instead of serving XSL.
curl -s -u "admin:$ICECAST_ADMIN_PASSWORD" http://127.0.0.1:8010/status-json.xsl \
  | tr ',' '\n' | grep -Ei 'listenurl|listeners|listener_peak|bitrate' | sed 's/^/   /' || true
echo
echo "   curl http://127.0.0.1:8010/live.mp3    # 128k"
echo "   curl http://127.0.0.1:8010/mobile.mp3  # 64k"
echo "   telnet 127.0.0.1 1234                  # liquidsoap control"
echo "   engine ingests to 127.0.0.1:8008/dj"