/**
 * Delivery-path watchdog.
 *
 * Why this exists, and why it measures the mount instead of the engine:
 *
 * The station broadcast silence for roughly five hours while every engine-side
 * field looked healthy. `engine.state` read "playing", telemetry reported
 * masterPeakDb around -7 dBFS with a full render-ahead lead, `broadcast.onAir`
 * was derived from fields that all agreed with each other — and ffmpeg measured
 * `mean_volume: -91.0 dB` at `http://127.0.0.1:8010/live.mp3`.
 *
 * The engine's meter is connected to the audio *graph*. It cannot see whether
 * harbor, Liquidsoap and Icecast delivered anything. A station can be perfectly
 * healthy internally and silent on the mount, and no field in `/status`
 * distinguished the two. So the only honest check reads the mount itself.
 *
 * Recovery is automatic, but it must never override a deliberate human decision.
 * `LiquidsoapControl.desiredOnAir` is the operator's stated intent; when that is
 * `false` the station is *supposed* to be silent and this watchdog does nothing.
 * Recovering out from under an operator who took the station off air is worse
 * than the silence it is fixing.
 */

import { spawn } from "node:child_process";

const FFMPEG = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

/**
 * How long to wait before re-measuring after a recovery attempt.
 *
 * Long enough for a track to actually reach the mount through harbor and
 * Liquidsoap. Verifying immediately would measure the pre-recovery state and
 * report a successful recovery as a failure.
 */
const VERIFY_DELAY_MS = 6000;

export type WatchdogVerdict = "audible" | "silent" | "unreachable";

export type WatchdogSample = {
  /** What the mount measurement concluded. */
  verdict: WatchdogVerdict;
  /** Mean volume in dBFS, or null when ffmpeg produced no measurement. */
  meanDb: number | null;
  peakDb: number | null;
  /** Mount sampled, e.g. `http://127.0.0.1:8010/live.mp3`. */
  mount: string;
  measuredAt: string;
  /** Set when the measurement itself could not be taken. */
  error: string | null;
};

export type WatchdogRecovery = {
  at: string;
  /** What was tried, in words an operator can act on. */
  action: string;
  ok: boolean;
  detail: string;
};

export type WatchdogStatus = {
  enabled: boolean;
  last: WatchdogSample | null;
  /** Consecutive silent samples. Recovery needs this to exceed the threshold. */
  silentStreak: number;
  /** Operator intent, mirrored. `false` means silence is deliberate. */
  operatorWantsOnAir: boolean | null;
  /** Why the watchdog is not acting, when it is not acting. */
  holdingBecause: string | null;
  recoveries: WatchdogRecovery[];
  lastRecoveryAt: string | null;
};

export type MountWatchdogOptions = {
  /** Seconds of audio to measure per sample. */
  sampleSeconds?: number;
  /** Seconds between samples. */
  intervalSec?: number;
  /**
   * Consecutive silent samples before recovery is attempted.
   *
   * Deliberately > 1. A track boundary, a beatmatch gap or a quiet intro can
   * read as near-silence for a second or two, and recovering into the middle of
   * a transition would be its own outage.
   */
  silentSamplesBeforeRecovery?: number;
  /** dBFS mean at or below which the mount counts as silent. */
  silenceFloorDb?: number;
  /**
   * How long to wait before re-measuring after a recovery attempt.
   *
   * Long enough for audio to actually reach the mount through harbor and
   * Liquidsoap. Verifying immediately would measure the pre-recovery state and
   * report a successful recovery as a failure. Overridable so tests need not
   * spend real seconds waiting.
   */
  verifyDelayMs?: number;
  mountUrl: string;
  /** Disables the timer. Measurements can still be taken on demand. */
  enabled?: boolean;
  /**
   * Perform one recovery attempt. Supplied by the server so this module holds no
   * engine or station references.
   */
  recover: (reason: string) => Promise<{ ok: boolean; detail: string }>;
  /** Operator intent, read fresh on every tick. */
  operatorIntent: () => boolean | null;
  log?: (message: string) => void;
};

