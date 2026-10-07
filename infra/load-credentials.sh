#!/bin/sh
# Shared credential loader for the NCSound Radio infra scripts.
#
#   . "$(dirname "$0")/load-credentials.sh"
#
# Populates and exports ICECAST_SOURCE_PASSWORD, ICECAST_ADMIN_PASSWORD,
# HARBOR_PASSWORD and LIVE_HARBOR_PASSWORD from infra/icecast/.env, then verifies
# all four are non-empty.
# Exits the calling script if the file is missing or a value is blank, so a
# verify script can never report a healthy station while authenticating with a
# default nobody rotated.
#
# Why this exists: the passwords were previously inline in icecast.xml,
# ncsound.liq and three verify scripts -- seven occurrences of three live
# credentials across five tracked files. gitleaks caught the curl -u copies and
# missed the Liquidsoap literals entirely. Centralising the read is what stops
# the next rotation from being a six-file find-and-replace.
#
# The file is gitignored (.gitignore rule `.env`); infra/icecast/.env.example
# is the tracked contract.

_CRED_ENV="${NCSOUND_CRED_ENV:-$(cd "$(dirname "$0")" && pwd)/icecast/.env}"

if [ ! -f "$_CRED_ENV" ]; then
  echo "ERROR: $_CRED_ENV not found." >&2
  echo "       generate it with: node infra/rotate-icecast-credentials.cjs" >&2
  return 1 2>/dev/null || exit 1
fi

set -a
# shellcheck disable=SC1090
. "$_CRED_ENV"
set +a

for _v in ICECAST_SOURCE_PASSWORD ICECAST_ADMIN_PASSWORD HARBOR_PASSWORD LIVE_HARBOR_PASSWORD; do
  eval "_val=\$$_v"
  if [ -z "$_val" ]; then
    echo "ERROR: $_v is empty or unset in $_CRED_ENV" >&2
    return 1 2>/dev/null || exit 1
  fi
done
unset _v _val

# Usernames are not secrets, so they stay here rather than in the env file.
ICECAST_SOURCE_USER=source
ICECAST_ADMIN_USER=admin
HARBOR_USER=engine
LIVE_HARBOR_USER=live
export ICECAST_SOURCE_USER ICECAST_ADMIN_USER HARBOR_USER LIVE_HARBOR_USER