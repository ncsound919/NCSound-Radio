# NCSound Radio — Station Monorepo

An online radio station where **Party DJ Studio is the broadcast controller**: its
Web Audio engine does the actual mixing, sequencing and transitions, and it runs
**headless on the server** rather than in a listener's browser.

## Layout

```
packages/
  station-core/    The contract. Types + zod schemas every process agrees on.
  scratch-agent/   Deterministic scratch-routine synthesis.
  dj-engine/       Party DJ's engine, running headless. Owns the timeline.
  ingest/          (planned) Control channel + Icecast stats reader.
apps/
  station-web/     Next.js 16 operator + listener site (Prisma/SQLite).
  dj-console/      Vite + TS DJ booth UI (browser-only bits: crate, MIDI).
analysis/          (planned) Python: essentia/madmom beat+key, demucs stems.
infra/
  icecast.xml      Icecast 2.4 config. Two mounts, source auth, admin.
  liquidsoap/
    ncsound.liq       Encoder + ingest + ICY metadata + dead-air fallback.
  station-up.sh    Start both daemons (WSL).
  station-down.sh  Stop both.
  station-verify.sh End-to-end proof the chain actually streams.
  engine-up.sh     Start the headless engine (Windows side).
```

## Running the engine

The engine is a normal Node/Bun process on the **Windows** side. Liquidsoap and
Icecast run in WSL, and WSL2 forwards localhost, so the engine ingests over
`127.0.0.1:8008`.

```sh
wsl -u root sh infra/station-up.sh            # liquidsoap + icecast (WSL)
sh infra/make-test-library.sh                 # optional: a real library to play
LIBRARY_DIR=./library bun packages/dj-engine/src/run.ts
wsl -u root sh infra/station-verify.sh        # prove the chain streams
```

Liquidsoap logs the moment the engine takes over:

```
[input.harbor:3] Decoding...
[switch:3] Switch to input.harbor with transition.
```

Without `LIBRARY_DIR` the engine falls back to the built-in synthesised studio
crate, so a fresh checkout still broadcasts.

### The engine plays a set, not one loop

`Autopilot` supplies the runtime around the existing, unit-tested musical
logic in `engine/marathon.ts`: it decodes a library, follows a party-template
energy curve, arms the next track onto the idle deck before the current one
ends, and runs the transition `marathon.ts` picked.

`ingest/decode.ts` shells out to ffmpeg for raw s16le and builds the
`AudioBuffer` itself, because `node-web-audio-api` has no file loading and
uneven `decodeAudioData` container coverage. Every decoded track goes through
the real analyser, so BPM and key are measured rather than read from the
filename.

### Three bugs worth knowing about

**A transition could leave the station silent.** `next()` started the incoming
deck at `cuePoints.intro ?? firstBeat`. On short files the beat detector places
`firstBeat` late, so the deck began seconds from its end and the station went
to digital silence right after the change. The offset is now clamped to leave at
least 15 seconds and at least half the track.

**The crossfader was not the culprit.** It sits at -1 (hard left) after
`play()`, which looks like it should mute the incoming deck, but `runTransition`
writes absolute deck gains, so the fader never gates the output. Measured
directly: 0 of 15 one-second windows silent across a transition. Worth knowing
before someone "fixes" the wrong thing.

**Peaks were clipping at 1.0 and above.** Summing two decks through the
limiter still exceeded full scale. A headroom guard now trims the master when
sustained peaks appear and releases slowly. Verified: peaks bounded at -1.8 dBFS
or below, with trim moving between 0 and -3 dB.

### Per-track ICY titles

The ICY title is a request header, so it cannot change on an already-open
upload. `input.harbor` is therefore configured with `icy=true` and the publisher
interleaves 255-byte audio blocks with metadata blocks, which is how a track
change reaches a connected listener.

### How the engine runs without an audio device

`node-web-audio-api` provides the Web Audio implementation. Three findings,
each verified before being relied on:

1. A real-time `AudioContext({ sinkId: { type: 'none' } })` **does** advance its
   clock at wall-clock rate without a device (measured ratio 1.006 over 2s).
   A bare `new AudioContext()` throws `DeviceNotAvailable`.
