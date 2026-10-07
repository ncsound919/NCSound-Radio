# NCSOUND DJ console: full redesign plan (v3)

Status: approved for build, 2026-10-06. Phase 0 starts now.
Owner decisions:
- One app, two modes: **Party** (events, home and club gigs, streamed with OBS, sometimes on camera, sometimes over video/footage) and **Radio** (broadcast console for the online station).
- 2 decks.
- Required: real FX, uploaded one-shots, stems.
- A simpler, classier, more professional UI.
- Controller: **Akai MPD226 only** for now. No jog wheels, no traditional DJ controller.

---

## 1. Where the console stands today (verified in code)

| Area | Fact |
|---|---|
| Code shape | `src/main.ts` 5,442 lines, 90 top-level functions, 35 module-level mutable `let`s, 155 listeners, 122 string-id lookups into a 1,528-line `index.html`; `style.css` 4,394 lines |
| Layout | 8-item top nav; party panels and radio panels share one scroll surface; a Simple/Advanced toggle stands in for hierarchy |
| Engine | Exactly 2 decks (`decks: [Deck, Deck]`, `0 \| 1` slots). Real: 3-band EQ and kills, colour filter, key lock and +-12 semitone shift, bar loops with halve/double, beat jump, hot-cue API, phase align, sync, crossfader curves, stutter, gater, vinyl brake, scratch engine, master limiter, split cue, MediaRecorder set recording |
| Not real | No FX unit (no echo/reverb/flanger/bitcrush). Four FX pads trigger a different sound than their label (Ping Pong, Reverb Tail, Bitcrush, Pitch Slide), and the "Reverb Tail" transition runs echo-out. No sampler with user files. No stems. No beatgrid editing |
| Readouts | 26 fallbacks show "8A", "124 BPM" or "Minor" when nothing was measured |
| Waveforms | Both decks share one 1360x116 canvas, about 58px each, with no zoomed scrolling view |
| Radio | Console audio **never reaches the station**. `radioBroadcast.ts` builds a broadcast MediaStream that nothing reads; `ncsound.liq` has one harbor input (`dj`), owned by the headless engine. Only autopilot is ever on air |
| OBS | `#obs-overlay` is a now-playing page that always reads the radio engine, so it is wrong during a party gig |
| Ops panel | Sends the old `x-ops-pin` header; station-web uses session cookies now, so every call fails |
| MPD226 | Profile exists but the CC/note numbers are guesses; only 3 transport buttons are mapped; Deck B has no pitch; importing a saved MPD226 profile reverts to Pioneer (import check omits `akai-mpd226`); the default profile is Pioneer, which you don't own |
| Tests | 11 engine/control test files; no UI tests, no screenshots |
| Reusable | Engine core, crate indexer with IndexedDB cache, control link to ingest, broadcast link, the consolidated blue-black colour tokens in `style.css` |

## 2. Product shape

### 2.1 Modes
A single top-bar switch: **Party | Radio**. The performance surface (decks, waveforms, mixer) is identical in both, so muscle memory carries over. Only the bottom zone and the top-bar status change.

| | Party | Radio |
|---|---|---|
| Bottom zone tabs | Library, Sampler, FX, Visuals (OBS) | Library, Broadcast, Requests, Sampler |
| Top bar status | REC, STREAM (OBS connected / live) | ON AIR / AUTOPILOT, listeners, stream health |
| Audio out | Local interface / club mixer | Live input to the station, local monitor |
| Overlay source | Local decks | Local decks while live, engine during autopilot |

### 2.2 Audio paths

| Situation | Path | Status |
|---|---|---|
| Party, home or club | Browser mixer -> audio interface -> speakers / club mixer | Exists |
| Streaming a gig | OBS: Application Audio Capture of the browser plus camera / media scenes | OBS-side; the console adds the overlay and scene control |
| Recording a set | Master bus -> MediaRecorder -> file | Exists; gets a visible REC state and a file save |
| Radio autopilot | Headless engine -> harbor `dj` -> Liquidsoap -> Icecast | Exists |
| Radio live | Browser master -> Opus over WebSocket -> ingest -> ffmpeg -> **new** harbor `live` mount, priority over autopilot -> Icecast | **Build** |
| Radio live + video | The radio-live path above, plus OBS capturing the same audio for the video stream | Follows from the two rows above |

Club reality: venue internet is unreliable. Recording runs independently of the stream, so a dropped connection never loses the set. The UI shows connection loss loudly and never fakes "live".

### 2.3 Video while playing
The console does **not** become a video player. OBS already handles cameras, media files and footage better than a browser canvas would. Instead the console **drives OBS** through obs-websocket v5, which is built into OBS 28+ (port 4455, password auth, browser WebSocket):
- Pad bank D on the MPD226: switch scenes (camera / footage / both / overlay-only), start and stop a media source, toggle the camera.
- The Visuals tab shows OBS connection state, the scene list (read from OBS, not typed in), the current scene, and stream/record status read back from OBS.
- If OBS isn't running, the tab says so and the pads do nothing visible. No placebo.

## 3. Controller design: MPD226 as the primary surface

The MPD226 has 16 velocity/pressure RGB pads in 4 banks (64 pads), 4 knobs, 4 faders and 4 switches across 3 control banks (36 controls), Stop/Play/Record transport, Note Repeat, Full Level, 16 Level and Tap Tempo. It has no jog wheels, so nudging and manual scratch stay on mouse/keyboard and the pads trigger the scratch engine.

**Pad banks**
- **A: decks.** Top row: hot cues 1-4 for Deck A. Second row: hot cues 1-4 for Deck B. Third row: play A, cue A, play B, cue B. Fourth row: sync A, sync B, loop A, loop B.
- **B: sampler.** 16 one-shots, velocity sets gain.
- **C: FX and transitions.** FX 1 on/off, FX 2 on/off, beat division -/+, roll 1/4 / 1/8 / 1/16 / 1/32, brake, backspin, echo-out, filter riser, the smart transition presets.
- **D: visuals.** OBS scenes 1-8, media play/stop, camera toggle, overlay toggle, REC.

**Control banks**
- **A: mixer.** Faders: volume A, volume B, crossfader, sampler volume. Knobs: filter A, filter B, FX wet, FX parameter.
- **B: EQ.** Faders: low A, low B, mid A, mid B. Knobs: high A, high B, trim A, trim B.
- **C: stems.** Faders: vocals and instrumental per deck. Knobs: drums A/B, bass A/B.

**Switches:** headphone cue A, headphone cue B, key lock A, key lock B.

**Transport:** Play toggles the active deck, Stop pauses, Record arms set recording. Tap Tempo is tap BPM for beatgrid correction.

Truth rules:
- Default mappings are **unverified until tested on your unit**. Phase 0 ships a MIDI monitor and learn mode, and the defaults are confirmed against what the hardware actually sends.
- On-screen pad labels mirror the active bank.
- Pad LEDs are driven over MIDI out only once the RGB message format is confirmed on the hardware; until then nothing claims LED feedback.

Keyboard covers the rest: space for play, Q/W cue, arrows for nudge, 1-8 hot cues, Tab to switch bottom tabs, M for mode.

## 4. Features

### 4.1 FX unit (engine plus UI)
- 2 FX slots, each assignable to Deck A, Deck B or master. Each slot has on/off, wet/dry, one parameter knob, and a beat division (1/8 to 4 beats) synced to that deck's BPM.
- Echo: tempo-synced delay, feedback, tone low-pass
- Reverb: ConvolverNode with a generated impulse, size and decay
- Flanger: LFO-modulated 1-10ms delay, rate synced to beats
- Filter: the per-channel colour filter is on the mixer since Phase 2, so it isn't an FX slot.
- Bitcrush: AudioWorklet, bits and downsample.
- Gater: rebuilt as a tempo-synced gate in the FX unit. The existing `triggerGaterEffect` rewrites the master gain's automation.
- Roll: rebuilt as a slip roll (the track keeps running underneath). The existing `triggerStutterRoll` seeks backwards and clicks.
- Brake: the existing `vinylBrake`, kept. Backspin: the existing `rewind-spin` is only a 4-beat seek. A real reversed-audio backspin is built in Phase 3, or dropped if it sounds wrong.
- Effect tails ring out after switch-off (echo/reverb), not hard-cut.
- Tests: an offline-render test per effect asserts a measurable change (energy at the delay time, decay tail length, spectral comb for the flanger).

### 4.2 Sampler / one-shots
- Upload WAV/MP3/AIFF/FLAC by drag-drop or file picker. Decode, normalise peak, store the decoded sample in IndexedDB so it survives reload.
- 4 banks x 16 pads. Per pad: name, colour, gain, mode (one-shot / gate / loop), choke group, quantize (off / 1/4 / 1 beat / 1 bar).
- Velocity drives gain.
- Routed pre-limiter into the master, so it reaches the recording, OBS and the radio-live feed.
- The four synthesised club sounds become the default bank 1. A station jingle pad uses the real imaging files.

### 4.3 Stems
- **Phase 7B.1, 1-day spike (go/no-go):** run the Demucs ONNX model (about 172MB, 4 stems, WebGPU with WASM fallback, needs COOP/COEP headers, expects 44.1kHz stereo) on a 4-minute track on your PC. Measure wall time and memory. Go if a track separates in under about 1.5x its length on WebGPU.
- **Path A (browser):** separate in a worker on import or queue, with a progress bar per track. Cache stems in OPFS keyed by file hash.
- **Path B (fallback):** run Demucs on the PC through the ingest service, which already uses ffmpeg. Needs Python. Cache next to the library.
- **Playback:** a deck plays 4 synced sources with per-stem gain/mute (vocals, instrumental, drums, bass), all through the deck's tempo and key processing. This needs the Phase 7A deck player rework, because today's player is a single `AudioBufferSourceNode`. Expect roughly 4x the CPU per deck; measure it.
- A track without stems shows the stem controls dimmed with "no stems yet", never fake stems.

### 4.4 Waveforms
- Per deck: a zoomed scrolling waveform (about 90px) with a fixed playhead, beatgrid ticks, downbeat accents, hot-cue and loop markers, coloured by low/mid/high energy. A thin full-track overview sits under it with click-to-seek.
- Canvas, DPR-aware, rAF at 60fps for the playhead and cached waveform tiles. Nothing is computed per frame from raw audio.

### 4.5 Library
- Search-first; filter as you type across artist, title, key, BPM.
- Columns: artist, title, BPM, key, time, rating, plus a stems/analysis status icon.
- Highlights tracks that are harmonically compatible and within +-6% BPM of the loaded deck.
- Up Next queue, crates, drag to deck, double-click loads to the idle deck.
- Sources: local files (crate indexer and IndexedDB) and the station library through ingest.

### 4.6 Radio mode
- **Broadcast tab:** autopilot state, now playing / next up (engine), skip, hold, imaging/sweeper pads, stream health (Icecast reachable, mount connected, listeners).
- **Go live:**
  1. Arm: a pre-flight check that the live mount is reachable and the encoder is running.
  2. 8-second countdown while autopilot fades.
  3. LIVE (red top bar).
  4. Hand back: autopilot resumes on the next track.
  5. If the connection drops, autopilot takes over automatically (Liquidsoap fallback) and the console shows it.
- **Requests tab:** listener requests from the station site; one-click "load to deck" or "queue in autopilot".
- **Submissions** stay on the station site's Ops page. The console panel is cut rather than re-authenticated, so there is one place to review.

### 4.7 OBS
- Visuals tab and pad bank D (see 2.3).
- Overlay `#obs-overlay`: lower third (now playing, DJ name), optional request ticker, transparent background. It reads local decks in Party / live mode and the engine during autopilot.
- `docs/OBS-SETUP.md`:
  - Enabling obs-websocket.
  - Browser source for the overlay.
  - Application Audio Capture of the browser.
  - Scene templates (Camera, Footage, Camera+Footage, Overlay-only).
  - Club checklist: audio interface routing, record-locally-as-backup.

## 5. UI system

Principle: one performance screen. Nothing on it that you don't touch during a set. Unwired controls are hidden, there's no synthetic motion, and no number appears that wasn't measured.

**Layout, desktop 1280-1920px wide (laptop first)**
- **Top bar (48px):** Party | Radio switch, master BPM and tap, clock, REC, STREAM / ON AIR, listeners (Radio), MIDI status, settings.
- **Waveform zone:** Deck A and Deck B scrolling waveforms stacked, with overviews.
- **Deck A | Mixer | Deck B:** decks show title/artist, BPM, key with harmonic badge, remaining time, transport, pitch, key lock, 8 hot cues, loop controls, and a stems strip. The mixer has trim, 3-band EQ with kills, filter, faders, crossfader, cue, and a master meter.
- **Bottom zone:** the mode-specific tabs.
- **Drawers:** Scratch lab (scratch agent, routines), Settings (audio output device, MIDI, OBS connection, station connection).

**Visual language**
- **Colour:** keep the existing blue-black surface tokens. One accent (warm amber) for selection and values. Deck A and B get muted, distinct tints. Red is reserved for live/on-air and clipping. Meters are green/amber/red.
- **Type:** Geist + Geist Mono, bundled locally. Tabular figures for every number. Sentence case. No emoji. No all-caps paragraphs.
- **Controls:** keys at least 36x44px (primaries and transport 44px tall); 8px gaps (16px between clusters); 11px minimum text; knobs only M38/L50/XL66; fader track at least 120px; 2px key travel; visible focus ring; 200ms transitions.
- **Feedback:** one quiet status line. No toast for every pad hit. Errors are inline.
- **Removed:** Simple/Advanced toggle, 8-item nav, emoji strings, decorative OLED animations with no data behind them.

