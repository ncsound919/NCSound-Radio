# Requirements — Listener App v1.0

Every ID must appear in at least one plan's `requirements` field.

| ID | Requirement | Acceptance |
|---|---|---|
| R1 | Public HTTPS stream (VPS Icecast relay, push from home) | A phone on cellular plays `/live.mp3` and `/mobile.mp3` over TLS |
| R2 | Public JSON API base (`api.<domain>`), path-scoped | `curl` reaches `/api/stream`; `/api/submissions` returns 404 |
| R3 | Bare RN app foundation (New Arch, workspace, `station-client`) | App builds; `bundle` smoke passes; one RN version |
| R4 | Background audio + lock-screen on iOS **and** Android | Audio survives lock and app-switch |
| R5 | Now-playing + up-next + honest on-air/offline | Lock screen shows live title; offline renders honestly |
| R6 | Resilience: reconnect on network switch, stall watchdog | Wi-Fi→cellular recovers without a manual restart |
| R7 | Data saver (64k / 128k) | Settings swaps mount; bitrate changes |
| R8 | Sleep timer with fade-out | Timer fades and pauses |
| R9 | Supabase Auth (Apple + Google + email OTP) + deep links | Sign-in works; session persists |
| R10 | Favorites synced (RLS) + migrate localStorage | Favorites sync across two devices |
| R11 | Requests list + submit, attributed to the user | A request carries the Supabase user id |
| R12 | Schedule (now / next) | Screen shows the current show |
| R13 | Push notifications (FCM + APNs) + prefs | A test notification arrives |
| R14 | CarPlay + Android Auto — **v1.1, not this milestone** | — |
| R15 | Store readiness (privacy manifest, deletion, demo, App Privacy) | Both builds reviewed |
| R16 | Home: one-tap play + resume last | Home plays in one tap |
| R17 | Observability: Sentry crash/error + playback telemetry | A test error is captured in Sentry |
| R18 | Config/env via `react-native-config` | `Config.API_BASE_URL` resolves per environment |
| R19 | Live video: watch the show in-app (`/api/video`, HLS, PiP) | The Watch tab plays the live HLS stream; PiP works; no double audio |
| R20 | Watch promotion: opt-in toggle + prompt on show start | A listener is prompted when a video show goes live and can turn watching off |
