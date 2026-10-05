/**
 * The WebSocket control plane, exercised over a real socket.
 *
 * This is the only test that checks the wire format end to end. `controlLink`
 * is unit-tested against a fake socket in dj-console, which proves its own
 * bookkeeping but says nothing about whether the frames it writes are the ones
 * the server accepts — and until P2 nothing in the repository opened a socket
 * at all, so that mismatch had nothing to catch it.
 *
 * The frames written below are copied from `apps/dj-console/src/engine/
 * controlLink.ts`. If that file changes shape, this test is the thing that
 * should fail.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { IngestService } from "../src/server";

const PORT = 8199;

/** Exactly what ControlLink builds for a frame. */
function consoleFrame(id: string, command: unknown, token?: string) {
  return JSON.stringify({
    id,
    actor: { id: "console", role: "console", label: "dj console" },
    token,
    command,
  });
}

type Frame = Record<string, unknown>;

/**
 * Collect frames, and let a caller wait for a *specific* one.
 *
 * Every command result arrives twice — once as a direct reply, once in the
 * broadcast to all sockets. A helper that just returns "the next
 * command.result" will happily hand back the duplicate of the PREVIOUS command,
 * and a test written against it passes for the wrong reason. That is not
 * hypothetical: it is how the replay test below first read a stale frame and
 * reported success while the replay cache was deleted from the source.
 */
function open(url: string): Promise<{
  socket: WebSocket;
  send: (payload: string) => void;
  close: () => void;
  next: (type: string, withinMs?: number) => Promise<Frame>;
  /** Wait for a `command.result` carrying this envelope id. */
  nextResult: (id: string, withinMs?: number) => Promise<Frame>;
  /** Wait until no frame has arrived for `quietMs`, discarding what was buffered. */
  settle: (quietMs?: number) => Promise<void>;
}> {
  return new Promise((resolveReady, rejectReady) => {
    const socket = new WebSocket(url);
    const seen: Frame[] = [];
    const waiters: { match: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
    let arrivals = 0;

    const deliver = (frame: Frame) => {
      arrivals += 1;
      const index = waiters.findIndex((w) => w.match(frame));
      if (index >= 0) waiters.splice(index, 1)[0].resolve(frame);
      else seen.push(frame);
    };

    socket.onmessage = (ev) => {
      try {
        deliver(JSON.parse(String(ev.data)) as Frame);
      } catch {
        /* a frame we cannot parse is a frame we cannot assert on */
      }
    };
    socket.onerror = () => rejectReady(new Error("socket error"));

    const await1 = (match: (f: Frame) => boolean, withinMs: number, label: string) => {
      const index = seen.findIndex(match);
      if (index >= 0) return Promise.resolve(seen.splice(index, 1)[0]);
      return new Promise<Frame>((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`timed out waiting for ${label}`)), withinMs);
        waiters.push({
          match,
          resolve: (f) => {
            clearTimeout(timer);
            res(f);
          },
        });
      });
    };

    socket.onopen = () => {
      resolveReady({
        socket,
        send: (payload) => socket.send(payload),
        close: () => socket.close(),
        next: (type, withinMs = 5000) =>
          await1((f) => f.type === type, withinMs, `a "${type}" frame`),
        nextResult: (id, withinMs = 5000) =>
          await1(
            (f) =>
              f.type === "command.result" &&
              (f.result as { id?: string } | undefined)?.id === id,
            withinMs,
            `a command.result with id "${id}"`,
          ),
        settle: (quietMs = 150) =>
          new Promise((res) => {
            // Wait until nothing new has arrived for `quietMs`, then DISCARD
            // whatever was buffered. Without the discard, the leftover
            // broadcast copy of the previous command sits in the queue and
            // satisfies the next wait — byte-identical, same envelope id, and
            // carrying the previous result.
            let seenAt = arrivals;
            const tick = () => {
              if (arrivals !== seenAt) {
                seenAt = arrivals;
                setTimeout(tick, quietMs);
                return;
              }
              seen.length = 0;
              res();
            };
            setTimeout(tick, quietMs);
          }),
      });
    };
  });
}