## 6. Architecture for the rewrite (vanilla TS plus Vite; no framework migration)

```
src/
  app/        boot, mode, keyboard, layout shell
  state/      store.ts: one typed store, subscribe/select; no module-level mutable state
  audio/      mixer adapter, fx/, sampler/, stems/, recorder, live-encoder
  midi/       devices, monitor+learn, mpd226 profile (banks), mapper
  ui/         components/ (knob, fader, pad, key, lcd, meter), views/ (topbar, waveform, deck, mixer, library, sampler, fx, broadcast, visuals, scratch-lab)
  services/   ingest (control/broadcast links), station, obs (obs-websocket v5)
  legacy/     old main.ts pieces until each is replaced
```
- The old UI stays reachable at `?ui=legacy` until Phase 8.
- Rendering: DOM for controls, canvas for waveforms and meters, rAF loop owned by one scheduler.

## 7. Phases, tasks and done-criteria

**Phase 0: safety net — DONE 2026-10-06**

Results:
- Harness: `scripts/screenshot.mjs`, `scripts/screenshot-advanced.mjs`, `scripts/audit-ui.mjs` (`npm run screenshot`, `npm run ui-audit`).
  - Baseline is in `test/screenshots/baseline`; after-state is in `test/screenshots/phase0`.
  - Audit: legacy UI 193 issues, new shell 0.
- Fake readouts removed:
  - The deck, master BPM, crate key column, setlist and OBS readout show "--" when nothing is measured.
  - Unknown keys get their own `unknown` tier labeled "Key unknown"; the score is unchanged, so autopilot sequencing is untouched.
  - Detection failures are stored as "" instead of a made-up 8A.
- Placebo removed:
  - Deleted: FM DSP toggle, watchdog / silence-protection badges, the "LIVE STREAM 192 KBPS HD" tag, "OBS: READY", and the AzuraCast/Centova claim.
  - "Simulate request" was renamed to Refresh, which is what it did.
- Mislabeled pads replaced with real ones:
  - Ping Pong became Roll A 1/8, Reverb Tail became Roll B 1/8, Bitcrush became Gater 1 s, Pitch Slide became Roll A 1/32.
  - Spin Whip became 1B Echo Out, and the Reverb Tail transition became 4B Echo Out.
- MPD226:
  - It is now the default profile, and the import check that dropped it is fixed, with a regression test.
  - A 20-message MIDI monitor log is in the MIDI drawer.
- The ops panel and `stationOps.ts` are removed from the console.
- **0.6 re-scoped:** splitting the legacy `main.ts` was dropped, because it is deleted in phase 8 and refactoring it first is wasted risk.
  - Instead: `src/entry.ts` routes `/` to the legacy console and `/?ui=new` to the new app.
  - The new skeleton is `src/app/boot.ts`, `src/state/store.ts`, `src/state/console.ts` (Party/Radio mode, persisted) and `src/ui/tokens.css`.
- 0.7: `packages/dj-engine/test/console-contract.test.ts` has 9 characterization tests on a real headless Web Audio graph.
- Engine facts the new UI must respect (found by those tests):
  - `setDeckPitchPct` returns the resulting **BPM**, not the percent, and does not write `deck.pitchPct`.
  - The crossfader position runs **-1..+1**.
  - `beatJump` lands correctly, but its return value under-reports the landing point. Read the playhead instead.
- Verification: dj-engine 38/38, console 11/11, typecheck and `vite build` clean.

Original task list:

**Phase 0: safety net (no visible redesign yet)**
- 0.1 Harness: build the console, Playwright screenshots of every current panel, and `scripts/audit-ui.mjs` (DAW-UI cramped-UI audit). Baseline images saved.
- 0.2 Kill the fake readouts: the 26 `"8A"` / `124` / `"Minor"` fallbacks render "--".
- 0.3 Delete the lying pads (Ping Pong, Reverb Tail, Bitcrush, Pitch Slide FX pads; Reverb Tail transition). The real ones stay.
- 0.4 MPD226: make it the default profile; fix the import check that drops it; add a MIDI monitor (last 20 messages) and learn mode in the UI.
- 0.5 Ops panel: remove it from the console (submissions live on the station site); remove `stationOps.ts`'s broken PIN path.
- 0.6 Split `main.ts` into `src/legacy/*` modules by domain with no behaviour change. The typecheck and the existing 11 tests stay green, and the screenshots match the baseline.
- 0.7 Characterization tests: load, play, sync, cue, loop, transition on the Mixer with an OfflineAudioContext.
- Done when: tests are green, screenshots are unchanged except for the deleted pads and readouts, and no fake values are on screen.

**Phase 1: design system**
- Tokens file, Geist bundled, component set (knob, fader, pad, key, LCD, meter, tabs, drawer), and a component gallery page (`?ui=gallery`) audited to 0 issues.

**Phase 2: performance screen**
- Top bar, waveform zone, decks, mixer wired to the existing engine through the store. New UI is the default; legacy stays at `?ui=legacy`.
- Done when: a full 2-deck mix works on mouse, keyboard and MPD226 bank A, the audit is clean, and screenshots are reviewed.

**Phases 3-8: how each phase is written**

Each phase lists:
- **Goal**
- **Depends on**
- **Build** (numbered tasks)
- **Files**
- **Tests and checks**
- **Done when**
- **Risks and open questions**

Every phase also follows section 8. Sizes are relative (S, M, L, XL) and are not time estimates.

Engine facts found while building phases 0-2 shape these plans:
- Playback is a plain `AudioBufferSourceNode` resample. Key lock and key shift are not in the audio path.
- The old "FX" are mostly oscillators or seeks.
- Headphone cue splits the single stereo output.
- Loading blocks the main thread.

---

**Phase 3: FX unit, sampler and outputs (L)**

Goal: real beat FX with tails, a one-shot sampler you can load your own sounds into, and a proper headphone cue on a second output. Without the headphone cue, the console can't be used in a club.

Depends on: Phase 2.

*3A. Outputs and headphone cue (do this first)*
- 3A.1 Settings drawer. List the output devices with `navigator.mediaDevices.enumerateDevices()`; full device names need the microphone permission. Keep these as separate settings:
  - Master output: `AudioContext.setSinkId()`, Chrome/Edge 110+. Other browsers get the default device and the drawer says so.
  - Headphone (cue) output.
- 3A.2 Cue bus on its own output:
  - Route `cueBusGain`, plus an optional master blend, into a `MediaStreamAudioDestinationNode`.
  - Play that through an `<audio>` element with `setSinkId(headphoneDevice)`.
  - This replaces the engine's split-mono routing in the new console. The legacy console keeps its old routing until Phase 8.
- 3A.3 Mixer: a CUE key per channel, plus a headphone Mix knob (cue to master) and a headphone Level knob. These only show when a headphone output is selected. Otherwise they stay hidden, with a one-line hint in the drawer.
- 3A.4 Measure and display the added latency of the headphone path (the `<audio>` element adds buffering). If it's over about 40 ms, say so in the drawer. Don't hide it.
- 3A.5 Persist the device choices. If a saved device is missing at boot, say so and fall back to the default; never fail silently.

*3B. FX unit (engine plus UI)*
- 3B.1 `FxUnit` engine class (`packages/dj-engine/src/engine/fx/`). Each unit has:
  - `input`, `output`, `wet`, `param`, `division` (1/8 to 4 beats), `on`, `assign(target: "A" | "B" | "master")`.
  - Two units.
  - The chosen effect is set on each unit.
- 3B.2 Insertion points:
  - Deck: post-fader, between `deck.out` and `masterGain`.
  - Master: between `masterGain` and `subsonicFilter`.
  - `assign()` rewires without a click, using a 10 ms crossfade between the old and new routes.
- 3B.3 Tails: switching off closes the send into the effect, not the effect output, so echo and reverb ring out. "Off" never hard-cuts.
- 3B.4 Tempo: the beat division follows the assigned deck's effective BPM (`analysis.bpm * rate`), or the master deck's for master. It retunes when pitch or sync changes.
- 3B.5 Effects:
  - Echo: DelayNode with feedback and a low-pass in the loop.
  - Reverb: ConvolverNode with a generated exponential-noise impulse; size and decay.
  - Flanger: 1-10 ms delay with a beat-synced LFO.
  - Bitcrush: AudioWorklet, bits plus downsample.
  - Gater: a tempo-synced gate on a GainNode. This replaces `triggerGaterEffect`, which currently rewrites `masterGain` automation and fights the master gain.
- 3B.6 Performance moves (pads, momentary):
  - Roll 1/4, 1/8, 1/16, 1/32 beat as a **slip roll**. The loop plays while held, and on release the deck lands where it would have been. This replaces `triggerStutterRoll`, which seeks backwards and clicks.
  - Brake: the existing `vinylBrake`, kept.
  - Backspin: honest version. Today `rewind-spin` is a 4-beat seek, not a backspin. Render a reversed, pitch-ramped slice of the buffer and play it. If that sounds wrong, ship Brake only and drop Backspin.
- 3B.7 FX tab in the bottom zone. Per unit:
  - Effect picker
  - On/off key
  - Wet and Param knobs
  - Beat division key with readout
  - Assign key (A / B / Master)
  The FX state is read back from the engine each frame, like everything else.
- 3B.8 Remove the oscillator "club FX" (airhorn, siren, laser, sub-drop) from the FX surface. They're sounds, not effects, so they move to the sampler as rendered samples (3C.6).

*3C. Sampler*
- 3C.1 `Sampler` engine class with 4 banks x 16 pads. Per pad:
  - Buffer, name, gain, mode (one-shot / gate / loop), choke group, quantize (off / 1/4 / 1 beat / 1 bar).
  - Velocity maps to gain on a squared curve.
- 3C.2 Output: sampler bus, then sampler volume, then `masterGain` (pre-limiter). Samples reach the recording, the radio live feed and OBS capture. Optional per-pad routing to the headphone cue only, for previewing.
- 3C.3 Quantize: expose `Mixer.nextGridTime(division)` from the beat anchor, which is private today. A quantized hit starts on the next grid line; the pad lights when armed.
- 3C.4 Storage: IndexedDB stores the original file bytes plus pad settings, decoded at boot. Show a usage meter against `navigator.storage.estimate()`. Ask for `navigator.storage.persist()` so the browser doesn't evict samples.
- 3C.5 Sampler tab UI:
  - Bank keys A-D and a 4x4 pad grid mirroring the MPD226.
  - Drag a file onto a pad, or use the picker. Shift-click a pad to edit it (name, gain, mode, choke, quantize, colour from a fixed 6-swatch set). Clear.
  - The MPD226's pad bank B triggers this.
- 3C.6 Default bank A:
  - The synthesized club sounds, rendered offline once into buffers, so they behave like any sample.
  - A station jingle pad that uses the real imaging files when the ingest service is reachable (`imaging.ts`). If it isn't, that pad is empty and says why.

*3D. Bottom-zone tabs and MPD226*
- 3D.1 The bottom zone becomes tabs:
  - Party: Library (placeholder until Phase 4), Sampler, FX, Visuals (placeholder until Phase 6).
  - Radio: Library, Broadcast, Requests (Phase 5), Sampler.
  - Tab and Shift+Tab inside the tab list; the number row stays for hot cues.
- 3D.2 MPD226 (assumed numbers, unverified until checked on the unit):
  - Pad bank B: sampler.
  - Pad bank C: FX 1/2 on, division -/+, rolls (held), brake, backspin, echo-out.
  - Control bank A: K3 FX wet, K4 FX param, F4 sampler volume.
  - A bank label in the top bar mirrors whatever the last pad message implies.

Files: `packages/dj-engine/src/engine/fx/{unit,echo,reverb,flanger,bitcrush.worklet,gater,roll}.ts`, `packages/dj-engine/src/engine/sampler.ts`, `apps/dj-console/src/audio/{outputs,samplerStore}.ts`, `src/ui/views/{fx,sampler,settings}.ts`, `src/midi/mpd226.ts`.

Tests and checks:
- Offline-render test per effect, asserting a measurable change:
  - Echo: energy at the delay time.
  - Reverb: decay tail length.
  - Flanger: moving comb notches.
  - Bitcrush: quantization noise floor.
  - Gater: gain modulation at the division rate.
- A tails test: after off, energy continues for at least the delay time.
- A slip-roll landing test (position after release = position without the roll, within 5 ms).
- Sampler tests: velocity curve, choke group cuts, quantized start lands on the grid within one render quantum.
- Browser check: upload a sample, reload the page, and it's still there and plays.
- Audit at 0 issues on the FX, Sampler and Settings states.

Done when:
- Both FX units work on A, B and master with audible tails.
- Sampler pads survive a reload.
- Headphone cue plays on a second device while the master plays on the first. This needs a second output to test: a USB headset or interface counts.
- MPD226 banks B/C trigger them, once checked on the unit.

Risks and open questions:
- `setSinkId` is Chromium-only. On Firefox or Safari the console runs single-output with no headphone cue, and says so.
- The `<audio>` element adds headphone-path latency; the size depends on the machine and is measured in 3A.4.
- Backspin quality is unknown until built.

---

**Phase 4: library (L)**

