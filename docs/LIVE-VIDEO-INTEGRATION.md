# Live video integration

Status: **research + plan** (nothing built). Companion to
`docs/MOBILE-LISTENER-APP-IMPLEMENTATION.md` (audio app) and
`docs/CLOUDFLARE-INTEGRATION.md` (edge plan, §7 Stream).

Goal in one line: **let listeners watch the live show** — the DJ booth, the
studio, or the OBS scene — inside the same app that plays the radio, without
breaking the audio experience.

---

## 1. What already exists

- **OBS drives the video** on the station PC; the DJ console starts/stops the
  OBS stream over obs-websocket (`docs/OBS-SETUP.md`, `apps/dj-console/src/services/obs.ts`).
- The console already has **Cloudflare Stream** fields (RTMPS server + key) and
  a `SetStreamServiceSettings` path (`services/obs.ts:208-216`,
  `ui/views/settings.ts:129-175`).
- A **Stream live input `ncsound-obs`** was created
  (uid `92f086306cebc22c7ce3a0e6d546db7f`): RTMPS
  `rtmps://live.cloudflare.com:443/live/`, SRT `srt://live.cloudflare.com:778`,
  HLS playback manifest (`docs/CLOUDFLARE-INTEGRATION.md:331`).
- The audio app plan is separate: `@rntp/player` plays the Icecast mounts.

So the **ingest is already chosen and half-built**. The gaps are: delivery
surfacing (an API the app can read), app playback, and audio/video coexistence.

---

## 2. The pipeline

```
OBS (station PC)                 Cloudflare Stream                 App
  scenes / camera  ──RTMPS──►  live input ncsound-obs  ──HLS──►  react-native-video
  browser overlay                (encode + global CDN)             Watch screen
  console audio                  DVR / LL-HLS / recording          PiP
```

Ingress and encoding are **free** on Stream; you pay for delivery and storage.

---

## 3. Decision: Cloudflare Stream for v1

**Chosen because it is already wired and removes all video infrastructure.**
The console already targets it; the live input exists; there is no origin,
transcoder or CDN to run.

| Option | Ingest | Delivery | ABR | Ops | Verdict |
|---|---|---|---|---|---|
| **Cloudflare Stream** | RTMPS/SRT/WebRTC | HLS/DASH/LL-HLS, DVR | Yes | none | **v1** |
| MediaMTX (self-host) | RTMP/SRT/RTSP | HLS/WebRTC/LL-HLS | **No** (no transcoder) | a VPS | later / cost path |
| SRS (self-host) | RTMP/SRT/WebRTC | HLS/DASH/HTTP-FLV | Yes (transcode) | a VPS | later |
| Mux | RTMP/SRT | HLS/LL-HLS | Yes | none | premium alternative |
| Bunny Stream | SRT/RTMP | HLS | Yes | none | cost path at scale |

Self-hosting wins only past ~50 TB/month egress or for 24/7 video; at this
station's scale, Stream's simplicity dominates. MediaMTX has **no transcoder**,
so no adaptive bitrate — a single rung, which is fine for a booth cam but not
for variable mobile networks.

---

## 3a. Scope: show-only video (decided 2026-10-07)

Video is **show-only**: the morning show and booked guest DJ slots. OBS goes
live for a show and stops after it. This is the intended, cheap shape — roughly
**$18/mo** storage for ~2 h/day (§7) — and it is what the promotion is built
around. A 24/7 channel is explicitly out of scope.

---

## 4. Delivery: HLS, LL-HLS, DVR

- **HLS** manifest: `https://customer-<CODE>.cloudflarestream.com/<INPUT_ID|VIDEO_ID>/manifest/video.m3u8`
  — adaptive bitrate, works in `AVPlayer`/ExoPlayer.
- **Low-latency (LL-HLS):** set `preferLowLatency: true` on the live input
  (requires recording mode `automatic`) and request
  `?protocol=llhls`. Brings glass-to-glass latency down; OBS needs no B-frames
  and a 2–4 s GOP.
- **DVR:** add `?dvrEnabled=true` to rewind/seek the live broadcast (nice for a
  DJ set). Degrades past 3 hours; 7,200-segment limit.
- **WebRTC (WHEP):** sub-second, billed as delivery from 2026-10-15; not needed
  for v1.
- **Live status:** `GET https://customer-<CODE>.cloudflarestream.com/<INPUT_ID>/lifecycle`
  → `live` + active `videoUID`. This is how the app knows whether video is on.

---

## 5. App playback: `react-native-video`

- Use **`react-native-video` v6** (stable; New Architecture via the interop
  layer, which RN 0.83 uses). v7 is beta.
- The HLS manifest plays natively; the player does adaptive bitrate.
- **Picture-in-Picture:** `enterPictureInPictureOnLeave` / `enterPictureInPicture()`;
  iOS needs the `audio` + `picture-in-picture` background modes, Android needs
  `android:supportsPictureInPicture="true"`.
- **`playInBackground`** / `playWhenInactive` for the background cases.

### Audio/video coexistence (the important part)

The video stream carries **the same program audio** OBS captured from the
console. So there is no second audio source to sync — the rule is:

| State | Plays |
|---|---|
| Watch screen, foreground | **video** (its own audio); `@rntp/player` paused |
| Listen (no video), or video not live | **audio** (Icecast, `@rntp/player`) |
| App backgrounded / locked while watching | **audio** (Icecast) — video cannot play without PiP; optionally PiP keeps the video |

