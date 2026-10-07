# NCSound listener app — implementation plan

Status: **implementation plan** (nothing built). Refines
`docs/MOBILE-LISTENER-APP-PLAN.md` after a second research pass on 2026-10-07.
Read that first for the strategy and the reasoning; this document is the
buildable version: decisions, layout, tasks, files, acceptance.

Goal: **one app, tap play, hear NCSound live — backgrounded, locked, and in the
car** — reusing the existing station-web API and `station-core` contracts.

## Main-app baselines resolved (2026-10-07)

Resolved on station-web so the app has a stable target (this session):

- **`GET /api/stream`** (`apps/station-web/src/app/api/stream/route.ts`) →
  `{ baseUrl, live, mobile, hls, updatedAt }`. Clients stop hardcoding mounts.
- **Stream base URL is config, not a constant** (`src/lib/stream.ts`):
  `NEXT_PUBLIC_STREAM_BASE_URL` / `NCSOUND_STREAM_BASE_URL`, falling back to the
  loopback Icecast. `stream-source.ts` and `ingest.ts` now read it; the
  hardcoded `http://127.0.0.1:8010` is gone. §8 tasks 1–2 done.
- **CORS on the public JSON routes** (`next.config.ts` `headers()`): stream,
  nowplaying, schedule, charts, history, tracks, artists, requests, listeners.
  Admin/auth routes excluded. §8 task 4 done.
- **`Track.isrc` + `Track.label`** added to the Prisma schema for Reports of
  Use (§11). §11 schema task done.
- **Ingest Icecast status reader is config** (`packages/ingest/src/icecast.ts`
  + `main.ts`): `ICECAST_STATUS_HOST/PORT/USER/PASSWORD/TLS`, loopback default.
  Point these at the VPS relay so public listener counts come from where
  listeners actually connect (decision D10). `TLS=1` fetches the status page
  over HTTPS.
- **Supabase project created + identity schema applied** (project
  `NCSound Radio`, ref `xczjyhsibnjbjhpvtotx`, us-east-1): `profiles`,
  `favorites`, `devices`, `push_prefs` — **RLS on all four** with user-scoped
  policies, and an `on_auth_user_created` trigger that creates the profile on
  signup. Source of truth: `supabase/migrations/20261007_init_identity.sql`
  (idempotent). §7 tables done.
- **§8 task 3 done:** `POST /api/requests` attributes to a Supabase user id
  (`src/lib/supabase-user.ts`), and the `delete-account` Edge Function is
  deployed + verified.
