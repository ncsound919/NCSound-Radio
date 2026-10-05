/**
 * OBS overlay mode.
 *
 * `#obs-overlay` in the URL turns the page into a transparent now-playing
 * display for an OBS Browser Source. The previous "OBS support" was a button
 * that opened the same page in a popup window with a hash nothing read — so an
 * operator who added it as a Browser Source captured the entire console UI,
 * booth meters and all, over their scene.
 *
 * Two things make it useful rather than decorative:
 *
 *  - **It reads the engine, not the booth.** The overlay polls the same
 *    broadcast status everything else uses, so it shows what listeners actually
 *    hear. A DJ can have a track cued in a deck that is not on air, and an
 *    overlay driven by local deck state would announce the wrong song to
 *    stream.
 *  - **It says when it does not know.** Off air, engine unreachable and "no
 *    track" render differently. An overlay that keeps the last title on screen
 *    after the station goes down is worse than no overlay, because it looks
 *    live.
 */

import type { BroadcastStatus } from "./broadcastLink";
import { fetchEngineCrate, type CrateSource } from "./engineCrate";

type EngineSnapshot = {
  state: string;
  onAir: boolean | null;
  title: string | null;
  artist: string | null;
  next: string | null;
  listeners: number | null;
  uptimeSec: number | null;
};

const POLL_MS = 2000;

export class ObsOverlay {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTitle: string | null = null;

  constructor(
    private readonly status: () => BroadcastStatus,
    private readonly engine: () => CrateSource,
  ) {}

  start(): void {
    const el = document.getElementById("obsOverlay");
    if (!el) return;
    el.hidden = false;
    document.body.classList.add("obs-mode");
    this.tick();
    this.timer = setInterval(() => this.tick(), POLL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const el = document.getElementById("obsOverlay");
    if (el) el.hidden = true;
    document.body.classList.remove("obs-mode");
  }

  get running(): boolean {
    return this.timer !== null;
  }

  /**
   * The engine's own now-playing.
   *
   * `BroadcastStatus.mounts[].lastMetadata` is the ICY title Icecast last saw,
   * which is the one value that has provably reached the encoder. It is the
   * right source for an overlay; the local decks are not.
   */
  private snapshot(): EngineSnapshot {
    const s = this.status();
    const live = s.mounts.find((m) => m.lastMetadata)?.lastMetadata ?? null;
    let title: string | null = null;
    let artist: string | null = null;
    if (live) {
      // Icecast's icy_song callback publishes "Artist - Title".
      const idx = live.indexOf(" - ");
      if (idx > 0) {
        artist = live.slice(0, idx).trim();
        title = live.slice(idx + 3).trim();
      } else {
        title = live.trim();
      }
    }
    return {
      state: s.connected ? s.engineState : "unreachable",
      onAir: s.stationOnAir,
      title,
      artist,
      // From the engine's own queue. The booth's queue is a rehearsal list and
      // routinely differs from what will air, so announcing from it would tell
      // the stream the wrong thing.
      next: s.queue[0] ? `${s.queue[0].title} — ${s.queue[0].artist}` : null,
      listeners: s.listeners,
      uptimeSec: s.uptimeSec,
    };
  }

  private tick(): void {
    const snap = this.snapshot();
    const crate = this.engine();

    const set = (id: string, text: string) => {
      const el = document.getElementById(id);
      if (el) el.textContent = text;
    };

    // The station name is not hardcoded silently: if the crate cannot be read
    // the overlay says so rather than presenting a confident name over an
    // engine it knows nothing about.
    set(
      "obsStationName",
      crate.error ? "NCSound Radio (library unavailable)" : "NCSound Radio",
    );
    if (crate.error) {
      set("obsTagline", crate.error);
    } else {
      set("obsTagline", `${crate.tracks.length} tracks`);
    }
    const dot = document.getElementById("obsLiveDot");
    if (dot) dot.classList.toggle("on", snap.onAir === true);

    // Three distinct states, because "off air" and "we cannot tell" must not
    // look the same on a stream.
    const stateEl = document.getElementById("obsState");
    if (stateEl) {
      stateEl.textContent =
        snap.state === "unreachable"
          ? "ENGINE OFFLINE"
          : snap.onAir === false
            ? "OFF AIR"
            : snap.onAir === true
              ? "LIVE"
              : "STATUS UNKNOWN";
    }

    const titleEl = document.getElementById("obsNowTitle");
    if (titleEl) {
      titleEl.textContent =
        snap.title ?? (snap.state === "unreachable" ? "Engine unreachable" : "—");
    }
    set("obsNowArtist", snap.artist ?? "");
    set("obsListeners", snap.listeners == null ? "" : `${snap.listeners} listening`);
    set(
      "obsNextTitle",
      snap.next ?? (snap.state === "unreachable" ? "unknown" : "nothing queued"),
    );

    // Title-change only. An overlay that fires a keyframe on every 2s poll
    // would restart the source animation continuously.
    if (snap.title !== this.lastTitle) {
      this.lastTitle = snap.title;
      document.title = snap.title ? `${snap.title} — NCSound Radio` : "NCSound Radio";
    }
  }
}

export function isOverlayRequested(): boolean {
  return typeof location !== "undefined" && location.hash.startsWith("#obs-overlay");
}
