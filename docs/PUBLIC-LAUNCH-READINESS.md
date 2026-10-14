# Public launch readiness — listeners

Two ways a member of the public reaches NCSound: **listen on the site**, or
**install the app**. Both are wired locally and neither is public yet. This is
the checklist to get them there. Tick a box only when you have seen it work
yourself ("measured"), never because the code exists.

Companions: `ROADMAP-TO-READY.md` (master, dependency-ordered),
`READINESS-CHECKLIST.md` (DJ-console / gig), `LISTENER-APP-STORE-READINESS.md`
(app-store gates), `CLOUDFLARE-INTEGRATION.md`, `REMOTE-LIVE.md`.

Status legend: **[done]** · **[ready]** (artifacts exist, needs running) ·
**[partial]** · **[blocked: <input>]** · **[todo]**.

---

## Decisions (fixed 2026-10-11)

- **No music licences.** Not doing SoundExchange/PRO — this removes the legal gate
  from the roadmap for our purposes. (Consequence accepted: this is not a
  statutory-licensed public broadcast; keep it to the private/known audience.)
- **Android-first; the app is downloadable from the site** as a PWA
  (installed to the home screen). **Native / iPhone defers to later** — the store
  track (W3–W5) is parked, not required for launch.
- **Site deploys to Vercel** (`apps/station-web`, config committed at
  `vercel.json`; `output: standalone` disabled under Vercel).
- **Auth via Google, credentials in Keywire** (`GOOGLE_OAUTH_CLIENT_ID` /
  `GOOGLE_OAUTH_CLIENT_SECRET`) — pulled from the vault, never committed.
- **Only the VPS (public stream) and Cloudflare scopes remain as blockers.**

---

## The bottleneck (read first)

The station streams on **`127.0.0.1:8010`** on this PC. There is no public
stream URL, so nothing listener-facing can work yet — the site falls back to
loopback, and an app has nothing to connect to. **Cloudflare's CDN is barred for
radio audio and does not cache ICY** (wiki 2026-10-07), so the public stream must
be a byte-rangeable, non-Cloudflare-CDN host (a small VPS running Icecast over
TLS). Track L's first three items block everything else.

---

## Track L — Listen from the site

| # | Step | Where | Status |
|---|---|---|---|
| L1 | Pick the stream domain, e.g. `stream.<domain>` | decision | **[blocked: your domain]** |
| L2 | Provision a small VPS (Hetzner/DO/Vultr); **DNS-only** A record for `stream.<domain>` | registrar + VPS | **[blocked: provider acct]** |
| L3 | Run the relay from `infra/stream/` (Icecast over TLS; firewall the source port to the home IP) | VPS | **[ready]** |
| L4 | Push from home: point `infra/liquidsoap/ncsound.liq` `output.icecast` `host` at the VPS; restart the station | station PC | **[todo]** |
| L5 | Point ingest at the relay: `ICECAST_STATUS_HOST/PORT/TLS/USER/PASSWORD` | station PC | **[ready] (code done)** |
| L6 | Set the site's stream URL and confirm `/api/stream` resolves to it | `apps/station-web` | **[ready]** |
| L7 | **Deploy station-web to Vercel** (Root Directory `apps/station-web`; config committed at `vercel.json`; set the env vars below) and set the admin credential (`scripts/set-admin-password.ts`) | Vercel | **[ready]** — config committed 2026-10-11; needs the env vars + the account |
| L8 | Lock the public API origin (`NEXT_PUBLIC_API_ORIGIN`) to the site origin | `apps/station-web` | **[ready]** |

**L6 — exact config (the one env value that makes listening work).** In
`apps/station-web/.env`:

```dotenv
NEXT_PUBLIC_STREAM_BASE_URL=https://stream.<domain>   # no trailing slash
# NCSOUND_STREAM_BASE_URL=https://stream.<domain>     # server-side alias
NEXT_PUBLIC_ICECAST_PORT=8010
```

Read by `src/lib/stream.ts` (`streamBaseUrl()` → `NEXT_PUBLIC_STREAM_BASE_URL`
?? `NCSOUND_STREAM_BASE_URL` ?? loopback `:8010`) and surfaced at
`/api/stream`. **Mixed content:** the site is HTTPS, so the stream URL **must**
be HTTPS or browsers will block the audio.

**Vercel — env vars to set** (Project → Settings → Environment Variables), then
deploy. Copy these key names from `apps/station-web/.env.example`:

```
NEXT_PUBLIC_STREAM_BASE_URL   # https://stream.<domain>  (from Track L)
NEXT_PUBLIC_ICECAST_PORT      # 8010
NEXT_PUBLIC_API_ORIGIN        # the Vercel site origin (lock CORS down)
DATABASE_URL                  # Supabase Supavisor SESSION pooler
DIRECT_URL                    # same pooler host (for prisma migrate)
SUPABASE_URL / SUPABASE_ANON_KEY
INGEST_URL / INGEST_TOKEN     # server-side only — never exposed to the browser
```

Do **not** expose `INGEST_TOKEN` as `NEXT_PUBLIC_*`. Deploy notes: monorepo is a
bun workspace, so `vercel.json` installs/built from the repo root; the auth
(Supabase Google provider) is configured in the Supabase dashboard using the
Keywire Google client, not in the site env.

