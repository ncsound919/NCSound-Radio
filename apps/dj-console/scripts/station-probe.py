#!/usr/bin/env python3
"""Listener probe for scripts/station-e2e.mjs.

Connects to the Icecast mount like a listener (ffmpeg decodes it), and every
0.25 s writes one JSON line: wall-clock ms, the dominant test tone and levels.
Tones used by the e2e run: 440 console, 523 console marker, 660 autopilot
stand-in, 880 library fallback.

    python3 station-probe.py http://127.0.0.1:8010/live.mp3 out.jsonl
"""
import json, math, subprocess, sys, time, struct

url, out = sys.argv[1], sys.argv[2]
SR, WIN = 8000, 2000  # 0.25 s windows
TONES = [440, 523, 660, 880]

def goertzel(xs, f):
    k = 2 * math.cos(2 * math.pi * f / SR)
    s1 = s2 = 0.0
    for x in xs:
        s0 = x + k * s1 - s2
        s2, s1 = s1, s0
    return math.sqrt(max(0.0, s1 * s1 + s2 * s2 - k * s1 * s2)) / (len(xs) / 2)

while True:
    p = subprocess.Popen(["ffmpeg", "-nostdin", "-loglevel", "error", "-i", url, "-f", "s16le", "-ac", "1", "-ar", str(SR), "pipe:1"], stdout=subprocess.PIPE)
    with open(out, "a") as fh:
        while True:
            raw = p.stdout.read(WIN * 2)
            if not raw or len(raw) < WIN * 2:
                break
            xs = [v / 32768 for v in struct.unpack("<%dh" % WIN, raw)]
            lv = {f: goertzel(xs, f) for f in TONES}
            rms = math.sqrt(sum(x * x for x in xs) / WIN)
            best = max(lv, key=lv.get)
            dom = best if lv[best] > 0.02 else 0
            fh.write(json.dumps({"t": int(time.time() * 1000), "dom": dom, "rms": round(rms, 4), "lv": {str(k): round(v, 4) for k, v in lv.items()}}) + "\n")
            fh.flush()
    p.kill()
    with open(out, "a") as fh:
        fh.write(json.dumps({"t": int(time.time() * 1000), "dom": -1, "reconnect": True}) + "\n")
    time.sleep(0.5)
