/**
 * Who is allowed to put audio on the operator's speakers.
 *
 * The failure these exist to catch, reported from the booth as "the DJ software
 * is conflicting with the stream and they interrupt each other, and the tracks
 * play pitched down". Both symptoms had one cause: the booth ran its own copy
 * of the broadcast.
 *
 *   - Doubling: `new Mixer()` defaults to `monitorPolicy: "program"`, so the
 *     booth's program bus reached `ctx.destination` while the engine published
 *     the same music to harbor. Two copies, on two unrelated clocks.
 *   - Pitch: the booth's Smart Mix drove the deck with `playbackRate`
 *     (deck.ts), which resamples the playhead and drags pitch down with tempo.
 *     The engine uses TimePitchEngine, which preserves pitch. So the booth's
 *     copy was flat and the broadcast was not.
 *
 * `routeOutputs` is the single owner of the destination wiring. Web Audio
 * cannot enumerate connections, so these tests observe the master limiter's own
 * `connect` calls - which is exactly the question being asked: does the program
 * bus reach the speakers?
 */

import { describe, expect, test } from "bun:test";
import { Mixer } from "../src/engine/mixer";
import { createHeadlessContext, createPcmTap, measureChunk } from "../src/audio/context";
import { BUILTIN_TRACK_SPECS, synthesizeStudioTrack } from "../src/engine/synthTracks";

const SR = 48000;

function shortTrack(ctx: BaseAudioContext, index: number, durationSec: number) {
  const spec = { ...BUILTIN_TRACK_SPECS[index % BUILTIN_TRACK_SPECS.length], durationSec };
  return synthesizeStudioTrack(ctx, spec as never);
}

/**
 * Record every destination the master limiter is wired to.
 *
 * `routeOutputs` disconnects the limiter wholesale and rebuilds, so this has to
 * be installed before the call under test. Forced through a policy round-trip
 * (cue-only -> program) rather than relying on constructor-time wiring, which is
 * already in place by the time a test can reach the node.
 */
function watchLimiterRouting(mixer: Mixer) {
  const limiter = (mixer as unknown as { masterLimiter: AudioNode }).masterLimiter;
  const targets: AudioNode[] = [];
  const realConnect = limiter.connect.bind(limiter);
  limiter.connect = ((dest: AudioNode, ...rest: unknown[]) => {
    targets.push(dest);
    return (realConnect as (...a: unknown[]) => unknown)(dest, ...rest);
  }) as AudioNode["connect"];

  return {
    targets,
    get reachesSpeakers() {
      return targets.includes(mixer.ctx.destination);
    },
    /** Re-run the routing under the current policy. */
    reroute(policy: "program" | "cue-only") {
      targets.length = 0;
      mixer.setMonitorPolicy(policy === "program" ? "cue-only" : "program");
      mixer.setMonitorPolicy(policy);
    },
  };
}

/** Peak level seen on a node over `ms`, proving audio is actually flowing. */
async function peakOn(node: AudioNode, mixer: Mixer, ms: number) {
  let peak = 0;
  const tap = createPcmTap(mixer.ctx, {
    bufferSize: 2048,
    onChunk: ({ channels }) => {
      peak = Math.max(peak, measureChunk(channels).peak);
    },
  });
  node.connect(tap.node);
  tap.node.connect(mixer.ctx.destination);
  await new Promise((r) => setTimeout(r, ms));
  tap.stop();
  return peak;
}

