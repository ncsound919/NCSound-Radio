# MPD226 NCSound preset

The console is driven by an Akai MPD226. The unit stores presets internally, so
program **one preset** to the table below and the console maps it in
`apps/dj-console/src/midi/mpd226.ts`. This file and that file are the contract.

Notes are shown as the unit's pad/bank identity and the MIDI they must send.
Program it with the Akai MPD226 Editor (or on the unit). Values are on the
default MIDI channel.

## Pads (banks A–D, contiguous notes 36–99)

| Bank | Notes | Purpose |
|---|---|---|
| A | 36–51 | Decks |
| B | 52–67 | Sampler pads 1–16 |
| C | 68–83 | FX |
| D | 84–99 | OBS |

### Bank A — Decks (pad 1 = bottom-left, as on the unit)

| Row (top→bottom) | Pads | Action |
|---|---|---|
| top | 13–16 | Hot cues 1–4, deck A |
| 2nd | 9–12 | Hot cues 1–4, deck B |
| 3rd | 5,6,7,8 | Play A, Cue A, Play B, Cue B |
| bottom | 1,2,3,4 | Sync A, Sync B, Loop A, Loop B |

### Bank C — FX (notes 68–83)

| Pad | Action |
|---|---|
| 68 | FX 1 on/off |
| 69 | FX 2 on/off |
| 70 | Beat division − |
| 71 | Beat division + |
| 72–83 | Reserved (rolls / brake / backspin — not built yet) |

### Bank D — OBS (notes 84–99)

| Pad | Action |
|---|---|
| 84–91 | Scenes 1–8 (OBS order) |
| 92 | Media play |
| 93 | Media stop |
| 94 | Camera toggle (first source) |
| 95 | Overlay toggle (source named `*overlay*`) |
| 96 | OBS record |
| 97–99 | Unassigned |

## Control banks (knobs / faders / switches)

### Control bank A — mixer + cue

| Control | CC | Action |
|---|---|---|
| K1 | 16 | Filter A |
| K2 | 17 | Filter B |
| K3 | 18 | FX wet |
| K4 | 19 | FX parameter |
| F1 | 20 | Volume A |
| F2 | 21 | Volume B |
| F3 | 22 | Crossfader |
| F4 | 23 | Sampler volume |
| S1 | 24 | Headphone cue A (on ≥ 64) |
| S2 | 25 | Headphone cue B (on ≥ 64) |
| S3, S4 | 26, 27 | Reserved |

### Control bank B — EQ

| Control | CC | Action |
|---|---|---|
| K1 | 28 | High EQ A |
| K2 | 29 | High EQ B |
| K3 | 30 | Trim A |
| K4 | 31 | Trim B |
| F1 | 32 | Low EQ A |
| F2 | 33 | Low EQ B |
| F3 | 34 | Mid EQ A |
| F4 | 35 | Mid EQ B |
| S1 | 36 | Kill low A |
| S2 | 37 | Kill low B |
| S3 | 38 | Kill high A |
| S4 | 39 | Kill high B |

EQ/trim knobs and faders are **detented at CC 64 = 0 dB**: below cuts toward the
minimum (−24 dB EQ, −12 dB trim), above boosts toward the maximum (+6 dB). A
switch sends 127 for on and 0 for off.

### Control bank C — reserved

CCs 40–47 are reserved for the stems strip (not built). Leave them unassigned.

## Transport

| Control | MIDI | Action |
|---|---|---|
| Play | Note 118 | Play/pause the focused deck |
| Stop | Note 117 | Pause the focused deck |
| Record | Note 119 | Arm/stop the set recording |
| Note Repeat / Full Level / 16 Level / Tap | — | Unit-internal; leave as-is |

## Using your generic preset on channel 16 (no reprogramming needed)

The unit keeps its own presets, and the console cannot write to them (Akai's
programming protocol is not public, and Web MIDI here is read-only). So the
console learns what your preset sends instead of the other way round.

1. Select your generic preset on the MPD226 (the one on channel 16).
2. In the console: **Settings -> MIDI controller mapping**.
3. Set the channel to **Channel 16 only**. Anything on other channels is ignored.
4. Pick **Pad bank A (decks): all 16 (press pad 1)**, press **Learn**, then press
   the bottom-left pad of that bank on the unit. All 16 pads of the bank are
   assigned in order. Repeat for banks B, C, D if your preset has them.
   - This assumes your preset sends 16 consecutive note numbers per bank. If
     the top-bar chip's "last:" readout shows gaps, learn those pads one by one
     (each pad is also listed individually in the same menu).
5. For each knob, fader and switch: pick it in the menu (for example
   "Crossfader"), press **Learn**, move the control. Faders and knobs only need
   a nudge. Learn is CC-only for CC controls, so a stray pad hit is ignored.
6. The mapping is saved in this browser. **Reset mapping** returns to the
   console's own numbers (the table above); the channel setting is kept.

Rules the remapper follows (tested in `test/remap.test.ts`):
- A learned control is rewritten to the number the console expects.
- A control you did not learn passes through unchanged, unless its raw number is
  now the target of something you did learn. Then it is dropped, so one physical
  press never fires two actions.
- Nothing is sent to the unit. Pad LEDs and its own bank/preset switching are
  the unit's business.

**Status:** unit-tested only. It has not been run against your MPD226 yet. Run
`node scripts/midi-probe.mjs` (needs a headed Chrome) or use the chip's "last:"
readout to confirm what the preset really sends before learning.

## Verifying

1. Open the console in **Chrome or Edge** (Web MIDI is not in Firefox/Safari).
2. Click the **MIDI chip** in the top bar and allow access; it shows the device
   name and, in its tooltip, the **last message received**.
3. Press a pad / turn a knob and read the last message. It should match this
   table. If the unit sends a different number, either re-program the preset or
   tell me the number and I will correct `mpd226.ts`.

> The automated browser checks cannot grant Web MIDI (Chrome blocks it under
> automation), so the mapping is verified on the unit in a real browser. The
> mapper itself is unit-tested in `test/mpd226.test.ts`.

## Not in this preset

- Headphone output device selection (saved for later) — the cue switches here
  only work once a headphone output is enabled in Settings.
- Stems (control bank C), rolls/backspin (bank C pads 72+), key lock (not in the
  audio path yet).
