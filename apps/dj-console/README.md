# NCSound DJ Console

Browser DJ console (Vite + TypeScript + Web Audio). Two decks, mixer, FX,
sampler, waveforms, library with crates/search, station broadcast, requests,
OBS overlay. Legacy Phase 0 UI removed in plan phase 8.

    npm install && npm run dev

## Layout
- `src/app/` – boot, keyboard shortcuts, scheduler loop, shell
- `src/audio/` – decks, mixer, outputs, audible-deck tracker, now-playing
- `src/engine/` – platform-agnostic logic (crate indexer, broadcast link, types shim)
- `src/library/` – sources (files/folder/station), db, analysis cache, search
- `src/midi/` – MIDI access + MPD226 map
- `src/radio/` – live client, station/ingest API
- `src/services/` – OBS websocket service
- `src/state/` – console store
- `src/ui/` – controls, tokens, views
- `packages/dj-engine` – shared sync/scratch/FX engine (`@ncsound/dj-engine`)

## Tests
    npm test

## Docs
- `../../docs/OBS-SETUP.md` – OBS scene/overlay setup
- `../../docs/REMOTE-LIVE.md` – going live on the station

## Hosts and guest DJs

The owner's console (`bun run dev`, port 3102) is the station operator: its proxy adds `INGEST_TOKEN` to every request. Hosts and guests use a **second server** that never does:

1. On ingest set `INGEST_TOKEN` and `INGEST_ALLOWED_ORIGINS=https://<your-guest-url>` (optionally `INGEST_SESSIONS_FILE=...` so invites survive a restart).
2. `bun run build`, then `bun run guest` (port 3104, `DJ_GUEST_PORT` to change). Point your tunnel at **this** port, never at 3102.
3. In the owner console: Settings → Hosts & guests → enter the guest URL, name, role and duration → Create invite → send the link.

A host/guest console is Radio-only, has no Party mode, OBS or cloud-library settings, and shows only the controls their role is allowed. That is a convenience; the real limits are in `packages/ingest/src/permissions.ts` and are enforced by ingest. Guests do not auto-rejoin after a drop. Expiry or revoke takes them off the air.
