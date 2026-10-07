# Roadmap — NCSound Listener App

**Milestone v1.0:** live listening everywhere (no car; no analytics).

## Phase 01 — listener-app

Goal: ship the listener app end-to-end in one pass, in waves. Wave 0 unblocks
delivery; waves 1–4 build the app; wave 5 releases.

| Plan | Title | Wave | Depends on | Requirements |
|---|---|---|---|---|
| 01-01 | Stream relay: deploy VPS + retarget Liquidsoap | 0 | — | R1 |
| 01-02 | Public API base: Cloudflare Tunnel | 0 | — | R2 |
| 01-03 | Backend: requests JWT + delete-account function | 0 | — | R11, R15 |
| 01-04 | App scaffold + toolchain + `station-client` | 1 | — | R3 |
| 01-05 | Config/env + theme + navigation | 1 | 01-04 | R3, R16, R18 |
| 01-06 | Observability: Sentry + error boundary | 1 | 01-04 | R17 |
| 01-07 | Player core (`@rntp/player`) | 2 | 01-04 | R4 |
| 01-08 | Player resilience + now-playing + data saver + sleep timer | 2 | 01-07 | R5, R6, R7, R8 |
| 01-09 | Auth + deep links | 3 | 01-04, 01-05 | R9 |
| 01-10 | Data layer + screens | 3 | 01-07, 01-09 | R5, R12, R16 |
| 01-11 | Favorites + requests attribution + migration | 3 | 01-09, 01-10 | R10, R11 |
| 01-12 | Push notifications | 4 | 01-09, 01-03 | R13 |
| 01-13 | Store readiness + release | 4 | all | R15 |

## Phase 02 — car (v1.1, not this milestone)

CarPlay (`com.apple.developer.carplay-audio` entitlement) + Android Auto via
RNTP's built-in browse tree. Covered by R14.

## Phase 03 — edge reads (v1.1)

Move `/api/stream` + `/api/nowplaying` (Durable Object) to a public Worker
`ncsound-listen`; move relational reads via Hyperdrive → Supabase. See
`docs/MOBILE-LISTENER-APP-IMPLEMENTATION.md` §4b Part 2.

## Phase 04 — live video (v1.1)

Watch the live show in the app. Ingest is already OBS → Cloudflare Stream live
input `ncsound-obs`; this phase surfaces delivery, adds app playback, and owns
the audio/video hand-off. **Show-only** (morning show, guest DJ slots). See
`docs/LIVE-VIDEO-INTEGRATION.md`.

| Plan | Title | Wave | Depends on | Requirements |
|---|---|---|---|---|
| 04-01 | Stream live input config + `GET /api/video` | 1 | — | R19 |
| 04-02 | Watch screen (`react-native-video`) + PiP | 2 | 04-01 | R19 |
| 04-03 | Audio/video coexistence + Watch/Listen toggle | 3 | 04-02, 01-07, 01-08 | R19 |
| 04-04 | Promotion + `watch_video` toggle + push on show start | 4 | 04-02, 01-11, 01-12 | R20 |