/** Parse ffmpeg's volumedetect summary from stderr. */
function parseVolumes(stderr: string): { meanDb: number | null; peakDb: number | null } {
  const pick = (label: string): number | null => {
    const m = new RegExp(`${label}:\\s*(-?[\\d.]+|-\\w+)\\s*dB`).exec(stderr);
    if (!m) return null;
    const v = Number.parseFloat(m[1]);
    return Number.isFinite(v) ? v : null;
  };
  return { meanDb: pick("mean_volume"), peakDb: pick("max_volume") };
}

export class MountWatchdog {
  private readonly opts: Required<
    Omit<MountWatchdogOptions, "recover" | "operatorIntent" | "log" | "mountUrl" | "enabled">
  > & {
    mountUrl: string;
    enabled: boolean;
    recover: MountWatchdogOptions["recover"];
    operatorIntent: MountWatchdogOptions["operatorIntent"];
    log: (message: string) => void;
  };

  private timer: ReturnType<typeof setInterval> | null = null;
  private sampling = false;
  private last: WatchdogSample | null = null;
  private silentStreak = 0;
  private recoveries: WatchdogRecovery[] = [];
  private holdingBecause: string | null = null;

  constructor(options: MountWatchdogOptions) {
    this.opts = {
      sampleSeconds: options.sampleSeconds ?? 4,
      intervalSec: options.intervalSec ?? 30,
      silentSamplesBeforeRecovery: options.silentSamplesBeforeRecovery ?? 3,
      silenceFloorDb: options.silenceFloorDb ?? -55,
      verifyDelayMs: options.verifyDelayMs ?? VERIFY_DELAY_MS,
      mountUrl: options.mountUrl,
      enabled: options.enabled ?? true,
      recover: options.recover,
      operatorIntent: options.operatorIntent,
      log: options.log ?? (() => {}),
    };
  }

  get status(): WatchdogStatus {
    return {
      enabled: this.opts.enabled,
      last: this.last,
      silentStreak: this.silentStreak,
      operatorWantsOnAir: this.opts.operatorIntent(),
      holdingBecause: this.holdingBecause,
      // Bounded: an operator wants the recent history, not every tick since boot.
      recoveries: this.recoveries.slice(-10),
      lastRecoveryAt: this.recoveries.at(-1)?.at ?? null,
    };
  }

