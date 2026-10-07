/**
 * Set history (plan 4.9).
 *
 * A track is logged once it has been audible — channel volume and crossfader
 * gain above -20 dB — for more than 30 s. This is fed a frame at a time; the
 * clock is injected so the rule can be unit-tested without waiting 30 s.
 */
import type { HistoryEntry } from "./types";

/** -20 dB as a linear gain. */
export const AUDIBLE_GAIN = 10 ** (-20 / 20); // ≈ 0.1
export const AUDIBLE_SECONDS = 30;

export type AudibleSample = {
  slot: 0 | 1;
  playing: boolean;
  /** channelVolume × crossfader gain, 0..1. */
  gain: number;
  track: Pick<HistoryEntry, "trackId" | "title" | "artist" | "fileName" | "bpm" | "key" | "durationSec"> | null;
  nowMs: number;
};

type Acc = {
  seconds: number;
  startedAtMs: number;
  lastMs: number;
  trackId: string | null;
  logged: boolean;
};

const fresh = (): Acc => ({ seconds: 0, startedAtMs: 0, lastMs: 0, trackId: null, logged: false });

export class AudibleLogger {
  private acc: [Acc, Acc] = [fresh(), fresh()];

  /** Resets a slot (e.g. a new track loaded) so the log does not merge two tracks. */
  reset(slot: 0 | 1): void {
    this.acc[slot] = fresh();
  }

  /** Feed one frame. Returns a history entry the moment one is logged, else null. */
  observe(s: AudibleSample): HistoryEntry | null {
    const a = this.acc[s.slot];
    const audible = s.playing && s.track != null && s.gain > AUDIBLE_GAIN;
    if (!audible) {
      this.acc[s.slot] = fresh();
      return null;
    }

    const trackId = s.track!.trackId;
    if (a.trackId !== trackId) {
      a.trackId = trackId;
      a.seconds = 0;
      a.startedAtMs = s.nowMs;
      a.lastMs = s.nowMs;
      a.logged = false;
    } else {
      const dt = Math.max(0, (s.nowMs - a.lastMs) / 1000);
      a.lastMs = s.nowMs;
      // Cap a single step so a backgrounded tab (one huge dt) cannot fake 30 s.
      a.seconds += Math.min(dt, 1);
    }

    if (!a.logged && a.seconds > AUDIBLE_SECONDS) {
      a.logged = true;
      return {
        trackId,
        title: s.track!.title,
        artist: s.track!.artist,
        fileName: s.track!.fileName,
        bpm: s.track!.bpm,
        key: s.track!.key,
        startedAtMs: a.startedAtMs,
        durationSec: s.track!.durationSec ?? 0,
      };
    }
    return null;
  }
}
