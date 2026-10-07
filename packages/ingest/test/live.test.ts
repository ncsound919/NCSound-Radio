/**
 * The live bridge, against a fake ffmpeg.
 *
 * The process boundary is injected so the whole state machine is tested without
 * a real ffmpeg or Liquidsoap: arm, single-session refusal, byte accounting,
 * drift, backpressure drop, operator hand-back, and unexpected loss. The auth
 * second factor (the per-session live key) is tested directly.
 */

import { describe, expect, test } from "bun:test";
import type { LiveEvent } from "@ncsound/station-core";
import { LiveBridge, LiveKeyStore, liveFfmpegArgs } from "../src/live";

type Handler = (...args: unknown[]) => void;

class FakeProcess {
  written: Uint8Array[] = [];
  ended = false;
  killed = false;
  /** When false, writes report backpressure. */
  drainOk = true;
  stdinError: ((err: unknown) => void) | null = null;
  private handlers: Record<string, Handler[]> = {};

  stdin = {
    write: (chunk: Uint8Array) => {
      this.written.push(chunk);
      return this.drainOk;
    },
    end: () => {
      this.ended = true;
    },
    on: (event: string, cb: Handler) => this.on(event, cb),
  };

  private stderrCbs: Array<(chunk: Buffer) => void> = [];
  stderr = { on: (_event: "data", cb: (chunk: Buffer) => void) => void this.stderrCbs.push(cb) };
  /** Simulate ffmpeg writing to stderr (progress lines, errors). */
  say(text: string) {
    for (const cb of this.stderrCbs) cb(Buffer.from(text));
  }

  on(event: string, cb: Handler) {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }

  kill() {
    this.killed = true;
    this.emit("exit", 0, null);
  }

  emit(event: string, ...args: unknown[]) {
    for (const cb of this.handlers[event] ?? []) cb(...args);
  }

  drain() {
    this.drainOk = true;
    this.emit("drain");
  }
}

function makeBridge(overrides: { drainOk?: boolean; events: LiveEvent[]; blockDropMs?: number; now?: () => number } ) {
  let clock = 0;
  const now = overrides.now ?? (() => clock);
  const procs: FakeProcess[] = [];
  const bridge = new LiveBridge({
    harbor: { password: "test-harbor-pw" },
    blockDropMs: overrides.blockDropMs ?? 100,
    statsIntervalMs: 50,
    now,
    onEvent: (e) => overrides.events.push(e),
    spawn: () => {
      const p = new FakeProcess();
      if (overrides.drainOk === false) p.drainOk = false;
      procs.push(p);
      return p as never;
    },
  });
  return { bridge, procs, advance: (ms: number) => (clock += ms) };
}

