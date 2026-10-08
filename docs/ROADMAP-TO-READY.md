# Roadmap to a fully ready system

Consolidated, dependency-ordered plan across every workstream. Companion to
`MOBILE-LISTENER-APP-IMPLEMENTATION.md`, `HOSTS-AND-GUEST-SLOTS-PLAN.md`,
`CLOUDFLARE-INTEGRATION.md`, `DATA-AND-DB-PLAN.md`, `REMOTE-LIVE.md`, and
`infra/stream/README.md`. Status legend: **[done]** / **[ready]** (artifacts
exist, needs running) / **[partial]** (part done, part still open) /
**[blocked]** (external input) / **[todo]**.

---

## 0. Critical path

The shortest chain to "a listener hears NCSound in the app, and you can safely
let others drive":

1. Restart Icecast on the home PC (apply the mount fix). *(minutes)*
2. Provision the VPS stream relay and go live on HTTPS. **Blocks public + app.**
3. Enable the app's auth providers (Apple/Google) → build the RN app.
4. Harden host/guest access (slot windows + audit + Access doors) before letting
   anyone else on air.
5. Ops/legal/CI before launch.

Everything else (Vectorize, AI Gateway, station container, hub) is additive and
does not block a first real broadcast.

---

## A. Stream delivery — the listener-facing audio

| # | Step | Status |
|---|---|---|
| A1 | Restart home Icecast so the fixed `<mount-name>`/`<max-listeners>`/`<genre>` apply | **[done 2026-10-07]** — re-rendered + restarted; both mounts reconnect; names apply |
| A2 | Choose the production domain (`stream.<domain>`) | **[blocked]** — your decision |
| A3 | Provision a small VPS (Hetzner/DO/Vultr); `stream.<domain>` **DNS-only** A record | **[blocked]** — provider acct |
| A4 | Run the relay from `infra/stream/` (`icecast-ssl` per D11, or `libretime/icecast:2.5.0` + certbot); TLS + firewall source port to home IP | **[ready]** |
| A5 | Point home `ncsound.liq` `output.icecast` at the VPS (push); restart | **[todo]** |
| A6 | Point ingest at the VPS: `ICECAST_STATUS_HOST/PORT/TLS/USER/PASSWORD` | **[ready]** (code done) |
| A7 | Set `NEXT_PUBLIC_STREAM_BASE_URL=https://stream.<domain>`; verify `/api/stream` | **[ready]** |
| A8 | **Accept:** a phone on cellular plays `/live.mp3` + `/mobile.mp3`; counts come from the relay | **[todo]** |

Why first: nothing public scales until the stream leaves the home PC and stops
relying on a Cloudflare tunnel (barred for audio, no ICY caching).

---

## B. Listener app (React Native) — the product

Strategy + build detail already written. Remaining:

| # | Step | Status |
|---|---|---|
| B1 | `packages/station-client` typed fetch client (shared by app + web), validated with `station-core` | **[done]** — opt-in zod validation via `@ncsound/station-core/http`; 8 tests |
| B2 | Enable Supabase auth providers: **Apple + Google + email OTP** | **[blocked]** — Apple Services ID/key + Google client |
| B3 | Bare RN + New Architecture + RNTP: player, background/lock, reconnect, data saver, sleep timer | **[partial]** — pure mount/reconnect/sleep logic in `packages/station-player` + 11 tests; bare RN shell scaffolded in `apps/listener-app` (react-native 0.87, `ios/`+`android/`); RNTP + background/now-playing wiring remain |
| B4 | Screens: Home / Player / Schedule / Requests / Settings / Sign-in | **[todo]** |
| B5 | Favorites + device tokens wired to the live Supabase tables (already applied) | **[partial]** — `packages/station-data` (favorites store, devices, prefs, profile; PostgREST adapter) + 13 tests; app wiring pending the B3 scaffold |
| B6 | Push: FCM + APNs, `devices`/`push_prefs` populated, an Edge Function sender | **[partial]** — `send-push` Edge Function (FCM v1, pref-aware, prunes dead tokens); needs the FCM service account + deploy |
| B7 | Car: request **CarPlay entitlement early**; Android Auto in v1.1 | **[blocked]** — Apple approval |
| B8 | Store gates: `PrivacyInfo.xcprivacy`, App Privacy, **account deletion (done)**, demo account, privacy/support URLs, screenshots | **[partial]** — manifest at `apps/listener-app/ios/NcsoundListener/PrivacyInfo.xcprivacy`; App Privacy/review copy in `docs/LISTENER-APP-STORE-READINESS.md`; screenshots + demo build need a built app |
| B9 | Legal: **SoundExchange** statutory + **ASCAP/BMI/SESAC/GMR**; populate `Track.isrc`; monthly Reports of Use | **[blocked]** — counsel/fees |

Auth backend (schema, RLS, delete-account, request attribution) is **[done]**.

---

## C. Hosts & guest slots — letting others drive safely

