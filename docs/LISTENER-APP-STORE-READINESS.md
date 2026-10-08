# Listener app — store submission pack

Working notes for the App Store / Play gates (plan §10, roadmap B8). Everything
here is the **content** that would go into App Store Connect / Play Console; the
screenshots and the demo build come from the app.

Status: drafted, **not submitted** — and, on the current zero-cost route, not
planned. See "Distribution" below. App Privacy answers must be re-checked
against the shipped binary and every SDK's own `PrivacyInfo.xcprivacy` before any
submission — an SDK whose required-reason API is missing from
`PrivacyInfo.xcprivacy` is a rejection.

## Distribution (zero cost)

| Platform | Route | Cost |
|---|---|---|
| Android | Self-hosted **signed APK**, sideloaded | $0 (no Play account, no 12-tester/14-day wait, no review) |
| iOS | **Web PWA** (the station site) | $0 (no Apple Developer account, no TestFlight) |

The iOS PWA is a stopgap: WebKit drops background audio after returning from the
background (bug 291892). The native iOS build is code-complete but needs a $99/yr
Apple Developer account to build to a device or ship; it is parked, not broken.

## Player licensing

The audio player is **`react-native-video` (MIT)** — no commercial license. The
earlier `@rntp/player` v5 dependency (commercial use requires a paid license) was
removed, and the app no longer plans CarPlay or Android Auto.

## Files

- `apps/listener-app/ios/NcsoundListener/PrivacyInfo.xcprivacy` — the shipping
  target's privacy manifest (created by the app scaffold). Keep it in the Xcode
  target's Copy Bundle Resources, and reconcile it against every shipped SDK's
  own manifest (Supabase, Sentry, react-native-video) at build time.

## App Privacy answers (App Store Connect)

| Data type | Collected | Linked to identity | Used for tracking | Purpose |
|---|---|---|---|---|
| Email address | Yes (Sign in with Apple/Google/email OTP) | Yes | No | App Functionality |
| Name | Yes (display name) | Yes | No | App Functionality |
| User ID | Yes (Supabase user id) | Yes | No | App Functionality |
| Device ID | Yes (push token) | Yes | No | App Functionality |
| Crash data | Yes (Sentry) | No | No | App Functionality |

No data is used for third-party advertising, and there is no cross-app tracking
(PostHog is deferred to v1.1).

## URLs (must be live during review)

- **Privacy policy:** `https://<domain>/privacy` — must be reachable from both
  App Store Connect and inside the app (Settings → Privacy).
- **Support:** `https://<domain>/support` — a real page with a contact address.

Minimum content of the privacy policy:

1. What is collected (the table above) and why.
2. That favorites and push preferences are stored in Supabase and are deletable
   in-app (Settings → Delete account), and that deletion cascades.
3. That the app plays audio from `stream.<domain>` and stores no listening
   history on the device beyond favorites.
4. The Sentry crash-reporting notice and how to opt out is not offered in v1 —
   state that crash data is not linked to identity.
5. A data-request contact address and an effective date.

## Review notes (paste into App Store Connect)

> NCSound is a live radio station app.
> - **Sign in:** email OTP with the demo account below, plus Sign in with Apple
>   and Google. 4.8 is satisfied by Sign in with Apple.
> - **Demo account:** `<demo email>` / OTP `<code>` (or email OTP to the reviewer
>   address). Use **Settings → Sign in** to try it.
> - **Live audio:** tap Play on Home. The station must be on air during review;
>   if it is not, the app shows an honest "off air" state (it does not fake a
>   stream).
> - **Account deletion:** Settings → Delete account (guideline 5.1.1(v)).
> - **Background audio:** lock the device or switch apps; audio continues and the
>   lock screen shows the live track title.

## Demo account / backend during review

- The backend (station-web API + stream) must stay up and the station on air for
  the whole review window.
- Seed a demo listener with at least one favorite so the "My Waves" screen is
  non-empty for the reviewer.

## Screenshots

Capture on a 6.7" iPhone and a 6.5" iPhone (required) plus a 7"/12.9" iPad if
shipping iPad. Each screen: Home (playing), Player (full screen), Schedule,
My Waves, Settings. Show the audio playing state on Home/Player.

## Still open (blocked on external input)

- Apple Services ID + key (Sign in with Apple) and Google OAuth client — B2.
- Apple Developer account ($99/yr) only if a native iOS build or a store listing
  is ever wanted.