describe("live bridge", () => {
  test("arm spawns the ffmpeg->harbor command and reports armed", () => {
    const events: LiveEvent[] = [];
    let args: string[] | null = null;
    const bridge = new LiveBridge({
      harbor: { password: "pw" },
      spawn: (_cmd, a) => {
        args = a;
        return new FakeProcess() as never;
      },
      onEvent: (e) => events.push(e),
    });

    const snap = bridge.arm({ sessionId: "s1", expiresAt: new Date(0).toISOString() });
    expect(snap.state).toBe("armed");
    expect(snap.sessionId).toBe("s1");
    expect(events.some((e) => e.type === "live.armed")).toBe(true);

    const a = args as string[] | null;
    expect(a).not.toBeNull();
    expect(a!.join(" ")).toContain("-f webm -i pipe:0");
    expect(a!.join(" ")).toContain("-c:a libmp3lame -b:a 192k");
    expect(a![a!.length - 1]).toBe("icecast://live:pw@127.0.0.1:8008/live");
    bridge.dispose();
  });

  test("a second arm is refused while one is in progress", () => {
    const events: LiveEvent[] = [];
    const { bridge } = makeBridge({ events });
    bridge.arm({ sessionId: "s1", expiresAt: new Date(0).toISOString() });
    expect(() => bridge.arm({ sessionId: "s2", expiresAt: new Date(0).toISOString() })).toThrow(/already in progress/);
    bridge.dispose();
  });

  test("write accounts bytes and returns the encoder's backpressure", () => {
    const events: LiveEvent[] = [];
    const { bridge, procs } = makeBridge({ events });
    bridge.arm({ sessionId: "s1", expiresAt: new Date(0).toISOString() });
    const ok = bridge.write(new Uint8Array(1000));
    expect(ok).toBe(true);
    expect(bridge.snapshot.bytesSent).toBe(1000);
    expect(procs[0].written.length).toBe(1);
    expect(bridge.write(new Uint8Array(500))).toBe(true);
    expect(bridge.snapshot.bytesSent).toBe(1500);
    bridge.dispose();
  });

  test("markOnAir is reported once and only after arm", () => {
    const events: LiveEvent[] = [];
    const { bridge } = makeBridge({ events });
    bridge.markOnAir(); // before arm: ignored
    expect(events.filter((e) => e.type === "live.on_air").length).toBe(0);
    bridge.arm({ sessionId: "s1", expiresAt: new Date(0).toISOString() });
    bridge.markOnAir();
    bridge.markOnAir();
    expect(events.filter((e) => e.type === "live.on_air").length).toBe(1);
    expect(bridge.state).toBe("on_air");
    bridge.dispose();
  });

  test("operator hand-back ends the session cleanly", () => {
    const events: LiveEvent[] = [];
    const { bridge, procs } = makeBridge({ events });
    bridge.arm({ sessionId: "s1", expiresAt: new Date(0).toISOString() });
    bridge.end();
    expect(procs[0].ended).toBe(true);
    procs[0].emit("exit", 0, null); // ffmpeg finishes after stdin closes
    expect(events.some((e) => e.type === "live.ended")).toBe(true);
    expect(bridge.available).toBe(true);
    bridge.dispose();
  });

  test("an unexpected exit is reported as a loss, not a hand-back", () => {
    const events: LiveEvent[] = [];
    const { bridge, procs } = makeBridge({ events });
    bridge.arm({ sessionId: "s1", expiresAt: new Date(0).toISOString() });
    procs[0].emit("exit", 1, null);
    const lost = events.find((e) => e.type === "live.lost");
    expect(lost).toBeDefined();
    expect(bridge.state).toBe("offline");
    bridge.dispose();
  });

  test("a socket close after a hand-back does not reclassify it as a loss", () => {
    const events: LiveEvent[] = [];
    const { bridge, procs } = makeBridge({ events });
    bridge.arm({ sessionId: "s1", expiresAt: new Date(0).toISOString() });
    bridge.end();
    // The server's onLiveClose runs when the socket drops after `live.end`.
    bridge.abort("live socket closed");
    expect(procs[0].killed).toBe(false); // abort must not kill a clean hand-back
    procs[0].emit("exit", 0, null);
    expect(events.some((e) => e.type === "live.ended")).toBe(true);
    expect(events.some((e) => e.type === "live.lost")).toBe(false);
    // "ended" is distinct from "offline" until the next arm.
    expect(bridge.snapshot.state).toBe("ended");
    bridge.dispose();
  });

  test("backpressure beyond the drop window aborts the session", async () => {
    const events: LiveEvent[] = [];
    // Real clock here: the guard interval and the block timer must agree, and a
    // frozen fake clock would never cross the drop window.
    const procs: FakeProcess[] = [];
    const bridge = new LiveBridge({
      harbor: { password: "pw" },
      blockDropMs: 30,
      statsIntervalMs: 50,
      onEvent: (e) => events.push(e),
      spawn: () => {
        const p = new FakeProcess();
        p.drainOk = false;
        procs.push(p);
        return p as never;
      },
    });
    bridge.arm({ sessionId: "s1", expiresAt: new Date(0).toISOString() });
    expect(bridge.write(new Uint8Array(10))).toBe(false);
    await new Promise((r) => setTimeout(r, 600)); // guard ticks every 250ms
    expect(events.some((e) => e.type === "live.lost" && /backpressure/.test(e.reason))).toBe(true);
    bridge.dispose();
  });

  test("encoder output stalling drops the session early, not at the harbor timeout", async () => {
    const events: LiveEvent[] = [];
    const procs: FakeProcess[] = [];
    const bridge = new LiveBridge({
      harbor: { password: "pw" },
      stallDropMs: 100,
      statsIntervalMs: 50,
      onEvent: (e) => events.push(e),
      spawn: () => {
        const p = new FakeProcess();
        procs.push(p);
        return p as never;
      },
    });
    bridge.arm({ sessionId: "s1", expiresAt: new Date(0).toISOString() });
    bridge.write(new Uint8Array(1000));
    procs[0].say("out_time_us=500000\n"); // producing, then ffmpeg's output stops
    await new Promise((r) => setTimeout(r, 500)); // guard ticks every 250ms
    expect(events.some((e) => e.type === "live.lost" && /output stalled/.test(e.reason ?? ""))).toBe(true);
    bridge.dispose();
  });

  test("an encoder that never produces progress is dropped", async () => {
    const events: LiveEvent[] = [];
    const bridge = new LiveBridge({
      harbor: { password: "pw" },
      stallDropMs: 100,
      statsIntervalMs: 50,
      onEvent: (e) => events.push(e),
      spawn: () => new FakeProcess() as never,
    });
    bridge.arm({ sessionId: "s1", expiresAt: new Date(0).toISOString() });
    bridge.write(new Uint8Array(1000)); // first byte; ffmpeg says nothing at all
    await new Promise((r) => setTimeout(r, 500));
    expect(events.some((e) => e.type === "live.lost" && /never started/.test(e.reason ?? ""))).toBe(true);
    bridge.dispose();
  });

  test("steady progress does not drop the session", async () => {
    const events: LiveEvent[] = [];
    const procs: FakeProcess[] = [];
    const bridge = new LiveBridge({
      harbor: { password: "pw" },
      stallDropMs: 100,
      statsIntervalMs: 50,
      onEvent: (e) => events.push(e),
      spawn: () => {
        const p = new FakeProcess();
        procs.push(p);
        return p as never;
      },
    });
    bridge.arm({ sessionId: "s1", expiresAt: new Date(0).toISOString() });
    bridge.write(new Uint8Array(1000));
    for (let i = 0; i < 4; i++) {
      procs[0].say(`out_time_us=${(i + 1) * 500000}\n`);
      await new Promise((r) => setTimeout(r, 90));
    }
    expect(events.some((e) => e.type === "live.lost")).toBe(false);
    expect(bridge.state).not.toBe("offline");
    bridge.dispose();
  });

  test("a drain clears the blocked state", () => {
    const events: LiveEvent[] = [];
    const { bridge, procs, advance } = makeBridge({ events, drainOk: false });
    bridge.arm({ sessionId: "s1", expiresAt: new Date(0).toISOString() });
    bridge.write(new Uint8Array(10));
    advance(5);
    expect(bridge.snapshot.blockedMs).toBe(5);
    procs[0].drain();
    expect(bridge.snapshot.blockedMs).toBe(0);
    bridge.dispose();
  });

  test("drift is measured from ffmpeg's own audio clock, not assumed from bytes", () => {
    const events: LiveEvent[] = [];
    let clock = 0;
    const { bridge, procs } = makeBridge({ events, now: () => clock });
    bridge.arm({ sessionId: "s1", expiresAt: new Date(0).toISOString() });
    expect(bridge.snapshot.driftMeasured).toBe(false);
    clock = 1000; // first byte arrives 1 s after arm
    bridge.write(new Uint8Array(200_000));
    expect(bridge.snapshot.driftMeasured).toBe(false); // bytes alone prove nothing
    clock = 11_000; // 10 s after the first byte
    procs[0].say("bitrate=192.0kbits/s\nout_time_us=9500000\nout_time=00:00:09.500000\nprogress=continue\n");
    expect(bridge.snapshot.driftMeasured).toBe(true);
    expect(bridge.snapshot.driftSec).toBeCloseTo(-0.5, 5);
    // Input stalls: wall clock moves 3 s, ffmpeg's audio clock does not.
    clock = 14_000;
    expect(bridge.snapshot.driftSec).toBeCloseTo(-3.5, 5);
    bridge.dispose();
  });

  test("an error line is caught even when progress lines follow it in the same chunk", () => {
    const events: LiveEvent[] = [];
    const { bridge, procs } = makeBridge({ events });
    bridge.arm({ sessionId: "s1", expiresAt: new Date(0).toISOString() });
    procs[0].say("[icecast] Connection refused for icecast://live:hunter2@127.0.0.1:8008/live\nout_time_us=0\nprogress=continue\n");
    expect(bridge.snapshot.error).toContain("Connection refused");
    expect(bridge.snapshot.error).not.toContain("hunter2");
    bridge.dispose();
  });

  test("the encoder command asks ffmpeg for progress on stderr", () => {
    const args = liveFfmpegArgs({ host: "127.0.0.1", port: 8008, mount: "live", user: "live", password: "pw" }, 192);
    const i = args.indexOf("-progress");
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe("pipe:2");
  });
});

