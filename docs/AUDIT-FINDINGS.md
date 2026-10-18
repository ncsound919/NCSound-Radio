# Audit findings — listener app, DJ console, and their shared packages

**Started:** 2026-10-18
**Scope:** `apps/listener-app`, `apps/dj-console`, and the packages they depend on
(`packages/dj-engine`, `packages/station-client`, `packages/station-data`,
`packages/station-player`, `packages/station-core`).
**Method:** every finding carries the command or file that proves it. A finding moves
to **Fixed** only after the fix has been run, not read.

## Classes

- **[C] Code** — findable and fixable here, provable locally.
- **[H] Hardware/human** — needs real gear or a person. Code review cannot close these.
- **[D] Decision** — needs an operator call.
- **[E] Environment** — a property of the machine, not the repo.

## How to reproduce the whole gate

```
bun install
bun run typecheck     # 10 packages
bun run test          # all packages
```

## Findings

| # | Class | Severity | Finding | Evidence | Status |
|---|-------|----------|---------|----------|--------|
| F1 | C | Blocker | `listener-app` failed `tsc --noEmit`. `test/*.test.ts` import `node:test` / `node:assert/strict`, the app declared no `@types/node`, and `@react-native/typescript-config` pins `types` to `["jest"]`, so `@types/node` would not have been picked up even if installed. | `bun run typecheck` → exit 2, 3 test files | **Fixed** `01f719d` |
| F2 | C | Blocker | `dj-console` died on its first test file. The script invoked `tsx`, which under Bun re-execs as `bun -r <loader>`; Bun 1.4.3 rejects the `file://` URL form ("preload not found"). The files are plain assertion scripts with no runner of their own. | `bun run test` → "preload not found" | **Fixed** `01f719d` |
| F3 | C | Blocker | `station-client` failed `bun run test`. The script was `node --test test/*.test.ts`, and `bun run` puts a `node`→`bun` shim on PATH, so it executed as `bun --test` — not the runner — and every `node:test` import threw "Cannot use test outside of the test runner". | `bun run test` → exit 1 | **Fixed** `28718eb` |
| F4 | E | Blocker (local) | `dj-engine`'s 13 tests could not run: `node-web-audio-api` is a napi-rs binary that dynamically links the MSVC C runtime, and `vcruntime140.dll` / `msvcp140.dll` were absent from `System32`. Reproduced under plain `node`, with the lockfile untouched — so not a repo defect and not Bun. | `node -e "require('…win32-x64-msvc.node')"` → `ERR_DLOPEN_FAILED`; `Test-Path C:\Windows\System32\vcruntime140.dll` → False | **Resolved** (VC++ redist installed; `dj-engine` now 66 pass / 9 skip / 0 fail) |
| F5 | C | Medium | `listener-app/tsconfig.json` maps `@rntp/player` to `../../node_modules/@rntp/player/lib/typescript/src/index.d.ts`, but the package is **not declared and not installed**, and `index.js` records that "the `@rntp/player` `registerPlaybackSession` call is gone with the library". Dead config that survives only because nothing imports it. | `@rntp` absent from `node_modules`; `index.js:11` | **Open** (W4) |
| F6 | C | Medium | `docs/ROADMAP-TO-READY.md` still says "RNTP + background/now-playing wiring remain". The player was migrated to `react-native-video` 6.19.3 (MIT) in the 2026-10-08 finalize pass, and `.planning/STATE.md` is correct. Confirmed against the code: no `@rntp` or `react-native-track-player` anywhere in `src/`. | `ROADMAP-TO-READY.md` vs `PlaybackEngine.tsx`, `.planning/STATE.md` | **Open** (W4) |
| F7 | C | Low | `dj-console` still declares `tsx` as a devDependency, but after F2 nothing uses it — it was the only consumer in the repo. | `grep '"tsx"' **/package.json` → only the devDep line remains | **Open** (W4) |
| F8 | C | Low (fragility) | `packages/dj-engine/src/index.ts` re-exports `./audio/index`, which imports the native `node-web-audio-api`. The console is safe today **only** because every import uses a subpath (`/mixer`, `/sync`, `/analysis`, …) and never the root. A single root import would pull a native Node module into the browser bundle. | `grep` of `apps/dj-console/src` → 19 subpath imports, zero root imports | **Open** (W3) |
| F9 | — | Note | Skipped tests are unverified surface, not passes: `dj-engine` 9 skip, `ingest` 6 skip. Known cause for at least one `ingest` skip: `watchdog.test.ts` spawns a bare `ffmpeg`, and `tools/ffmpeg/` contains only a `.gitignore` — the binary is not fetched. | `bun run test` summary lines | **Open** |
| F10 | C | Medium | The DJ console's honest weak point, per its own checklist, is that correctness has never been demonstrated on real hardware (MPD226, OBS, mic, headphone cue, 2-hour soak). `docs/READINESS-CHECKLIST.md` marks all of sections A/B/C unticked. | Readiness checklist | **[H]/[D]** — see below |

## Corrections to the record

Two documents describe the app's audio stack and disagree. `.planning/STATE.md`
(2026-10-08) matches the code; `docs/ROADMAP-TO-READY.md` does not. **Treat
`.planning/STATE.md` as the authoritative status source**, and `F6` as doc drift to fix.

## Environment prerequisites (not repo defects)

| Need | Why | How |
|------|-----|-----|
| MSVC C++ runtime | `node-web-audio-api` (napi-rs) in `dj-engine` | `winget install Microsoft.VCRedist.2015+.x64` — done here |
| `ffmpeg` on PATH | `ingest/watchdog.test.ts` spawns bare `ffmpeg` | install it, or fetch the binary into `tools/ffmpeg/` |
| Bun | workspace uses `workspace:*`, which npm cannot install | `irm bun.sh/install.ps1 \| iex` — done here |
| Docker + local `ncsound-pg` (:5433) | `station-web` DB-backed suites skip without it | optional; suites skip visibly |

## Still to do in this audit

- **W2** — `listener-app`: correctness, native/background wiring, a11y against the
  written `LISTENER-APP-DESIGN.md` contract, error paths, secrets.
- **W3** — `dj-console` + `dj-engine`: state machines, quota/storage, F8, key-detection
  hit rate, security of the Remote Live path.
- **W4** — mechanical sweeps: F5, F6, F7, dead code, dependency hygiene.
- **W5** — hardware/human acceptance: the `[H]` list. Scripts + pass criteria to be written.
