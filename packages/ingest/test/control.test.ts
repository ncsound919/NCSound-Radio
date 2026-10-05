/**
 * Tests for the ingest control plane.
 *
 * The dispatcher is exercised against a HeadlessEngine with publishing turned
 * off, so nothing here touches Liquidsoap or Icecast. The Icecast parsing is
 * tested against the real response shape captured from the running server,
 * including the missing `mount` field.
 */

import { describe, test, expect } from "bun:test";
import type { CommandEnvelope } from "@ncsound/station-core";

import { buildStreamStatus, listenerCountsFrom } from "../src/icecast";
import { CommandDispatcher } from "../src/commands";
import { HeadlessEngine } from "@ncsound/dj-engine";

// Captured verbatim from Icecast 2.4.4 at /status-json.xsl. Note there is no
// "mount" key: the mount name only exists inside listenurl.
const ICECAST_DOC = {
  icestats: {
    admin: "ops@ncsound.local",
    host: "ncsound.local",
    location: "Localhost",
    server_id: "Icecast 2.4.4",
    server_start_iso8601: "2026-10-03T06:31:42-0400",
    source: [
      {
        audio_info: "channels=2;samplerate=44100;bitrate=128",
        bitrate: 128,
        channels: 2,
        genre: "Various",
        listener_peak: 3,
        listeners: 2,
        listenurl: "http://ncsound.local:8010/live.mp3",
        samplerate: 44100,
        server_description: "Independent hip-hop radio",
        server_name: "NCSound Radio",
        server_type: "audio/mpeg",
        stream_start_iso8601: "2026-10-03T07:52:13-0400",
        title: "NCSound Radio",
        dummy: "",
      },
      {
        audio_info: "channels=2;samplerate=44100;bitrate=64",
        bitrate: 64,
        channels: 2,
        listener_peak: 1,
        listeners: 1,
        listenurl: "http://ncsound.local:8010/mobile.mp3",
        samplerate: 44100,
        server_type: "audio/mpeg",
        stream_start_iso8601: "2026-10-03T07:52:13-0400",
        title: "NCSound Radio",
        dummy: "",
      },
    ],
  },
};

describe("icecast status parsing", () => {
  test("maps both mounts and recovers the mount name from listenurl", () => {
    const s = buildStreamStatus(ICECAST_DOC, { ingestHealthy: true });
    expect(s.mounts).toHaveLength(2);
    expect(s.mounts.map((m) => m.mount)).toEqual(["/live.mp3", "/mobile.mp3"]);
    expect(s.mounts.map((m) => m.bitrateKbps)).toEqual([128, 64]);
    expect(s.icecast.reachable).toBe(true);
    expect(s.icecast.version).toBe("Icecast 2.4.4");
  });

  test("prefers the higher-bitrate mount as the station encoder", () => {
    const s = buildStreamStatus(ICECAST_DOC, { ingestHealthy: true });
    expect(s.encoder).toBe("mp3");
  });

  test("onAir requires both a connected source and a healthy ingest", () => {
    expect(buildStreamStatus(ICECAST_DOC, { ingestHealthy: true }).onAir).toBe(true);
    expect(buildStreamStatus(ICECAST_DOC, { ingestHealthy: false }).onAir).toBe(false);
  });

  test("no sources means unreachable, not a crash", () => {
    const s = buildStreamStatus({}, { ingestHealthy: true });
    expect(s.icecast.reachable).toBe(false);
    expect(s.mounts).toEqual([]);
    expect(s.icecast.error).toBeTruthy();
  });

  test("a single source object is handled as well as an array", () => {
    const one = { icestats: { source: ICECAST_DOC.icestats.source[0] } };
    const s = buildStreamStatus(one, { ingestHealthy: true });
    expect(s.mounts).toHaveLength(1);
    expect(s.mounts[0]?.mount).toBe("/live.mp3");
  });

  test("listener counts take the largest mount, not the sum", () => {
    // The two mounts are alternative bitrates of one station, so a listener
    // on both would double count if we summed. 2 and 1 -> 2, peak 3.
    const c = listenerCountsFrom(buildStreamStatus(ICECAST_DOC, { ingestHealthy: true }));
    expect(c.current).toBe(2);
    expect(c.peak24h).toBe(3);
    expect(c.source).toBe("icecast");
  });
});

