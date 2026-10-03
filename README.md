# WAVC 91.3 — Station Monorepo

An online radio station where **Party DJ Studio is the broadcast controller**: its
Web Audio engine does the actual mixing, sequencing and transitions, and it runs
**headless on the server** rather than in a listener's browser.

## Layout

```
packages/
  station-core/    The contract. Types + zod schemas every process agrees on.
  scratch-agent/   Deterministic scratch-routine synthesis (vitest).
  dj-engine/       (planned) Party DJ's engine, ported headless.
  ingest/          (planned) render-ahead pump -> PCM -> Liquidsoap.
apps/
  station-web/     Next.js 16 operator + listener site (Prisma/SQLite).
  dj-console/      Vite + TS DJ booth UI.
analysis/          (planned) Python: essentia/madmom beat+key, demucs stems.
infra/
  icecast.xml      Icecast 2.4 config. Two mounts, source auth, admin.
  liquidsoap/
    wavc.liq       Encoder + ingest + ICY metadata + dead-air fallback.
  station-up.sh    Start both daemons (WSL).
  station-down.sh  Stop both.
  station-verify.sh End-to-end proof the chain actually streams.
```

## Running the stream (WSL2)

Liquidsoap and Icecast are Linux-native, so they run in WSL:

```sh
wsl -u root sh infra/station-up.sh      # start icecast + liquidsoap
wsl -u root sh infra/station-verify.sh  # prove it streams
wsl -u root sh infra/station-down.sh    # stop
```

Then listen: `curl http://127.0.0.1:8000/live.mp3` (128k) or `/mobile.mp3` (64k).

- **Icecast** `:8000` — public mounts, admin on `/admin/stats`
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
channel. `@wavc/station-core/schema` replaces that with 42 validated commands,
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
| scratch-agent | `bunx vitest run` | 15 pass |