2. `createScriptProcessor` **works** headless (~46 callbacks/sec at 2048 frames,
   the correct cadence). `createMediaStreamDestination` is *not* implemented
   (upstream #91) and `AudioWorklet` is unavailable, so ScriptProcessor is the
   only capture path.
3. `AudioBuffer`s are safe to reuse across `OfflineAudioContext`s, so decoded
   tracks can be rendered into any number of windows later.

The mixer needed exactly one change: `ctx = new AudioContext()` became
`constructor(context?: AudioContext)`. Its only browser coupling was mic
talkover and `MediaRecorder`, both already guarded.

### The engine must send WAV, not raw PCM

This cost real debugging. Publishing raw interleaved s16le with
`Content-Type: audio/L16;rate=48000;channels=2` authenticated fine, registered
the harbor mountpoint, and returned HTTP 200 — while Liquidsoap logged:

```
[decoder:3] Unable to find a decoder for stream mime-type audio/L16 ...
[harbor:4] Harbor.Make(T).Unknown_codec
```

Liquidsoap cannot decode raw L16 over HTTP. It needs an encoded container, so
the publisher now streams WAV (44-byte header with `0xFFFFFFFF` sizes, then
bare frames) as `audio/wav`. Raise `settings.log.level` to 4 in `ncsound.liq` to
see harbor-level errors; the "Switch to input.harbor" line is at level 3.

### Getting the audio request actually on the wire

A streaming upload must pass a `ReadableStream` as the request `body` with
`duplex: "half"`. Writing to `response.body` instead silently discards
everything while local byte counters keep incrementing — which looks like a
working publisher right up until the listener hears the fallback source.
`packages/dj-engine/test` and the A/B check in git history cover this.

## Running the stream (WSL2)

Liquidsoap and Icecast are Linux-native, so they run in WSL:

```sh
wsl -u root sh infra/station-up.sh      # start icecast + liquidsoap
wsl -u root sh infra/station-verify.sh  # prove it streams
wsl -u root sh infra/station-down.sh    # stop
```

Then listen: `curl http://127.0.0.1:8010/live.mp3` (128k) or `/mobile.mp3` (64k).

- **Icecast** `:8010` — public mounts, JSON status at `/status-json.xsl`
- **Liquidsoap** telnet `:1234` — Liquidsoap's control commands
- **Engine ingest** `:8008/dj` — where the DJ engine pushes audio
  (Icecast-compatible HTTP source endpoint, `input.harbor`, 12s buffer)

`/admin/stats` returns real per-mount listener counts, `listener_peak` and
`audio_info`. That is the replacement for the station app's invented
`computeListeners()` sine wave, and for the hardcoded
`Icecast mount /stream - 128 kbps AAC ... OK` in the ops panel.

### Icecast/Liquidsoap gotchas found the hard way

- **Source auth must be global** (`<authentication><source-password>`). Per-mount
  `<source-username>`/`<source-password>` is silently ignored by this build and
  every source connection 401s with "No source password set, rejecting source".
- **This Ubuntu build ignores `<webroot>`/`<adminroot>`** and resolves them
  against a compiled-in `/usr/local/icecast` prefix. `station-up.sh` seeds those
  directories from the packaged XSLs.
- **`<hostname>` must not be literally `localhost`** or Icecast warns it is unset.
- **XML comments cannot contain `--`**, so don't paste shell commands with
  double-dash flags into the Icecast config.
- **Liquidsoap 2.2 settings use `:=`, not `=`.** List literals use `;`
  separators. `input.harbor`'s `on_connect` receives the request headers.
- **Liquidsoap refuses to run as root** (`settings.init.allow_root`), so
  `station-up.sh` drops to the `liquidsoap` user via `setpriv`.
- **Liquidsoap takes ~6s to boot** (loads its stdlib, typechecks the script), so
  the start script polls instead of sleeping a fixed amount.
- The admin endpoint is `/admin/stats` and `/admin/listmounts`;
  `/admin/status.xml` is not recognised on this build.

### Liquidsoap does not sequence music

Both Liquidsoap and the DJ engine want to own the program clock. The split:

- **DJ engine owns the timeline** — track selection, beat matching, Camelot key
  locks, energy curves, transitions, scratch drops.
- **Liquidsoap owns delivery** — MP3/Opus encoding, Icecast ingest, ICY metadata,
  dead-air failover. It ingests exactly **one** input source, fed by the engine,
  and falls back to the library playlist when the engine is not connected.

## Architectural decisions

**1. Headless rendering uses `OfflineAudioContext`, not a real-time graph.**
`node-web-audio-api` implements the full graph, all `AudioParam` automation and
`AudioContext({ sinkId: { type: 'none' } })`, and renders the mixer chain at
**~66x realtime** — a 24h station costs roughly 22 min of CPU per day.

`AudioWorklet` is *not* available in that runtime and `createMediaStreamDestination()`
is unimplemented (issue #91), so the obvious "tap the live graph" design is out.
Rendering discrete blocks *ahead* of the live clock is the better answer anyway:
broadcast timing becomes immune to Node GC pauses and timer jitter.

**2. Liquidsoap does not sequence music.** See "Running the stream" above.

**3. `station-core` is the only place domain types are declared.**
It had been duplicated between `station-web/src/lib/station-types.ts` and
`dj-console/src/engine/types.ts`, which is how the two apps drift apart. Both now
import it. It has **zero runtime dependencies**; zod is an *optional* peer so
`dj-console` stays dependency-free.

**4. Control commands are a discriminated union, validated.**
The DJ app previously accepted five untyped strings (`skip`, `play`, `pause`,
`jingle`, `vibe`) with no schema, no auth, no idempotency key and no result
channel. `@ncsound/station-core/schema` replaces that with 42 validated commands,
each carrying an envelope id for correlation and replay protection.

## Known environment gotchas

- **`bun test` hangs** when a `test.each` table entry is an empty array (bun 1.3.14).
  Hostile-input tables use an explicit loop instead.
- **`bun test` needs an explicit `./path`**, otherwise it walks the workspace and
  scans ~15k files including `node_modules`.
- **Turbopack needs `turbopack.root`** set to the repo root, or it treats the app
  as the boundary and cannot resolve hoisted dependencies. This is also why the
  radio app's `.git` was moved up to the repo root rather than left nested.
- **Never write JSON with PowerShell 5.1 `Set-Content -Encoding utf8`** — it emits
  a BOM and `JSON.parse` throws `Unexpected token '\uFEFF'`. Use the editor or
  `[System.IO.File]::WriteAllText` with `UTF8Encoding($false)`.
- **Duplicate `@types/react` breaks the typecheck** ("Two different types with this
  name exist"). `scratch-agent` was on `^18` while `station-web` is on `^19`; both
  are pinned to `^19` and the root `overrides` block guards it.
- `apps/station-web/.env` is **no longer tracked** (it was, and it held a
  hardcoded absolute path). It remains on disk, untracked. Next.js needs
  `DATABASE_URL` pointed at a Windows path, e.g. `file:./db/custom.db`.
- Liquidsoap and Icecast are **Linux-native** and run in WSL2 Ubuntu, not Windows.
- `apps/station-web` has no test suite yet; `bun run test` covers the other three.

## Verification

| Package | Command | Status |
|---|---|---|
| station-core | `bun run test:core` | 86 pass |
| station-core | `bun run typecheck` | clean |
| station-web | `bunx tsc --noEmit` | clean |
| station-web | `bunx next build` | 21 routes |
| dj-console | `bun run test` | 9 suites |
| dj-console | `bunx tsc --noEmit` | clean |
| dj-engine | `bun test ./test/` | 5 pass |
| dj-engine | `bunx tsc --noEmit` | clean |
| scratch-agent | `bunx tsc --noEmit` | clean |

All five packages are clean under `bun run typecheck` at the repo root.

`scratch-agent` has no test script of its own: its behaviour is covered by
dj-console's nine suites, which exercise the scratch agent, sentence mode and
autoscratch against the real implementation. Its former vitest test targeted
the older scratch-agent variant and is parked with that variant in
`.merge-park/scratch-agent-variant-b/`, kept in case that implementation is
ever wanted back.