| # | Step | Status |
|---|---|---|
| C1 | ingest: `Session` slot window (`notBefore`/`notAfter`), optional `producer` role, **audit log** | **[done 2026-10-07]** — window enforced at `/live/arm`; a slot end clamps `expiresAt` (the air drops then); JSONL audit of `session.issue/revoke` + `live.arm/kill` via `INGEST_AUDIT_FILE`. No `producer` role: guest + `canLive:false` covers it |
| C2 | Host + guest console builds; host door adds `/requests`; guest door as today | **[done 2026-10-07]** — the guest door already proxies `/requests`; ingest's role-scoped reads (host includes `/requests`) do the scoping, so one door serves both invite roles |
| C3 | Enable **Cloudflare Access**; OTP IdP; apps + policies on `host/guest/ingest.<domain>` | **[blocked]** — enable Access |
| C4 | Host/guest doors served behind Access (Pages or a tunnel hostname) | **[todo]** — **optional if the control plane moves to Workers VPC** (2026), where the private binding is the boundary instead of a public Access gate. See `CLOUDFLARE-NEW-2026.md` |
| C5 | Shows & slots roster in station-web that mints slot-bound sessions | **[partial]** — read-only roster + window-bound mint/revoke in the Ops tab (`api/ops/slots`, `lib/slots`, `SlotsPanel`), admin-gated, using the engine's owner `/sessions`. Needs `INGEST_TOKEN` set on station-web and the Access door (C4) to be usable end-to-end; not yet run against a live engine |
| C6 | (optional) Access-JWT → session broker so recurring hosts hold no link | **[todo]** |

P0 (gate the public endpoints, worker tokens) is **[done]**.

---

## D. Cloudflare edge completion

| # | Step | Status |
|---|---|---|
| D1 | **Vectorize** "similar tracks": feature producer + index + `/similar` | **[done 2026-10-07]** — index `ncsound-tracks` (32-dim, cosine); `trackFeatureVector` (station-core) from `TrackAnalysis`; Worker `/index` (INDEX_TOKEN, fail-closed) + `/similar`; the console publishes R2 tracks via the `/vectorize` proxy. `/similar` neighbour ordering verified live. Console runtime populates the index as tracks are analysed |
| D2 | Decide `ncsound-api` gating (`LIBRARY_TOKEN`) — currently fail-open by decision | **[todo]** |
| D3 | **Access + Turnstile + WAF + rate limits** on public surfaces (phase 7) | **[partial]** — Turnstile reachable; AI Gateway + AI Search already exist (account). Access: needs enablement, and is optional if the control plane uses Workers VPC |
| D4 | **AI Gateway** in front of any model calls | **[ready]** — the account already runs `ecosystem` and `default` gateways; reuse one rather than provisioning |
| D5 | **Hyperdrive → Supabase** (only if a Worker reads operator Postgres) | **[todo]** |
| D6 | **Durable Objects** for edge control state (if the edge serves now-playing / live keys) | **[todo]** |
| D7 | **Station container** (Liquidsoap+Icecast+ingest) to retire the home SPOF | **[todo]** |

Done: `ncsound-api` Worker, `ncsound-transcode` Container (gated), R2 media +
CORS, the `ncsound-api.overlay365.online` subdomain, Cloudflare **Stream** live
input + OBS→Stream wiring.

---

## E. Operator site, ops, and release hygiene

| # | Step | Status |
|---|---|---|
| E1 | Host station-web and set the admin credential (`scripts/set-admin-password.ts`) | **[partial 2026-10-07]** — credential set/rotated (recoverably stored at `~/.config/ncsound/admin.txt`; the checklist required rotating the shared one). **Hosting remains** — needs a target (Vercel / self-host / Pages); the ops surfaces are otherwise ready |
| E2 | Confirm no remaining ungated endpoints; keep CORS public-only | **[done]** |
| E3 | Backups: DB snapshots, R2 lifecycle rules, ingest sessions file | **[partial]** — `infra/backup-state.mjs` takes an online SQLite snapshot (`node:sqlite` `backup()`) plus the ingest sessions/audit files, one timestamped dir per run with rotation; verified (integrity ok). Scheduling + R2 lifecycle rules remain |
| E4 | Monitoring/alerting on the mount watchdog + Icecast | **[partial 2026-10-07]** — `infra/health-check.mjs` polls ingest `/status`, distinguishing "not on air" (exit 1) from "ingest down / port held by another process" (404 or non-JSON ⇒ exit 2); optional `--webhook`. Verified against a mock (healthy 0 / silent 1 / off-air 1 / wrong-service 2). Remaining: schedule it, and the edge half via Cloudflare **Observability + Notifications** |
| E5 | CI: one pipeline running typecheck + all tests + the check scripts | **[done 2026-10-07]** — `.github/workflows/ci.yml` runs `bun install` + `bun run typecheck` + `bun run test`; the browser check scripts stay local (they need a dev server / OBS) |
| E6 | Secrets: rotate the OBS password and the Cloudflare Stream key (both surfaced in chat); delete `.history-backup-pre-scrub.bundle`; creds now at `~/.config/ncsound/supabase.txt` | **[partial 2026-10-07]** — bundle deleted; OBS password + Stream key rotation still open (operator action) |
| E7 | Commit the working tree (very large, long uncommitted) | **[done 2026-10-07]** — baseline `883c3d7`; C1 merged to `main` `1b46a6e`. B's newer packages (`station-data`, `station-player`, `listener-app`) are still untracked — B commits those |

---

## F. Data / databases

**[done]**: Supabase identity (RLS, delete-account, request attribution); SQLite
migrations baselined + `Track.isrc`/`label` + `TrackRequest.userId`; media in R2.
**Remaining**: populate ISRCs (B9); decide the operator-site SQLite→Postgres move
(recommended: later, separate project — `DATA-AND-DB-PLAN.md` §4).

---

## External inputs you must supply (the true blockers)

1. **Domain** for `stream.<domain>`.
2. **VPS provider** account/billing (Hetzner / DO / Vultr).
3. **Apple** developer account: Services ID + key (Sign in with Apple) and the
   **CarPlay** audio entitlement request.
4. **Google** OAuth client.
5. **Cloudflare**: enable **Access**; a token with **Stream** + **AI Gateway**
   scopes; **Stream** billing.
6. **Licenses**: SoundExchange + a PRO, and ISRC data, before public launch.