**L-acceptance [todo]:** on a phone on **cellular** (off the home LAN), open the
site, press play, hear `/live.mp3`; switch to 64k `/mobile.mp3`; listener counts
come from the relay.

---

## Track W — Download / install the app

"Download the web app" means **install the PWA to the home screen**. As of
2026-10-11 the pieces are in place (service worker, 192/512 icons, `scope`/`id`,
an `Install app` button) — what is left is a real browser test on the deployed
HTTPS site, and Android is the target (iPhone's manual "Add to Home Screen"
works too, but the native app defers).

| # | Step | Where | Status |
|---|---|---|---|
| W1 | Service worker + registration, so the PWA is installable | `public/sw.js` + `ServiceWorkerRegister` in the root layout | **[done 2026-10-11]** — install/activate only, no fetch caching; site typechecks. **Still needs a real browser install test** |
| W2 | Install affordance + complete manifest (192/512 icons, `scope`/`id`) | `apps/station-web` | **[done 2026-10-11]** — `icon-192.png` + `icon-512.png` generated, manifest updated, `InstallApp` button (`beforeinstallprompt`) added; typechecks |
| W3 | **Verify the install end-to-end** (Android Chrome) | a device | **[todo]** — tap Install on the deployed site; the app opens standalone and plays |
| W4 | Native app + store listing (**iPhone later**) | app stores | **[deferred]** — Android-first via PWA; native/iPhone is a later track |
| W5 | Native app auth providers (Apple / Google / email OTP) | Supabase | **[deferred]** — Google client is in Keywire for when this resumes |

**State of the app (`apps/listener-app`):** bare RN + New Architecture; player /
reconnect / sleep logic lives in `packages/station-player` (tested); screens,
RNTP background wiring, and store screenshots still open — see
`MOBILE-LISTENER-APP-IMPLEMENTATION.md` and `LISTENER-APP-STORE-READINESS.md`.

**W-acceptance [todo]:** on Android Chrome over the deployed HTTPS site, the
**Install app** button appears, installs, and the installed app opens standalone
and plays. (iOS Safari: Share → Add to Home Screen — manual, no button.)

---

## Shared / supporting (needed for either track)

- [x] **Brand reconciled (2026-10-11).** The manifest's outlier "WAVC 91.3 FM —
  Carolina Waves" (and its mojibake em dash) was replaced with **"NCSound Radio"**,
  matching the system default in `api/nowplaying` (`station_name ?? 'NCSound Radio'`),
  `share.ts`, and the layout metadata. The public domain is now driven by
  `NEXT_PUBLIC_SITE_URL` (fallback `https://ncsound.fm` is a placeholder — set it
  on Vercel).
- [~] **Now-playing reaches listeners.** The **site and PWA already show the real
  track**: `/api/nowplaying` reads the engine's now-playing (not ICY), so the
  player bar is correct. **Third-party ICY players (VLC/TuneIn) still show the
  station name, not the track** — enabling `icy=true` on the harbor (alone, and
  with the engine's ICY framing `HARBOR_ICY=1`) did not surface a title and
  risks the WAV desync, so it was reverted. Left open; not needed for the site.
- [ ] **Monitoring has a destination.** `infra/health-check.mjs` is scheduled and
  logs locally; wire a real alert (Cloudflare Notifications or a webhook).
- [x] **Legal — not doing it (operator decision 2026-10-11).** No
  SoundExchange/PRO. Consequence accepted: not a statutory-licensed public
  broadcast; keep the audience private/known. (If that changes, this becomes a
  hard gate again.)
- [ ] **After a reboot, start the stack.** `sh infra/station-up.sh` (WSL) and
  `sh infra/engine-up.sh` (Windows) — neither persists. The engine has no
  supervision: it died mid-session (2026-10-11) and the station silently fell
  back to filler until it was restarted. Watch it, or add a supervised unit.
- [ ] **Security:** rotate the shared admin password; keep ingest/harbor/telnet
  ports **unexposed** (tunnel only to the ingest hostname — `REMOTE-LIVE.md`).

## External inputs you must supply (the true blockers)

**Remaining (only these):**

1. **Domain** (for `stream.<domain>` and the site).
2. **VPS** account/billing (Hetzner / DO / Vultr) for the public stream relay.
3. **Cloudflare** scopes (Access / Stream / AI Gateway) as needed.

**Already handled / deferred:**

- **Google auth** — client id + secret are in **Keywire** (pull when wiring the
  Supabase Google provider).
- **Apple / Play accounts** — deferred; Android ships via the PWA.

---

## Minimum path to a public listener (shortest chain)

1. L1–L5 → a public `https://stream.<domain>/live.mp3` a phone can play.
   (Needs the **VPS + domain** — the only real blockers.)
2. L6 + L7 → the site on **Vercel** with its player pointed at that URL.
3. W1–W3 → the site offers **Install app** on Android and it plays.
4. (No licence step — operator decision; keep the audience private.)

Everything else (native/iPhone app, host/guest delegation, video) is additive
and can follow after a listener can hear the station from the site.