describe("websocket control plane", () => {
  let service: IngestService;

  beforeAll(async () => {
    service = new IngestService({
      port: PORT,
      host: "127.0.0.1",
      // No token: `listen()` refuses to bind a non-loopback host without one,
      // and this binds loopback deliberately.
      engine: { publish: false },
    });
    service.listen();
    await service.engine.start();
  });

  afterAll(async () => {
    await service.shutdown();
  });

  test("greets a new socket with ready, then runs the command that was sent", async () => {
    const c = await open(`ws://127.0.0.1:${PORT}/ws`);

    const ready = (await c.next("connection.ready")) as { actor: { role: string } };
    expect(ready.actor.role).toBe("console");

    c.send(consoleFrame("env-1", { type: "mix.setCrossfader", position: 0.25 }));
    const result = (await c.nextResult("env-1")) as {
      result: { id: string; ok: boolean; result?: { applied: number } };
    };
    // The envelope id the client minted must come back untouched: it is what
    // the replay cache is keyed on, so a lost id would make every retry a
    // fresh command.
    expect(result.result.id).toBe("env-1");
    expect(result.result.ok).toBe(true);
    if (result.result.ok) expect(result.result.result?.applied).toBeCloseTo(0.25, 5);

    c.close();
  });

  test("the sender receives its own result twice — once directly, once by broadcast", async () => {
    const c = await open(`ws://127.0.0.1:${PORT}/ws`);
    await c.next("connection.ready");
    c.send(consoleFrame("env-dup", { type: "mix.setCrossfaderCurve", curve: "dip" }));

    const first = (await c.nextResult("env-dup")) as { result: { id: string; ok: boolean } };
    const second = (await c.nextResult("env-dup")) as { result: { id: string; ok: boolean } };
    // Two frames, same id. This is why the client keeps an "already answered"
    // set rather than resolving its pending promise once per frame.
    expect(first.result.id).toBe("env-dup");
    expect(second.result.id).toBe("env-dup");
    expect(first.result.ok).toBe(true);
    c.close();
  });

  test("replaying an envelope id returns the stored result without re-running it", async () => {
    const c = await open(`ws://127.0.0.1:${PORT}/ws`);
    await c.next("connection.ready");

    c.send(consoleFrame("env-replay", { type: "mix.setCrossfader", position: -0.5 }));
    const first = (await c.nextResult("env-replay")) as {
      result: { ok: boolean; appliedAt: string; result?: { applied: number } };
    };
    // Wait out the broadcast copy of that same result. Matching on the envelope
    // id is not enough on its own: both copies are byte-identical, so a later
    // wait would happily be satisfied by the stale duplicate and the assertion
    // below would pass with the replay cache deleted outright.
    await c.settle();

    // Same id, different intent: a replay must win over the new payload, or a
    // retried frame could move the fader somewhere the operator never asked for.
    c.send(consoleFrame("env-replay", { type: "mix.setCrossfader", position: 1 }));
    const replayed = (await c.nextResult("env-replay")) as {
      result: { ok: boolean; appliedAt: string; result?: { applied: number } };
    };

    expect(replayed.result.ok).toBe(true);
    expect(replayed.result.appliedAt).toBe(first.result.appliedAt);
    // The decisive check: the replay echoes the ORIGINAL applied position. If
    // the server had re-run the command, this would read 1.
    expect(replayed.result.result?.applied).toBeCloseTo(-0.5, 5);
    c.close();
  });

  test("a command that fails validation is refused, not applied", async () => {
    const c = await open(`ws://127.0.0.1:${PORT}/ws`);
    await c.next("connection.ready");
    c.send(consoleFrame("env-bad", { type: "mix.setCrossfader", position: 9 }));
    const out = (await c.nextResult("env-bad")) as {
      result: { id: string; ok: boolean; code?: string };
    };
    expect(out.result.ok).toBe(false);
    expect(out.result.code).toBe("INVALID_PARAMS");
    c.close();
  });

  test("a frame with no command is rejected rather than treated as the console", async () => {
    const c = await open(`ws://127.0.0.1:${PORT}/ws`);
    await c.next("connection.ready");
    c.send(JSON.stringify({ id: "env-empty" }));
    const out = (await c.next("command.result")) as {
      result: { ok: boolean; code?: string; error?: string };
    };
    expect(out.result.ok).toBe(false);
    expect(out.result.code).toBe("INVALID_PARAMS");
    c.close();
  });

  test("a frame claiming a restricted role is still dispatched as the console", async () => {
    const c = await open(`ws://127.0.0.1:${PORT}/ws`);
    await c.next("connection.ready");
    // `automation` is refused every mutation by `defaultAuthorisation`. If the
    // server trusted the role on the wire, `mix.panic` would come back
    // UNAUTHORIZED; it comes back applied, which is the proof that the role on
    // a socket is forced to "console" and the frame's claim is discarded.
    c.send(
      JSON.stringify({
        id: "env-esc",
        actor: { id: "attacker", role: "automation", label: "spoofed" },
        command: { type: "mix.panic" },
      }),
    );
    const out = (await c.nextResult("env-esc")) as { result: { id: string; ok: boolean } };
    expect(out.result.id).toBe("env-esc");
    expect(out.result.ok).toBe(true);
    c.close();
  });

  test("imaging.play reports a missing imaging library instead of pretending", async () => {
    const c = await open(`ws://127.0.0.1:${PORT}/ws`);
    await c.next("connection.ready");
    c.send(consoleFrame("env-imaging", { type: "imaging.play", jingleId: "sw-top-hour" }));
    const out = (await c.nextResult("env-imaging")) as {
      result: { ok: boolean; code?: string; error?: string };
    };
    // No playImaging is attached in this fixture, so the dispatcher must say
    // so. A silent success here would be a jingle that never played.
    expect(out.result.ok).toBe(false);
    expect(out.result.error).toContain("imaging");
    c.close();
  });
});