  start(): void {
    if (!this.opts.enabled || this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.opts.intervalSec * 1000);
    (this.timer as unknown as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Take one measurement of the mount.
   *
   * Reads a short window of the live mount through ffmpeg's `volumedetect`
   * filter. This is the same measurement used to prove the outage by hand, which
   * is why it is the measurement used here.
   */
  async sample(): Promise<WatchdogSample> {
    const seconds = this.opts.sampleSeconds;
    const mount = this.opts.mountUrl;
    const base: WatchdogSample = {
      verdict: "unreachable",
      meanDb: null,
      peakDb: null,
      mount,
      measuredAt: new Date().toISOString(),
      error: null,
    };

    const raw = await new Promise<{ code: number | null; stderr: string }>((resolve) => {
      let stderr = "";
      const child = spawn(
        FFMPEG,
        [
          "-hide_banner",
          "-nostats",
          // Long enough to be past any Icecast connect jitter, short enough that
          // a wedged mount is noticed while an operator still cares.
          "-t",
          String(seconds),
          "-i",
          mount,
          "-af",
          "volumedetect",
          "-f",
          "null",
          process.platform === "win32" ? "NUL" : "/dev/null",
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      child.stderr?.on("data", (c: Buffer) => {
        stderr += c.toString();
      });
      child.on("error", (err) => {
        base.error = err.message;
        resolve({ code: null, stderr });
      });
      child.on("close", (code) => resolve({ code, stderr }));
    });

    if (raw.code !== 0) {
      // ffmpeg exits non-zero on a timed-out read of a live stream, which is
      // normal when the window elapses before EOF. The measurement still parsed.
      const { meanDb } = parseVolumes(raw.stderr);
      if (meanDb === null) {
        return { ...base, error: raw.stderr.trim().split("\n").at(-1) ?? `ffmpeg exited ${raw.code}` };
      }
    }

    const { meanDb, peakDb } = parseVolumes(raw.stderr);
    if (meanDb === null) {
      return { ...base, error: "volumedetect produced no reading" };
    }

    return {
      verdict: meanDb <= this.opts.silenceFloorDb ? "silent" : "audible",
      meanDb,
      peakDb,
      mount,
      measuredAt: new Date().toISOString(),
      error: null,
    };
  }

  /** One watchdog cycle: measure, classify, and recover if warranted. */
  async tick(): Promise<WatchdogSample | null> {
    if (this.sampling) return null;
    this.sampling = true;
    try {
      const sample = await this.sample();
      this.last = sample;

      if (sample.verdict === "audible") {
        this.silentStreak = 0;
        this.holdingBecause = null;
        return sample;
      }

      // Unreachable is not silence, and must never trigger recovery: a mount we
      // cannot read is a measurement failure, and "recovering" from it would
      // restart the engine every time the network hiccuped.
      if (sample.verdict === "unreachable") {
        this.holdingBecause = `could not read the mount: ${sample.error ?? "unknown"}`;
        return sample;
      }

      this.silentStreak += 1;

      const intent = this.opts.operatorIntent();
      if (intent === false) {
        this.holdingBecause = "the operator has the station off air; silence is deliberate";
        return sample;
      }
      if (intent !== true) {
        /**
         * Unknown intent is not permission.
         *
         * `desiredOnAir` is null until something has actually asked Liquidsoap for
         * a state. Treating that as "on air" meant a station that was merely idle
         * — or one whose control plane had not yet spoken — got its engine rolled
         * out from under it. Only an explicit `true` authorises recovery.
         */
        this.holdingBecause =
          "the operator's on-air intent is unknown, so the watchdog will not override it";
        return sample;
      }

      if (this.silentStreak < this.opts.silentSamplesBeforeRecovery) {
        this.holdingBecause =
          `silent ${this.silentStreak}/${this.opts.silentSamplesBeforeRecovery} samples ` +
          "before recovery is attempted";
        return sample;
      }

      this.holdingBecause = null;
      const reason =
        `mount silent at ${sample.meanDb?.toFixed(1)} dBFS for ` +
        `${this.silentStreak} consecutive samples while the station is meant to be on air`;

      let outcome: { ok: boolean; detail: string };
      try {
        outcome = await this.opts.recover(reason);
      } catch (err) {
        outcome = { ok: false, detail: err instanceof Error ? err.message : String(err) };
      }

      /**
       * Verify the recovery by measuring the mount again.
       *
       * The recovery step used to report success on its own say-so — "a deck is
       * rolling" — and that is the same mistake this whole module exists to
       * catch. A deck can read as playing while the engine's render pump is
       * starved (`renderedAheadSec` pinned at its -1 floor), in which case the
       * master bus meters fine and the mount still receives nothing. Observed
       * live: four consecutive "recovered" results against a mount that stayed at
       * -91 dBFS.
       *
       * Only audio actually arriving at the mount counts as recovered. The
       * action's own claim is kept as `actionOk` so the two can be compared.
       */
      const actionOk = outcome.ok;
      let verified: WatchdogSample | null = null;
      if (actionOk) {
        await new Promise((r) => setTimeout(r, this.opts.verifyDelayMs));
        verified = await this.sample();
        this.last = verified;
      }
      const delivered = verified?.verdict === "audible";

      const record: WatchdogRecovery = {
        at: new Date().toISOString(),
        action: "auto-recover the broadcast",
        ok: delivered,
        detail:
          `${outcome.detail} — then measured the mount: ` +
          (verified
            ? `${verified.verdict} at ${verified.meanDb?.toFixed(1) ?? "?"} dBFS`
            : "no reading") +
          (delivered
            ? ""
            : actionOk
              ? " (the engine reported recovery, but no audio reached the mount)"
              : ""),
      };
      this.recoveries.push(record);
      this.opts.log(
        `watchdog ${delivered ? "recovered" : "DID NOT recover"}: ${reason} — ${record.detail}`,
      );

      // Reset either way: a failed recovery must retry on the next cycle rather
      // than waiting for silence to "become consecutive" all over again.
      this.silentStreak = 0;
      return sample;
    } finally {
      this.sampling = false;
    }
  }
}