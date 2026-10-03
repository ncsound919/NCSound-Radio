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

  test("reports NO_SUCH_TRACK rather than throwing", async () => {
    const { send } = await fixture();
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