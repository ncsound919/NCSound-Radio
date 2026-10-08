# Listener app — App Store / Play review notes

Filled in if the app is ever submitted to a store. Kept current so a submission
does not stall on guideline 2.1 (App Completeness).

**Current distribution is not a store.** The zero-cost route is a self-hosted
**signed APK** (Android, sideloaded) and a **web PWA** (the station site). The
$99/yr Apple Developer account and the $25 Play account are not bought, so there
is no TestFlight and no store listing. These notes exist for the day that
changes; until then they are the honest answer set, not a submission in flight.

## What the app is

NCSound Radio's listener app: one-tap live audio (background + lock screen),
now-playing, a weekly schedule, a listener request line, synced favorites, and a
**show-only** live-video Watch screen.

The audio transport is **`react-native-video` (MIT)** — the same library the
Watch screen uses for video. There is no commercially licensed player in the
build, and no CarPlay / Android Auto (dropped with the paid tier; the app is
phone-only). See `docs/LISTENER-APP-STORE-READINESS.md`.

## Review access (if submitted)

- **Demo account:** provide a working email + the 6-digit OTP flow, or a demo
  mode. Sign-in is optional — the app is fully usable signed-out.
- **Live video** is only on air during the morning show / guest DJ slots. If it
  is not live during review, the Watch screen correctly shows "Not live right
  now"; note this in the review notes.
- Backend must be live during review (Supabase project + station-web API).

## Sign-in (guideline 4.8)

Sign in with Apple is offered alongside Google and email OTP.

## Account deletion (guideline 5.1.1(v))

Settings → Delete account calls the Supabase `delete-account` Edge Function and
cascades.

## Privacy

- `PrivacyInfo.xcprivacy` is present (from the RN template); declare
  required-reason APIs and each shipped SDK's manifest (Supabase, Sentry,
  react-native-video).
- App Privacy answers must match the SDKs actually shipped.

## Not a website wrapper (guideline 4.2)

Background audio, lock-screen controls, notifications and the offline state are
real native features.

## Licensing (deliberately out of scope)

This build plays artist-submitted and CC-licensed music, stream only (no
on-demand), and is not registered with SoundExchange or a PRO. That is the
project's explicit, accepted risk — not an oversight and not part of these store
notes.
