#!/bin/sh
# NCSound Radio - generate a test library.
#
#   sh infra/make-test-library.sh [dir]
#
# Each track gets a KICK transient train at a known tempo plus a tonal layer,
# so the file has both the percussive onsets a beat tracker keys on and the
# harmonic content a key detector needs. Pure tones, or tremolo-only tones, are
# pathological for onset-based tempo detection and make a useless benchmark.
#
# Files are built in /tmp first: ffmpeg writing many chunks straight onto the
# Windows mount is an order of magnitude slower.

set -e
LIB="${1:-/mnt/c/Users/User/Downloads/BUSINESS/CREATIVE/Radio and DJ/library}"
TMP=/tmp/ncsound-lib
BARS=48

rm -rf "$TMP"
mkdir -p "$TMP" "$LIB"

make_track() {
  name="$1"; bpm="$2"; root="$3"
  len=$(awk -v b="$bpm" -v n="$BARS" 'BEGIN{ v=(60.0/b)*4.0*n; if (v<=1 || v>600) v=30; printf "%.2f", v }')
  P=$(awk -v b="$bpm" 'BEGIN{printf "%.6f", 60.0/b}')
  # kick: exponentially decaying thump on every beat (the onset a tracker sees)
  # bass: tonal layer at the root, so key detection has something to work with
  ffmpeg -v error -y \
    -f lavfi -i "aevalsrc=0.9*exp(-mod(t\,${P})*22)*sin(2*PI*52*t):s=48000:d=${len}:c=mono" \
    -f lavfi -i "sine=frequency=${root}:sample_rate=48000:duration=${len}" \
    -f lavfi -i "sine=frequency=$((root * 2)):sample_rate=48000:duration=${len}" \
    -filter_complex "[1:a]volume=0.22[b1];[2:a]volume=0.11[b2];[b1][b2]amix=inputs=2:duration=longest[tone];[0:a][tone]amix=inputs=2:duration=longest,alimiter=limit=0.89,aformat=channel_layouts=stereo" \
    -ac 2 -ar 48000 -c:a pcm_s16le "$TMP/$name"
  printf '  %-46s %sbpm  beat=%ss  %ss  %sKB\n' "$name" "$bpm" "$P" "$len" "$(( $(wc -c < "$TMP/$name") / 1024 ))"
}

echo "generating test library into $LIB"
# Names follow "NN. Artist - Title" so the engine's parser reads both fields.
make_track "01. Deepwater - Undertow.wav"        124 55
make_track "02. Static Field - Half Light.wav"  126 58
make_track "03. Marlow - Nightshift.wav"        120 49
make_track "04. Kestrel - Blue Channel.wav"     128 65
make_track "05. Pale Harbor - Slack Water.wav"  122 51
make_track "06. Ashgrove - Tidewater.wav"       130 62
make_track "07. Longshore - Fathom.wav"         118 43
make_track "08. Rivergate - Slow Water.wav"     132 60

cp "$TMP"/*.wav "$LIB"/
echo
echo "done: $(ls -1 "$LIB" | wc -l) tracks in $LIB"