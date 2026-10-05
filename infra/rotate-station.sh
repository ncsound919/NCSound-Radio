#!/bin/sh
# Rotate the running station onto the current credentials.
#
# Runs the preflight first and refuses to proceed if it fails, so a bad config
# cannot leave Icecast up with no authenticated source. Restart both daemons
# together: Liquidsoap holds the source password, so stopping one and not the
# other is how a mount goes silent while still reporting healthy.
set -e
cd "$(dirname "$0")/.." || exit 1

echo "########## PREFLIGHT ##########"
sh infra/preflight.sh

echo
echo "########## STOP ##########"
sh infra/station-down.sh

echo
echo "########## START ##########"
sh infra/station-up.sh

echo
echo "########## VERIFY ##########"
sh infra/station-verify.sh