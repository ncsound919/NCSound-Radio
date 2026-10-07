# NCSound listener app — build plan

Status: **plan** (nothing here is built unless marked). Companion to
`docs/REMOTE-LIVE.md` (tunnels) and `docs/CLOUDFLARE-INTEGRATION.md` (edge plan).
Researched 2026-10-07; sources at the end.

> **Superseded on one point:** the buildable version is
> [`docs/MOBILE-LISTENER-APP-IMPLEMENTATION.md`](MOBILE-LISTENER-APP-IMPLEMENTATION.md).
> A second research pass found that **Cloudflare's terms bar serving audio over
> the free CDN and Cloudflare does not cache ICY streams**, so the stream host is
> a **VPS with Icecast over TLS on a DNS-only subdomain**, not a Cloudflare
> Tunnel. The implementation doc is authoritative where the two differ.

Goal in one line: **let listeners open one app, tap play, and hear NCSound —
live and in the car — with the same honesty about "are we on air?" that the
station site already keeps**, without giving up the existing web investment.

---

## 1. What this app is (and is not)

NCSound is a **single-station app**, not a directory app. The competition
(TuneIn, myTuner, Radio Garden, Radio Browser clients) win on *50,000-station
directories and search*. That is a different product. The right model here is
**BBC Sounds / a station's own app**: live listen, now-playing, schedule,
catch-up, requests, notifications, car.

That framing sets the feature bar. It also means the app's whole value is the
**player experience** — background playback, lock screen, reconnect, and the
car. Everything else is secondary.

---

## 2. What already exists (build on this, don't replace it)

The listener **backend is already built**. The app reuses it as-is:

| Capability | Location |
|---|---|
| Live MP3 mounts — `/live.mp3` 128k, `/mobile.mp3` 64k (ICY) | Icecast `:8010`; `apps/station-web/src/lib/stream-source.ts:38`; `README.md:92` |
| Now-playing + up-next + on-air + listeners, honest offline | `apps/station-web/src/app/api/nowplaying/route.ts:31-245` |
| Request/shout line (rate-limited, deduped) | `.../api/requests/route.ts:105-181` |
| Charts, history, schedule, artist detail | `.../api/charts`, `/history`, `/schedule`, `/artists/detail` |
| Library to pick a request from | `.../api/tracks/route.ts:11-33` |
| Submission pipeline + lookup | `.../api/submissions` |
| PWA manifest + lock-screen metadata | `station-web/public/manifest.webmanifest`; `player-bar.tsx:158-189` |
| Chat relay (decoupled, socket.io `:3003`) | `mini-services/chat-service/index.ts` |

Gaps that block a phone app (see §4): a public stream host, listener identity,
push, and CarPlay/Android Auto.

---

## 3. Decision: build it in React Native with `react-native-track-player`

**Recommended:** a **React Native app** (TypeScript), sharing
`packages/station-core` contracts and the station-web JSON API, using
**`react-native-track-player` (RNTP)** as the player.

### Why (research-backed, not preference)

1. **The player is the product, and RNTP is purpose-built for radio.** Its
   changelog addresses internet-radio stalls, reconnect on network restore,
   `seekToLiveEdge()` / `liveResumeBehavior` for live streams, and radio title
   encoding — the exact problems a music player has to re-solve.
2. **Car is the highest-value context for radio, and RNTP ships
   CarPlay + Android Auto "from a cold start"** with browse lists and transport
   controls.
3. **It sidesteps the App Store's guideline 4.2 trap.** A WebView/Capacitor
   wrapper of the existing site is now the single most common rejection reason;
   Apple rejects apps that are "a repackaged website." A real native app does
   not carry that risk.
4. **Android Auto does not allow WebViews** — so Capacitor would need custom
   native `MediaBrowserService` code anyway, at which point the "cheap wrapper"
   advantage is gone.
5. **Supabase Auth has a first-class React Native SDK**, matching the decision
   to ship accounts from v1.

### Options weighed

