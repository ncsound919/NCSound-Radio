# State

**Milestone:** Listener App v1.0
**Updated:** 2026-10-08

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

## App scaffold (2026-10-07)

- **01-04 task 1 + task 3 done.** `apps/listener-app` scaffolded with
  **React Native 0.87.1** (New Architecture) via the community CLI
  (`--directory`, `--skip-install`, `--skip-git-init`). Reconciled the app
  `package.json` (RN 0.87.1 template + `@ncsound/station-client`);
  `metro.config.js` set for the workspace; root `bunfig.toml` = `linker = "hoisted"`.
- `bun install` ran (1446 pkgs). **Android Metro bundle smoke passed**; the
  workspace `@ncsound/station-client` resolved. Prior `src/player/*` preserved.
- **Regression fixed:** hoisting `@types/node` shadowed the DOM `FormData`, so
  `value instanceof File` failed typecheck in `station-web`'s submissions route;
  fixed with a commented cast; `tsc` clean.
- Open: `bun pm trust` for `@parcel/watcher`/`@swc/core` if `react-native start`
  watching needs native watchers (trusting runs third-party scripts).

## App config & shell (01-05, 2026-10-07) — DONE

- `react-native-config` wired: `.env.example`, `.env.development`,
  `react-native-config.d.ts`, `src/config/env.ts` (dev fallbacks),
  `android/app/build.gradle` applies `dotenv.gradle`, `.env.*` gitignored.
- `src/ui/tokens.ts` implements the `ncsound-dark` contract
  (`docs/LISTENER-APP-DESIGN.md`).
- `src/app/navigation.tsx` = bottom tabs Home/Schedule/Requests/Settings on the
  brand theme with a11y labels; `App.tsx` mounts it.
- **Verified:** app `tsc --noEmit` clean; Android bundle smoke passes (1.2 MB).
- **Note:** the prior `apps/listener-app/src/player/{mounts,reconnect}.ts` are no
  longer present (they were untracked; lost during the scaffold/install
  sequence). The player logic is (re)built in 01-07/01-08.

## Player core (01-07, 2026-10-07) — code done

- `src/player/setup.ts` (v5 config), `service.ts` (UI-free playback session),
  `live.ts` (`liveMediaItem` + `playLive`); registered in `index.js`.
- iOS `Info.plist`: `UIBackgroundModes:[audio]`, URL scheme `com.ncsound.radio`,
  display name "NCSound Radio". Android: `POST_NOTIFICATIONS`,
  `FOREGROUND_SERVICE_MEDIA_PLAYBACK`, `WAKE_LOCK`.
- **Verified:** app `tsc` clean; Android bundle smoke passes (1.22 MB).
- **Licensing:** `@rntp/player@5` header states "Commercial use requires a
  license" (rntp.dev/pricing) — decide before store release.
- Still needs a **real device** to confirm background/lock playback (iOS: a Mac).

## Player resilience (01-08, 2026-10-07) — code done

- Pure logic (TDD, **14 tests pass**): `src/player/reconnect.ts`
  (error classifier + bounded backoff), `src/player/watchdog.ts` (stall
  detection), `src/data/streams.ts` (mounts + data-saver mapping).
- Glue: `src/player/network.ts` (NetInfo + reachability probe),
  `src/player/controller.ts` (event wiring + `initPlayback`), `src/player/sleepTimer.ts`.
- `App.tsx` calls `initPlayback()` on mount; `live.ts` uses the shared mounts.
- **Verified:** app `tsc` clean; Android bundle smoke passes and now *includes*
  the new modules (1.24 MB).
- Deferred: now-playing artwork poll → 01-10 (v5 updates the lock-screen ICY
  title natively). Device checkpoint for background/lock + network switch pending.

## Observability (01-06, 2026-10-07) — code done

- `src/observability/sentry.ts` + `ErrorBoundary.tsx`; `App.tsx` initialises
  Sentry, wraps navigation, and reports player reconnect/fatal events.
- `SENTRY_DSN` in config (blank disables Sentry).
- **Verified:** app `tsc` clean; bundle includes Sentry (2.45 MB). Needs a DSN
  (operator) to see events.

## Auth (01-09) & screens (01-10), 2026-10-07 — code done

- Auth: `src/auth/{supabase,session}`, `src/app/sign-in.tsx`, deep-link
  intent-filter; SessionProvider wraps the app.
- Data: `src/data/{client,prefs,hooks}` (station-client + Supabase token,
  TanStack Query, foreground-only polling).
- Screens: `home`, `player`, `schedule`, `requests`, `settings`; Player route.
- **Verified:** app `tsc` clean; bundle passes (3.53 MB). Blank Supabase env
  disables auth gracefully.
- **Finding:** `station-client` (a version with optional zod validation, added by
  another session) dynamically imports `@ncsound/station-core/http`, pulling
  **zod** into the RN bundle (~670 KB). RN's Babel preset lacks the namespace
  transform, so `@babel/plugin-transform-export-namespace-from` was added to the
  app's `babel.config.js`. Cleaner fix (deferred): inject the validator so
  station-client stays dependency-free.

## Favorites (01-11) & live video (04-02/03/04), 2026-10-07 — code done

