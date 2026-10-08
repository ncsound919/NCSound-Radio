"""Synthesise a realistic-ish stereo test mix for the S0 stem measurement.

No real music exists on this machine (the WSL library holds only a 10 s tone),
and the stem realtime factor depends on audio *duration*, not content. So this
builds a 3-minute 44.1 kHz stereo mix with four separable components — kick /
snare / hats, a bass line, a chord pad, and a vibrato'd "vocal" line — so the
measurement has a non-trivial input and each stem can be checked for non-silence.

Not part of the product; a measurement fixture. Writes to analysis/out/ (ignored).
"""

import argparse
from pathlib import Path

import numpy as np
import soundfile as sf

SR = 44100


def env(n: int, attack: float, decay: float) -> np.ndarray:
    a = max(1, int(attack * SR))
    d = max(1, int(decay * SR))
    e = np.ones(n)
    e[:a] = np.linspace(0, 1, a)
    tail = np.exp(-np.linspace(0, 6, min(d, n)))
    e[-len(tail):] *= tail
    return e


def kick(dur=0.25):
    n = int(dur * SR)
    t = np.arange(n) / SR
    freq = np.linspace(120, 45, n)
    return np.sin(2 * np.pi * np.cumsum(freq) / SR) * np.exp(-t * 18) * 0.9


def snare(dur=0.2):
    n = int(dur * SR)
    noise = np.random.default_rng(1).standard_normal(n)
    t = np.arange(n) / SR
    return (noise * np.exp(-t * 26) * 0.5)


def hat(dur=0.05):
    n = int(dur * SR)
    noise = np.random.default_rng(2).standard_normal(n)
    t = np.arange(n) / SR
    return noise * np.exp(-t * 90) * 0.18


def bass(freq, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    wave = sum(np.sin(2 * np.pi * freq * k * t) / k for k in (1, 2, 3, 5))
    return wave * env(n, 0.005, dur) * 0.35


def chord(freqs, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    wave = sum(np.sin(2 * np.pi * f * t) for f in freqs)
    return wave * env(n, 0.4, dur) * (0.12 / len(freqs))


def vocal(freq, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    vib = 1 + 0.015 * np.sin(2 * np.pi * 5.5 * t)
    wave = sum(np.sin(2 * np.pi * freq * vib * k * t) * a for k, a in ((1, 1.0), (2, 0.5), (3, 0.25)))
    return wave * env(n, 0.06, dur) * 0.22


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--seconds", type=int, default=180)
    ap.add_argument("--out", default="analysis/out/test_mix.wav")
    args = ap.parse_args()

    sr = SR
    total = args.seconds * sr
    mix = np.zeros((total, 2))

    bpm = 92
    beat = 60 / bpm
    bar = 4 * beat

    rng = np.random.default_rng(7)
    # Drums.
    n_beats = int(args.seconds / beat)
    for b in range(n_beats):
        pos = int(b * beat * sr)
        k = kick()
        if pos + len(k) < total:
            for ch in range(2):
                mix[pos:pos + len(k), ch] += k
        if b % 4 in (1, 3):  # snare on 2 and 4
            s = snare()
            mix[pos:pos + len(s), 0] += s
            mix[pos:pos + len(s), 1] += s
        for eighth in range(2):
            hp = pos + int(eighth * beat / 2 * sr)
            h = hat()
            if hp + len(h) < total:
                mix[hp:hp + len(h), 0] += h
                mix[hp:hp + len(h), 1] += h * 0.9

    # Bass line (root notes over a 4-bar loop).
    roots = [55.0, 55.0, 73.42, 65.41]  # A1, A1, D2, C2
    n_bars = int(args.seconds / bar)
    for i in range(n_bars):
        pos = int(i * bar * sr)
        note = bass(roots[i % len(roots)], beat)
        if pos + len(note) < total:
            mix[pos:pos + len(note)] += note[:, None]

    # Chord pad (2 bars per chord).
    chords = [[220, 261.63, 329.63], [174.61, 220, 261.63], [196, 246.94, 293.66], [164.81, 207.65, 246.94]]
    n_pads = int(args.seconds / (2 * bar))
    for i in range(n_pads):
        pos = int(i * 2 * bar * sr)
        c = chord(chords[i % len(chords)], 2 * bar)
        if pos + len(c) < total:
            mix[pos:pos + len(c)] += np.stack([c, c * 0.98], axis=1)

    # Vocal-ish melody (8 bars per phrase, quarter notes).
    melody = [440, 493.88, 523.25, 493.88, 440, 392, 440, 523.25]
    step = 0
    pos = int(2 * bar * sr)
    while pos < total - int(beat * sr):
        v = vocal(melody[step % len(melody)], beat * 0.9)
        mix[pos:pos + len(v), 0] += v
        mix[pos:pos + len(v), 1] += v * 0.97
        pos += int(beat * sr)
        step += 1
        if step % 32 == 0:
            pos += int(bar * sr)  # a gap between phrases

    # Normalise to a comfortable headroom and light-limit.
    peak = np.max(np.abs(mix)) or 1.0
    mix = (mix / peak) * 0.8
    mix = np.tanh(mix * 1.2) * 0.85

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(out), mix.astype(np.float32), sr, subtype="PCM_16")
    print(f"wrote {out} ({args.seconds}s, {sr} Hz stereo, RMS {np.sqrt((mix**2).mean()):.4f})")


if __name__ == "__main__":
    main()
