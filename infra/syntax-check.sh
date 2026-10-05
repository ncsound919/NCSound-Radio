#!/bin/sh
# Syntax-check the infra scripts from inside WSL, where the space in the repo
# path ("Radio and DJ") cannot be mangled by argument splitting.
set -e
cd "$(dirname "$0")/.." || exit 1
fail=0
for f in infra/station-up.sh infra/station-down.sh infra/station-verify.sh \
         infra/verify-engine-onair.sh infra/load-credentials.sh \
         infra/engine-up.sh infra/make-test-library.sh; do
  [ -f "$f" ] || continue
  printf '%-36s ' "$f"
  if sh -n "$f" 2>/tmp/synerr; then echo OK; else echo "SYNTAX ERROR"; cat /tmp/synerr; fail=1; fi
done
exit $fail