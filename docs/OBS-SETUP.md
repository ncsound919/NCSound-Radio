# OBS setup

The console drives OBS through its built-in **obs-websocket v5** server (OBS 28
or newer). The console does not play video; OBS does. This guide covers the one
time setup, the overlay, audio capture and a club checklist.

> Verified against a **running OBS 32.2.2** on this machine (obs-websocket on
> `127.0.0.1:4455`): the console connects, reads the live scene list, switches
> the program scene, and refuses to fake a stream that OBS cannot start. The
> remaining OBS-side steps (scene templates, overlay Browser Source, Application
> Audio Capture, the stream service/key) are yours to do once in the UI.

## 1. Enable obs-websocket

1. In OBS: **Tools → WebSocket Server Settings**.
2. Tick **Enable WebSocket server**.
3. Note the **port** (default `4455`).
4. Tick **Enable Authentication** and copy the **password** (or set your own).

## 2. Tell the console about it

1. Open the console, click **Settings** in the top bar.
2. **OBS address**: `127.0.0.1:4455` (the console adds `ws://` for you).
3. **OBS password**: paste the password from step 1.
4. Click **Connect**. The top bar shows an **OBS** chip once an address is set;
   it reads the current scene when connected.

The password is stored in this browser's local storage (the setup says so on
purpose — it is a local operator tool, not a public page). Do not reuse the OBS
password for anything else.

## 2a. Go live (video) from the console

OBS sends the video; the console starts and stops it. Before the first stream,
configure the output once in OBS: **Settings → Stream** (pick the service and
paste the stream key). Without that, OBS sits on "starting" and never goes
active.

- **Visuals tab** (Party mode) and the **Broadcast tab → OBS video stream**
  (Radio mode) both carry a **Go live / Start streaming** button. It turns into
  **Stop stream** once OBS confirms the output is active.
- The button is a read-back: the console never shows "live" because a button
  was pressed. If OBS cannot start (no service/key), it says
  *"OBS did not go live. Set the service and stream key in OBS: Settings →
  Stream"* instead of pretending.
- `npm run obs-check` verifies the disconnected states without OBS.
  `OBS_PASSWORD=… npm run obs-live-check` runs the real acceptance against a
  running OBS (connect, scene list, scene switch, stream start/stop) and skips
  cleanly when OBS is not reachable.

## 3. Visuals tab and pad bank D

The **Visuals** tab (Party mode) and MPD226 **pad bank D** drive OBS:

| Control | Action |
|---|---|
| Scenes list / pads D1–D8 | Switch program scene (read from OBS, in OBS order) |
| Source toggle | Show/hide a source in the current scene (camera on/off) |
| Media pads D9/D10 | Play / stop the first media source |
| Camera pad D10 | Toggle the first source (usually the camera) |
| Overlay pad D11 | Toggle a source whose name contains "overlay" |
| Record pad D12 | Toggle OBS recording |
| OBS Record key | Same, from the tab |

If OBS is not running, the tab says so and the pads do nothing. There is no
placebo.

## 4. The now-playing overlay

The overlay is a transparent lower third (title, artist, DJ name, a live dot).

1. In OBS: **Sources → + → Browser**.
2. URL: `http://127.0.0.1:3102/?ui=overlay`
   (opening the console with `#obs-overlay` also works).
3. Width **1920**, Height **1080**.
4. Tick **Shutdown source when not visible** off, and **Refresh browser when
   scene becomes active** off (the overlay polls; a refresh is a flicker).
5. Position the lower third where you want it; the page background is
   transparent.

The overlay shows "Waiting for the console…" until the console page (the one
with the decks) is open in the same browser, because the console publishes what
is audible over a same-origin channel. It never keeps a stale track on screen.

## 5. Capture the console audio

OBS captures the browser's audio, not the console's file output:

- **Windows 10 2004+**: add **Application Audio Capture**, choose the browser
  running the console.
- Older Windows: use a virtual audio cable, or an audio interface loopback.

Keep the console's own **REC** running as a local backup (see the checklist): the
recording is independent of the stream.

## 6. Scene templates

Build four scenes and map them to the first four pads:

1. **Camera** — one video capture device.
2. **Footage** — a Media Source (video file).
3. **Camera+Footage** — both, with the camera inset.
4. **Overlay-only** — just the browser overlay over gameplay/footage.

Add the overlay browser source to every scene you stream, or to a single scene
with the other sources composited underneath.

## 7. Audio sync

OBS captures the browser audio and the camera picture on separate clocks. If
speech or instruments look late/early against the picture:

1. Right-click the **Video Capture Device** → **Properties** → **Activate**.
2. Adjust **Sync Offset** in milliseconds (negative = delay the video).
3. Measure once on your setup and write the number here so it is not guessed
   again: `sync offset = ______ ms`.

## 8. Club checklist

- [ ] Audio interface selected in the console's **Settings → Master output**.
- [ ] Headphone output selected and **CUE** tested on both channels (plan 3A).
- [ ] OBS connected; every pad in banks A–D tried before doors.
- [ ] Local backup recording armed (console **REC**) — it survives a dropped
      stream.
- [ ] Overlay shows the right track when both decks play and when one is cued.
- [ ] Venue network for the stream tested; recording does not depend on it.
