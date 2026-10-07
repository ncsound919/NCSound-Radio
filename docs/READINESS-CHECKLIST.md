# NCSOUND DJ console: readiness checklist

Last updated 2026-10-07. Tick a box only when you have seen it work yourself.
"Measured" means a number from a real run. "Unit-tested" means code only, no real hardware or network.

Status as of this date: **not gig-ready.** Code is built; the items below in sections A, B and C have never been run on real gear.

## Progress review, 2026-10-07 evening (checked by reading the repo and re-running tests, not by using the gear)

Re-run just now: console `tsc` clean, console `npm test` green, ingest 102/102, key-detection test runs.
Nothing here is ticked, because ticking needs you to have seen it work.

- **2-hour soak: ran, NOT accepted.** `apps/dj-console/--dur=7200` holds 479 samples over 7,209 s, context `running` in every sample, recording on throughout. Why it isn't proof:
  - Heap reads exactly 68 MB in all 479 samples. Chrome coarsens `performance.memory` unless launched with `--enable-precise-memory-info`, so this does not show "no growth". With recording on, flat to the MB is more likely quantisation than reality.
  - `longestFrameMs` is a running maximum that never resets: 67 -> 233 (345 s) -> 350 (1174 s) -> 367 (1687 s). It says a 367 ms frame stall happened at least once in the first 28 minutes, and nothing about the last 90.
  - Samples every 15 s cannot see audio dropouts between samples; no `statechange` count was kept.
  - 61 samples sit at -1 to 0 dBFS master peak. Check for clipping by ear and with a recording before a gig.
  - Headless Chromium on this PC with no real output device.
  - **Fixed in `scripts/soak.mjs` today:** flags are no longer mistaken for the report path (that is why the log is named `--dur=7200`), precise memory info is on, frame stalls are reported per 15 s window as well as overall, and context state changes are counted. **The 2-hour run needs repeating** for a result you can rely on. A 60 s smoke run of the fixed harness works (heap now varies, 61 to 62 MB, so precise memory is on; new per-window and state-change fields are written). Start it on the PC: `node scripts/soak.mjs http://127.0.0.1:3102 <trackA> <trackB> test/soak.jsonl --dur=7200` against `vite preview` (use two real, long tracks), and leave the PC alone for 2 hours.