describe("liveFfmpegArgs", () => {
  test("targets the live mount with the live harbor user", () => {
    const args = liveFfmpegArgs(
      { host: "127.0.0.1", port: 8008, mount: "live", user: "live", password: "secret" },
      128,
    );
    expect(args[args.length - 1]).toBe("icecast://live:secret@127.0.0.1:8008/live");
    expect(args.join(" ")).toContain("-b:a 128k");
  });
});

describe("live key store", () => {
  test("a key is issued once and redeemed once", () => {
    let clock = 0;
    const store = new LiveKeyStore({ ttlMs: 1000, now: () => clock, random: () => Buffer.alloc(24, 7) });
    const { key } = store.issue();
    expect(store.armed).toBe(true);
    expect(store.redeem(key)).toBe(true);
    expect(store.redeem(key)).toBe(false); // one use only
    expect(store.armed).toBe(false);
  });

  test("a wrong key is refused", () => {
    const store = new LiveKeyStore({ random: () => Buffer.alloc(24, 1) });
    store.issue();
    expect(store.redeem("not-the-key")).toBe(false);
  });

  test("an expired key is refused", () => {
    let clock = 0;
    const store = new LiveKeyStore({ ttlMs: 1000, now: () => clock, random: () => Buffer.alloc(24, 2) });
    const { key } = store.issue();
    clock += 1001;
    expect(store.redeem(key)).toBe(false);
  });
});
