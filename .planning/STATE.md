# State

**Milestone:** Listener App v1.0
**Updated:** 2026-10-07

## Done (this session / prior)

- `docs/MOBILE-LISTENER-APP-PLAN.md` — strategy.
- `docs/MOBILE-LISTENER-APP-IMPLEMENTATION.md` — decisions D1–D20, §4b (D14).
- `infra/stream/` — relay `icecast.xml`, `.env.example`, runbook.
- station-web: `GET /api/stream`, stream base-URL config, CORS on public JSON
  routes, `Track.isrc` + `Track.label`.
- ingest: `ICECAST_STATUS_*` (incl. TLS) wired.
- Supabase: project `NCSound Radio` (`xczjyhsibnjbjhpvtotx`, us-east-1);
  `profiles`/`favorites`/`devices`/`push_prefs` + RLS +
  `on_auth_user_created` (`supabase/migrations/20261007_init_identity.sql`).
- station-web: `POST /api/requests` attribution already present
  (`src/lib/supabase-user.ts` — `supabaseUserId`; wired in the route). **01-03
  code was already done by a prior session**; only the Edge Function *deploy*
  remains (`supabase/functions/delete-account/index.ts` is written).
- `packages/station-client` — new typed API client for the listener app
  (plan 01-04 task 2). Typechecks clean.

## Next — buildable now

- **01-04** task 1: scaffold `apps/listener-app` (bare RN 0.83, hoisted bun,
  `metro.config.js`) + task 3 bundle smoke. Toolchain present: bun
  (`~\.bun\bin\bun.exe`), Android SDK; **no Xcode**, so iOS builds need a Mac.
- Then 01-05 … 01-13 (app screens, auth, favorites, push, store).

## Next — needs you (human)

- 01-01 deploy the VPS relay + retarget `infra/liquidsoap/ncsound.liq`.
- 01-02 stand up the `api.<domain>` tunnel.
- 01-03 deploy the `delete-account` Edge Function.
- 04-01 set `STREAM_*` env + live input `automatic` + `preferLowLatency`.

## Open inputs

- `stream.<domain>` / `api.<domain>` hostnames.
- VPS provider + region (recommend East Coast for US).

## Not started

App scaffold (`apps/listener-app`), player, auth screens, favorites, push,
store. `packages/station-client` is built. Car and edge reads are v1.1.

## Live video (2026-10-07)

Scope decided: **show-only** (morning show, guest DJ slots) — a 24/7 channel is
out of scope. `docs/LIVE-VIDEO-INTEGRATION.md` + `.planning/phases/04-live-video/`.

- **Built this session:** `GET /api/video` (`apps/station-web/src/app/api/video/route.ts`)
  — returns live status + manifest URLs + `promote` + the on-air show; CORS added;
  `apps/station-web/.env.example` added. Typecheck clean.
- Remaining for 04-01: set env (`STREAM_API_TOKEN`, `STREAM_CUSTOMER_CODE`,
  `STREAM_LIVE_INPUT_ID`) and set the live input to `automatic` + `preferLowLatency`.
- Then 04-02 Watch screen, 04-03 coexistence/toggle, 04-04 promotion + `watch_video`
  toggle.

## MCP refinement pass (2026-10-07)

Ran the fleet MCPs against the plan (`docs/MOBILE-LISTENER-APP-IMPLEMENTATION.md` §15):

- **Design:** built OG-Glass preset **`ncsound-dark`** (amber `#ffb020`), graded
  **S/100**; contract in `docs/LISTENER-APP-DESIGN.md`; binds 01-05. D21.
- **Business rules:** footguns folded in - no PII in logs (`user_id` only),
  external calls server-side, idempotent jobs. D23.
- **Architecture:** DevBrain down, so the matrix did not run; proceeding with
  React Navigation + TanStack Query + `station-client`. D22.
- **Infra:** DevBrain (`:3450`) down - recorded in `fleet.md`; og-glass JEV
  falls back without it.
