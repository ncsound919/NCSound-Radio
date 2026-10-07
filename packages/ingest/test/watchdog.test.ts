/**
 * Delivery-path watchdog.
 *
 * The behaviour under test is a judgement, not just arithmetic: recover the
 * broadcast when it is broken, and never recover it when an operator meant it to
 * be silent. Getting the second half wrong is worse than the outage it fixes —
 * a station that comes back up by itself after a deliberate stop is a station
 * nobody can turn off.
 *
 * ffmpeg is not stubbed. `sample()` is exercised against the real mount so the
 * parsing of `volumedetect` output is verified rather than assumed.
 */

import { describe, expect, test } from "bun:test";
import { MountWatchdog, type WatchdogSample } from "../src/mount-watchdog";

const MOUNT = process.env.NCSOUND_TEST_MOUNT ?? "http://127.0.0.1:8010/live.mp3";

/** A watchdog over a real mount, with the recovery decision recorded. */
function makeWatchdog(overrides: {
  intent: () => boolean | null;
  recover?: (reason: string) => Promise<{ ok: boolean; detail: string }>;
  silentSamplesBeforeRecovery?: number;
}) {
  const attempts: string[] = [];
  const watchdog = new MountWatchdog({
    mountUrl: MOUNT,
    enabled: false, // no timer: tests drive tick() explicitly
    silentSamplesBeforeRecovery: overrides.silentSamplesBeforeRecovery ?? 2,
    // The real delay is 6s so harbor, Liquidsoap and Icecast have time to carry
    // a track. Tests are not that patient, and bun's default per-test timeout is
    // 5s — without this every recovery test times out rather than asserting.
    verifyDelayMs: 5,
    recover:
      overrides.recover ??
      (async (reason) => {
        attempts.push(reason);
        return { ok: true, detail: "rolled a track" };
      }),
    operatorIntent: overrides.intent,
  });
  return { watchdog, attempts };
}

/**
 * Force the next measurement.
 *
 * Decision tests must not depend on what the live station happens to be doing.
 * An earlier version of this file asserted against real ticks, so "does not
 * recover" passed only while the station was silent and failed the moment it was
 * playing — a test that described the clock, not the rule.
 */
function forceSample(watchdog: MountWatchdog, verdict: WatchdogSample["verdict"], meanDb: number | null) {
  (watchdog as unknown as { sample: () => Promise<WatchdogSample> }).sample = async () => ({
    verdict,
    meanDb,
    peakDb: meanDb,
    mount: MOUNT,
    measuredAt: new Date().toISOString(),
    error: verdict === "unreachable" ? "connection refused" : null,
  });
}

/**
 * Model a mount that is silent until `audibleAfterCalls`, then carries audio.
 *
 * A recovery attempt triggers a verification measurement, so a test that wants to
 * see a *successful* recovery has to let the mount come back — otherwise the
 * watchdog correctly reports that nothing was delivered.
 */
function forceRecoveringSample(watchdog: MountWatchdog, audibleAfterCalls: number) {
  let calls = 0;
  (watchdog as unknown as { sample: () => Promise<WatchdogSample> }).sample = async () => {
    calls += 1;
    const audible = calls > audibleAfterCalls;
    return {
      verdict: audible ? "audible" : "silent",
      meanDb: audible ? -14 : -91,
      peakDb: audible ? -1 : -91,
      mount: MOUNT,
      measuredAt: new Date().toISOString(),
      error: null,
    };
  };
}