Goal: find and load tracks fast during a set, and make loading not freeze the screen.

Depends on: Phase 2. Phase 3's tabs land first, or this phase adds them.

- 4.1 Background analysis:
  - `decodeAudioData` stays on the main thread; it's async and decodes off-thread internally.
  - The decoded channel data is transferred to a Worker, which runs `analyze()` and `computeWaveform()`.
  - `analyze()` and `extractWaveformAndCues()` get an entry point that takes `Float32Array` channels plus a sample rate instead of an `AudioBuffer`, because Workers have no `AudioBuffer`.
  - Results are cached in IndexedDB, keyed by file name, size and last-modified time, plus a hash of the first 64 KB.
  - A deck load with a cached result passes it as `overrideAnalysis`. No re-analysis.
- 4.2 Local sources:
  - **Folder:** `showDirectoryPicker()` (Chrome/Edge); the handle is stored in IndexedDB, with permission asked again at boot.
  - **Drag-drop files:** stored as Blobs in IndexedDB, which is what `crateIndexer` does today. The UI warns past about 2 GB of browser storage.
  - Tags read with the existing `parseAudioFileMetadata` (ID3v1/v2, MP4). This replaces Phase 2's file-name parsing.
- 4.3 Station source:
  - Ingest `GET /crate` and `/crate/audio/<id>.wav`.
  - This only works when the console runs on the station PC, because the route is loopback-only by design.
  - At a club the Station source shows "only available on the station computer"; it doesn't try and fail.
- 4.4 Index queue: background analysis with per-track status (queued / analysing / ready / failed with reason) and a total progress line. It pauses while either deck is loading.
- 4.5 Library tab:
  - Search box that filters as you type across artist, title, key and BPM ("8A", "120-126").
  - Sortable columns: artist, title, BPM, key, time, status.
  - Virtualized rows, so 10,000 tracks scroll smoothly.
  - Rows played this session are marked.
- 4.6 Matching:
  - With a deck playing, rows within ±6% BPM of it and harmonically compatible with its effective key (`evaluateHarmonicMatch`) get a quiet highlight.
  - A "Matches" filter toggle.
  - The highlight uses the key heard, which after Phase 2 includes the pitch shift.
- 4.7 Loading:
  - Drag a row to a deck or its waveform lane.
  - Double-click loads to the idle deck (the one not playing; ask if both are).
  - Keyboard: up/down to move, Enter loads to the focused deck, Shift+Enter to the other one.
  - Loading into a playing deck is refused, as in Phase 2.
- 4.8 Up Next queue and crates:
  - Add to Up Next from a row. "Load next" puts the head of the queue on the idle deck.
  - Crates are named lists in IndexedDB.
  - Export a crate or set history to M3U8 and CSV (played times from the session log).
- 4.9 Set history: every track that was audible (channel volume and crossfader gain above -20 dB for more than 30 s) is logged with its time. Useful for radio logs and tracklists.

Files: `src/library/{worker.ts,analysisCache.ts,sources/{folder,files,station}.ts,search.ts,queue.ts,history.ts}`, `src/ui/views/library.ts`, `packages/dj-engine/src/engine/analysis.ts` (channel-data entry point).

Tests and checks:
- Worker analysis matches main-thread `analyze()` on the same audio (BPM within 0.01, first beat within 5 ms).
- Search unit tests (key, BPM range, partial text).
- Cache hit and miss tests.
- Browser check: index 300 tracks while a deck plays; measure the longest frame (target: no frame over 50 ms during indexing). A cached track goes from click to waveform in under 300 ms.
- Audit at 0 issues on the Library tab, empty and full.

Done when:
- A real music folder indexes in the background while you mix.
- Search finds tracks as you type.
- Loading an indexed track doesn't freeze the screen.
- Matching highlights are correct against the readouts.

Risks and open questions:
- The File System Access API is Chromium-only.
- Browser storage can be evicted unless `persist()` is granted, so the cache is rebuildable, never the only copy.
- Key detection accuracy on real music hasn't been measured; Phase 2 only used synthetic tones. Spot-check 20 tracks against a known source and record the hit rate.

---

**Phase 5: Radio mode and Go live (XL)**

Goal: from the console, at home or at a club, take over the station live, talk on the mic, and hand back to autopilot. A dropped connection never causes dead air.

Depends on: Phase 2. Phase 3A for the headphone cue, which a radio DJ needs.

*Architecture (decided)*
- Browser master is captured by `MediaRecorder` (Opus in WebM, 128-192 kbps), sent in 250 ms chunks over a WebSocket to ingest (`/live`).
- Ingest pipes it into `ffmpeg` (WebM/Opus in, MP3 out), which sends it to Liquidsoap's new harbor mount `live` using the Icecast source protocol.
- Liquidsoap: `fallback(track_sensitive=false, [dj_live, dj_source (autopilot), filler])`.
- Liquidsoap's harbor only accepts Icecast/Shoutcast sources, not browser WebSockets ([harbor docs](https://www.liquidsoap.info/doc-2.4.5/harbor)). So the bridge is required: the browser can't talk to harbor directly. It also keeps the harbor password off the browser.
- Ingest already has token auth, an Origin allowlist and ffmpeg (`mount-watchdog.ts`).

*Remote (club) access*
- The station runs on the home PC. From a club, the console must reach ingest over the internet.
- Plan: a Cloudflare Tunnel to ingest only (`cloudflared` is installed), on its own hostname, with `wss://` end to end, plus:
  - `INGEST_TOKEN` required.
  - `INGEST_ALLOWED_ORIGINS` set to the console's origin.
  - A per-session live key issued at Arm.
- Harbor and Icecast source ports are never exposed.

*Build*
- 5.1 Liquidsoap:
  - Add `dj_live = input.harbor("live", port=8008, user="live", password=getenv("LIVE_HARBOR_PASSWORD"), buffer=4., max=10., timeout=8.)`.
  - Put it first in the fallback, with a short crossfade on hand-over (`fallback(transitions=[...])`).
  - Expose `dj_live` connected/disconnected over telnet (as `harbor_source_connected` is today).
  - `infra/syntax-check.sh` must pass.
- 5.2 Ingest live bridge (`packages/ingest/src/live.ts`):
  - WebSocket `/live` (token plus live key).
  - Spawns `ffmpeg -f webm -i pipe:0 -c:a libmp3lame -b:a 192k -f mp3 icecast://live:<pw>@127.0.0.1:8008/live`.
  - Backpressure: if ffmpeg stdin is blocked for more than 2 s, drop and report.
  - Status events: `live.armed`, `live.on_air`, `live.lost`, `live.ended`, plus bytes/s and the audio-time to wall-clock drift.
  - One live session at a time; a second is refused with a reason.
- 5.3 Go-live flow in the console:
  1. Arm: preflight checks that ingest is reachable, the token is valid, the live mount is free and the encoder started; each check is shown pass or fail.
  2. Countdown from 8 s. Autopilot fades on its next bar (engine command), and the live mount connects.
  3. LIVE: red top bar, elapsed time, and a stream health line (send rate, drift, Icecast listeners).
  4. End: send "hand back"; autopilot resumes with its next track; the bridge closes.
  5. Drop-out: if the WebSocket closes or the send stalls for over 3 s, Liquidsoap's fallback has already put autopilot back on air. The console shows "Connection lost: autopilot is on air", retries for 60 s, and offers Rejoin.
- 5.4 What listeners hear is measured, not assumed:
  - "LIVE" turns on only after the mount watchdog sees our live source on `/live.mp3`, through the Liquidsoap source state plus the Icecast stats.
  - Pressing the button doesn't turn it on.
- 5.5 Mic:
  - The engine's `toggleMicTalkover` (110 Hz high-pass plus -10 dB ducking) goes on a Mic key, with input device selection.
  - `getUserMedia` constraints: echo cancellation off, noise suppression off, auto gain off. These need a decent mic setup; a laptop mic with speakers will feed back.
  - The mic reaches the live feed and recording. It also goes to the headphone cue when selected.
- 5.6 Broadcast tab:
  - Autopilot state; now playing and next (from the engine).
  - Skip, Hold, and imaging/sweeper pads (`imaging.play`).
  - Stream health: Icecast reachable, mount connected, listeners now and peak.
  - It reuses `controlLink.ts` and `broadcastLink.ts`, which already talk to ingest honestly.
- 5.7 Requests tab:
  - Listener requests from `requests.ts` (station DB), newest first.
  - Per request: "Load to deck" (only if the track is in a reachable library source), "Queue in autopilot" (`cue.request`) and Dismiss.
- 5.8 Top bar in Radio mode:
  - ON AIR / AUTOPILOT state, listeners, health dot.
  - REC stays independent: a local backup recording always runs while live, if enabled.

Files: `infra/liquidsoap/ncsound.liq`, `packages/ingest/src/{live.ts,server.ts}`, `packages/station-core/src/contract` (live events), `apps/dj-console/src/radio/{live.ts,preflight.ts}`, `src/ui/views/{broadcast,requests}.ts`, `docs/REMOTE-LIVE.md` (tunnel setup).

Tests and checks:
- Liquidsoap syntax check.
- Ingest bridge test: a recorded WebM stream into `/live` comes out on a local harbor; measure the delay.
- Fallback test: kill the WebSocket mid-stream and autopilot is audible on the Icecast mount within the harbor timeout (target 8 s or less), measured with the mount watchdog's ffmpeg level probe.
- Auth tests: a wrong token, a wrong origin, or a second session is refused.
- End-to-end on the real station: go live from the console on the station PC, then from a second network through the tunnel. Record the delay from deck to listener.

Done when:
- Going live from a non-home network is heard on the station mount.
- Pulling the network cable hands back to autopilot with no dead air beyond the measured timeout.
- Hand-back resumes autopilot cleanly.
- The mic works on air.

Risks and open questions:
- Venue upload bandwidth. 192 kbps needs about 250 kbps sustained; add a 128 kbps choice.
- The tunnel's added latency is irrelevant to listeners but matters to the hand-over timing.
- Running Liquidsoap and Icecast on the home PC means home power or internet loss takes the whole station down; this plan doesn't solve that.
- Running live and autopilot at once doubles CPU on the home PC; measure it.

---

**Phase 6: OBS (M)**

Goal: switch cameras and footage from the pads while you play, and show a clean now-playing overlay. OBS does the video; the console drives it.

Depends on: Phase 2. Phase 5's broadcast status for the overlay in Radio mode.

- 6.1 OBS client:
  - `obs-websocket-js` v5 (MIT, browser bundle). Connects to `ws://127.0.0.1:4455` with a password from Settings.
  - Reconnects with backoff.
  - Connection state is shown in the top bar only when an OBS address is configured.
- 6.2 Visuals tab:
  - Scene list read from OBS (`GetSceneList`) and the current program scene, kept live through the `CurrentProgramSceneChanged` event.
  - Stream and record state read back from OBS (`GetStreamStatus`, `GetRecordStatus`, events).
  - Media sources in the current scene, with play/stop/restart (`TriggerMediaInputAction`).
  - Camera toggle (`SetSceneItemEnabled` on a chosen source).
  - Nothing is typed in; everything is picked from what OBS reports.
- 6.3 Pad bank D:
  - Scenes 1-8 (in OBS order, or a chosen mapping).
  - Media play/stop, camera toggle, overlay toggle, OBS record toggle.
  - With OBS disconnected the pads do nothing, and the Visuals tab says so. No placebo.
- 6.4 Overlay (`#obs-overlay`, existing `obsOverlay.ts`, restyled with the Phase 1 tokens):
  - Lower third with now playing and DJ name; optional request ticker.
  - Party mode or live: it reads local decks. The audible track is whichever deck has the most gain after channel fader and crossfader, held for 4 s before switching, so a quick scratch doesn't flip it.
  - Autopilot: it reads the engine (existing behaviour).
  - Transparent background, sized for 1920x1080.
- 6.5 `docs/OBS-SETUP.md`:
  - Enable obs-websocket.
  - Add the overlay as a Browser Source.
  - Application Audio Capture of the browser window (Windows 10 2004+).
  - Scene templates: Camera, Footage, Camera+Footage, Overlay-only.
  - Club checklist: audio interface routing, local backup recording, test scene switches before doors.
- 6.6 Audio sync note: OBS captures the browser's audio and the camera separately. Document how to set the camera's sync offset, and measure the offset once on your setup.

Files: `apps/dj-console/src/services/obs.ts`, `src/ui/views/visuals.ts`, `src/engine/obsOverlay.ts`, `docs/OBS-SETUP.md`, `src/midi/mpd226.ts` (bank D).

Tests and checks:
- A unit test of the overlay's "audible deck" logic.
- Against a running OBS 30+:
  - Connect, list scenes, switch by pad and see OBS change.
  - Stop OBS, and the tab shows disconnected and the pads go inert.
  - Restart it, and it reconnects.
- Overlay screenshot over a test scene.

Done when: on your PC with OBS running, pads switch scenes and start footage, the overlay shows the right track in both modes, and the guide has been followed once end to end.

Risks and open questions:
- OBS must run on the same machine as the browser, or be reachable from it.
- The obs-websocket password is stored in browser storage; the setup doc says so.
- Which platform you stream to only affects the doc.

---

**Phase 7: deck player rework, key lock and stems (XL, gated)**

Goal: real key lock and key shift, then stems. Both need the same change: decks stop being a bare `AudioBufferSourceNode` and play through a time-stretch AudioWorklet that can run several synced sources.