describe("monitor policy", () => {
  test("the booth's program bus does not reach the speakers", async () => {
    const ctx = createHeadlessContext({ sampleRate: SR });
    const mixer = new Mixer(ctx);
    const watch = watchLimiterRouting(mixer);

    watch.reroute("program");
    expect(watch.reachesSpeakers).toBe(true);

    watch.reroute("cue-only");
    expect(watch.reachesSpeakers).toBe(false);
    // Release the sink-less context. Without this the audio clock keeps
    // running and starves the next test's context - which is how a real
    // assertion here turns into a flake in an unrelated suite.
    await ctx.close();
  });

  test("the broadcast engine still reaches the speakers", async () => {
    const ctx = createHeadlessContext({ sampleRate: SR });
    const mixer = new Mixer(ctx);
    // This is the load-bearing default. The headless engine publishes this very
    // program bus to harbor, so flipping the default to "cue-only" would silence
    // the station itself, not just the booth.
    expect(mixer.monitorPolicy).toBe("program");

    const watch = watchLimiterRouting(mixer);
    watch.reroute("program");
    expect(watch.reachesSpeakers).toBe(true);
    await ctx.close();
  });

  test("cue-only keeps the decks running, so the booth's transport model stays live", async () => {
    const ctx = createHeadlessContext({ sampleRate: SR });
    const mixer = new Mixer(ctx);
    mixer.setMonitorPolicy("cue-only");

    mixer.loadBuffer(0, shortTrack(ctx, 0, 6), { bpm: 124, firstBeat: 0.24 });
    expect(mixer.play()).toBe(true);

    // The point of cue-only is that routing changed, not that playback stopped.
    // A booth whose playhead froze would be a worse bug than the doubling.
    const programPeak = await peakOn(mixer.getMasterOutputNode(), mixer, 700);
    expect(programPeak).toBeGreaterThan(0.01);
    expect(mixer.playing).toBe(true);
    await ctx.close();
  });

  test("an external program tap survives a policy change", async () => {
    const ctx = createHeadlessContext({ sampleRate: SR });
    const mixer = new Mixer(ctx);

    // This is the station stream player: `mixer.addProgramTap(radio.inputNode)`
    // in the booth. It used to be wired by hand, and `disconnect()` takes no
    // arguments - so the first re-route silently detached it, leaving a booth
    // that had toggled split-cue with no stream monitor and no error.
    let tapped = 0;
    const sink = ctx.createGain();
    mixer.addProgramTap(sink);
    sink.connect(mixer.ctx.destination);

    mixer.loadBuffer(0, shortTrack(ctx, 0, 6), { bpm: 124, firstBeat: 0.24 });
    mixer.play();

    const meter = createPcmTap(mixer.ctx, {
      bufferSize: 2048,
      onChunk: () => {
        tapped += 1;
      },
    });
    sink.connect(meter.node);
    meter.node.connect(mixer.ctx.destination);

    await new Promise((r) => setTimeout(r, 500));
    expect(tapped).toBeGreaterThan(0);

    // Force a full re-route, then confirm the tap is still being pulled.
    mixer.setMonitorPolicy("cue-only");
    mixer.setMonitorPolicy("program");

    const before = tapped;
    await new Promise((r) => setTimeout(r, 500));
    expect(tapped).toBeGreaterThan(before);
    meter.stop();
    await ctx.close();
  });

  test("the cued deck stays audible for pre-listen in cue-only", async () => {
    const ctx = createHeadlessContext({ sampleRate: SR });
    const mixer = new Mixer(ctx);
    mixer.setMonitorPolicy("cue-only");

    // Deck A is the (silent) on-air deck; deck B is the cue.
    mixer.loadBuffer(0, shortTrack(ctx, 0, 8), { bpm: 124, firstBeat: 0.24 });
    mixer.loadBuffer(1, shortTrack(ctx, 1, 8), { bpm: 126, firstBeat: 0.24 });

    const started = mixer.toggleCueAudition(1);
    expect(started).toBe(true);
    expect(mixer.auditioningSlot).toBe(1);

    /**
     * The pitch half of the report, asserted on the actual playhead.
     *
     * `playbackRate` is what determines whether a deck sounds flat, so this
     * reads the rate the cue deck was actually started at rather than trusting
     * the call site. A cue beatmatched to the programme is exactly the "plays
     * pitched down" symptom.
     */
    const cueRate = (mixer.decks[1] as unknown as { src: AudioBufferSourceNode | null }).src
      ?.playbackRate.value;
    expect(cueRate).toBe(1);

    // The cue bus is what the booth is left with, so it must carry signal.
    const cuePeak = await peakOn(
      (mixer as unknown as { cueBusGain: AudioNode }).cueBusGain,
      mixer,
      700,
    );
    expect(cuePeak).toBeGreaterThan(0.01);
    await ctx.close();
  });
});