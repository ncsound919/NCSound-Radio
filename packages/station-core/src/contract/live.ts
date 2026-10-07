/**
 * Go-live contract (plan phase 5).
 *
 * The console captures its master bus with MediaRecorder and streams Opus/WebM
 * chunks to ingest over a WebSocket. Ingest pipes them through ffmpeg into a
 * dedicated Liquidsoap harbor (`live`), which sits ahead of the autopilot feed
 * in the fallback. These types describe the state that bridge reports.
 */

export type LiveState =
  /** No session; the console is not trying to be live. */
  | "offline"
  /** Encoder started, waiting for Liquidsoap to confirm the mount. */
  | "armed"
  /** Liquidsoap confirms our live source is the one carrying the mount. */
  | "on_air"
  /** The operator handed back, or the session closed cleanly. */
  | "ended";

export type LiveSnapshot = {
  state: LiveState;
  sessionId: string | null;
  armedAt: string | null;
  onAirSince: string | null;
  /** Bytes of encoded audio accepted from the console. */
  bytesSent: number;
  bytesPerSec: number;
  /**
   * Encoder audio time minus wall-clock time since the first audio byte, in
   * seconds. Measured, not estimated: the audio time is ffmpeg's own
   * `-progress` `out_time`, i.e. how much console audio has actually been
   * decoded and pushed to the harbor. It starts slightly negative (ffmpeg's
   * probe/startup) and should then hold steady; a value that keeps falling
   * means audio is arriving slower than real time and listeners will hear gaps.
   * 0 until `driftMeasured` is true.
   */
  driftSec: number;
  /** True once ffmpeg has reported progress for this session. */
  driftMeasured: boolean;
  /** Milliseconds the encoder's stdin has been blocked, 0 when draining. */
  blockedMs: number;
  error: string | null;
};

export type LiveEvent =
  | { type: "live.armed"; at: string; sessionId: string; expiresAt: string }
  | { type: "live.on_air"; at: string; sessionId: string }
  | {
      type: "live.stats";
      at: string;
      sessionId: string;
      bytesSent: number;
      bytesPerSec: number;
      driftSec: number;
      blockedMs: number;
    }
  | { type: "live.lost"; at: string; sessionId: string; reason: string }
  | { type: "live.ended"; at: string; sessionId: string };
