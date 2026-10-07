# Project: NCSound Listener App

**Goal:** a bare React Native app (iOS + Android) that plays NCSound live with
background/lock-screen audio, now-playing, resilient reconnect, favorites,
requests, schedule and push — reusing the existing station-web API and the
`@ncsound/station-core` contracts.

**Milestone:** v1.0 "live listening everywhere". CarPlay/Android Auto are v1.1.

## Stack

| Layer | Choice |
|---|---|
| App | bare React Native 0.83, New Architecture, TypeScript |
| Player | `@rntp/player@^5` (RNTP v5) |
| Auth / data | Supabase (Postgres + RLS + Auth) |
| Backend | existing Next.js `apps/station-web` + `packages/ingest` |
| Audio delivery | VPS Icecast relay over TLS (`infra/stream/`) |
| JSON API | Cloudflare Tunnel `api.<domain>` (edge Worker later, §4b) |
| Push | `@react-native-firebase/messaging@^26` (FCM + APNs) |
| Observability | Sentry (v1.0); PostHog (v1.1) |
| Build / test | EAS Build; Jest + RNTL + Maestro |

## Invariants

- `packages/station-core` is the single source of domain types.
- Never fabricate on-air state — render the honest `mode:'offline'` state.
- No secrets in the app bundle; Supabase RLS is the boundary.
- The statutory streaming license is **non-interactive only** (no on-demand
  listen-back).
- The stream host must not traverse Cloudflare's CDN (audio ToS); the API tunnel
  carries JSON only.

## Non-goals (v1.0)

CarPlay / Android Auto · HLS · listen-back / catch-up · PostHog · widgets ·
alarm · moving the whole station chain off the home PC.

## Canonical references

- `docs/MOBILE-LISTENER-APP-PLAN.md` — strategy
- `docs/MOBILE-LISTENER-APP-IMPLEMENTATION.md` — implementation + decisions
- `docs/REMOTE-LIVE.md` — tunnel model
- `infra/stream/README.md` — relay runbook
- `apps/station-web/AGENTS.md` — read Next.js docs before writing app code
