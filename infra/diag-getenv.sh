#!/bin/sh
# Diagnose why getenv() did not resolve for liquidsoap.
cd "$(dirname "$0")/.." || exit 1
. infra/load-credentials.sh

echo "== are the vars actually exported to child processes? =="
for v in ICECAST_SOURCE_PASSWORD ICECAST_ADMIN_PASSWORD HARBOR_PASSWORD; do
  eval "val=\$$v"
  # length only -- never print the value
  printf '   shell sees %-26s len=%s\n' "$v" "${#val}"
done
echo "   child process sees:"
for v in ICECAST_SOURCE_PASSWORD ICECAST_ADMIN_PASSWORD HARBOR_PASSWORD; do
  n=$(env | grep -c "^$v=")
  printf '   env has %-26s %s\n' "$v" "$([ "$n" = 1 ] && echo yes || echo NO)"
done

echo
echo "== minimal liquidsoap getenv probe =="
cat > /tmp/ge.liq <<'EOF'
a = getenv("HARBOR_PASSWORD")
output.dummy(a)
EOF
if liquidsoap --check /tmp/ge.liq >/tmp/ge.out 2>&1; then
  echo "   PASS: getenv resolves under --check"
else
  echo "   FAIL: getenv does NOT resolve under --check"
  sed 's/^/      /' /tmp/ge.out
fi

echo
echo "== is it the --check mode specifically? (real run, immediate exit) =="
cat > /tmp/ge2.liq <<'EOF'
a = getenv("HARBOR_PASSWORD")
output.dummy(a)
EOF
timeout 5 liquidsoap /tmp/ge2.liq >/tmp/ge2.out 2>&1
echo "   exit=$? (124 = still running, which means getenv worked)"
sed 's/^/      /' /tmp/ge2.out | head -5
rm -f /tmp/ge.liq /tmp/ge2.liq /tmp/ge.out /tmp/ge2.out