describe("http command plane", () => {
  let service: IngestService;
  const PORT_HTTP = 8198;

  beforeAll(async () => {
    service = new IngestService({ port: PORT_HTTP, host: "127.0.0.1", engine: { publish: false } });
    service.listen();
    await service.engine.start();
  });

  afterAll(async () => {
    await service.shutdown();
  });

  test("accepts a console envelope and echoes the client envelope id", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT_HTTP}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "http-env-1",
        actor: { id: "console", role: "console", label: "dj console" },
        command: { type: "query.status" },
      }),
    });
    const body = (await res.json()) as { id: string; ok: boolean };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.id).toBe("http-env-1");
  });

  test("refuses a mutation from an actor the role policy does not allow", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT_HTTP}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        actor: { id: "bot", role: "automation", label: "bot" },
        command: { type: "mix.panic" },
      }),
    });
    const body = (await res.json()) as { ok: boolean; code?: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("UNAUTHORIZED");
  });

  test("a POST with no actor is a 400, not an ops-privileged request", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT_HTTP}/command`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: { type: "mix.panic" } }),
    });
    expect(res.status).toBe(400);
  });
});

describe("read endpoints", () => {
  let service: IngestService;
  const PORT = 8196;

  beforeAll(async () => {
    service = new IngestService({ port: PORT, host: "127.0.0.1", engine: { publish: false } });
    service.listen();
    await service.engine.start();
  });

  afterAll(async () => {
    await service.shutdown();
  });

  test("/health separates 'up' from 'ready'", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/health`);
    const body = (await res.json()) as {
      ok: boolean;
      ready: boolean;
      engineState: string;
      crateSize: number;
    };
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.ready).toBe("boolean");
    expect(body.engineState.length).toBeGreaterThan(0);
  });

  /**
   * `/requests` is what the DJ console's request panel reads.
   *
   * The distinction that matters: "no requests" and "requests unavailable" are
   * different states for a DJ waiting on a listener, so the endpoint must
   * always carry a `reason` when it has nothing to show.
   */
  test("/requests reports a reason when the station database is not configured", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/requests`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { requests: unknown[]; reason: string | null };
    // No NCSOUND_STATION_DB in the test environment.
    expect(Array.isArray(body.requests)).toBe(true);
    expect(body.reason).toContain("NCSOUND_STATION_DB");
  });

  test("/status carries the station on-air state or says why it cannot", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      engine: { state: string };
      station: { onAir: boolean | null; error: string | null };
    };
    expect(body.engine.state.length).toBeGreaterThan(0);
    // This service has no LiquidsoapControl attached.
    expect(body.station.onAir).toBeNull();
    expect(body.station.error).toBeTruthy();
  });

  /**
   * The on-air verdict, and the reason it exists.
   *
   * Two surfaces used to compute this themselves from different subsets of the
   * same inputs and disagreed: the listener-facing site required an Icecast
   * mount and an armed track, the console required the Liquidsoap switch. Going
   * off air satisfies the first and fails the second, so the site announced
   * "live" while the station transmitted silence.
   */
  test("/status exposes one broadcast verdict with its components and a reason", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/status`);
    const body = (await res.json()) as {
      broadcast: {
        onAir: boolean;
        reason: string;
        components: { enginePlaying: boolean; outputLive: boolean; mountConnected: boolean };
      };
    };
    expect(typeof body.broadcast.onAir).toBe("boolean");
    expect(typeof body.broadcast.reason).toBe("string");
    // No LiquidsoapControl in this fixture, so it must refuse to vouch rather
    // than assume "fine" — an unconfigured switch is not a live one.
    expect(body.broadcast.onAir).toBe(false);
    expect(body.broadcast.reason).toContain("Liquidsoap");
    expect(body.broadcast.components.outputLive).toBe(false);
  });

  test("/health reports the same verdict as /status", async () => {
    // These used to be computed from different expressions in the same file,
    // which is how a health check and a status poll could contradict.
    const [health, status] = (await Promise.all([
      fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.json()),
      fetch(`http://127.0.0.1:${PORT}/status`).then((r) => r.json()),
    ])) as [{ onAir: boolean; broadcastReason: string }, { broadcast: { onAir: boolean; reason: string } }];
    expect(health.onAir).toBe(status.broadcast.onAir);
    expect(health.broadcastReason).toBe(status.broadcast.reason);
  });

  test("an unknown path is a 404, not a crash", async () => {
    const res = await fetch(`http://127.0.0.1:${PORT}/nope`);
    expect(res.status).toBe(404);
  });
});

describe("listen guard", () => {
  test("refuses to bind a non-loopback host with no token", () => {
    const svc = new IngestService({ port: 8197, host: "0.0.0.0", engine: { publish: false } });
    expect(() => svc.listen()).toThrow(/INGEST_TOKEN/);
  });
});
