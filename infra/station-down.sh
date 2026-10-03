#!/bin/sh
# NCSound Radio - stop the Icecast + Liquidsoap pair.
set -e
pkill -u liquidsoap -x liquidsoap 2>/dev/null || true
pkill -u icecast2   -x icecast2   2>/dev/null || true
sleep 1
echo "liquidsoap: $(pgrep -u liquidsoap -x liquidsoap >/dev/null && echo running || echo stopped)"
echo "icecast:    $(pgrep -u icecast2 -x icecast2 >/dev/null && echo running || echo stopped)"