- **MPD226:** `docs/MPD226-SETUP.md` and `scripts/midi-probe.mjs` now exist, so you can read the real numbers off the unit. Still unticked: nobody has pressed a pad and compared.
- **OBS:** `scripts/obs-live-check.mjs` exists (skips cleanly if OBS isn't running). Not yet run against live OBS.
- **Key detection:** 2 of 4 labeled synthetic tracks correct (8A, 5A hit; 9A read as 5A, 10A read as 4A). That test only asserts at least 1 hit, so it passes either way. Real music: untested. Treat key readouts as a hint until you've checked 20 tracks.
- **Cloudflare/R2 library source (new, not in the plan):** see section G. Later the same day: R2 and MPD226 work finished in code (see the dated list at the end of section G); **none of it is deployed or tried on the unit.**
- The plan (`REDESIGN-PLAN.md`) still has nothing on the R2 library, the Workers, the MPD226 doc, the probes or the key-detection change.

## G. Cloudflare / R2 library

Built and unit-tested in the repo (2026-10-07), **not deployed**:
- API Worker token lock, 400/416 fixes, tests (14, fake R2). Transcode Worker fails closed (4 tests).
- Console streams through the Worker, token field in Settings, offline cache + "Offline" key (8 tests).
- Found and fixed: importing R2 queued all 410 tracks for background analysis (about 2.17 GB of downloads).

Still to do (you; commands are in `docs/CLOUDFLARE-INTEGRATION.md`, "Deploy and lock down"):
- [ ] Run `infra\cloudflare-lockdown.ps1` (deploys both Workers with tokens, checks 401/200 live, asks before turning off `r2.dev`, prints the token once). **The script has never been run.** Then paste the token in Settings.
- [ ] `curl -i https://ncsound-api.tap4500.workers.dev/library` with no token returns **401**.
- [ ] Disable public `r2.dev` access on `ncsound-media`; the old public URL stops serving. (Right now 410 commercial tracks are downloadable by anyone with that address.)
- [ ] `TRANSCODE_TOKEN` + deploy for `ncsound-transcode`; POST without a token is refused. Nothing in the console uses transcode yet, so this is a safety step, not a feature.
- [ ] Click R2 in the Library, load a track, seek in it (real R2 ranges are not covered by the fake-bucket tests).
- [ ] Venue-Wi-Fi-dies test on the real Worker: queue 5 R2 tracks, press **Offline**, turn Wi-Fi off, load them. (`scripts/r2-offline-check.mjs` already passes 10/10 in Chromium against a local stand-in Worker: token refusal, CORS preflight, no audio downloaded on import, Offline saves exactly the queued tracks, and both load with the network off from the cache. It does not prove Cloudflare.)
- [ ] Check the browser storage quota: 410 tracks is ~2.2 GB. Save only the set you need.
- [ ] `docs/CLOUDFLARE-INTEGRATION.md` phases 3 and 5-7 are blocked on dashboard API tokens (Stream, Access, AI Gateway) and a Supabase connection string. Decide which you want; none are needed for a gig.

## A. Before any gig (blockers)

- [ ] **MPD226 mapped.** Unit is plugged in with a generic preset on channel 16. In Settings -> MIDI controller mapping choose Channel 16 only, then Learn each bank and control (`docs/MPD226-SETUP.md`, "Using your generic preset"). Then press every mapped pad and control and confirm the console reacts. (Remap is unit-tested; never run on the real unit.)
- [ ] **Production build runs the show.** `npm run build`, serve `dist/`, open it full screen, load two tracks, mix for 10 minutes without touching the dev server.
- [ ] **2-hour soak passes.** `node scripts/soak.mjs <url> <trackA> <trackB> --dur=7200`. Record memory growth, audio-context state changes, longest frame in the plan. (Script exists, never run; no `soak.jsonl`.)
- [ ] **Headphone cue on a second output.** Pick the headphone device, cue a deck, confirm the room feed is unaffected. (Chromium only.)
- [ ] **Library on your real music.** Add your folder, confirm BPM/key look right on 20 tracks you know, restart the browser and confirm the folder still loads (permission re-check at boot is not built).
- [ ] **Backup plan.** A playlist or second laptop ready if the console fails mid-set.

## B. Party mode and OBS (streaming a gig)

- [ ] OBS WebSocket enabled; console connects and shows scenes (`docs/OBS-SETUP.md`).
- [ ] Scene switch, source on/off, record toggle all work from the Visuals tab and pad bank D, against live OBS. (Never tried against live OBS.)
- [ ] Stream/record state shown in the console matches OBS.
- [ ] Application Audio Capture or the audio route you chose carries the mix, no echo, no double audio.
- [ ] Audio/video sync offset set and checked by ear.
- [ ] Overlay Browser Source loads and updates.
- [ ] Venue Wi-Fi/upload test: sustained upload at least 2x your stream bitrate.

## C. Radio mode and Go live

Station PC:
- [ ] `infra/icecast/.env` has all four credentials (Icecast source, relay, admin, `LIVE_HARBOR_PASSWORD`); file is gitignored.
- [ ] Liquidsoap 2.1 or newer. (2.0.x fails to start the repo's config.)
- [ ] `station-up.sh` brings up Icecast, Liquidsoap and ingest; `/health` is OK.
- [ ] Autopilot plays from the library; Skip and Hold/Resume work; imaging pads fire.
- [ ] Real engine as the autopilot source. (Only a stand-in tone has been tested.)

Going live from home (same network):
- [ ] Go live, hear yourself on the public stream, console shows LIVE only after the station confirms.
- [ ] Hand back: stream returns to autopilot with no silence.
- [ ] Pull the network mid-set: listeners get autopilot, console shows LOST, rejoin works within 60 s.
- [ ] Real mic + headphones: talkover ducks music, no feedback. (Never tested on a real mic.)

Going live from a venue (remote):
- [ ] `INGEST_TOKEN` set on the station and on the console; token never in the browser.
- [ ] Cloudflare Tunnel up on the ingest hostname only. Harbor, Icecast source and telnet ports are NOT exposed.
- [ ] 401 check from a phone with no token (`docs/REMOTE-LIVE.md`).
- [ ] One real broadcast over the tunnel on the venue's network. Pick 192 or 128 kbps from that result.

Measured so far (real Icecast 2.4.4 + Liquidsoap 2.2.5 + real ingest, one machine, no tunnel):
- Go live to listener: 5.1 s. Deck change to listener: 5.1 s.
- Stall, drop or hand-back to autopilot: 4.6 to 4.9 s, no silence.
- Console shows LOST about 8 s after a stall. Early-drop code (3 s) is unit-tested but not timed on a live chain.

## D. Security and housekeeping

- [ ] Change the admin password (it was shared in chat).
- [ ] Decide on `git push --force origin main` (history was rewritten to scrub credentials; not yet pushed), then delete `.history-backup-pre-scrub.bundle`.
- [ ] Commit the redesign work. Almost nothing from it is committed. Set `core.fileMode false` or add `.gitattributes` first so mode/line-ending noise doesn't bury real changes.
- [ ] Decide what to do with `.merge-park/` (modified files, unclear purpose).
- [ ] Do not commit `apps/dj-console/spike/` model and WASM files (~210 MB).

## E. Not built (decide: build or cut)

- [ ] Key lock: spike passed on pitch only. CPU and real-music quality unmeasured, deck player not reworked. Key lock key stays hidden.
- [ ] Stems: browser route is no-go on this PC (about 2.2x realtime vs 1.5x gate). Server route needs Demucs installed and measured. Stem controls stay hidden.
- [ ] Slip-roll and backspin (3B.6).
- [ ] Faster LOST detection from Liquidsoap's active source.
- [ ] Phase 8 leftovers: dead-code scan (8.2), docs pass (8.5), plan updated with Phase 8.
- [ ] Autopilot overlay source for OBS.

## F. Day-of-gig pre-flight (5 minutes, every time)

- [ ] Power, cables, MPD226 detected.
- [ ] Output device and headphone cue chosen, levels checked.
- [ ] Tracks loaded in crates; two decks load and play.
- [ ] Master limiter on; no clipping at normal level.
- [ ] If streaming: OBS connected, scene right, stream key correct, test upload.
- [ ] If radio: Go live preflight checklist all green before the countdown ends.
- [ ] Laptop on power, sleep disabled, notifications off, browser tab not backgrounded.