- **Console wiring (P3) done:** library **LUFS**/**Norm** via the console's
  `/transcode` proxy (Worker token server-side) and Settings → **Send to OBS**
  for Cloudflare Stream (`SetStreamServiceSettings`). See
  `HOSTS-AND-GUEST-SLOTS-PLAN.md` §8 G7.
- **Still open:** enabling the Apple/Google auth providers (needs the Apple and
  Google developer credentials).


---

## 0. Corrections to the strategy plan (do not build the old P0)

The first plan said to expose the stream with a **Cloudflare Tunnel**. Research
says that is wrong twice over:

1. **Cloudflare's Service-Specific Terms** prohibit using the free CDN to serve
   "a disproportionate percentage of pictures, audio files, or other large
   files" without a paid product (Stream/Images/R2), and reserve the right to
   disable access. A public radio stream is exactly that.
2. **Cloudflare does not cache ICY streams.** Even through a Tunnel, every
   listener hits the origin — so it buys nothing at scale and risks the account.

The stream host is therefore a **small VPS with Icecast over TLS**, on a
**DNS-only** subdomain. Details in §4.

---

## 0b. Corrections from the deep-research pass (third pass, 2026-10-07)

| # | Earlier said | Corrected |
|---|---|---|
| C1 | `react-native-track-player` | **`@rntp/player@^5`** (v5.12.1). `react-native-track-player` npm is frozen at **4.1.2**; do not install it. |
| C2 | Poll `/api/nowplaying` for the lock-screen title (iOS won't surface ICY) | RNTP v5 **auto-updates lock screen / notification / CarPlay / Android Auto from ICY** (`autoUpdateMetadataFromStream`, default true; iOS ICY fixed in 5.7.0). Poll `/api/nowplaying` only for in-app art + up-next. |
| C3 | "P0 is all ahead of us" | P0's **code** is done (stream env base, `/api/stream`, CORS, `ICECAST_STATUS_*` TLS). Only the **VPS deploy** and the **Liquidsoap retarget** remain. |
| C4 | (unaddressed) | The app needs a **public API base** (`api.<domain>`), separate from the stream host. See §4b. |
| C5 | bare RN in a bun workspace, hand-waved | Needs **hoisted installs** (`bunfig.toml` → `[install] linker = "hoisted"`) + an explicit `metro.config.js`; exactly one `react-native` / `react` / `metro` version across the workspace. |

---

## 1. Locked decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Bare React Native** (React Native CLI), New Architecture, TypeScript | Expo + CarPlay is a known dead end (Expo has no Scenes; `expo-dev-client` clashes). Bare RN is what the car libs support. |
| D2 | **`@rntp/player@^5`** as the player (the RNTP v5 package; `react-native-track-player` on npm is frozen at 4.1.2) | Purpose-built for live radio: `isLive`, `liveResumeBehavior:'live-edge'`, `seekToLiveEdge()`, and native ICY metadata → lock screen/notification/car. Requires New Architecture. |
| D3 | **Stream host = VPS + Icecast over TLS**, DNS-only subdomain | Cloudflare CDN is barred for audio; a VPS gives TLS, reach, and removes the home-PC single point of failure for listeners. |
| D4 | **v1 streams ICY MP3** (existing mounts); HLS deferred | Lowest latency, works in `AVPlayer`/ExoPlayer, no packager needed. |
| D5 | **Supabase Auth from v1**, app queries Supabase directly with RLS | Favorites sync, request attribution, device/push table. Matches the roadmap. |
| D6 | **Car = RNTP's built-in browse/now-playing first**; `@iternio/react-native-auto-play` only if custom templates are needed | Avoid a second car framework unless required. |
| D7 | **Sign-in = Apple + Google + email OTP** | Guideline 4.8 requires an equivalent privacy-preserving option when using a third-party login; Apple covers it. |
| D8 | **Push = FCM + APNs direct** (`@react-native-firebase/messaging`), tokens in Supabase | No extra vendor; device table already planned. |
| D9 | **VPS role = raw Icecast over TLS as a dumb relay** (not AzuraCast, not the full chain) | Reuses the existing `icecast.xml`/mounts; leaves `ncsound.liq`'s failover, harbor buffer and ICY titles untouched; smallest, reversible step. AzuraCast would force re-implementing them. |
| D10 | **Origin direction = push** — home Liquidsoap is a source client to the VPS Icecast over TLS (source password restricted to the home IP) | No inbound port on the home network. Consequence: public listener counts come from the **VPS** Icecast status, so point `packages/ingest/src/icecast.ts` at the VPS. |
| D11 | **TLS = the `icecast-ssl` Docker image** (native TLS + bundled Let's Encrypt) | Avoids reverse-proxy streaming pitfalls (R7); Caddy termination only if a web page is also wanted. |
| D12 | **VPS provider = Hetzner** (EU) or DigitalOcean/Vultr (US), region near the audience | ~€4/mo, ample traffic; 100 concurrent @128k ≈ 500 GB/mo. |
| D13 | **v1.0 ships without car**; CarPlay/Android Auto land in v1.1 | The entitlement can be slow and must not gate launch. |
| D14 | **Public API base = Cloudflare Tunnel `api.<domain>`** (path-scoped), edge Worker later | JSON only, so Cloudflare's audio restriction does not apply; station-web stays on loopback; playback is independent of the API. Detail in §4b. |
| D15 | **bun hoisted linker + version-alignment guard** | RN/Metro expect hoisted `node_modules`; duplicate `react-native` versions fail cryptically. |
| D16 | **RN 0.83 / New Architecture** | Mandatory from RN 0.82; both `@rntp/player@^5` and RNFirebase v26 require it. |
| D17 | **Push = `@react-native-firebase/messaging@^26`** (modular API); permission via `react-native-permissions` | v26 deprecates RNFirebase's own permission APIs. |
| D18 | **Resilience = error classifier + bounded backoff + stall watchdog + headphone-pause** | Radio reliability is a field problem, not a desk problem. |
| D19 | **Observability = Sentry now; PostHog deferred to v1.1** | Crash/error tracking is non-negotiable; analytics deferred to avoid App Privacy disclosure overhead at launch. |
| D20 | **Env = `react-native-config`; E2E = Maestro; build = EAS** | Bare-RN best practice. |

---

## 2. Target architecture

```
  ┌──────────────── React Native app (bare, iOS + Android) ──────────────┐
  │  Screens (TS)        Player: react-native-track-player               │
  │     │                      │                                         │
  │  @ncsound/station-client   │  ICY MP3 over HTTPS                     │
  │  @ncsound/station-core     │                                         │
  └─────┬──────────────────────┼──────────────────┬─────────────────────┘
        │ HTTPS JSON           │                  │ Auth session / RLS
        ▼                      ▼                  ▼
  station-web API         stream.<domain>     Supabase
  (Next.js, existing)     ──► Icecast (VPS)   Auth · Postgres · Realtime
  + GET /api/stream           TLS (Caddy/ice)  favorites · follows · devices
        │
        │ (later) push
        ▼
   FCM / APNs  ◄── Supabase Edge Function (or Worker) reads devices table
```

The **home PC keeps the DJ engine + Liquidsoap**; only delivery moves. Home
Liquidsoap pushes its source to the VPS Icecast (or the VPS relays it), so a
listener never depends on the home PC being reachable.

---

## 3. Repo layout (new + changed)

```
apps/
  listener-app/                     NEW  bare React Native app
    index.js                        entry: playback service registered first
    app.config.ts (or app.json)     scheme, bundle id, background modes
    src/
      app/          navigation, screens (Home, Player, Schedule, Requests, Settings)
      player/       setup.ts, service.ts, nowPlaying.ts, reconnect.ts, liveEdge.ts
      car/          browse tree / auto-play templates
      auth/         supabase client, session provider, deep-link handler
      data/         favorites.ts, requests.ts, schedule.ts, devices.ts
      ui/           components, tokens, theme
    ios/  android/  generated (bare init)
packages/
  station-client/                   NEW  typed fetch client for station-web API
  station-core/                     existing contracts (reused)
apps/station-web/
  src/app/api/stream/route.ts       NEW  mount descriptor
  src/lib/stream-source.ts          CHANGE  base URL from env, not loopback
  next.config.ts                    CHANGE  CORS headers (optional, for web)
infra/
  stream/                           NEW  VPS Icecast + Caddy/nginx config
```

---

## 4. P0 — the public stream host (blocks everything)

**Tasks**
1. Provision a small VPS (Debian/Ubuntu, 1 vCPU / 1 GB, ~$4–6/mo).
2. Install Icecast **with TLS**. Note: Debian/Ubuntu's packaged Icecast has SSL
   disabled (licensing); use the **Xiph repo** build, the `icecast-ssl` Docker
   image, or terminate TLS with **Caddy/nginx**. **AzuraCast** is the
   batteries-included option (manages Icecast + Liquidsoap + SSL).
3. DNS: `stream.<domain>` **A record → VPS, DNS-only** (not Cloudflare-proxied).
   Obtain a Let's Encrypt cert (Caddy does this automatically).
4. Wire the source: home Liquidsoap → VPS Icecast source mount (restrict the
   source port to the home IP), **or** VPS Icecast relays from home.
5. If reverse-proxying, use streaming-safe settings:
   `proxy_buffering off; proxy_read_timeout 3600s; proxy_http_version 1.1;
   chunked_transfer_encoding on;`.
6. Set `NCSOUND_STREAM_BASE_URL=https://stream.<domain>` on station-web; make
   `stream-source.ts:84` and `ingest.ts:164` read it instead of `127.0.0.1`.
7. Add `GET /api/stream` → `{ live, mobile, baseUrl, updatedAt }`.
8. Open firewall: 80/443 public; source port restricted to home IP.

**Acceptance**
- A phone on **cellular** plays `https://stream.<domain>/live.mp3` and
  `/mobile.mp3`; `curl -I` shows a valid TLS chain; `/api/stream` returns the
  real mounts; pulling the home source does not 404 the listener (relay/fallback).

**Resolved:** raw Icecast relay (D9); push origin (D10); `icecast-ssl` TLS (D11);
Hetzner/DO/Vultr (D12). Only the exact domain remains open (§14).

---

## 4b. D14 — public API base: Cloudflare Tunnel now, edge Worker later

**Why the tunnel is correct here.** It carries **JSON only**; Cloudflare's
audio/large-file restriction applies to the CDN and to the *stream* (which stays
on the DNS-only VPS, §4). station-web keeps listening on **loopback `:3100`** —
no port is exposed.

### Part 1 — Cloudflare Tunnel now (v1)

1. Dedicated tunnel (separate from the operator `ncsound-ingest` tunnel):
   ```
   cloudflared tunnel create ncsound-public
   cloudflared tunnel route dns ncsound-public api.<domain>
   ```
2. `~/.cloudflared/ncsound-public.yml` — path-scoped so **only the listener API**
   is reachable:
   ```yaml
   tunnel: <uuid>
   credentials-file: C:\Users\User\.cloudflared\<uuid>.json
   ingress:
     - hostname: api.<domain>
       path: ^/api/(stream|nowplaying|schedule|requests|tracks)$
       service: http://127.0.0.1:3100
     - service: http_status:404
   ```
   Verified semantics: rules match top-to-bottom; `path` is a Go regex; the last
   rule must be a catch-all; cloudflared forwards the path unchanged. So
   `/api/submissions`, `/api/stats`, `/api/ops/*` and the operator UI are
   **unreachable** even though station-web serves them. Extend the regex when the
   app adopts `/api/charts`, `/api/history`, `/api/artists/detail`.
3. Verify before trusting it:
   ```
   cloudflared tunnel ingress validate
   cloudflared tunnel ingress rule https://api.<domain>/api/nowplaying   # rule #1
   cloudflared tunnel ingress rule https://api.<domain>/api/stats        # catch-all -> 404
   curl -i https://api.<domain>/api/stream        # 200
   curl -i https://api.<domain>/api/submissions   # 404
   ```
4. Edge hardening: rate-limit `POST /api/requests`; cache `GET /api/stream`
   ~60s; bypass cache on `/api/nowplaying`.
5. App config: `API_BASE_URL=https://api.<domain>` (see §5); dev fallback
   `http://127.0.0.1:3100`.
6. Resilience this buys: with the tunnel (or home PC) down, the app still plays
   audio and shows the live ICY title; only discovery screens degrade, and they
   render the honest `mode:'offline'` state. **Playback is independent of the API
   by design.**

### Part 2 — Edge-Worker migration path (v1.1+)

Same public base URL (`api.<domain>`); only the origin behind it moves — **no app
change**.

| Endpoint | Moves to | Why |
|---|---|---|
| `/api/stream` | Worker (static from config/R2) | no home dependency; cacheable |
| `/api/schedule`, `/api/tracks`, `/api/charts`, `/api/history` | Worker → **Hyperdrive → Supabase** | relational; the app already uses Supabase |
| `/api/requests` GET/POST | Worker → Supabase; POST keeps rate-limit + JWT verify | writes stay server-authoritative |
| `/api/nowplaying` | **Durable Object per station** | inherently live; needs the engine |

**Now-playing Durable Object.** One object per station holds the latest snapshot
(current track, elapsed, listeners, engine state); the home ingest pushes
updates; `GET /api/nowplaying` reads it; **WebSocket Hibernation**
(`acceptWebSocket` + `serializeAttachment` + `setWebSocketAutoResponse`) pushes
track changes while the DO sleeps, so it costs nothing when idle. This replaces
today's poll and is the top-notch listener-realtime path.

**Cutover.** Repoint `api.<domain>` from the tunnel to a new public Worker
(`ncsound-listen`, separate from the token-locked `ncsound-api`); keep the tunnel
as fallback. The app never changes because `station-client` takes a configurable
base. Phasing: (a) move `/api/stream` + `/api/nowplaying`; (b) move relational
reads via Hyperdrive→Supabase; (c) retire the tunnel for `api.<domain>`.

---

## 5. App foundation

**Tasks**
1. Scaffold: `bunx @react-native-community/cli@latest init listener-app
   --skip-install`, move to `apps/listener-app`, add to root `workspaces`, then
   `bun install` from root. Set `bunfig.toml` `[install] linker = "hoisted"`.
   RN 0.83 / New Architecture. Do not hand-edit generated Gradle/Podfile.
2. Add to the bun workspace; install `react-native-track-player`,
   `@supabase/supabase-js`, `@react-native-async-storage/async-storage`,
   `@react-native-community/netinfo`, `@react-native-firebase/app` +
   `/messaging`, `@notifee/react-native`, and (car) nothing yet.
3. **iOS** `Info.plist`: `UIBackgroundModes: [audio]`; bundle id, URL scheme
   `com.ncsound.radio`.
4. **Android**: RNTP declares the media foreground service; add
   `POST_NOTIFICATIONS` runtime request; verify
   `FOREGROUND_SERVICE_MEDIA_PLAYBACK` in the merged manifest.
5. `index.js`: register the playback service before the app component.

**Acceptance:** a bare app runs on a device and a simulator with New Arch on.

---

## 6. Player (`src/player/`)

**Tasks**
1. `setup.ts` — `TrackPlayer.setupPlayer({ autoHandleInterruptions: true })`;
   `updateOptions({ capabilities: [Play, Pause, Stop, SeekToLive], compact:
   [Play, Pause] })`.
2. `service.ts` — `registerPlaybackService` handling remote play/pause/stop.
3. Queue item: `{ id, url: <mount>, type: default, isLive: true, title,
   artist, artwork }`. `isLive` bypasses cache and enables live-edge.
4. `nowPlaying.ts` — lock-screen/car metadata comes from ICY **natively**
   (`autoUpdateMetadataFromStream`, C2). Poll `GET /api/nowplaying` only for the
   in-app art + up-next, then `TrackPlayer.updateMetadata(index, { artworkUrl })`.
5. `reconnect.ts` — on `PlaybackError` / stall, reload the stream; use NetInfo
   to reload when connectivity returns (iOS reports a live drop as a buffering
   stall with no error).
6. `liveEdge.ts` — `liveResumeBehavior: 'live-edge'`; a "jump to live" action.
7. Data saver — swap `/live.mp3` ↔ `/mobile.mp3` from Settings.
8. Sleep timer — JS countdown → volume fade → `pause()`.

**Acceptance:** audio survives lock and app-switch on **iOS and Android**; a
Wi-Fi→cellular switch recovers without a manual restart; lock screen shows the
live title; data-saver changes bitrate.

---

## 7. Auth & data (Supabase)

**Tasks**
1. The Supabase project exists (`xczjyhsibnjbjhpvtotx`). Store only the
   **publishable** URL/key in the app via `react-native-config`
   (`SUPABASE_URL` / `SUPABASE_ANON_KEY`); RLS is the boundary. Never ship the
   service-role key.
2. `auth/supabase.ts` — client with `AsyncStorage`, `autoRefreshToken`,
   `persistSession`, `detectSessionInUrl: false`; tie auto-refresh to `AppState`.
3. Deep linking — scheme `com.ncsound.radio`, redirect in Supabase auth settings;
   handle OAuth callback + magic link via `Linking`.
4. Sign-in screen: **Apple** (`expo-apple-authentication` or native), **Google**,
   **email OTP**.
5. Schema (RLS on every table; `user_id = auth.uid()`):

   | table | columns |
   |---|---|
   | `profiles` | `id` (= auth uid), `display_name`, `created_at` |
   | `favorites` | `id`, `user_id`, `kind` (`station`\|`artist`\|`track`), `ref`, `created_at`; unique(`user_id`,`kind`,`ref`) |
   | `devices` | `id`, `user_id`, `platform`, `push_token`, `updated_at` |
   | `push_prefs` | `user_id`, `artist_on_air`, `request_played`, `show_start` |

6. `data/favorites.ts` — read/write with optimistic UI; migrate the existing
   `localStorage` favorites (`use-favorites.ts:22`) on first sign-in.
7. Account deletion (required by App Store): an Edge Function that deletes the
   user and cascades.

**Acceptance:** favorites sync across two devices; account deletion works in-app;
a request carries the user id.

---

## 8. station-web API changes

**Tasks**
1. `GET /api/stream` (new).
2. Base-URL config for the stream (§4 task 6).
3. `POST /api/requests` — accept an optional Supabase JWT and store the user id
   (verify against Supabase JWKS; fall back to today's `listenerName`).
4. CORS headers on the public JSON routes (needed only for Expo web / a future
   webview; native clients do not need them).
5. **Do not** expose listen-back audio (see §11).

**Acceptance:** the app reads every screen from the existing API plus
`/api/stream`; no server rewrite.

---

## 9. Car, notifications, and screens

**Car (P3)**
1. Request the **CarPlay audio entitlement** (`com.apple.developer.carplay-audio`)
   via Apple's CarPlay Contact Us form + the Addendum — **do this early**.
2. Android Auto car app category + Play review.
3. Publish a browse tree (Favorites + "NCSound Live") and now-playing via
   **RNTP's built-in car support**; add `@iternio/react-native-auto-play`
   (NitroModules; needs the current Xcode/iOS SDK) only if custom templates are
   required.
4. `installTimers` first import if using auto-play (car timers throttle).

**Notifications (P3)**
1. FCM + APNs config; request `POST_NOTIFICATIONS` at the right moment.
2. Store the token in `devices`; send from a Supabase Edge Function (or a
   Worker) reading `push_prefs`.
3. Events: artist-followed on air, request played, followed show started.

**Screens (P2)**
Home (one-tap play, now-playing, resume last), Player (full-screen, live badge,
jump-to-live, sleep timer), Schedule (now/next), Requests (list + submit),
Settings (data saver, notifications, account, sign out), Sign-in.

---

## 10. Non-functional

**Testing**
- Unit: Jest + RNTL for pure logic (formatters, stores, reconnect policy).
- E2E: Maestro for the main flows (launch → play → favorite → request).
- On-device: background/lock, network switch, and **real car** for P3.
- Contract: `station-client` against a mock server, validated with
  `station-core` zod schemas.

**Build & release**
- **EAS Build** (works with bare RN) or Fastlane + GitHub Actions; EAS
  credentials carry the extra iOS entitlements.
- TestFlight + Play internal testing before store submission.

**App Store gates (must-do before P4)**
- `PrivacyInfo.xcprivacy` in the shipping target: declare required-reason APIs
  (UserDefaults, file timestamps, disk space, boot time) **plus** third-party SDK
  manifests (Firebase, Supabase, RNTP).
- App Privacy questionnaire matching the app + every SDK.
- **Sign in with Apple** present (D7).
- **In-app account deletion**.
- Privacy policy URL (App Store Connect **and** in-app), support URL.
- **Demo account** (or demo mode) + review notes; backend live during review.
- Guideline 4.2 satisfied by real native features (background audio, CarPlay,
  notifications, offline state) — this is why we did not wrap the site.

---

## 11. Legal (unchanged, still binding)

- **SoundExchange** statutory license: 2026 interim **$0.0025/performance**;
  **$1,000/station/yr** minimum (recoupable); monthly census Reports of Use;
  **ISRCs preferred** — add ISRC + label to the track schema now.
- **Musical works:** separate **ASCAP/BMI/SESAC/GMR** license.
- **The statutory license is non-interactive only.** Listen-back / on-demand is
  **not** covered → keep `/api/shows/listenback` metadata-only, or get direct
  licenses. This gates the "later" catch-up feature.
- Not legal advice; confirm with counsel before launch.

---

## 12. Phased task breakdown & acceptance

| Phase | Work | Acceptance |
|---|---|---|
| **P0** Stream host | VPS + Icecast TLS, DNS-only subdomain, source wiring; **station-web half done (env base URL + `GET /api/stream` + CORS); VPS half open** | Phone on cellular plays HTTPS; `/api/stream` correct |
| **P1** Auth & data | Supabase project + **schema/RLS applied** (`supabase/`); `station-client`, auth screens, favorites sync, devices | Favorites sync across 2 devices; account deletion works || **P2** App core | Bare RN + New Arch, RNTP player, background/lock, now-playing, reconnect, data saver, sleep timer, core screens | Lock/app-switch on both OSes; network switch recovers |
| **P3** Push (v1.0) | FCM/APNs + prefs (car deferred to v1.1) | A notification arrives |
| **P3b** Car (v1.1) | CarPlay entitlement + browse, Android Auto | Browse+play from a car |
| **P4** Stores | Privacy manifest, App Privacy, account deletion, demo account, screenshots, submit | Both builds live |
| **P5** Later | HLS adaptive; listen-back (licensed); widgets; alarm | — |

---

## 13. Risks & mitigations

| # | Risk | Mitigation |
|---|---|---|
| R1 | CarPlay entitlement approval is slow | Request it at the start of P3 (or P0); ship v1.0 without car if needed |
| R2 | Home PC is the stream origin SPOF | VPS relays/origins the stream so listeners don't depend on home |
| R3 | Cloudflare ToS / no ICY caching | Do not front the stream with Cloudflare; DNS-only |
| R4 | Expo + CarPlay incompatibility | Bare RN (D1) |
| R5 | RNTP New-Architecture-only | New Arch from the start |
| R6 | Listen-back licensing | Live-only; metadata-only until licensed |
| R7 | Reverse-proxy buffering breaks streams | Streaming-safe proxy settings; or Icecast TLS directly |

---

## 14. Resolved decisions & what remains

Decided 2026-10-07 (D9–D20 in §1):

- **VPS role:** raw Icecast relay — *not* AzuraCast, *not* the full chain yet.
- **Origin:** push from home Liquidsoap — *not* relay-from-home.
- **TLS:** `icecast-ssl` image; Caddy only if a web page is also wanted.
- **Provider:** Hetzner (EU) or DigitalOcean/Vultr (US) — **East Coast** for US.
- **Public API base:** Cloudflare Tunnel `api.<domain>` now, path-scoped; edge
  Worker + now-playing Durable Object later (§4b).
- **Toolchain:** bare RN 0.83 / New Architecture; `@rntp/player@^5`; bun hoisted;
  `react-native-config`; E2E Maestro; build EAS.
- **Push:** `@react-native-firebase/messaging@^26`, direct FCM + APNs — *not*
  OneSignal.
- **Observability:** Sentry now; PostHog deferred to v1.1.
- **Launch:** v1.0 without car; car in v1.1.

**Still open:** the exact `stream.<domain>` / `api.<domain>` hostnames.

**Deferred, not rejected:** moving the whole chain (Liquidsoap + Icecast +
ingest) to a VPS/container to remove the home PC as the listener SPOF. Revisit
once the app is live and listener count justifies it — the dumb-relay design
(D9) is chosen so this upgrade is additive.

---

## 15. Refinement pass via the fleet MCPs (2026-10-07)

Applied the domain MCPs to this plan (fleet.md: skipping a domain MCP when it
matches is a defect). What changed:

- **Design system (og-glass).** Built brand preset **`ncsound-dark`** (extends
  `client-dark-minimal`, amber `#ffb020`), graded **S/100**. Contract:
  `docs/LISTENER-APP-DESIGN.md`. The shipped dark presets collapse all text
  tokens to one colour (white, or neon green) — `ncsound-dark` fixes the text
  hierarchy. JEV was **offline** (DevBrain down), so this direction is an
  explicit override; the fallback had chosen a *light pastel* for a dark brief.
- **Business-rule footguns (business-logic).** `check_plan_footguns` flagged
  (keyword heuristic, verified): do **not log PII** — log the Supabase `user_id`,
  never `listenerName` or push tokens; **external API calls go through the
  service layer** (Cloudflare Stream `lifecycle` is server-side in `/api/video`);
  background jobs are idempotent (request dedupe and PlayLog `@@unique` already
  are). Money-in-cents is not applicable.
- **Architecture decision (devbrain).** Unavailable (`:3450` down), so the matrix
  could not run. Proceed with the planned stack: **React Navigation + TanStack
  Query over the `@ncsound/station-client` singleton**, plus a thin Zustand for
  player/prefs; now-playing polled only while foregrounded.
- **Infra state.** DevBrain down; Middle-Man registry reports only math-x
  healthy. Recorded in `fleet.md` (known-down dependencies).

New decisions (amend §1):

| # | Decision |
|---|---|
| D21 | App design system = OG-Glass preset `ncsound-dark` (S/100); `docs/LISTENER-APP-DESIGN.md` is the contract, `src/ui/tokens.ts` implements it. |
| D22 | Client stack = React Navigation + TanStack Query + `station-client` singleton + thin Zustand; poll now-playing only while foregrounded. |
| D23 | No PII in logs (`user_id` only); external calls stay server-side; no colours off the `ncsound-dark` palette. |

---

## Sources (opened 2026-10-07, second pass)

- Cloudflare Service-Specific Terms (CDN content restriction) — primary.
- Cloudflare community: "Radio station hosting" (no ICY caching, 2.8) — secondary.
- Icecast HTTPS/Let's Encrypt setup, Xiph SSL repo, Caddy auto-HTTPS — primary/secondary.
- `@iternio/react-native-auto-play` (npm/GitHub) and Expo CarPlay discussion #24354 — primary/secondary.
- Supabase Expo/React Native auth + native deep linking docs — primary.
- App Review Guidelines 4.8 / 5.1.1(v) / 2.1; Apple App Privacy; iOS 26 review checklist — primary.
- RNTP changelog/setup (`rntp.dev`) — primary.
- `@rntp/player` on npm (v5.12.1; `react-native-track-player` frozen at 4.1.2) — primary.
- cloudflared configuration-file docs (ingress `path` regex, catch-all) — primary.
- Cloudflare Durable Objects WebSocket Hibernation docs — primary.
- `@react-native-firebase/messaging` v26 docs + changelog — primary.
- `react-native-config` README (bare RN, Android `dotenv.gradle`) — primary.