| Option | Effort | iOS background audio | CarPlay / Android Auto | Store risk | Verdict |
|---|---|---|---|---|---|
| **React Native + RNTP** | 2–4 mo | Yes (native) | **Yes, from cold start** | Low (real native app) | **Chosen** |
| Capacitor over the Next.js site | 2–4 wk | Yes (plugin) | Hard (custom native; AA no WebView) | **High — 4.2 wrapper** | Rejected as primary |
| Optimize the existing PWA | 1–2 wk | **No** (iOS kills on lock) | No | n/a (no store) | Rejected |
| Native Swift + Kotlin | 4–6 mo | Yes | Yes | Low | Overkill for the team |
| Flutter + `audio_service` | 3–5 mo | Yes | Partial | Low | Weaker radio tooling |

**Cost accepted:** the Next.js listener **UI** is not reused. The **API and
contracts are**, and `station-core` stays the single source of domain types
(`README.md:264`). The web site remains the fallback and the operator surface.

**If speed ever outranks quality:** the honest cheap path is *not* a store
wrapper — it is to make the existing PWA excellent on Android and keep iOS on
the website until the RN app ships. Do not spend weeks on a wrapper that risks
rejection.

---

## 4. Blockers to clear before any app work

| # | Blocker | Evidence | Fix |
|---|---|---|---|
| B1 | **The stream URL is hardcoded to `http://127.0.0.1:8010`.** No phone can reach it. | `stream-source.ts:84`; `src/lib/ingest.ts:164-165` | Expose Icecast on a public **HTTPS** host — a **VPS with Icecast over TLS, DNS-only** (see implementation doc §4; *not* a Cloudflare Tunnel) — and move the base URL to config |
| B2 | **iOS ATS blocks plain HTTP.** | platform default | Same fix as B1: HTTPS endpoint |
| B3 | **No CORS on API routes or Icecast.** | `next.config.ts` sets no headers | Needed only if a webview/fetch path is used; native clients are unaffected — add anyway for the PWA |
| B4 | **No listener identity.** Favorites are `localStorage` only. | `hooks/use-favorites.ts:22` | Supabase Auth (§6) |
| B5 | **No server-provided stream descriptor.** Clients would have to know mount names. | — | Add `GET /api/stream` returning `{ live, mobile, hls? }` with the real host |

B1 is the gate. Everything downstream is unbuildable until a phone on cellular
can play `/live.mp3` over HTTPS.

---

## 5. Streaming: ship on ICY MP3, add HLS later