Depends on: Phases 2-4. The library cache stores the stems.

*7A. Key lock: player spike, then rework*
- 7A.1 Spike (go/no-go) with Signalsmith Stretch Web (`signalsmith-stretch` on npm, MIT, WASM AudioWorklet; independent `rate` and `semitones`, buffer playback with seek and loop). Measure on your PC:
  - Audio-thread CPU for 2 decks.
  - Latency added.
  - Quality at ±8% and at ±2 semitones, judged by ear on 5 real tracks.
  - Behaviour at seek and loop boundaries.
  - Go if 2 decks stay under about 30% of one core and seeks and loops are click-free.
- 7A.2 If go, add a `DeckPlayer` interface in the engine with two implementations:
  - Resample: today's behaviour, kept for scratching and as a fallback.
  - Stretch: the worklet.
  Then:
  - `start`, `pause`, `seek`, `setRate`, `setLoop`, `currentOffset` move behind it.
  - `Deck.keyLockEnabled` and `pitchShiftSemitones` become real.
  - `getEffectiveKey()` honours key lock again, now truthfully.
  - The Phase 0/2 contract tests must pass on both players.
- 7A.3 UI: Key lock key per deck, key shift -/+ with a semitone readout, and "Match key" (`matchHarmonicKey`, which then actually changes the audio).
- 7A.4 Scratch: the scratch engine drives the resample player; scratching while key lock is on switches player for the gesture. Confirm there's no audible jump, or disable key lock during scratches and say so.

*7B. Stems*
- 7B.1 Spike (go/no-go), as planned before:
  - Demucs (htdemucs, 4 stems) as ONNX in the browser, WebGPU with WASM fallback. Model about 172 MB; needs COOP/COEP headers for threads.
  - Time a 4-minute track on your PC.
  - Go if separation takes under about 1.5x the track length on WebGPU.
- 7B.2 Path A (browser, if go):
  - A separation worker queued from the library: separate on demand or in the background.
  - Cache the 4 stems in OPFS, keyed by the file hash, with progress per track in the library.
- 7B.3 Path B (if no-go):
  - Separation on the PC through ingest (Python Demucs).
  - Stems cached next to the library and served like crate audio.
  - Library-wide, offline only.
- 7B.4 Playback:
  - The stretch player plays 4 sources in lockstep, with per-stem gain and mute.
  - Measure CPU with 2 decks x 4 stems with key lock on, and record it.
- 7B.5 UI and MPD226:
  - Stems strip per deck: vocals, instrumental, drums, bass faders and mutes.
  - Control bank C mapping.
  - A track without stems shows the strip dimmed with "No stems yet". It never fakes stems with EQ.

Files: `packages/dj-engine/src/engine/player/{resample,stretch}.ts`, `deck.ts`, `apps/dj-console/src/stems/{worker,cache}.ts`, `src/ui/views/stems.ts`, `vite.config.ts` (COOP/COEP headers).

Tests and checks:
- Contract tests on both players.
- Key-lock test: a 440 Hz tone at rate 1.08 with key lock stays at 440 Hz (FFT peak within 1%); without key lock it moves to about 475 Hz.
- Stem lockstep test (sources stay sample-aligned after seeks and loops).
- Recorded CPU and quality results for both spikes.

Done when: key lock and key shift are audible and measured; or the spike's no-go is recorded with numbers and the controls stay hidden. Stems play in sync with per-stem control on at least one path; or the no-go is recorded the same way.

Risks and open questions:
- This is the deepest engine change in the plan: every playback feature (loops, cues, beat jump, scratch, sync anchor) goes through the new player.
- COOP/COEP headers can break third-party embeds and the OBS overlay page. Scope them to the console route.

---

**Phase 8: cleanup and release (M)**

Goal: one console, no dead code, a build you can run at a gig without the dev server.

Depends on: Phases 3-6. Phase 7 isn't required.

- 8.1 Delete the legacy console:
  - `src/main.ts` (5,442 lines) and `src/style.css` (4,394 lines).
  - The legacy markup in `index.html`.
  - `?ui=legacy` and the legacy-only modules. Confirm each has no import from the new app before deleting: `engine/midi.ts` (replaced by `src/midi/`), `presets/party-templates.json`, and the in-browser `radioBroadcast.ts` if Phase 5 replaced it.
- 8.2 Engine dead code: anything only the legacy UI called. Run a usage scan and delete what has no caller in the console, ingest or the station site.
  - Candidates: club-FX oscillator branches moved to the sampler, the scratch agent UI hooks, auto-transition paths not used by autopilot.
  - Autopilot code stays.