describe("command dispatcher", () => {
  async function fixture() {
    const engine = new HeadlessEngine({ publish: false });
    await engine.start();
    const dispatcher = new CommandDispatcher({ engine });
    const send = (command: unknown) =>
      dispatcher.dispatch({
        id: "t1",
        issuedAt: new Date().toISOString(),
        actor: { id: "test", role: "ops", label: "test" },
        command: command as never,
      } satisfies CommandEnvelope);
    return { engine, send };
  }

  test("rejects a command that fails contract validation", async () => {
    const { send } = await fixture();
    const r = await send({ type: "mix.setCrossfader", position: "sideways" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_PARAMS");
  });

  test("rejects an unknown command type", async () => {
    const { send } = await fixture();
    const r = await send({ type: "does.not.exist" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_PARAMS");
  });

  test("mixNext runs at the requested transition length, not a guessed one", async () => {
    const { engine, send } = await fixture();
    // The dispatcher used to build a bare `{ id }` from presetId alone, and
    // `runTransition` reads `p.bars || 2`. Every engine-side transition was
    // therefore 2 bars — an 8-bar blend chosen in the console played as 2.
    // This needs a playing engine with both decks loaded; `next()` otherwise
    // refuses before the preset is ever read. The default fixture crate holds
    // a single synthesised track, which is enough — it goes into both decks.
    const only = engine.library[0];
    expect(only).toBeDefined();
    await send({ type: "cue.track", trackId: only.id, slot: 0 });
    await send({ type: "cue.track", trackId: only.id, slot: 1 });
    await send({ type: "transport.play" });

    const long = await send({ type: "mix.mixNext", presetId: "long", bars: 8, curve: "equal-power" });
    expect(long.ok).toBe(true);
    if (long.ok) expect((long.result as { bars: number }).bars).toBe(8);

    await engine.close();
  });

  test("mixNext defaults to the documented length when no bars are given", async () => {
    const { engine, send } = await fixture();
    // The field is optional, so a bare command has to fall back to the value
    // the engine was silently using before the field existed.
    const bare = await send({ type: "mix.mixNext" });
    // It may be refused for want of two loaded decks; what matters is that it
    // is not rejected by validation when it does reach the mixer.
    if (bare.ok) expect((bare.result as { bars: number }).bars).toBe(2);
    else expect(bare.code).not.toBe("INVALID_PARAMS");
    await engine.close();
  });

  test("rejects a transition length the mixer would silently clamp", async () => {
    const { send } = await fixture();
    const r = await send({ type: "mix.mixNext", presetId: "long", bars: 64 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_PARAMS");
  });

  test("transport.stop also takes the station off air", async () => {
    // Stopping the engine is not enough. ncsound.liq falls back to the library
    // playlist when the harbor drops, so "stop" alone left the station playing
    // filler while the UI said it had stopped.
    const engine = new HeadlessEngine({ publish: false });
    await engine.start();
    const setOnAir: boolean[] = [];
    let current = true;
    const dispatcher = new CommandDispatcher({
      engine,
      station: {
        setOnAir: async (on) => {
          setOnAir.push(on);
          current = on;
        },
        onAir: async () => ({ onAir: current, error: null }),
      },
    });
    const send = (command: unknown) =>
      dispatcher.dispatch({
        id: "t-offair",
        issuedAt: new Date().toISOString(),
        actor: { id: "test", role: "ops", label: "test" },
        command: command as never,
      } satisfies CommandEnvelope);

    const stopped = await send({ type: "transport.stop" });
    expect(stopped.ok).toBe(true);
    expect(setOnAir).toEqual([false]);
    if (stopped.ok) expect((stopped.result as { onAir: boolean | null }).onAir).toBe(false);

    // And coming back up brings it back on air, so an emergency is not sticky.
    const played = await send({ type: "transport.play" });
    expect(played.ok).toBe(true);
    expect(setOnAir).toEqual([false, true]);

    await engine.close();
  });

  test("off-air works without stopping the engine", async () => {
    const engine = new HeadlessEngine({ publish: false });
    await engine.start();
    let current = true;
    const dispatcher = new CommandDispatcher({
      engine,
      station: {
        setOnAir: async (on) => {
          current = on;
        },
        onAir: async () => ({ onAir: current, error: null }),
      },
    });
    const send = (command: unknown) =>
      dispatcher.dispatch({
        id: "t-mute",
        issuedAt: new Date().toISOString(),
        actor: { id: "test", role: "ops", label: "test" },
        command: command as never,
      } satisfies CommandEnvelope);

    const off = await send({ type: "transport.offAir" });
    expect(off.ok).toBe(true);
    if (off.ok) expect((off.result as { onAir: boolean | null }).onAir).toBe(false);
    // The engine is untouched: still playing, just not being broadcast.
    expect(engine.status.state).not.toBe("offline");

    const on = await send({ type: "transport.onAir", enabled: true });
    expect(on.ok).toBe(true);
    if (on.ok) expect((on.result as { onAir: boolean | null }).onAir).toBe(true);

    await engine.close();
  });

  test("a missing Liquidsoap does not make stop fail", async () => {
    // No `station` dep at all — the test fixture, and any machine without
    // Liquidsoap. The engine state change still happened and must be reported;
    // the on-air answer is null because it could not be determined.
    const { engine, send } = await fixture();
    const r = await send({ type: "transport.stop" });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.result as { onAir: boolean | null }).onAir).toBeNull();
    await engine.close();
  });
  test("a Liquidsoap that refuses does not make stop fail", async () => {
    const engine = new HeadlessEngine({ publish: false });
    await engine.start();
    const dispatcher = new CommandDispatcher({
      engine,
      station: {
        setOnAir: async () => {
          throw new Error("connection refused");
        },
        onAir: async () => ({ onAir: null, error: "connection refused" }),
      },
    });
    const r = await dispatcher.dispatch({
      id: "t-refused",
      issuedAt: new Date().toISOString(),
      actor: { id: "test", role: "ops", label: "test" },
      command: { type: "transport.stop" } as never,
    } satisfies CommandEnvelope);
    // A control-plane hiccup must not be reported as "the stop failed" — the
    // engine did stop. It reports onAir:null so the UI can say so.
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.result as { onAir: boolean | null }).onAir).toBeNull();
    await engine.close();
  });

  test("setEnergyTarget pins the energy the autopilot actually aims at", async () => {
    const engine = new HeadlessEngine({ publish: false });
    await engine.start();
    const dispatcher = new CommandDispatcher({ engine });
    const send = (command: unknown) =>
      dispatcher.dispatch({
        id: "t-energy",
        issuedAt: new Date().toISOString(),
        actor: { id: "test", role: "ops", label: "test" },
        command: command as never,
      } satisfies CommandEnvelope);

    const before = engine.autopilot.energyTarget;
    const r = await send({ type: "autopilot.setEnergyTarget", energy: 0.9 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const result = r.result as { energyTarget: number; overridden: boolean };
      // Used to validate the input and then report the template curve's value
      // back, writing nothing — so 0.9 came back as something else entirely.
      expect(result.energyTarget).toBeCloseTo(0.9, 6);
      expect(result.overridden).toBe(true);
      expect(engine.autopilot.energyTarget).toBeCloseTo(0.9, 6);
    }
    expect(before).not.toBeCloseTo(0.9, 6);

    // Out of range is refused rather than silently clamped.
    const bad = await send({ type: "autopilot.setEnergyTarget", energy: 4 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("INVALID_PARAMS");

    // Choosing a vibe template hands control back to the curve.
    await send({ type: "autopilot.setVibe", templateId: "club-peak" });
    expect(engine.autopilot.isEnergyOverridden).toBe(false);

    await engine.close();
  });

  test("resequence makes played tracks eligible again", async () => {
    const engine = new HeadlessEngine({ publish: false });
    await engine.start();
    const dispatcher = new CommandDispatcher({ engine });
    const send = (command: unknown) =>
      dispatcher.dispatch({
        id: "t-reseq",
        issuedAt: new Date().toISOString(),
        actor: { id: "test", role: "ops", label: "test" },
        command: command as never,
      } satisfies CommandEnvelope);

    // Force some history, which is the only thing that makes autopilot avoid a
    // repeat — it scores the whole crate on every transition.
    (engine.autopilot as unknown as { history: string[] }).history = ["x", "y"];

    const r = await send({ type: "autopilot.resequence" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const result = r.result as { crateSize: number };
      expect(result.crateSize).toBe(engine.autopilot.crate.length);
    }
    expect((engine.autopilot as unknown as { history: string[] }).history).toEqual([]);
    await engine.close();
  });

  test("resequence can pin an energy target in the same call", async () => {
    const engine = new HeadlessEngine({ publish: false });
    await engine.start();
    const dispatcher = new CommandDispatcher({ engine });
    const r = await dispatcher.dispatch({
      id: "t-reseq2",
      issuedAt: new Date().toISOString(),
      actor: { id: "test", role: "ops", label: "test" },
      command: { type: "autopilot.resequence", targetEnergy: 0.25 } as never,
    } satisfies CommandEnvelope);
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.result as { energyTarget: number }).energyTarget).toBeCloseTo(0.25, 6);
    expect(engine.autopilot.energyTarget).toBeCloseTo(0.25, 6);
    await engine.close();
  });

  test("reports NO_SUCH_TRACK rather than throwing", async () => {    const { send } = await fixture();
    const r = await send({ type: "cue.track", trackId: "not-in-crate" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NO_SUCH_TRACK");
  });

  test("sets the crossfader and reads it back", async () => {
    const { send } = await fixture();
    const r = await send({ type: "mix.setCrossfader", position: 0.4 });
    expect(r.ok).toBe(true);
    if (r.ok) expect((r.result as { applied: number }).applied).toBeCloseTo(0.4, 5);
  });

  test("the contract rejects an out-of-range crossfader before the engine sees it", async () => {
    const { send } = await fixture();
    // The zod schema already bounds position to [-1, 1], so this never reaches
    // the handler's clamp. That is the right layer for it: rejecting a bad
    // command beats quietly applying a different one.
    const r = await send({ type: "mix.setCrossfader", position: 5 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_PARAMS");
  });

  test("accepts the extremes of the legal crossfader range", async () => {
    const { send } = await fixture();
    for (const pos of [-1, 0, 1]) {
      const r = await send({ type: "mix.setCrossfader", position: pos });
      expect(r.ok).toBe(true);
      if (r.ok) expect((r.result as { applied: number }).applied).toBe(pos);
    }
  });

  test("rejects a master bpm outside the musical range", async () => {
    const { send } = await fixture();
    const r = await send({ type: "sync.masterBpm", bpm: 4000 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("INVALID_PARAMS");
  });

  test("enforces the authorised hook when one is supplied", async () => {
    const engine = new HeadlessEngine({ publish: false });
    await engine.start();
    const dispatcher = new CommandDispatcher({
      engine,
      isAuthorised: (actor) => actor.role === "ops",
    });
    const denied = await dispatcher.dispatch({
      id: "t",
      issuedAt: new Date().toISOString(),
      actor: { id: "bot", role: "automation", label: "bot" },
      command: { type: "query.status" } as never,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("UNAUTHORIZED");
    await engine.close();
  });

  test("status reports a real on-air track rather than null", async () => {
    const { engine, send } = await fixture();
    const r = await send({ type: "query.status" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const status = r.result as { onAir: { current: { track: { title: string }; elapsed: number } } | null };
    // The crate falls back to a synthesised track, so there is always something.
    expect(status.onAir).not.toBeNull();
    expect(status.onAir?.current.track.title.length).toBeGreaterThan(0);
    expect(status.onAir?.current.elapsed).toBeGreaterThanOrEqual(0);
    await engine.close();
  });
});