| | ICY/MP3 (today) | HLS |
|---|---|---|
| Latency | 2–5 s | 15–30 s (LL-HLS 2–5 s) |
| Adaptive bitrate | No | Yes |
| Now-playing | ICY in-stream | separate API / ID3 |
| Native player support | Yes | Yes (Apple's native format) |
| Work to adopt | none | needs a packager + a mount |

**Decision:** v1 uses the existing ICY MP3 mounts. It is the shortest path,
works in `AVPlayer`/ExoPlayer, and has the lowest latency for live radio. RNTP
already handles reconnect and live-edge on it. Add **HLS later** for adaptive
bitrate and cellular resilience; front it with Cloudflare rather than
re-architecting Liquidsoap.

**Now-playing in a native app:** do **not** rely on in-stream ICY tags — iOS
`AVPlayer` does not surface them reliably. Poll the existing
`GET /api/nowplaying` for the title (accepting its known metadata delay) and use
`mediaSession` for lock-screen art. The site already does this
(`player-bar.tsx:158`).

---

## 6. Identity, favorites, and notifications (Supabase)

Supabase Auth from v1. The app is the first consumer of the Postgres the
Cloudflare plan already targets (`docs/CLOUDFLARE-INTEGRATION.md:77`).

- **Auth:** Apple + Google + email OTP via `@supabase/supabase-js` with an
  `AsyncStorage` adapter. Let users sign up *in the app* (guideline 4.2.3) and
  provide a demo account for review.
- **Tables (RLS on, user-scoped):** `profiles`, `favorites` (station "My
  Waves"/artist/track follows), `devices` (push tokens), `push_prefs`.
- **Requests:** attach the Supabase user id to `POST /api/requests` so a phone
  user is attributable and de-duplicable, replacing the free-text `listenerName`
  (`requests/route.ts:109`).
- **Push:** APNs + FCM via the devices table; events = "an artist you follow is
  on air", "your request is playing", "a show you follow just started".
- **Bridge to SQLite:** station-web is Prisma/SQLite today. Keep it; reach
  Supabase from the app directly with RLS, and later via a Worker + Hyperdrive.
  Do not migrate the operator site as part of this project.

---

## 7. Feature plan

### MVP — "live listening everywhere" (v1)
- One-tap live play; **resume last station**
- Background audio + lock-screen / notification transport controls (native)
- Now-playing + up-next + a truthful on-air/offline indicator (from
  `/api/nowplaying`, which already answers honestly — `nowplaying/route.ts:38`)
- **Reconnect** on network switch with backoff; buffering vs offline states
- **Data-saver** toggle (64k ↔ 128k); output/route picker
- **Sleep timer** (fade-out)
- Favorites ("My Waves") synced via Supabase
- Request/shout line
- Schedule: what's on now and next

### v1.1
- **CarPlay + Android Auto** (browse favorites + stations, now-playing, transport)
- **Push notifications** (follows, requests, shows)
- Charts / history / artist pages (reuse existing APIs)
- Live chat (reuse the socket.io relay)

### Later (license-gated — see §8)
- **Listen-back / catch-up** — only with direct licenses; metadata-only until then
- Android alarm clock; Chromecast/AirPlay/Sonos; HLS adaptive streaming

---

## 8. Legal — read before widening the audience

The station already streams **commercial recordings**. An app multiplies
listeners and makes the audience measurable, which raises the stakes. An app
does **not** change the licensing requirement — but it makes it real.

- **Sound recordings:** SoundExchange statutory license. 2026 interim rates
  **$0.0025/performance** (non-subscription); minimum fee **$1,000/station/year**
  (recoupable). Reports of Use are **monthly census**; **ISRCs are preferred**.
- **Musical works (compositions):** a separate public-performance license from
  **ASCAP / BMI / SESAC / GMR**. SoundExchange does not cover these.
- **Critical boundary:** the statutory license covers only **non-interactive**
  streaming. **On-demand / listen-back / "play that again" is NOT covered** and
  needs direct licenses from rights holders. This is why listen-back is a
  *later, license-gated* feature, and why the current
  `/api/shows/listenback` returns a metadata log, not audio
  (`shows/listenback/route.ts`).
- **Action:** add ISRC (and marketing label) fields to the track schema now;
  they are needed for Reports of Use regardless of the app.

This section is not legal advice; confirm with a lawyer before launch.

---

## 9. Mobile best practices checklist (must-do)

**iOS**
- `UIBackgroundModes: audio`; `AVAudioSession` category `.playback`
- `MPNowPlayingInfoCenter` (title/artist/art) + `MPRemoteCommandCenter`
- ATS requires HTTPS (B1/B2)

**Android**
- Foreground service with `type=mediaPlayback` +
  `FOREGROUND_SERVICE_MEDIA_PLAYBACK` + `POST_NOTIFICATIONS`
- `MediaSession`; request audio focus; pause on `ACTION_AUDIO_BECOMING_NOISY`
- **Start the service on the user's play tap** (Android 12+ blocks background
  starts)

**Car**
- **CarPlay needs an Apple entitlement** (`com.apple.developer.carplay-audio`)
  requested via the CarPlay Contact Us form + the CarPlay Addendum — **apply
  early; approval is not instant.**
- **Android Auto** needs a car app category and Google Play review.
- Car UIs are template-driven; no WebView mirroring.

**Store review**
- Guideline **2.5.4**: background audio must be genuine content the user started
- Guideline **4.2**: real native functionality, native navigation, an offline
  state, and in-app signup — this is exactly why the RN path was chosen

---

## 10. Architecture

```
        ┌──────────────── React Native app (iOS / Android) ────────────────┐
        │  Screens (TS)   Player (react-native-track-player)               │
        │        │                       │                                 │
        │        └── station-core types ──┘                               │
        └───────┬───────────────────────────────┬─────────────────────────┘
                │ HTTPS JSON                     │ ICY MP3 / HLS
                ▼                                ▼
   station-web API (Next.js, existing)      stream.<domain>  ──► Icecast (VPS)
   /api/nowplaying /requests /schedule …        (TLS, DNS-only — not Cloudflare)
                │
                ▼
   Supabase (Auth + Postgres + Realtime)   ← favorites, follows, devices, push
                │
   push: APNs / FCM
```

Reuse: `packages/station-core` (contracts), all station-web listener APIs, the
Icecast chain. New: the RN app, the public stream host, the Supabase layer.

---

## 11. Phased rollout & acceptance

- **P0 — Unblock the stream.** Public HTTPS host for Icecast (**VPS + TLS,
  DNS-only** — not a Cloudflare Tunnel; see implementation doc §4), config
  stream base URL, add `GET /api/stream`, add CORS to API routes.
  *Accept:* a phone on **cellular** plays `/live.mp3` over HTTPS; `/api/stream`
  returns the real mounts.
- **P1 — Identity & favorites.** Supabase Auth + favorites/follows/devices
  tables + RLS; request attribution.
  *Accept:* favorites sync across two devices; a request carries the user id.
- **P2 — The app (MVP).** RN + RNTP: background audio, lock screen, now-playing,
  reconnect, data-saver, sleep timer, car mode.
  *Accept:* audio survives lock and app-switch on iOS **and** Android; a
  network switch recovers without a manual restart.
- **P3 — Car & notifications.** CarPlay (entitlement in flight) + Android Auto;
  push notifications.
  *Accept:* browse + play from the car; a follow/request notification arrives.
- **P4 — Stores.** Submit to App Store + Play with an in-app signup flow and a
  demo account.
  *Accept:* both builds live and reviewed.
- **P5 — (later)** HLS adaptive streaming; listen-back behind direct licenses.

---

## 12. Open questions (decisions to make)

1. **Which domain** hosts the public stream — `stream.overlay365.online` (or a
   radio-specific domain), served from the VPS?
2. **Move Icecast off the home PC** (Cloudflare container,
   `CLOUDFLARE-INTEGRATION.md` §5) now, so the stream host isn't a home-PC
   single point of failure the app depends on?
3. **Is the RN UI acceptable to build from scratch**, given the Next.js listener
   UI is not reused? (This is the main cost of the recommendation.)
4. **Catch-up policy:** live-only at launch, or pursue direct licenses for
   listen-back?
5. **Apple/Google developer accounts** and the **CarPlay entitlement request** —
   start now, since entitlement review gates the car feature.

---

## Sources (opened 2026-10-07)

- `react-native-track-player` changelog + setup (live streams, reconnect,
  `seekToLiveEdge`, CarPlay/Android Auto cold start) — `rntp.dev`.
- App Store Review Guidelines 4.2 / 2.5.4 — `developer.apple.com/app-store/review/guidelines/`.
- CarPlay entitlement + `CPListTemplate` — `developer.apple.com/documentation/carplay`.
- SoundExchange 2026 Commercial Webcaster memo and rate tables — `soundexchange.com`.
- PWA vs native background-audio limitations — Prototyp.digital; ZAO OS mobile
  strategy; YuSMP 2026 comparison.
- Library/feature survey (myTuner, TuneIn, BBC Sounds, radioBee, LiveTune) —
  vendor pages.
- In-repo: `README.md`, `docs/REMOTE-LIVE.md`, `docs/CLOUDFLARE-INTEGRATION.md`,
  `docs/READINESS-CHECKLIST.md`.