- 8.3 Remove `window.__ncConsole`, or gate it behind `?debug`; the browser checks then opt in.
- 8.4 Production build:
  - `vite build`, served by ingest or a tiny static server, so a gig runs without the dev server.
  - Ship it as an installable PWA, so it opens full-screen and keeps working if the venue Wi-Fi drops (decks and local library don't need the network).
- 8.5 Docs:
  - Console README: shortcuts, MPD226 map, setup.
  - The plan updated with the final state.
  - `docs/OBS-SETUP.md` and `docs/REMOTE-LIVE.md` linked.
- 8.6 Final pass:
  - All tests.
  - `ui-audit` on every state at 1280x720 and 1920x1080.
  - `mix-check.mjs` on the production build.
  - A 2-hour soak: two decks looping, the sampler firing, recording on; watch memory and dropouts.

Tests and checks:
- Typecheck and `vite build` clean.
- Bundle size recorded.
- Soak results recorded (memory growth, audio underruns from `AudioContext` `onstatechange`, and the longest frame).

Done when: the legacy code is gone, the production build runs a 2-hour soak without dropouts or memory growth, and a real gig or broadcast has been run on it.

Risks and open questions: a deleted legacy path that autopilot or the station site still used. Mitigation: the usage scan, plus the full engine and ingest test suites before each deletion.

## 8. Verification rules (every phase)
- Typecheck and all tests green; new engine code gets offline-render tests.
- UI audit at 0 issues on every panel state, with real fonts loaded; screenshots captured and looked at.
- Every control is either wired to real DSP / state or not rendered.
- MIDI mappings verified on the actual MPD226 before being called done.
- Anything not yet measured is labeled as such.

## 9. Open items
- MPD226: run the MIDI monitor in Phase 0 to confirm what your unit sends (factory presets vary by firmware/preset slot).
- MPD226 note/CC numbers in `src/midi/mpd226.ts` are assumed factory values. Confirm them on the unit, using the MIDI chip's "last:" readout in the top bar.
- Key lock depends on the Phase 7A.1 spike (Signalsmith Stretch CPU and quality on your PC).
- The stems go/no-go depends on the Phase 7B.1 measurement.
- Remote go-live depends on a Cloudflare Tunnel hostname for ingest (Phase 5), and on venue upload bandwidth (about 250 kbps sustained at 192 kbps).
- The headphone cue on a second output is Chromium-only (`setSinkId`). Firefox and Safari run single-output.
- Key detection accuracy on real music hasn't been measured; Phase 4 spot-checks 20 tracks.
- Streaming platform: affects only the OBS guide.

## Sources
- MPD226 controls: https://www.bhphotovideo.com/c/product/1170806-REG/akai_professional_mpd226_usb_midi_pad_controller.html
- obs-websocket-js (v5): https://github.com/obs-websocket-community-projects/obs-websocket-js
- Competitor and UX research: https://dj.studio/blog/best-dj-software, https://dj.studio/blog/ux-buyers-guide-mixing-software, https://virtualdj.com/articles/best-dj-software-features-that-matter, https://www.digitaldjtips.com/reviews/mixxx-2-5-1-dj-software/
- Radio automation: https://zeno.fm/blog/free-radio-automation-software/
- Browser stems: https://github.com/timcsy/demucs-web
- Liquidsoap harbor (Icecast/Shoutcast sources only, so a browser can't connect directly): https://www.liquidsoap.info/doc-2.4.5/harbor
- Signalsmith Stretch Web (MIT, WASM AudioWorklet, independent rate and semitones): https://npmjs.com/package/signalsmith-stretch
- AudioContext.setSinkId (Chrome 110+): https://developer.chrome.com/blog/audiocontext-setsinkid
- obs-websocket-js on npm (v5.0.8, MIT, browser bundle): https://npmjs.com/package/obs-websocket-js


## Phase 1: design system, DONE 2026-10-06

- `src/ui/tokens.css`: surfaces, ink, one amber accent, red for live/clip only, control sizes (knob 38/50/66, pad 64, key 36x44), Geist and Geist Mono bundled locally from `src/ui/fonts/` (SIL OFL, licence beside them).
- `src/ui/controls.ts` + `controls.css`: knob, fader (vertical/horizontal), pad (trigger/toggle/empty/live), key, readout (null renders `--`), meter (shows only the level passed in), tabs, drawer. Sliders are `role=slider` with drag, wheel, arrows, Home/End, shift for fine, double-click reset.
- `/?ui=gallery` shows every control in every state with hand-set demo values.
- Checks: `tsc --noEmit` clean; `ui-audit` 0 issues on gallery and `?ui=new`; keyboard, drag, double-click, toggle and tab behaviour exercised in a browser; screenshot in `test/screenshots/phase1/`.
- Not done here: bundled-font size in the production build was not measured; no touch-device test.


## Phase 2: performance screen, DONE 2026-10-06 (MPD226 part pending hardware check)

- The new console is now the default at `/`; the old one is at `?ui=legacy`, the gallery at `?ui=gallery`. `index.html` stays hidden until a UI mounts, so the legacy markup never flashes.
- Engine (`packages/dj-engine`): `Mixer.manualMix` (set by the new console). Play no longer snaps the crossfader, and moving the crossfader no longer starts a paused deck; autopilot behaviour is unchanged when it's off. `Deck.getEffectiveKey()` now reports the key actually heard: playback is a plain resample, so key lock and key shift were never applied to audio, and the old code claimed an unchanged key (and "8A" for tracks with no key). `Deck.loopStartSec` is exposed for drawing. Six new contract tests.
- `src/audio/engine.ts`: CDJ-style CUE, load only into a stopped deck, hot cues (jump, Shift sets), loop, sync (only offered when the other deck is loaded), nudge, and recording saved as a file. `src/audio/waveform.ts`: 3-band waveform at 150 buckets/s from the decoded audio, pre-rendered into tiles. `src/app/scheduler.ts` runs the one rAF loop; views read the engine each frame and write only what changed.
- Views: top bar (mode, master BPM, REC with elapsed time, MIDI chip, clock), waveforms (zoomed, centre playhead, beat grid with downbeats, hot cues, cue point, loop region, overview with click-to-seek), decks, mixer (trim, filter, 3-band EQ with kills, level meters, faders, master meter and gain, crossfader with curve, pitch range).
- Hidden on purpose: key lock and key shift (not in the audio path), headphone cue (the engine splits the one stereo output, which in a club puts the cue on half the PA; it needs an output-device setting first), and stems (phase 7).
- Keyboard: Space plays the focused deck, Z/X play A/B, Q/W cue A/B, 1-4/5-8 hot cues (Shift sets), arrows nudge, [ ] focus deck, M mode.
- MPD226: `src/midi/mpd226.ts` maps pad bank A and control bank A (F1/F2 volume, F3 crossfader, K1/K2 filter). The note and CC numbers are assumed factory values, **not verified on the unit**. The MIDI chip tooltip shows the last message received, for checking.
- Checks: `tsc` clean. dj-engine: 44 pass, 0 fail, 9 skipped (BPM tests that need a local library). dj-console: 12 test files pass, including the new `mpd226.test.ts`. `ui-audit` 0 issues at 1480x960 (Party, Radio, gallery) and at 1280x720. `scripts/mix-check.mjs` drives a full two-deck mix in Chromium through the UI with synthetic test tracks: 21/21 checks pass at both sizes. Screenshots are in `test/screenshots/phase2/`.
- Known gaps:
  - Loading blocks the UI: decode, analysis and the waveform run on the main thread. A 5-minute WAV took 1.5 to 5.1 s, measured twice. During that time the screen freezes, though audio keeps playing. It moves to a Worker with the library work in phase 4.
  - Track names come from the file name only; there's no ID3 parsing yet.
  - Hot cues are the engine's four auto-detected points (Intro, Drop, Break, Outro), not 8 free cues.
  - Not tested with real music or on a touch screen. The MPD226 hasn't been tested on the actual unit.


## Audit of phases 1 and 2, 2026-10-06 (three-lens, fixed same day)

Verified before fixing: `tsc --noEmit` clean (console, engine); dj-engine 44 pass / 0 fail / 9 skip; dj-console 13 test files pass; `ui-audit` 0 issues at 1480x960 and 1280x720 for Party, Radio and gallery; `mix-check` 21/21 at both sizes; `vite build` clean; no page errors. Screenshots reviewed (empty, mixing, after, gallery).

**Lens 1 — frontend/UX (17/24):** Copywriting 3, Visuals 3, Color 3, Typography 3, Spacing 3, Experience 2.
- Experience 2 was driven by a real keyboard defect (below) and tabs missing ARIA wiring.

**Lens 2 — club/radio DJ:** no headphone cue (BLOCKER, scheduled 3A; correctly hidden rather than faked); loading freezes the UI 0.6–0.8 s for a 40 s file (known, phase 4); only 4 auto hot cues, not 8 free cues (WARNING); no library browse yet (phase 4); MPD226 unverified on hardware. Positives: every mixer control is real DSP, unmeasured values read `--`, no placebo.

**Lens 3 — senior dev:**
- **WARNING, fixed:** the global Space handler stole activation from any focused button. Verified with Playwright: Space on the focused crossfader-curve button did nothing to the button, and Space on REC did not record. Enter worked. A keyboard user could not trigger a focused control.
- **WARNING, fixed:** `tabs()` set `role=tab`/`role=tabpanel` but no `id`/`aria-controls`/`aria-labelledby`, so assistive tech could not associate tabs with panels.
- **INFO, fixed:** `waveforms.ts` hardcoded the canvas palette (`#7b93d6`, `#e8a33d`, `#eef1f6`, rgba literals) instead of reading the design tokens.
- **INFO, fixed:** `mix-check.mjs` asserted `|B.bpm - 124| < 0.05` against a hardcoded number. A fixture that analyses to 123.82 failed even though SYNC matched B to A exactly — a test that would lie. It now compares B to deck A's measured BPM.
- **INFO, open:** `src/ui/format.ts` (four exports) and `src/ui/dom.ts` are legacy-only; they sit in the new design-system folder and become dead in phase 8.

**Fixes shipped:**
- `src/app/shortcutScope.ts` (new): `shortcutBlocked()` — text fields swallow all keys; Space/Enter are left to a focused button or link; other shortcut keys stay global. `keyboard.ts` uses it. `test/shortcutScope.test.ts` covers the cases (13 test files now).
- `src/ui/controls.ts`: `tabs()` assigns stable ids and `aria-controls`/`aria-labelledby`.
- `src/ui/views/waveforms.ts`: the canvas palette is resolved from `--nc-deck-a/b`, `--nc-ink`, `--nc-accent` at first draw.
- `scripts/mix-check.mjs`: SYNC check compares against deck A's measured tempo.

**Phase 1 open item closed:** bundled font size measured in the production build — `Geist-Variable` 69.65 kB + `GeistMono-Variable` 71.37 kB ≈ **141 kB woff2** total. Touch-device test still not done.


## Phase 3: FX unit, sampler and outputs — STARTED 2026-10-06

First increment is **3B (the FX unit)**, end to end: engine DSP, mixer insertion, tab UI, offline tests and a browser check.

**Engine (`packages/dj-engine`)**
- New `src/engine/fx/`: `types.ts` (kinds, targets, divisions), `effects.ts` (echo, reverb, flanger, bitcrush, gater), `unit.ts` (`FxUnit`, `FxSlot`, `FxRack`), `index.ts`. Exported as `@ncsound/dj-engine/fx`.
- Effects are real: echo is a filtered feedback `DelayNode`; reverb a `ConvolverNode` with a generated exponential-noise impulse; flanger a beat-synced swept comb; gater a tempo-locked square gate; bitcrush a quantising `WaveShaperNode` (bit depth only — downsampling is not implemented yet).
- `FxUnit`: `input`/`output`, dry/wet, `on`, `param`, `division`, `setEffect`, `setOn`, `setWet`, `setParam`, `setSync`. Off closes the **send** into the effect, never the output, so echo/reverb tails ring out (3B.3). Serial effects (gater, bitcrush) crossfade dry to `1 - wet`; parallel effects (echo, reverb, flanger) keep the dry.
- `Mixer` gains `fx: FxRack` and `assignFx(unitIndex, target)`. The graph is now `deck.out -> slot -> masterGain -> masterSlot -> subsonicFilter -> …`; a slot with nothing assigned is a straight wire. Both units default to bypass, so the autopilot and ingest paths are unchanged (all 53 engine tests still pass). A unit can sit on only one bus; assigning it elsewhere evicts and clears the old unit's route.
- Effects are built lazily: a bypassed mixer's graph is plain gains, so nothing pays for delay/convolver nodes it does not use, and a mock AudioContext in the console tests no longer needs `createDelay`.

**Console**
- `src/ui/views/fx.ts`: two unit cards — effect picker, On key, Wet/Param knobs, beat-division key, assign key. Everything is read back from the engine each frame; a tempo follower pushes the assigned bus's effective BPM to each unit so divisions track pitch and sync.
- The bottom zone is now the planned tab set via the Phase 1 `tabs()`: Party = Library, Sampler, FX, Visuals; Radio = Library, Broadcast, Requests, Sampler. Non-FX tabs are honest placeholders naming their phase.

**Tests and checks**
- `packages/dj-engine/test/fx.test.ts`: 9 offline-render tests — bypass is bit-identical; echo energy lands at the delay time; tails continue after the send closes (OfflineAudioContext `suspend`); reverb rings after the input stops; the flanger modulates a steady tone; the gater closes at the division rate; bitcrush quantises more with fewer bits; a unit assigned to Deck A reaches the master bus and does not when bypassed.
- `scripts/fx-check.mjs` (`npm run fx-check`): drives the FX tab in Chromium — effect picker, On, routing (including eviction), the wet knob, and independence of the two units. 13/13. Screenshot `test/screenshots/phase3/fx-tab.png`.
- Verification: dj-engine **53 pass / 0 fail / 9 skip**; dj-console 13 test files pass; `ui-audit` 0 issues at 1480x960 and 1280x720 including the FX tab; `mix-check` 21/21 (the FX slots sit in the mix path and the two-deck mix is unaffected); `fx-check` 13/13; `tsc` clean; no page errors.

**Two bugs found and fixed while building this:**
- `WaveShaperNode.curve` cannot be reassigned in the installed runtime (`InvalidStateError: cannot assign curve twice`); bitcrush now swaps in a fresh shaper on a bits change.
- Evicting a unit from a bus left its `target` label pointing at a bus it was no longer on; `FxSlot.detach` now clears it.

### Phase 3 continued: 3A, 3C and 3D.2 — DONE 2026-10-06

The rest of phase 3 is built. Only 3B.6 remains deferred (below).

**3A outputs and headphone cue**
- Engine: `getCueBusNode`/`addCueTap(node)` (a cue tap survives the engine's own re-routing, mirroring the existing `programTaps`), `setDeckCue(slot, on)` — explicit per-deck cue that overrides the legacy single-deck audition model and is honoured by `updatePflRouting`.
- Console `src/audio/outputs.ts`: `listOutputs()` (with an optional mic-permission gate for full device names), `setMasterOutput()` (`AudioContext.setSinkId`, Chromium), and `HeadphoneCue` — the pre-fader cue bus plus a master blend summed into a `MediaStreamAudioDestinationNode`, played through an `<audio>` element on the chosen sink. `latencyMs()` reports Web Audio's `baseLatency + outputLatency` and the UI says the `<audio>` element may add more.
- Settings panel (`src/ui/views/settings.ts`, opened from a top-bar Settings key): master output select, headphone output select + Enable, headphone mix and level, a "Show device names" button, and inline notes. Device choices persist in `localStorage`; a saved master sink is re-applied at boot and a missing one falls back with a note.
- Mixer: a CUE key per channel (stacked under the fader so the strip keeps its width) and headphone Mix/Level knobs shown only when a headphone output is enabled.

**3C sampler**
- Engine `packages/dj-engine/src/engine/sampler.ts`: 4 banks x 16 pads, per-pad buffer/name/gain/mode (one-shot, gate, loop)/choke group/quantize. Velocity maps to gain on a squared curve. `nextGridTime(division)` (new on `Mixer`) schedules a quantized hit on the audible grid. The sampler bus runs into `masterGain` pre-limiter, so samples reach the recording, the radio-live feed and OBS capture.
- Console: `src/audio/samplerStore.ts` (IndexedDB, bytes + config, usage estimate, `storage.persist()`), `src/audio/clubSounds.ts` (the four club sounds rendered into real buffers), `src/ui/views/sampler.ts` (bank keys A-D, a 4x4 grid mirroring the MPD226, drag-drop or picker to load, Shift-click to edit name/gain/mode/choke/quantize/colour, clear, sampler volume). Stored pads are decoded at boot; the default bank fills any bank-A pad that has nothing stored.
- **3B.8:** the new FX surface never carried the oscillator "club FX" — they are now the sampler's default bank. Removing them from the legacy `main.ts` surface is phase 8.
- **3D.2:** MPD226 bank B triggers sampler pads (velocity from the pad), bank C maps FX 1/2 on-off and beat division, and control bank A K3/K4/F4 map FX wet/param and sampler volume. The note/CC numbers are still the assumed factory values, unverified on the unit; unmapped performance-move pads do nothing rather than lie.

**Layout fixes found while wiring this (real bugs, not just phase fit):**
- The mixer strip's fader spanned all four grid rows, which inflated every row to 83px and pushed the whole bottom tab bar below the viewport at 1280x720. The strip now uses `min-content` rows and the CUE key is stacked under the fader.
- `[hidden]` was overridden by `display: flex/grid` on the headphone knob row and the sampler editor, so "hidden" controls stayed visible. Added explicit `[hidden]` rules.
- **Audit blind spot:** `scripts/audit-ui.mjs` drops any control whose click point is covered by another element (`onTop` filter), so a genuine overlap — Deck B covering the mixer's "Kill Low B" — passed the audit at 0 issues and was only caught by `mix-check`. This is why `mix-check`, `fx-check`, `sampler-check` and `library-check` drive real clicks; the audit alone is not sufficient.

**Tests and checks (merged with the parallel Phase 4 work)**
- `packages/dj-engine/test/sampler.test.ts`: 8 offline-render tests — velocity squared curve, empty pad, one-shot end, loop sustain, choke cut, quantized onset, `nextGridTime` alignment, and `setDeckCue` routing the cue bus.
- `apps/dj-console/test/mpd226.test.ts` extended for banks B/C and the K3/K4/F4 CCs.
- `scripts/sampler-check.mjs` (`npm run sampler-check`): 10/10 in Chromium. `fx-check` 13/13, `mix-check` 21/21, `library-check` 12/12.
- `ui-audit` 0 issues at 1480x960 and 1280x720 for the default screen, Sampler (Party and Radio), FX and Settings.
- Offline engine tests (fx + sampler + analysis-channels) 21 pass / 0 fail; `tsc` clean for console and engine; `vite build` clean.
- **Caveat, reported honestly:** the full dj-engine suite intermittently fails its real-time headless audio tests under machine load (the package's own `//test` note documents this). In isolation the FX and sampler suites are green; the console suite is green.

**Remaining in phase 3 (deliberately deferred):**
- **3B.6 performance moves:** slip roll (1/4-1/32) and a real reversed backspin. Brake already exists (`Deck.vinylBrake`). The plan allows dropping backspin if it sounds wrong; both need their own offline landing test and were left out rather than shipped untested. The MPD226 bank C pads for them are intentionally unmapped.
- Bitcrush downsampling (bit depth only so far).


## Phase 4: library — BUILT 2026-10-06

**Engine (Worker entry points)**
- `packages/dj-engine/src/engine/analysis.ts`: a `SampleSource` interface (`sampleRate` + `getChannelData`) that `AudioBuffer` satisfies structurally, so `analyze()` is unchanged for every existing caller. Added `analyzeChannels(channels, sampleRate)` and `extractWaveformAndCuesChannels(...)` for the Worker, which has no `AudioBuffer`. `packages/dj-engine/test/analysis-channels.test.ts` proves the Worker path agrees with the AudioBuffer path sample-for-sample and rejects an empty channel list.

**Console (`src/library/`)**
- `analysisWorker.ts` + `analysisRunner.ts`: the Worker runs `analyzeChannels` and `computeWaveformChannels` and transfers the arrays back; `AnalysisRunner` falls back to `analyzeChannelsInline` where `Worker` is unavailable.
- `hash.ts`: FNV-1a over the first 64 KB (synchronous, identical in Worker and Node). `cacheKeyFor` = name + size + last-modified + head hash. `makeId` gives stable track ids.
- `db.ts` / `persist.ts` / `analysisCache.ts`: one IndexedDB database (`ncsound.library.v1`) with `tracks`, `blobs`, `handles`, `analysis`, `crates`, `meta`. The analysis cache is keyed by content hash and is rebuildable.
- `controller.ts`: owns the track list, a sequential index queue (pauses while either deck is loading or the tab is hidden), Up Next, crates, set history and load-to-deck. A cached record is passed to `Mixer.loadBuffer` as `overrideAnalysis` and the cached waveform straight to the view, so an indexed load does no main-thread analysis.
- `search.ts` (pure), `crates.ts` (pure), `history.ts` (pure): free-text + `bpm:120-126` / bare `120-126` / Camelot key search; sortable fields; ±6% BPM + harmonic match highlight; M3U8 and history CSV export; the 30 s audible rule for the set log.
- `sources/{files,folder,station}.ts`: drag-drop blobs in IndexedDB, `showDirectoryPicker()` with the handle persisted, and ingest's `/crate` + `/crate/audio/<id>.wav` (which reports "station computer only" off-loopback instead of trying).

**Console audio**
- `ConsoleAudio.load` now accepts `LoadOptions` and a new `loadDecoded(slot, AudioBuffer, opts)`; `loadBuffer` receives the cached `overrideAnalysis`, so loading an indexed track skips `analyze()` on the main thread (plan 4.1). `LoadedTrack` carries `durationSec` and the library id.

**UI**
- `src/ui/views/library.ts` (+ `library.css`): search box, sortable headers, virtualized rows (28px, rAF-coalesced), a status icon and played-this-session marker, a queue button per row, drag-to-deck (resolved at drop so `deck.ts` is untouched), double-click to the idle deck, Enter / Shift+Enter to the focused / other deck, Up Next + crates side panel, index progress line and storage estimate.
- Wired into `boot.ts`; the Library tab is real in both Party and Radio.

**Tests and checks**
- `apps/dj-console/test/library.test.ts` (`npm test`): 35 assertions across search/filter/match, M3U8/CSV export, hashing, and the audible-history rule (including the guarded big-time-step case). All pass.
- `scripts/library-check.mjs` (`npm run library-check`): drives the tab in Chromium with two generated WAVs — empty state, background index to `ready`, a measured BPM (124.0), search narrowing, queue, crate save, double-click load to deck A and a non-empty waveform. **12/12**, no page errors.
- `ui-audit` 0 issues on Library (empty), Sampler and FX.
- Engine `analysis-channels` 4/4; full engine suite 65 pass / 0 fail / 9 skip; `tsc` clean; `vite build` clean with the worker emitted as its own chunk.

**Harness fix:** `scripts/audit-ui.mjs` sampled before the app mounted; `index.html` hides the legacy markup with `visibility:hidden`, which keeps layout boxes, so the audit counted the legacy console (269 false issues) whenever the module graph took over 600 ms to mount. It now waits for `html[data-ui-ready]` first.

**Gaps / not done here**
- The folder handle is persisted but the boot-time permission re-check (`ensurePermission` exists) is not wired yet; a revoked folder surfaces when a track fails to read, not at boot.
- Folder tracks use filename metadata, not `parseAudioFileMetadata` (files source does parse tags).
- The full-state UI audit (rows present) was not run; behaviour is covered by `library-check` instead.
- None of the `library/*` code has been exercised against real music beyond the 20-track key spot-check the plan calls for — still outstanding.


## Phase 5: Radio mode and Go live — SERVER CORE BUILT 2026-10-06

Scope for this session was the server core (5.1 + 5.2); the console go-live flow (5.3, 5.5-5.8) is next. Verified locally; the Liquidsoap/Icecast/network acceptance checks need the station PC.

**5.1 Liquidsoap (`infra/liquidsoap/ncsound.liq`)**
- New `input.harbor("live", port=8008, user="live", password=getenv("LIVE_HARBOR_PASSWORD"), buffer=4., max=10., timeout=8.)` on the same port as the engine mount, publishing `live_harbor_connected` from its connect/disconnect callbacks (the live twin of `harbor_source_connected`).
- `normal = fallback(track_sensitive=false, [dj_live, mksafe(dj_source), filler], transitions=[cross.simple(...) × 3])`: console live is first, autopilot second, library third, with a 0.5 s crossfade.
- **Critical invariant:** the live mount is deliberately NOT wrapped in `mksafe`. `fallback` selects the first *ready* child and `mksafe` makes a source infallible (always ready), so an `mksafe`'d live mount would win forever and autopilot would never play when no console is attached. The raw harbor is ready only while a source is connected.
- Validated for real: rendered with the getenv placeholders substituted and `liquidsoap --check` passed (exit 0) in WSL Liquidsoap 2.x. `sh -n` passes on `preflight.sh`, `load-credentials.sh`, `station-up.sh`.
- `LIVE_HARBOR_PASSWORD` threaded through `infra/icecast/.env.example`, `load-credentials.sh` (required, fail-closed), `station-up.sh` (render + required), `preflight.sh` (render + leak scan), and `rotate-icecast-credentials.cjs` (generated).

**5.2 Ingest live bridge (`packages/ingest/src/live.ts`)**
- `LiveBridge`: spawns `ffmpeg -f webm -i pipe:0 -c:a libmp3lame -b:a 192k -f mp3 icecast://live:<pw>@127.0.0.1:8008/live`, with an injectable `spawn`, a session state machine (offline/armed/on_air/ended), single-session enforcement, byte accounting, an estimated bytes-vs-wall-clock drift, and a backpressure guard that drops the session if ffmpeg stops draining for over 2 s. Emits `live.armed/on_air/stats/lost/ended`.
- `LiveKeyStore`: one-time, short-TTL per-session keys issued at Arm. The control token authenticates the control plane; the live key is the audio path's second factor.
- Contract: `LiveState`, `LiveSnapshot`, `LiveEvent` in `station-core/contract/live.ts`, with `LiveEvent` folded into `ServerEvent`.

**Server integration (`packages/ingest/src/server.ts`)**
- `POST /live/arm` (token + origin) mints a key and refuses a second session with 409.
- `WS /live` (origin-gated) accepts JSON `{ token, key }` first, redeems the key once, arms the bridge, then treats binary frames as audio and text `{type:"live.end"}` as hand-back. A closed socket aborts a live session.
- **5.4 respected:** "on air" is set by `live_harbor_connected` via a Liquidsoap poll (`LiveBridge.markOnAir()`), never by the button. If Liquidsoap drops the source while the session is on air, the session is aborted.
- `/status` now carries `live: LiveSnapshot`.

**Tests and checks**
- `packages/ingest/test/live.test.ts` (13): arm/args, single-session refusal, byte accounting, on-air idempotence, clean hand-back, unexpected loss, backpressure drop, drain, drift estimate, key one-use/expiry. Includes a caught bug: a fake clock starting at 0 exposed `0` used as a sentinel where a null check was needed (`armsAtMs`, `blockedSinceMs`).
- `packages/ingest/test/live-ws.test.ts` (5) over a real socket: valid key arms and audio bytes reach ffmpeg stdin, wrong key closed with 4403, single-use key replay refused, second arm 409, `/status` carries live state.
- `packages/ingest`: **82 pass / 0 fail**; `station-core` and `ingest` `tsc` clean.

**Not done here (next)**
- Console: `src/radio/live.ts`, `preflight.ts`, Broadcast and Requests tabs, mic talkover + device selection, Radio top bar (5.3, 5.5-5.8).
- The ingest-bridge delay, harbor fallback timing (target ≤ 8 s), and end-to-end station/tunnel tests — they need a running Icecast + Liquidsoap, which this machine lacks (WSL has Liquidsoap and ffmpeg; no Icecast).
- Operator action: add `LIVE_HARBOR_PASSWORD` to `infra/icecast/.env` (or regenerate) before `station-up.sh`; it now fails closed without it.


## Audit of phases 4-5, 2026-10-06 (three-lens + independent subagent, fixed same day)

An independent auditor subagent reviewed the Phase 4 library and Phase 5 server core in parallel with the repo's own checks. Every finding was re-verified in the code or with a test before fixing. Baseline before fixes: ingest 82 pass, console suite green, `library-check` 12/12, `ui-audit` 0, liquidsoap `--check` exit 0.

**CRITICAL, fixed:**
- **The live on-air poll called a dependency that nothing implements.** `readLiveSource` guarded on `deps.station.liveSourceConnected`, but the production `LiquidsoapControl` provides `liveHarborConnected`. Every `station` member is optional, so it typechecked and silently returned: `on_air` was unreachable and the loss branch dead. No test called `startStreamPolling`, so nothing caught it. Renamed the dep to `liveHarborConnected`; added a poll test that flips an armed session to `on_air`.
- **"Load next" never advanced the queue.** `loadNext` loaded the head then called `toggleQueue(id)`, which is add-only, so the head stayed. `loadToDeck` now returns success and the head is removed only on a successful load; a browser check asserts `2 → 1`.
- **A clean hand-back was reclassified as a loss.** A socket close after `live.end` called `abort()`, which overwrote the hand-back reason and killed ffmpeg mid-flush, so `onExit` emitted `live.lost`. `abort()` is now a no-op once a hand-back is in progress; regression test added.

**WARNING, fixed:**
- **The library dead-air filler was unreachable.** `fallback` picks the first *ready* child and `mksafe` is always ready, so `mksafe(dj_source)` ahead of `filler` made the library dead. Both harbor mounts are now raw: `fallback([dj_live, dj_source, filler])`. Config re-validated with `liquidsoap --check`.
- **The live password reached argv and could reach `/status`.** ffmpeg's URL carries the password (inherent to the icecast muxer) and its stderr was copied verbatim into `lastError`. Added `redactCredentials()` and corrected the misleading comment.
- **A completed session was indistinguishable from never-started.** `onExit` forced `"offline"` over `"ended"`; `"ended"` is now kept until the next arm.
- Capped session history at 500 entries; relabelled the storage figure as whole-origin usage (it was never the library's own size); made `AnalysisRunner.terminate()` reject in-flight work; aborted the Library view's document listeners via an `AbortController` and kept the controller's frame unsubscribe.

**INFO, fixed:** removed dead exports (`deleteCachedAnalysis`, `clearAnalysisCache`, `removeHandle`, `removeCrate`, `hashHead`, `idbClear`), removed the unused `busyTrackId` state, fixed a misplaced comment, deleted a stray 0-byte root `ncsound.liq`.

**Open (not fixed):** with `INGEST_TOKEN` set, the browser must present the control token on `/live`, which tensions with "no control-plane secret ships to the client". Resolve when the remote-tunnel go-live client is built. The view/controller teardown is now wired but still never exercised because the console mounts once.

**Verified after fixes:** ingest **85 pass / 0 fail**; console suite green; `vite build` clean; liquidsoap `--check` exit 0; `library-check` **14/14**; `ui-audit` 0 on Library/Sampler/FX. Lesson: `2026-10-06-audit-phase4-library-and-phase5-live`.


## Phase 6: OBS — BUILT 2026-10-06 (console side; live-OBS acceptance pending)

The console now drives OBS over obs-websocket v5 (`obs-websocket-js@5.0.8`, MIT). OBS was not running on this machine, so the disconnected and error states are verified and the actions are built but not exercised against a live OBS.

**6.1 Client (`src/services/obs.ts`)**
- `ObsService` wraps `OBSWebSocket`: `connect`/`disconnect`, exponential-backoff reconnect (1 s → 15 s), and events `CurrentProgramSceneChanged`, `StreamStateChanged`, `RecordStateChanged`, `ConnectionClosed`, `ConnectionError`.
- Reads `GetSceneList`, `GetSceneItemList`, `GetStreamStatus`, `GetRecordStatus`, per-source `GetMediaInputStatus`; actions `SetCurrentProgramScene`, `SetSceneItemEnabled`, `TriggerMediaInputAction`, `ToggleRecord`. `normalizeAddress` accepts `host:port` or a full `ws(s)://` URL.
- The whole client is inert until an address is set; a refused socket shows `error` and reconnects, it never reports connected.

**6.2 Visuals tab (`src/ui/views/visuals.ts`)**
- Scene buttons read from OBS, current scene highlighted; the current scene's sources with a show/hide toggle; media sources get Play/Stop/Restart; OBS Record toggle; stream state. All values are read back from OBS; nothing is typed in.
- With no address it says so; with OBS disconnected it says so and every control is inert.

**6.3 Pad bank D (`src/midi/mpd226.ts`)**
- Pads 1–8 switch scenes (OBS order), pad 9 media play, 10 media stop, 11 camera (first source toggle), 12 overlay (source named `*overlay*`), 13 OBS record. Note numbers are the assumed bank-D range (unverified on the unit) and the unassigned pads do nothing.

**6.4 Overlay**
- `?ui=overlay` (and `#obs-overlay`) renders a transparent 1920x1080 lower third: now playing, artist, DJ name, a live dot.
- Because a Browser Source is a separate page that cannot see the console's decks, the console publishes what is audible over a same-origin `BroadcastChannel` (`src/audio/nowPlaying.ts`) and the overlay renders it. The audible deck is chosen by `src/audio/audibleDeck.ts` (`AudibleDeckTracker`): the most gain after channel fader and crossfader, held 4 s before switching so a scratch does not flip the title. It shows "Waiting for the console…" when nothing is arriving — never a stale track.
- **Dependency noted:** the Radio/autopilot case in the plan says the overlay reads the engine. That needs Phase 5's console engine hook; today the overlay reads the local decks (the party/live case). `onAir` is carried in the payload and is `null` until then.

**6.5 Docs:** `docs/OBS-SETUP.md` — enable obs-websocket, connect the console, the Visuals/pad-D mapping, the Browser Source overlay, Application Audio Capture, four scene templates, the audio sync offset step, and a club checklist.

**Settings:** OBS address + password (persisted; the doc says the password is in browser storage) and a DJ name for the overlay; a top-bar **OBS** chip appears only when an address is configured.

**Tests and checks**
- `apps/dj-console/test/audibleDeck.test.ts`: the required overlay audible-deck hold logic (first deck immediate; a flick does not switch; a sustained lead past 4 s does; a paused deck is never audible).
- `mpd226.test.ts` extended for bank D.
- `scripts/obs-check.mjs` (`npm run obs-check`): 11/11 in Chromium — Visuals renders and says "no address"; the OBS chip is hidden until configured; with an address set but OBS absent it shows `error`, never "connected"; the overlay renders and waits. No page errors.
- `ui-audit` 0 issues at 1480x960 and 1280x720 for Visuals, Settings and the overlay. `mix-check` 21/21, `fx-check` 13/13, `sampler-check` 10/10, `library-check` 14/14 still green; `tsc` and `vite build` clean.

**Bugs found and fixed while building this**
- The overlay module failed to load (`../ui/tokens.css` from inside `src/ui/views/`); it is `../tokens.css`. Caught by the overlay check, not by `tsc`.
- `bun add obs-websocket-js` re-resolved the dependency tree and removed the Playwright 1.48 Chromium, so every browser check failed to launch. Restored with `bunx playwright install chromium`. The check scripts take `PW_CHROMIUM` but now find the default browser again.
- `obs-check` initially flagged the expected "WebSocket refused" console line and the zero-height overlay `<html>` as failures; both are the honest disconnected state / a transparent page, and the check now filters them so it asserts only real errors.

**Not done here:** live-OBS acceptance (scene switching, media, camera, record on a running OBS 30+), and the autopilot overlay source (Phase 5 console hook). Both are noted in the plan's open items.




## Phase 7A.1: key-lock spike — RESULT 2026-10-06 (go on correctness; CPU and music quality still to measure on your PC)

`npm run`-free: `node scripts/stretch-spike.mjs` against the dev server, page `spike/stretch.html`.

**Two bugs made the spike hang or lie; both fixed:**
- **Vite pre-bundling broke the worklet.** `signalsmith-stretch` builds its AudioWorklet by stringifying its own functions into a Blob. esbuild's pre-bundle rewrites them, the worklet fails inside the audio thread, and `SignalsmithStretch(ctx)` never resolves — no error anywhere. `vite.config.ts` now has `optimizeDeps.exclude: ["signalsmith-stretch"]`; the node is ready in ~30 ms.
- **`numberOfInputs: 0` produces silence.** The node resolves "ready" but never processes (`inputTime` stuck at −latency). The default shape (1 stereo input, 1 stereo output) plays buffers correctly, and a deck is stereo anyway. The spike now uses that and stereo buffers.

**Measured in Chromium 128 (headless, 44.1 kHz), 440 Hz test tone:**
| Case | Expected | Measured |
|---|---|---|
| Key lock, rate 1.08 | 440 Hz | **440 Hz** |
| Key lock, rate 1.08, +1 semitone | 466.2 Hz | **467 Hz** (FFT bin 1.35 Hz) |
| Plain resample, rate 1.08 (today's deck) | 475.2 Hz | **475 Hz** |
| Two stretch nodes at once | both run | both run, context stays `running` |

**Latency is the real cost.** The node's latency equals its block size: 120 ms default, and `configure({ blockMs })` gives 80 → 80 ms, 60 → 60 ms, 40 → 40 ms, all still holding pitch on the tone. 120 ms is too much for cue-point feel and jog nudges; the player rework must (a) schedule with `output` ahead by `latency()` so sync/beat positions stay aligned, and (b) ship a smaller block (start at 60 ms) only after a listen test on real music — shorter blocks typically smear bass and transients, which a sine cannot reveal.

**Not measured (do on the station PC before 7A.2):** audio-thread CPU with two decks of real music (Chrome Task Manager / `chrome://tracing`), quality on drums and vocals at ±8 % with key lock on, and behaviour under glitch (tab in background). A pure tone proves pitch correctness only.

**Decision:** go for 7A.2 (`DeckPlayer` with resample + stretch implementations), gated on the CPU/quality listen. Key lock is still NOT in the audio path; the Key lock key must stay hidden until 7A.2 lands.

## Phase 5 console: Go live, Broadcast tab, Radio top bar — BUILT 2026-10-06 (station-PC and tunnel acceptance pending)

**5.3 `src/radio/live.ts` (`LiveClient`)** — a state machine with fetch, socket, encoder and clock injected:
- Phases `idle → preflight → countdown → connecting → armed → on_air → ending → ended`, plus `lost` and `failed`.
- Preflight shows four checks, each pass or fail with the reason: ingest reachable and has a live bridge (and no other console holds it); Opus/WebM encoder available; `POST /live/arm` (401 names `INGEST_TOKEN`, 403 names `INGEST_ALLOWED_ORIGINS`, 409 passes ingest's reason on); the live socket accepted.
- An 8 s countdown that can be cancelled. The mount connects only when it reaches 0, and the key (60 s TTL) is minted before it starts.
- The encoder is `MediaRecorder` on a program-bus tap (`Mixer.addProgramTap`, post-limiter), so it carries the decks, the sampler and mic talkover. It sends 250 ms chunks at 192 kbps, or 128 kbps for a weak venue uplink.
- **5.4 respected:** `on_air` is set only when ingest's `/status.live.state` says `on_air`, which ingest sets only on Liquidsoap's word. The top bar says "Sending, not yet on air" until then.
- What counts as a drop: the socket closes after arming; more than 3 s of audio queued in the socket; no encoder output for 3 s; or ingest reporting the session offline or ended. The message says Liquidsoap hands back to autopilot within the harbor timeout. Rejoin is automatic every 5 s and survives a 409 while the old session closes on the server. It gives up at exactly 60 s (an off-by-one that let it run to 65 s was caught by a test), after which a Rejoin key appears.
- Hand-back flushes the encoder, sends `live.end`, and finishes when ingest reports `ended`. If ingest doesn't confirm, it closes after 6 s and says so.
- `beforeunload` asks before closing the tab while live.

**5.5 mic (part):** `Mixer.toggleMicTalkover({ deviceId, processing })` is a new optional parameter, so legacy callers are unchanged. The console passes `processing: false` (echo cancellation, noise suppression and auto gain all off, per the plan) and the chosen input device. The Broadcast tab has a mic input select (persisted) and a Mic key, plus a note that processing is off and headphones are needed. Not tested: there is no microphone in headless Chromium.

**5.6 Broadcast tab (`src/ui/views/broadcast.ts`, part):**
- Go-live controls, the phase banner, health while sending (on-air elapsed, send kbit/s measured by the console, seconds queued, ingest kbit/s, drift labelled as an estimate), and the checklist. The checklist hides once on air so health stays above the fold.
- Station panel from ingest `/status`, polled only in Radio mode: Autopilot on/off air (ingest's single answer for the autopilot path, labelled as such so it doesn't contradict LIVE), listeners, peak, mount check, now on stream, autopilot next, and the reason line.
- Skip, Hold, imaging pads and the Requests tab are **not built**, and the tab says so.

**5.8 top bar:** an on-air chip shows OFF AIR / AUTOPILOT / LIVE IN n / Sending… / LIVE m:ss / LOST · AUTOPILOT, plus listeners. It shows in Radio mode and whenever a session is active, so switching to Party can't hide that you're live. The bar turns live red only on `on_air`.

**Lie fixed in `engine/broadcastLink.ts`:** listeners and peak came from the engine's counters, which read 0 when Icecast was never reached, so the console showed "0 listening" for an unmeasured station. They are now null unless Icecast is reachable, as the type always promised.

**Tests and checks**
- `test/liveClient.test.ts` (in `npm test`): 20 cases, all passing. They cover preflight failures, the countdown gate and cancel, on air only on ingest's word (20 s armed stayed armed), close-before-arm vs close-after-arm, the 5 s armed timeout, drop then 409 then rejoin, the 60 s give-up, uplink stall, a silent encoder, the station dropping the session, a confirmed hand-back, an unconfirmed hand-back, and double Go live.
- `scripts/live-check.mjs` + `scripts/live-harness.ts` (`npm run live-check`): Chromium against a **real** `IngestService`. The real `/live/arm`, `/live` socket, `LiveBridge` and real ffmpeg are used. ffmpeg's output is a WAV instead of `icecast://`, and Liquidsoap's "harbor connected" is stood in (true after 20 kB). **23/23.**
  - Countdown → armed in 7.9 s → on air 5.0 s later (the ingest poll is 5 s).
  - Console send rate 175 kbit/s at 192 VBR.
  - Hand-back confirmed in 0.7 s and the bridge reports `ended`, not `lost`.
  - A forced socket drop shows LOST · AUTOPILOT and rejoins on air in 9.8 s (1 attempt).
  - All three sessions' WAVs decode: 11.4 s / 4.1 s / 5.1 s at 48 kHz stereo, with 440 Hz dominant (the console's test tone) by ~130×.
- `ui-audit`: 0 issues on Radio + Broadcast at 1480x960 and 1280x720. Regression: `mix-check` 21/21, `fx-check` 13/13, `sampler-check` 10/10, `library-check` 14/14, `obs-check` 11/11. dj-engine 65 pass / 0 fail / 9 skip. `tsc` and `vite build` clean.

**Not done / not proven**
- No real Icecast or Liquidsoap in the loop. Still outstanding on the station PC: the harbor fallback time (target ≤ 8 s), console-to-listener delay, the 192→128 kbps choice on a real venue uplink, and the tunnel (`docs/REMOTE-LIVE.md` not written).
- **On-air latency in practice:** ingest polls Liquidsoap every 5 s, so LIVE lags reality by up to 5 s. Faster polling or an event from Liquidsoap would fix it.
- **Drift is a rough estimate:** ingest assumes a constant 192 kbit/s input, but MediaRecorder Opus is VBR (~175 kbit/s measured), so the estimate wanders. It is labelled "(est.)". Don't act on it.
- The `INGEST_TOKEN` tension is unchanged: with a token set, the browser console can't arm and preflight says so. That has to be resolved before going live through the tunnel.
- Requests tab (5.7), Skip/Hold/imaging (5.6), and the autopilot overlay source (6.4 dependency).
- Mic not tested with real hardware. Local speakers also carry the mic (it's on the master), so in a room with speakers, use headphones.

## Phase 5 open items resolved, 2026-10-06 (real station chain measured)

**Measured on a real chain: Icecast 2.4.4 + Liquidsoap 2.2.5 + ingest + the console in Chromium** (`scripts/station-run.sh`)
- The repo's `ncsound.liq` and `icecast.xml` are used with only paths and passwords substituted. They pass `liquidsoap --check` on 2.2.5.
  - Ubuntu 22.04's packaged Liquidsoap 2.0.2 **cannot** run this config: `settings.x := v` needs 2.1+. Keep the station PC on 2.1 or newer.
- The listener is a probe that decodes `/live.mp3` like a player and classifies the dominant test tone every 0.25 s (`scripts/station-probe.py`).
- Only the autopilot feed is a stand-in: ffmpeg pushes a 660 Hz tone into the `dj` harbor, where the engine normally publishes.

| What | Measured |
|---|---|
| Go live pressed → listener hears the console | **5.1 s** |
| Audio flowing → console shows LIVE | 1.0 s (so LIVE appears about 4 s before listeners hear it; that's Liquidsoap's 4 s live buffer plus Icecast's connect burst) |
| Deck change → listener hears it (on-air delay) | **5.1 s** |
| Feed stalls (sockets open, no audio) → listener on autopilot | **4.7 s**, 0.00 s of silence |
| Feed stalls → console shows LOST | 8.1 s (Liquidsoap only reports the disconnect at its 8 s harbor timeout; listeners were already on autopilot at 4.7 s) |
| Socket drops → listener on autopilot | **4.6 s**, 0.00 s of silence |
| Drop → automatic rejoin → listener hears console again | 16.0 s (the stall case: 18.0 s from the stall starting) |
| Hand back → listener on autopilot | 4.9 s |
| Autopilot feed dies → library filler | 12.8 s, a 0.28 s gap (the engine harbor's 12 s buffer plays out first, by config) |
| Send rate / encoder behind (real, from ffmpeg progress) | 209 kbit/s / 0.21 s |

The plan's target was fallback in 8 s or less with no dead air. It is met: 4.6–4.9 s with no silence. Two latency knobs in `ncsound.liq` trade delay for jitter tolerance: the live harbor `buffer=4.` and Icecast's default 64 KB burst. Lowering them cuts the ~5 s delay but makes a venue uplink's hiccups audible.

**LIVE lag: fixed.** Ingest's Liquidsoap poll now ticks every second, reading every tick while a session is armed or on air and every fifth tick otherwise. LIVE now follows Liquidsoap within ~1 s; it was up to 5 s.

**Drift: now measured.** The bridge asks ffmpeg for `-progress pipe:2` and computes encoder audio time (`out_time_us`) minus wall time since the first byte. The snapshot carries `driftMeasured`. The console shows "Behind s" only when it's measured. The stderr reader now scans every line, so an error followed by progress lines in the same chunk is no longer missed. Tests cover it.

**`INGEST_TOKEN` for remote live: resolved, plus a hole closed.**
- **Hole closed:** cloudflared connects to ingest *from 127.0.0.1*, so by peer address every tunnelled request looked local. With no token set, a tunnel would have exposed the whole control plane and `/requests` (listener names) to the internet. Ingest now treats any request carrying proxy headers (`cf-connecting-ip`, `cf-ray`, `x-forwarded-for`, `x-real-ip`, `forwarded`) as remote:
  - with no token, it's refused (except `/health`);
  - with a token, everything needs the bearer, reads included;
  - crate audio is never served through the tunnel.
- **Token handling:** the console's own server (`vite.config.ts`) adds `Authorization: Bearer $INGEST_TOKEN` to every proxied request, WebSocket upgrades included, so the browser never holds the token. Ingest accepts a bearer on the upgrade in place of the frame token.
- **Tests:** `packages/ingest/test/remote-auth.test.ts` (11). `live-check` 23/23 with ingest *requiring* a token (direct unauthenticated arm → 401). Without the token on the console server, preflight refuses and says where to set it.
- **Guide:** `docs/REMOTE-LIVE.md`, the tunnel setup with a phone check that `/status` answers 401.
- **Correction:** an earlier "token" pass was invalid. The test machine's file-copy step had delivered an older harness without the token flag. Caught when a direct `curl` returned 409 instead of 401; re-run after the fix.

**5.6 / 5.7 built**
- Ingest `GET /imaging` (`listImaging`) lists the jingle ids.
- `src/radio/station.ts` holds the command, request and imaging calls.
- **Broadcast tab:**
  - Skip (`mix.skip`).
  - Hold/Resume (`autopilot.set`). The label follows ingest's reported `autopilot.enabled`, re-read straight after each command.
  - One pad per imaging file (`imaging.play`).
  - Every command shows the engine's answer.
- **Requests tab (`src/ui/views/requests.ts`):**
  - Lists listener requests newest first, with listener, age and note.
  - **Cue for autopilot** (`cue.request`) shows the result: "Cued on the engine's idle deck." or "Not cued: no queued request …".
  - **Load to deck** appears only when the title/artist is in this console's library.
  - **Dismiss** hides a request on this console only (the station DB is read-only to ingest, and the tab says so).
- `requests-check` 13/13 against a real SQLite request store and a real imaging folder. The only HTTP error is the engine's expected 400 `NO_SUCH_REQUEST` for an uncrated request.

**Mic: proven into the live feed.** `scripts/mic-check.mjs` feeds a 1500 Hz file as Chromium's fake microphone. The tone was absent from the feed before the Mic key (−134 dB) and present after it (−16 dB), with the music ducked by **10.3 dB**. Input list filled after permission. 9/9. A real mic and headphones are still for you to try.

**Also fixed**
- `test/watchdog.test.ts` ("a real measurement…") needed a live station on :8010 and failed everywhere else. It now serves its own 440 Hz MP3 and asserts `audible`; set `NCSOUND_TEST_MOUNT` to measure a real station.

**Verification:** console `tsc`, ingest `tsc` and engine `tsc` are clean. `npm test` is green (now including the go-live and request-matching tests), ingest 98/98, `vite build` clean. `live-check` 23/23, `requests-check` 13/13, `mic-check` 9/9. `mix-check` 21/21, `fx-check` 13/13, `sampler-check` 10/10, `library-check` 14/14, `obs-check` 11/11. `ui-audit` 0 issues on the default, Broadcast and Requests screens at 1480x960 and 1280x720.

**Still not proven**
- A real Cloudflare Tunnel and venue network. Do the 401 phone check in `docs/REMOTE-LIVE.md`, then a test broadcast from mobile data.
- The real engine as the autopilot source (a tone stand-in was used).
- A real mic and headphones.
- LOST appears 8 s into a stall because Liquidsoap reports the disconnect only at its timeout. Listeners are fine (back on autopilot at 4.7 s), but the DJ learns late. Next step: read Liquidsoap's active source (or the live buffer state) instead of only the connected flag.


## Phase 7: spikes run — 7A.1 go on correctness, 7B.1 NO-GO on browser stems (this PC)

The two spikes that gate phase 7 were run on this machine. Results are measurements, not the plan's estimates.

**7A.1 key lock (already recorded above, line 916):** Signalsmith Stretch holds 440 Hz at rate 1.08 (key lock) vs 475 Hz by resampling; two stereo nodes now emit distinct audible tones (441/331 Hz, nonzero RMS — the earlier two-deck check counted nodes without measuring their output, a vacuous test, now fixed). Audio-thread CPU, real-music quality, and seek/loop clicks are **not** measured, so the player rework (7A.2) stays out and the Key lock key stays hidden.

**7B.1 stems — measured 2026-10-07 on this PC:**
- Browser/Chrome had a WebGPU adapter (Intel Gen-9). **Important:** the bundled Playwright Chromium reported *no* adapter; only the installed desktop Chrome found the GPU. A no-go from the bundled browser alone would have been false (lesson `2026-10-07-bundled-chromium-falsely-blocked-webgpu-spike`).
- ORT 1.30 with its full JSEP glue set; model `htdemucs_embedded.onnx` (180,534,758 bytes, SHA-256 matches the author's) loaded from a local copy. The Demucs author's own report says WebGPU Conv1d support is limited and currently falls back toward WASM.
- `scripts/stems-model-pilot.mjs` → `spike/stems-run.html`, WebGPU-only (`executionProviders: ["webgpu"]`). A WebGPU-only session created and produced four valid stems, so it did run on the GPU path.
- **A 30 s stereo track: 6 segments, model load 4.7 s, separation 64.7 s.** Steady-state ~**10.1 s per 7.8 s segment** (first 14.5 s). **Real-time factor ≈ 2.16×.** A 4-minute track projects to **~420–520 s** — well over the plan's < 360 s gate.
- Stems were not equal placeholders: the synthetic drum/bass/chord mix read drums 0.104, bass 0.226, other 0.010, vocals ~0 (no vocal present, as expected).

**Decision:** **browser stems (Path A) are NO-GO on this PC** — ~2.2× realtime means a track takes ~2× its length, far above the ~1.5× gate. Go to **Path B** (offline Python Demucs through the ingest service), gated on installing and measuring it; this PC has `torch` and `onnxruntime` but **not** `demucs`, so Path B is not yet runnable. Stem controls stay hidden until a measured path exists.

**Caveats on the numbers:** real-time factor is for this Intel UHD GPU and ORT 1.30; a different GPU may change it, so re-run on the station PC before ruling Path A out there. `peakJsHeapBytes` (~219 MB) is JS heap only; GPU memory was not measurable from JS. The model and ORT WASM binaries in `apps/dj-console/spike/` (~210 MB) are spike artifacts, not to be committed.


## Deployment-readiness work, 2026-10-07

**Credentials (operator item, done):** `infra/icecast/.env` was missing only `LIVE_HARBOR_PASSWORD`; `station-up.sh:34` requires it and renders it into `ncsound.liq` at line 107. A fresh value was appended (the other three credentials untouched — no rotation/restart). `.env` is confirmed gitignored. `station-up.sh`'s fail-closed check now passes its required-vars loop.

**Earlier LOST on a downstream stall (code, unit-tested):** the console already detects a *local* send stall at 3 s, but a stall between ingest and Liquidsoap (ffmpeg accepting input yet producing no output) only surfaced at the harbor's ~8 s timeout, because ingest's backpressure guard (`write()` returning false) never tripped. `packages/ingest/src/live.ts` now tracks the wall clock of the last ffmpeg `out_time_us` progress line and drops the session if progress stops for `stallDropMs` (3 s), or if no progress ever starts. The console's `/status` poll then shows LOST within ~3–4 s instead of ~8 s. Live-chain timing still to confirm on the station PC.

- `packages/ingest/test/live.test.ts`: 3 new tests — output stalling drops early, a never-starting encoder drops, steady progress does not drop. Ingest **102/102**; `tsc` clean.

**Blocked (need the station PC / venue / a runnable chain):**
- Cloudflare Tunnel + 401 phone check + a real mobile broadcast (`docs/REMOTE-LIVE.md`).
- 192→128 kbps choice on a real weak uplink.
- Real engine as the autopilot source and live-chain LOST timing: this WSL environment lacks the VM's station assets (`$HOME/station`, `radio-pkgs`, `ls22`, `pw-browsers`), so `scripts/station-run.sh` does not run here. icecast2/liquidsoap/ffmpeg exist, so a minimal chain could be rebuilt if needed.


## Phase 8: cleanup and release — BUILT 2026-10-07

**8.1 Legacy deleted:** the 5,400-line `src/main.ts`, the 4,400-line `src/style.css`, the legacy `index.html` markup, the `?ui=legacy` route, the legacy engine modules (`engine/midi.ts`, `engine/radioBroadcast.ts`, `engine/obsOverlay.ts`, `presets/party-templates.json`, `presets/transitions.json`) and the legacy tests are gone. `entry.ts` now routes only `/`, `?ui=gallery` and `?ui=overlay`. A pre-delete scan found no importer from the new app or from `packages/*` / the station site.

**8.2 Engine dead code:** `Mixer.triggerClubFX` (~150 lines of oscillator club FX) removed; the same four sounds still ship as the sampler's default bank (`audio/clubSounds.ts`). `transitions`, `marathon` and `scratch` are kept — they are the live autopilot path in `packages/dj-engine`.

**8.3 Debug surface gated:** `window.__ncConsole` / `__ncObs` / `__ncLive` are exposed only with `?debug`; every `scripts/*-check.mjs` now targets `?debug`.

**8.4 Production build + PWA:** `vite build` clean. `public/manifest.webmanifest` + `public/sw.js` (network-first, caches the UI shell, never caches `/ingest` or live traffic), registered from `entry.ts` and linked in `index.html`. **Bundle: boot chunk 246.10 kB, 83.26 kB gzip.** Served with `vite preview` for the checks below.

**8.5 Docs:** the console README was rewritten for the new UI (shortcuts, modes, MPD226 map, setup); the stale root `party-templates.json` removed; `docs/OBS-SETUP.md` and `docs/REMOTE-LIVE.md` stand.

**8.6 Final pass (owned here):**
- **Build fix:** the production build failed on `import.meta.env.PROD` (PWA registration) because the console tsconfig had no Vite client types. Added `src/vite-env.d.ts` (`/// <reference types="vite/client" />`).
- `ui-audit` **0 issues** on the production build at **1280×720 and 1920×1080** (default, Sampler, FX, Settings).
- `mix-check` **21/21** on the production build (two-deck mix, sync, EQ kill, loop, hot cue, cue, overview seek).
- **Soak harness** `scripts/soak.mjs` (`node scripts/soak.mjs <url> <A> <B> --dur=7200`): two decks synced and looping, crossfader centred, sampler firing every 15 s, **recording on**, sampling JS heap / master peak / context state / longest frame every 15 s. Smoke run (75 s): heap flat at **68 MB**, audio continuous (peak −2 to −21 dBFS, never a dropout), steady-state longest frame **~50–67 ms**, recording active, **0 page errors**. The full **2-hour** run is in progress writing to the run log.
- Load/start spike (one ~167 ms frame during decode) is expected and is reset before the steady-state figure is taken.

**Still open for release:** the full 2-hour soak's result; hosting the built bundle for a gig (ingest static serve or a tiny static server) rather than `vite preview`; and the hardware/venue acceptance items in categories B/C/D (MPD226 on the unit, second-output headphone cue, live OBS, real mic, tunnel, real-music key detection).


## Readiness work, 2026-10-07 (R2/Cloudflare finish, MIDI learn, soak harness)

Written from what is in the repo and what was re-run today. Hardware, the deployed Workers and a real venue are untested.

**Soak (8.6) — ran, not accepted.** The 2-hour run (479 samples) kept the context `running` with recording on, but the numbers cannot carry the "no memory growth, no dropouts" claim: heap read exactly 68 MB throughout (Chrome coarsens `performance.memory` without `--enable-precise-memory-info`), `longestFrameMs` was a never-reset maximum (a 367 ms stall at some point in the first 28 minutes, nothing about the rest), samples every 15 s cannot see dropouts, and 61 samples sat at -1 to 0 dBFS. `scripts/soak.mjs` now: ignores `--` flags as positional args (the log had been named `--dur=7200`), launches with precise memory info, reports per-window frame stalls, and counts context `statechange` events. **Needs a re-run.**

**R2 / Cloudflare finished in code (not deployed).**
- `ncsound-api`: optional `LIBRARY_TOKEN` lock (bearer or `?t=`, constant-time compare, `/health` open); malformed key 400, bad range 416, `Cache-Control`. 14 tests against a fake R2 bucket.
- `ncsound-transcode`: fail-closed `TRANSCODE_TOKEN` gate (`src/auth.ts`), 503 until configured. It was an open 200 MB billed endpoint; nothing in the console uses it. 4 tests.
- Console: audio streams through the Worker's `/audio/<key>` (not the rate-limited `r2.dev`); token field in Settings; offline cache in Cache Storage (`library/sources/r2Cache.ts`) with an **Offline** key in the Library toolbar; truncated downloads are never stored.
- **Bug found:** importing R2 queued every track for background analysis, i.e. downloading ~2.17 GB. R2 tracks are now analysed on load or on Offline save (also excluded on reload).
- **Bug found by test:** the offline pin counter lost updates under concurrency (`+=` across an `await`); fixed.
- Open: the live Workers still run old code; deploy steps and lock-down are in `docs/CLOUDFLARE-INTEGRATION.md`. The public `r2.dev` bucket currently exposes 410 commercial tracks. Range behaviour on real R2 is untested (the fake bucket is mine).

**MPD226 on a generic channel-16 preset.** Programming the unit from here is not possible, so the console learns it: `src/midi/remap.ts` rewrites what a learned control sends into the mapper's numbers, with a channel filter (1-16) and whole-bank learn (press pad 1). Settings -> MIDI controller mapping; saved per browser. 13 tests. Not run against the real unit. Unmapped controls pass through unless their raw number is now the target of something learned, in which case they are dropped.

**Audit script:** `scripts/audit-ui.mjs` ignores controls inside a closed `<details>` (they were being measured while hidden). Settings audits at 0 issues at 1480x960 and 1280x720 with the new sections folded.

**Checks re-run today:** console `tsc` clean; `npm test` green incl. 8 R2 + 13 remap tests; `vite build` clean (boot chunk 261 kB, 88 kB gzip); ingest 102/102; key-detection test passes but 2/4 correct on synthetic tracks. Readiness list: `docs/READINESS-CHECKLIST.md`.