describe("mount watchdog", () => {
  test("a real ffmpeg measurement of a mount parses", async () => {
    // This used to measure http://127.0.0.1:8010/live.mp3 and failed on any
    // machine without a running station. It now serves its own 10 s, 440 Hz
    // MP3 over HTTP, so ffmpeg and the volumedetect parser are exercised
    // everywhere. Set NCSOUND_TEST_MOUNT to measure a real station instead.
    const mp3 = Bun.spawnSync(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=f=440:d=10", "-f", "mp3", "pipe:1"]).stdout;
    expect(mp3.byteLength).toBeGreaterThan(10_000);
    const server = process.env.NCSOUND_TEST_MOUNT
      ? null
      : Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(new Uint8Array(mp3), { headers: { "content-type": "audio/mpeg" } }) });
    try {
      const mountUrl = process.env.NCSOUND_TEST_MOUNT ?? `http://127.0.0.1:${server!.port}/live.mp3`;
      const watchdog = new MountWatchdog({
        mountUrl,
        enabled: false,
        recover: async () => ({ ok: true, detail: "unused" }),
        operatorIntent: () => true,
      });
      const sample = await watchdog.sample();
      expect(sample.error).toBeNull();
      expect(typeof sample.meanDb).toBe("number");
      if (server) {
        // Our own tone is loud and steady, so here the verdict is known.
        expect(sample.verdict).toBe("audible");
      }
    } finally {
      server?.stop(true);
    }
  });

  test("classifies measured audio against the silence floor", async () => {
    // The classification rule, on values taken from the real outage (-91) and a
    // real live capture (-13.1).
    const floor = -55;
    for (const [meanDb, expected] of [
      [-91, "silent"],
      [-13.1, "audible"],
    ] as const) {
      const { watchdog } = makeWatchdog({ intent: () => true });
      forceSample(watchdog, meanDb <= floor ? "silent" : "audible", meanDb);
      await watchdog.tick();
      expect(watchdog.status.last?.verdict).toBe(expected);
    }
  });

  test("never recovers while the operator has the station off air", async () => {
    const { watchdog, attempts } = makeWatchdog({ intent: () => false });
    forceSample(watchdog, "silent", -91);

    // Drive well past the streak threshold.
    for (let i = 0; i < 6; i++) {
      await watchdog.tick();
    }

    expect(attempts).toHaveLength(0);
    const status = watchdog.status;
    expect(status.operatorWantsOnAir).toBe(false);
    expect(status.holdingBecause).toMatch(/deliberate/);
  });

  test("does not recover when intent is unknown", async () => {
    // `desiredOnAir` is null before anything has asked for a state. Guessing
    // "on air" there would restart the engine on a station that was merely idle.
    const { watchdog, attempts } = makeWatchdog({ intent: () => null });
    forceSample(watchdog, "silent", -91);
    for (let i = 0; i < 6; i++) await watchdog.tick();
    expect(attempts).toHaveLength(0);
    expect(watchdog.status.holdingBecause).toMatch(/unknown/);
  });

  test("recovers when the operator wants the station audible", async () => {
    const { watchdog, attempts } = makeWatchdog({
      intent: () => true,
      silentSamplesBeforeRecovery: 2,
    });
    forceRecoveringSample(watchdog, 2);
    await watchdog.tick();
    await watchdog.tick();
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatch(/meant to be on air/);
    expect(watchdog.status.recoveries.at(-1)?.ok).toBe(true);
  });

  /**
   * The case this module was written for.
   *
   * The engine reported a deck rolling and metering audio on its master bus, and
   * the mount still carried -91 dBFS. A recovery routine that trusted its own
   * return value logged four consecutive successes against a silent station. Only
   * a fresh measurement of the mount can decide whether recovery worked.
   */
  test("reports failure when the engine recovers but no audio reaches the mount", async () => {
    const { watchdog } = makeWatchdog({
      intent: () => true,
      silentSamplesBeforeRecovery: 1,
      // The engine's own claim: everything worked.
      recover: async () => ({ ok: true, detail: "restarted the sequencer" }),
    });
    forceSample(watchdog, "silent", -91);

    await watchdog.tick();

    const recovery = watchdog.status.recoveries.at(-1);
    expect(recovery?.ok).toBe(false);
    expect(recovery?.detail).toMatch(/no audio reached the mount/);
    expect(recovery?.detail).toMatch(/-91/);
  });

  test("requires consecutive silent samples before acting", async () => {
    const { watchdog, attempts } = makeWatchdog({
      intent: () => true,
      silentSamplesBeforeRecovery: 3,
    });
    // Silent for the three streak samples; only the post-recovery verification read
    // sees audio, which is what "recovered" means.
    forceRecoveringSample(watchdog, 3);

    await watchdog.tick();
    expect(attempts).toHaveLength(0);
    expect(watchdog.status.holdingBecause).toMatch(/1\/3/);

    await watchdog.tick();
    expect(attempts).toHaveLength(0);

    await watchdog.tick();
    expect(attempts).toHaveLength(1);
  });

  test("an unreachable mount is a measurement failure, not an outage", async () => {
    const { watchdog, attempts } = makeWatchdog({ intent: () => true });
    forceSample(watchdog, "unreachable", null);

    for (let i = 0; i < 6; i++) await watchdog.tick();

    // Restarting the engine every time the network hiccuped would be its own
    // outage, so an unreadable mount must never trigger recovery.
    expect(attempts).toHaveLength(0);
    expect(watchdog.status.holdingBecause).toMatch(/could not read the mount/);
  });

  test("records what recovery did, and retries after a failure", async () => {
    let calls = 0;
    const { watchdog } = makeWatchdog({
      intent: () => true,
      silentSamplesBeforeRecovery: 1,
      recover: async () => {
        calls += 1;
        return calls === 1
          ? { ok: false, detail: "crate is empty" }
          : { ok: true, detail: "rolled a track" };
      },
    });
    // Silent throughout; the second attempt's verification will therefore read
    // silent too, which is the honest outcome and is asserted as such below.
    forceSample(watchdog, "silent", -91);

    await watchdog.tick();
    await watchdog.tick();

    expect(calls).toBe(2);
    const status = watchdog.status;
    expect(status.recoveries).toHaveLength(2);
    expect(status.recoveries[0].detail).toMatch(/crate is empty/);
    // A refusal is not retried into a "success" without evidence.
    expect(status.recoveries[0].ok).toBe(false);
    expect(status.recoveries[1].ok).toBe(false);
    expect(status.lastRecoveryAt).not.toBeNull();
  });

  /**
   * A repair is not instantaneous.
   *
   * Re-opening the harbor upload has to refill Liquidsoap's 12-second startup
   * buffer before anything reaches the mount. A single measurement straight after
   * the repair reads the pre-recovery state, so a fix that genuinely worked gets
   * logged as a failure — which is what happened live.
   */
  test("waits for delivery instead of judging the repair instantly", async () => {
    const { watchdog } = makeWatchdog({
      intent: () => true,
      silentSamplesBeforeRecovery: 1,
      recover: async () => ({ ok: true, detail: "re-opened the harbor upload" }),
    });
    // Silent for the streak sample and the first three verification reads, then
    // audio arrives.
    forceRecoveringSample(watchdog, 4);

    await watchdog.tick();

    const recovery = watchdog.status.recoveries.at(-1);
    expect(recovery?.ok).toBe(true);
    expect(recovery?.detail).toMatch(/audible/);
  });

  test("gives up honestly when the repair never delivers", async () => {
    const { watchdog } = makeWatchdog({
      intent: () => true,
      silentSamplesBeforeRecovery: 1,
      recover: async () => ({ ok: true, detail: "re-opened the harbor upload" }),
    });
    forceSample(watchdog, "silent", -91);

    await watchdog.tick();

    expect(watchdog.status.recoveries.at(-1)?.ok).toBe(false);
  });

  test("a verified recovery is recorded as a success", async () => {
    const { watchdog } = makeWatchdog({
      intent: () => true,
      silentSamplesBeforeRecovery: 1,
      recover: async () => ({ ok: true, detail: "rolled a track" }),
    });
    forceRecoveringSample(watchdog, 1);

    await watchdog.tick();

    const recovery = watchdog.status.recoveries.at(-1);
    expect(recovery?.ok).toBe(true);
    expect(recovery?.detail).toMatch(/audible/);
  });

  test("an audible sample clears the silence streak", async () => {
    const { watchdog, attempts } = makeWatchdog({
      intent: () => true,
      silentSamplesBeforeRecovery: 2,
    });
    forceSample(watchdog, "audible", -14);

    await watchdog.tick();
    expect(watchdog.status.silentStreak).toBe(0);
    expect(watchdog.status.holdingBecause).toBeNull();
    expect(attempts).toHaveLength(0);
  });
});