This avoids the two failures that plague radio+video apps: **double audio**
(two players) and **A/V drift** (Icecast and HLS are different encodes with
different latency, so they must never play at once).

---

## 6. API surface

Add `GET /api/video` to station-web (public, like `/api/stream`):

```
{
  configured: true,
  live: true,
  inputId: "92f086306cebc22c7ce3a0e6d546db7f",
  videoId: "<active video uid or null>",
  hls:   "https://customer-<CODE>.cloudflarestream.com/<ID>/manifest/video.m3u8",
  dash:  ".../manifest/video.mpd",
  dvrHls:".../manifest/video.m3u8?dvrEnabled=true",
  player:"https://customer-<CODE>.cloudflarestream.com/<ID>/iframe",
  promote: true,
  show: { id, name, host, kind: "LIVE", isVideo: true },
  reason: null,
  updatedAt: "..."
}
```

It reads the Stream `lifecycle` endpoint server-side (holding `STREAM_API_TOKEN`
in env, never in the app). The app shows the Watch UI only when `live` is true;
otherwise it degrades to audio (honest, like `mode:'offline'`). `promote` is true
only when a **LIVE show** is on air **and** the feed is live — that is the signal
the app uses to nudge listeners.

**Built:** `apps/station-web/src/app/api/video/route.ts` (this session). The live
show comes from `getActiveShow()` (`lib/broadcast.ts:449`); a LIVE show is the
video show (`Show.kind === 'LIVE'`). A future `Show.video` flag would let a LIVE
show be audio-only.

---

## 6a. Prompts, promotion, and the Watch toggle

Video is **opt-in and promoted, never forced**:

- **Global toggle (Settings):** "Watch live video" on/off, persisted per user
  (Supabase `push_prefs.watch_video`, or a small `video_prefs` table) and
  respected on every device. Default **on** for discovery; the app never
  auto-plays video over audio.
- **In-app promotion:** when `promote:true`, Home and Player show a
  **"◉ Watch the {show} — live now"** banner. Tapping opens Watch; there is no
  auto-switch, and the banner disappears the moment `promote` goes false.
- **Push promotion:** when a followed video show goes live, fire the existing
  `show_start` notification (already in `push_prefs`), deep-linking into Watch.
  Only for followed shows, and only while the toggle is on.
- **Player toggle:** a **Watch ⇄ Listen** control, shown only while
  `promote:true`. Listen = Icecast audio (data-saver friendly); Watch = the video
  stream. The choice persists; **default is Listen** so audio is never
  interrupted.

---

## 7. Cost model (the caveat)

Stream: **$5 / 1,000 min stored** + **$1 / 1,000 min delivered**; ingress and
encoding free; egress included.

- **Live playback requires recording mode `automatic`** — Cloudflare's docs say a
  live input with mode `off` is "not recorded **or available for playback**".
  So a live stream is always recorded, and recording is billed as storage.
- A **show-only** model (say 2 h/day = ~3,600 min/month) → ~**$18/mo** storage.
- A **24/7** video channel (43,200 min/month) → ~**$216/mo** storage before
  delivery. That is the point where self-hosting (MediaMTX/SRS + Bunny) starts to
  win.
- Delivery at, e.g., 10,000 viewer-minutes/month → **$10/mo**.

**Decision this forces:** is the video **show-only** (OBS goes live for DJ sets
and shows) or **24/7**? Show-only keeps Stream cheap and is the recommended v1
shape. 24/7 should be a deliberate, costed decision (and a reason to revisit
self-hosting or WHIP ingest, which is not recorded).

---

## 8. Store / policy notes

- Live video of your **own** station is fine; there is no user-generated video.
- PiP: iOS `UIBackgroundModes` `audio` + `picture-in-picture`; Android
  `supportsPictureInPicture`. Guideline 2.5.4 still applies (real content).
- **Car (CarPlay/Android Auto) is audio-only** — no video; the car plan is
  unaffected.
- Chromecast cannot play audio and video delivered separately; we play the video
  (with its own audio), so this does not apply.

---

## 9. Phased plan & acceptance

| Phase | Work | Acceptance |
|---|---|---|
| V1 | Set the live input to `automatic` + `preferLowLatency`; add `GET /api/video` (lifecycle) | `/api/video` returns `live:true` and real manifest URLs while OBS is up |
| V2 | Watch screen: `react-native-video` plays the HLS manifest; PiP | Video plays in the app; PiP works on both OSes |
| V3 | Coexistence: pause audio when watching; resume audio on background | No double audio; listening continues after lock |
| V4 | Promotion + toggle: `promote` banner, push on show start, Watch/Listen toggle | A listener is prompted when a show goes live and can turn watching off |
| V5 | (optional) DVR rewind; recordings list | Rewind works during a set |

---

## 10. Open questions

1. **Which scenes** does the station stream (booth cam, visualizer, overlay)?
2. **Customer code / manifest host** for `GET /api/video` (account config).
3. **DVR** in v1, or later?
4. **LL-HLS** from the start, or standard HLS first?
5. **Push cadence:** one notification per show start, or also at "going live
   now" if a show starts late?

---

## Sources (opened 2026-10-07)

- Cloudflare Stream: Watch a live stream, DVR for Live, Start a live stream,
  Live Inputs API, Pricing, Use your own player — primary.
- `react-native-video` v6 props/methods/README (PiP, background) — primary.
- MediaMTX scalability + MediaMTX vs SRS — primary/secondary.
- Managed-video cost comparisons (Mux/Cloudflare/Bunny/self-host) — secondary.