- `src/data/favorites.ts` (Supabase CRUD) + Player favorite toggle.
- `src/video/{VideoScreen.tsx,coexistence.ts}`; Watch stack route; PiP flags
  (iOS `UIBackgroundModes`, Android `supportsPictureInPicture`).
- Promotion: Home banner gated on `promote` + local `watchVideo` pref; Settings
  toggle; `supabase/migrations/20261008_video_prefs.sql` adds server-side
  `push_prefs.watch_video`.
- **Verified:** app `tsc` clean; bundle passes (3.56 MB).
- **Remaining:** push-on-show-start needs 01-12 (FCM/APNs); real video playback
  needs a device + Stream env.

## Store readiness (01-13) — partial, 2026-10-07

- Settings has **Delete account** (invokes the Supabase `delete-account` Edge
  Function, then signs out). `eas.json` (dev/preview/production) added;
  `docs/store/REVIEW-NOTES.md` written. `PrivacyInfo.xcprivacy` ships from the
  template.
- **Verified:** app `tsc` clean; bundle passes (3.56 MB).
- **Blocked (human):** App Store Connect / Play records, demo account, App
  Privacy answers, screenshots, a Mac for iOS, and the CarPlay entitlement (v1.1).

## Not done (need external config/accounts)

- **01-12 push:** Supabase-native sender written (APNs-direct iOS; FCM opt-in for
  Android) + app token registration, `push_prefs` toggles and a Realtime in-app
  banner. **Native iOS token module added**
  (`@react-native-community/push-notification-ios`; APNs, Firebase-free;
  AppDelegate forwards the callbacks; registers into `devices` when signed in).
  Remaining: Xcode Push Notifications capability, `pod install`, deploy
  `send-push` with APNs secrets; Android OS push needs FCM.
- **Phase 02 car (v1.1):** CarPlay entitlement + Android Auto.
- **Phase 03 edge reads (v1.1):** Cloudflare Worker + Durable Object.
- **Deferred cleanup:** make `station-client` dependency-free (inject the zod
  validator) so ~0.7 MB leaves the RN bundle.

## MCP refinement pass (2026-10-07)

Ran the fleet MCPs against the plan (`docs/MOBILE-LISTENER-APP-IMPLEMENTATION.md` §15):

- **Design:** built OG-Glass preset **`ncsound-dark`** (amber `#ffb020`), graded
  **S/100**; contract in `docs/LISTENER-APP-DESIGN.md`; binds 01-05. D21.
- **Business rules:** footguns folded in - no PII in logs (`user_id` only),
  external calls server-side, idempotent jobs. D23.
- **Architecture:** DevBrain restarted (`:3450`, JEV gateway tier online);
  `devbrain_decide` recommends **React Navigation + TanStack Query over
  `station-client`** (STRONGLY_RECOMMENDED, LOW risk) — no Zustand layer. D22.
- **Infra:** DevBrain (`:3450`) was down and is now running (relaunch with
  `INFRASTRUCTURE\Dev-Brain\start-dev-brain.ps1`); og-glass's JEV still reports
  offline independently (its own tier/config).

## Finalize pass (2026-10-08)

Zero-cost finalize of the app + site.

- **Site:** `apps/station-web` production build verified (`next build` +
  standalone copy; 2 non-blocking Turbopack tracing warnings in
  `submission-audio.ts`). The C5 ops/slots panel and the ingest host/guest
  session plane are in the tree.
- **Player migrated off the licensed library.** `@rntp/player` v5 (commercial
  license) → **`react-native-video` 6.19.3 (MIT; already a dep for the Watch
  screen)**. New `src/player/{engine.ts,PlaybackEngine.tsx}`; `controller.ts` /
  `live.ts` rewritten; `setup.ts` / `service.ts` deleted; `<PlaybackEngine/>`
  mounted at the root. Android bundle 3.56 → 2.86 MB. **On-device background /
  lock-screen / notification playback is unverified** (needs a device; iOS a Mac).
- **`station-client` is dependency-free.** `validateResponses` → injected
  `validateResponse`; no runtime import of `station-core/http`, so zod leaves the
  RN bundle (`zod` module absent from the output). `@ncsound/station-core` moved
  to devDependencies. 8/8 tests pass.
- **APK release build:** Gradle release signing via `android/keystore.properties`
  (`.example` added, gitignored); `npm run android:release`. `eas.json` is inert
  (bare RN, no Expo).
- **Docs:** store docs purged of CarPlay/RNTP/paid-store content; §0c addendum
  added to `docs/MOBILE-LISTENER-APP-IMPLEMENTATION.md` superseding C1/C2/D2/D6/
  D13/D20.
- **CarPlay / Android Auto dropped** (not deferred) — phone-only v1. iOS native
  build parked ($99/yr Apple Developer); the iOS route is the web PWA.
- **Verification:** `bun run typecheck` clean (10 packages); `bun run test` all
  green except one **pre-existing, environmental** failure in `@ncsound/ingest`
  (`watchdog.test.ts` spawns bare `ffmpeg`; 13/13 pass with `tools/ffmpeg` on
  PATH).
- **Still needs you (free):** confirm the home IP is public (not CGNAT); pick the
  stream subdomain; rotate the OBS password + Stream key (E6); generate the
  release keystore.
