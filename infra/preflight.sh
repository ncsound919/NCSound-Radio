#!/bin/sh
# Pre-flight: prove the rendered configs are valid BEFORE station-up.sh restarts
# Icecast. Run this first, always, when changing infra/.
#
# Why the ordering matters. station-up.sh starts Icecast and only then validates
# Liquidsoap. If the Liquidsoap config is bad, that ordering leaves Icecast up
# with no authenticated source on either mount: the mounts read as healthy and
# the station is silent. That is precisely the failure recorded at
# 2026-10-04-two-surfaces-two-definitions-of-on-air, so the validation happens
# here, against the rendered files, while the current daemons keep running.
#
# Note on exit codes: `liquidsoap --check ... | tail` reports TAIL's status, not
# liquidsoap's. The first version of this script did exactly that and printed
# "PASS: ncsound.liq typechecks" over a hard type error. Output goes to a file and
# the exit code is read directly.
set -e
cd "$(dirname "$0")/.." || exit 1
. infra/load-credentials.sh

fail=0

echo "== render icecast.xml =="
sed -e "s|__ICECAST_SOURCE_PASSWORD__|$ICECAST_SOURCE_PASSWORD|g" \
    -e "s|__ICECAST_ADMIN_PASSWORD__|$ICECAST_ADMIN_PASSWORD|g" \
    infra/icecast/icecast.xml > /tmp/icecast.dryrun.xml
if grep -qE '<(source|admin)-password>__' /tmp/icecast.dryrun.xml; then
  echo "   FAIL: unrendered password placeholder remains"; fail=1
else
  echo "   PASS: both passwords rendered"
fi

echo "== render ncsound.liq =="
sed -e "s|getenv(\"HARBOR_PASSWORD\")|\"$HARBOR_PASSWORD\"|g" \
    -e "s|getenv(\"ICECAST_SOURCE_PASSWORD\")|\"$ICECAST_SOURCE_PASSWORD\"|g" \
    infra/liquidsoap/ncsound.liq > /tmp/ncsound.dryrun.liq
if grep -q 'password=getenv(' /tmp/ncsound.dryrun.liq; then
  echo "   FAIL: unrendered getenv() password remains"; fail=1
else
  echo "   PASS: all three passwords rendered"
fi

echo "== liquidsoap --check on the RENDERED file =="
# Not on the source: --check cannot resolve getenv(), so checking the source is
# guaranteed to fail even when the config is correct.
if liquidsoap --check /tmp/ncsound.dryrun.liq > /tmp/preflight-ls.log 2>&1; then
  echo "   PASS: rendered ncsound.liq typechecks"
else
  echo "   FAIL: rendered ncsound.liq rejected -- DO NOT RESTART"
  sed 's/^/      /' /tmp/preflight-ls.log
  fail=1
fi

echo "== no credential literal leaked into the TRACKED sources =="
leak=0
for f in infra/icecast/icecast.xml infra/liquidsoap/ncsound.liq; do
  if grep -qE "$ICECAST_SOURCE_PASSWORD|$ICECAST_ADMIN_PASSWORD|$HARBOR_PASSWORD" "$f"; then
    echo "   FAIL: a live value is present in tracked source $f"; leak=1
  fi
done
[ "$leak" = 0 ] && echo "   PASS: tracked sources carry no live credential"

rm -f /tmp/icecast.dryrun.xml /tmp/ncsound.dryrun.liq /tmp/preflight-ls.log

echo
if [ "$fail" = 0 ] && [ "$leak" = 0 ]; then
  echo "PREFLIGHT OK -- safe to run: sh infra/station-down.sh && sh infra/station-up.sh"
else
  echo "PREFLIGHT FAILED -- do not restart"
fi
exit $((fail + leak))