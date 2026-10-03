#!/bin/sh
# NCSound Radio - generate a test library so the autopilot has real tracks to
# sequence. Each file gets a distinct tempo, so harmonic scoring and the
# energy curve have something to work with.
#
#   sh infra/make-test-library.sh [dir]
#
# Files are built in /tmp first: ffmpeg writing many chunks straight onto the
# Windows mount is an order of magnitude slower.

set -e
LIB="${1:-/mnt/c/Users/User/Downloads/BUSINESS/CREATIVE/Radio and DJ/library}"
TMP=/tmp/ncsound-lib
BARS=64

rm -rf "$TMP"
mkdir -p "$TMP" "$LIB"

make_track() {
  name="$1"; bpm="$2"; root="$3"
  # Guard the duration: a zero/blank length makes ffmpeg stream until the disk
  # fills, which happened once already.
  len=$(awk -v b="$bpm" -v n="$BARS" 'BEGIN{ v=(60.0/b)*4.0*n; if (v<=1 || v>600) v=30; printf "%.2f", v }')
  ffmpeg -v error -y \
    -f lavfi -i "sine=frequency=${root}:sample_rate=48000:duration=${len}" \
    -f lavfi -i "sine=frequency=$((root * 2)):sample_rate=48000:duration=${len}" \
    -f lavfi -i "sine=frequency=$((root * 3)):sample_rate=48000:duration=${len}" \
    -filter_complex "[0:a]volume=0.5[a0];[1:a]volume=0.26[a1];[2:a]volume=0.14[a2];[a0][a1][a2]amix=inputs=3:duration=longest,tremolo=f=${bpm}:d=0.7,volume=0.65" \
    -ac 2 -ar 48000 -c:a pcm_s16le "$TMP/$name"
  printf '  %-46s %sbpm  %sHz  %ss  %sKB\n' "$name" "$bpm" "$root" "$len" "$(( $(wc -c < "$TMP/$name") / 1024 ))"
}

echo "generating test library into $LIB"
# Names follow "NN. Artist - Title" so the engine's parser reads both fields.
make_track "01. Deepwater - Undertow.wav"        124 55
make_track "02. Static Field - Half Light.wav"  126 58
make_track "03. Marlow - Nightshift.wav"        120 49
make_track "04. Kestrel - Blue Channel.wav"     128 65
make_track "05. Pale Harbor - Slack Water.wav"  122 51
make_track "06. Ashgrove - Tidewater.wav"       130 62

cp "$TMP"/*.wav "$LIB"/
echo
echo "done: $(ls -1 "$LIB" | wc -l) tracks in $LIB"