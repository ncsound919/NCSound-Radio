/**
 * The `/live` audio socket, over a real socket.
 *
 * `live.test.ts` proves the bridge state machine against a fake process. This
 * proves the *route*: the one-time key is required and single-use, a second
 * session is refused, and binary frames actually reach the encoder's stdin.
 * The ffmpeg process is faked, so nothing external is needed.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IngestService } from "../src/server";

const PORT = 8201;
const BASE = `http://127.0.0.1:${PORT}`;

type Frame = Record<string, unknown>;

class FakeProc {
  written: Uint8Array[] = [];
  private handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  stdin = {
    write: (chunk: Uint8Array) => {
      this.written.push(chunk);
      return true;
    },
    end: () => {},
    on: (event: string, cb: (...a: unknown[]) => void) => {
      (this.handlers[event] ??= []).push(cb);
    },
  };
  stderr = { on: (_e: "data", _cb: (chunk: Buffer) => void) => {} };
  on(event: string, cb: (...a: unknown[]) => void) {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }
  kill() {
    for (const cb of this.handlers.exit ?? []) cb(0, null);
  }
}

/** Connect to /live and collect frames, with a wait-for-frame helper. */
function connectLive() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/live`);
  const frames: Frame[] = [];
  const waiters: { match: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  let closedInfo: { code: number; reason: string } | null = null;

  ws.onmessage = (ev) => {
    let frame: Frame | null = null;
    try {
      frame = JSON.parse(String(ev.data)) as Frame;
    } catch {
      return;
    }
    const i = waiters.findIndex((w) => w.match(frame!));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(frame);
    else frames.push(frame);
  };
  ws.onclose = (ev) => {
    closedInfo = { code: ev.code, reason: ev.reason };
  };

  const ready = new Promise<void>((res, rej) => {
    ws.onopen = () => res();
    ws.onerror = () => rej(new Error("live socket error"));
  });

  return {
    ws,
    ready,
    send: (data: string | Uint8Array) => ws.send(data),
    closed: async (withinMs = 4000) => {
      if (closedInfo) return closedInfo;
      return new Promise<{ code: number; reason: string }>((res, rej) => {
        const t = setTimeout(() => rej(new Error("socket did not close")), withinMs);
        const check = setInterval(() => {
          if (closedInfo) {
            clearTimeout(t);
            clearInterval(check);
            res(closedInfo);
          }
        }, 20);
      });
    },
    next: (type: string, withinMs = 4000) => {
      const match = (f: Frame) => f.type === type;
      const i = frames.findIndex(match);
      if (i >= 0) return Promise.resolve(frames.splice(i, 1)[0]);
      return new Promise<Frame>((res, rej) => {
        const t = setTimeout(() => rej(new Error(`timed out waiting for ${type}`)), withinMs);
        waiters.push({ match, resolve: (f) => { clearTimeout(t); res(f); } });
      });
    },
  };
}

describe("live audio socket", () => {
  let service: IngestService;
  const procs: FakeProc[] = [];

  beforeAll(async () => {
    service = new IngestService({
      port: PORT,
      host: "127.0.0.1",
      engine: { publish: false },
      live: {
        harbor: { password: "test-live-pw" },
        spawn: () => {
          const p = new FakeProc();
          procs.push(p);
          return p as never;
        },
      },
    });
    service.listen();
    await service.engine.start();
  });

  afterAll(async () => {
    await service.shutdown();
  });

  /** Wait until the bridge has no session, so tests never stack on a socket close. */
  async function idle(withinMs = 3000): Promise<void> {
    const deadline = Date.now() + withinMs;
    while (!service.live.available && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(service.live.available).toBe(true);
  }

  async function arm(): Promise<string> {
    const res = await fetch(`${BASE}/live/arm`, { method: "POST" });
    const body = (await res.json()) as { ok: boolean; key: string };
    expect(body.ok).toBe(true);
    return body.key;
  }

  test("a valid key arms the encoder and audio bytes reach stdin", async () => {
    const key = await arm();
    const c = connectLive();
    await c.ready;
    c.send(JSON.stringify({ key }));
    const armed = await c.next("live.armed");
    expect(armed.sessionId).toBeTruthy();

    const before = service.live.snapshot.bytesSent;
    c.send(new Uint8Array(4096));
    await new Promise((r) => setTimeout(r, 100));
    expect(service.live.snapshot.bytesSent).toBe(before + 4096);
    expect(procs.at(-1)?.written.length).toBeGreaterThan(0);

    c.ws.close();
    await idle();
  });

  test("a wrong key is refused and the socket is closed", async () => {
    // No key issued: the socket must be refused on the mismatch alone, and the
    // test must not leave a pending key that blocks the next arm.
    const c = connectLive();
    await c.ready;
    c.send(JSON.stringify({ key: "definitely-not-the-key" }));
    const closed = await c.closed();
    expect(closed.code).toBe(4403);
  });

  test("a key is single-use: a replay is refused", async () => {
    const key = await arm();
    const first = connectLive();
    await first.ready;
    first.send(JSON.stringify({ key }));
    await first.next("live.armed");
    first.ws.close();
    await first.closed();

    const second = connectLive();
    await second.ready;
    second.send(JSON.stringify({ key }));
    const closed = await second.closed();
    expect(closed.code).toBe(4403);
    await idle();
  });

  test("a second arm is refused while a session is live", async () => {
    const key = await arm();
    const c = connectLive();
    await c.ready;
    c.send(JSON.stringify({ key }));
    await c.next("live.armed");

    const res = await fetch(`${BASE}/live/arm`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/already in progress/);

    c.ws.close();
    await idle();
  });

  test("a second arm is refused while a key is issued but unused", async () => {
    const key = await arm();
    // The bridge is not armed until the socket connects, so the guard must be
    // on the issued key, not on the bridge state.
    const res = await fetch(`${BASE}/live/arm`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toMatch(/already issued/);

    // Redeem the key so later tests are not blocked by the pending key.
    const c = connectLive();
    await c.ready;
    c.send(JSON.stringify({ key }));
    await c.next("live.armed");
    c.ws.close();
    await idle();
  });

  test("duplicate arm is rejected when an unredeemed key exists", async () => {
    // Arm once, get a key, but don't connect the socket yet
    const key = await arm();
    // Try to arm again while the key is still unredeemed
    const res = await fetch(`${BASE}/live/arm`, { method: "POST" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.error).toMatch(/already issued/);
  });

  test("/status reports the live state", async () => {
    const res = await fetch(`${BASE}/status`);
    const doc = (await res.json()) as { live?: { state: string } };
    expect(doc.live).toBeDefined();
    expect(typeof doc.live!.state).toBe("string");
  });
});

describe("live on-air is decided by Liquidsoap, not the button", () => {
  const PORT2 = 8203;
  const BASE2 = `http://127.0.0.1:${PORT2}`;
  let service: IngestService;

  beforeAll(async () => {
    service = new IngestService({
      port: PORT2,
      host: "127.0.0.1",
      engine: { publish: false },
      live: { harbor: { password: "pw" }, spawn: () => new FakeProc() as never },
      // A station whose live harbor is connected. The poll must reach this via
      // `liveHarborConnected` — the production LiquidsoapControl method name.
      station: {
        setOnAir: async () => {},
        onAir: async () => ({ onAir: true, error: null }),
        liveHarborConnected: async () => ({ onAir: true, error: null }),
      } as never,
    });
    service.listen();
    await service.engine.start();
  });

  afterAll(async () => {
    await service.shutdown();
  });

  test("the harbor poll flips an armed session to on_air", async () => {
    const res = await fetch(`${BASE2}/live/arm`, { method: "POST" });
    const { key } = (await res.json()) as { key: string };
    const c = new WebSocket(`ws://127.0.0.1:${PORT2}/live`);
    await new Promise<void>((r) => {
      c.onopen = () => r();
    });
    c.send(JSON.stringify({ key }));
    await new Promise((r) => setTimeout(r, 100));
    expect(service.live.state).toBe("armed");

    // The poll reads liveHarborConnected() once immediately on start.
    service.startStreamPolling();
    const deadline = Date.now() + 3000;
    while (service.live.state !== "on_air" && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(service.live.state).toBe("on_air");
    const doc = (await (await fetch(`${BASE2}/status`)).json()) as { live: { state: string } };
    expect(doc.live.state).toBe("on_air");

    c.close();
  });
});

describe("POST /live/kill (break-glass)", () => {
  const PORT3 = 8204;
  const BASE3 = `http://127.0.0.1:${PORT3}`;
  let service: IngestService;
  let proc: FakeProc | null = null;

  beforeAll(async () => {
    service = new IngestService({
      port: PORT3,
      host: "127.0.0.1",
      engine: { publish: false },
      live: {
        harbor: { password: "pw" },
        spawn: () => {
          proc = new FakeProc();
          return proc as never;
        },
      },
    });
    service.listen();
    await service.engine.start();
  });

  afterAll(async () => {
    await service.shutdown();
  });

  async function armSocket() {
    const res = await fetch(`${BASE3}/live/arm`, { method: "POST" });
    expect(res.status).toBe(200);
    const { key } = (await res.json()) as { key: string };
    const ws = new WebSocket(`ws://127.0.0.1:${PORT3}/live`);
    let closed: { code: number; reason: string } | null = null;
    const armed = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no live.armed")), 4000);
      ws.onopen = () => ws.send(JSON.stringify({ key }));
      ws.onmessage = (ev) => {
        if (String(ev.data).includes("live.armed")) {
          clearTimeout(t);
          resolve();
        }
      };
    });
    ws.onclose = (ev) => {
      closed = { code: ev.code, reason: ev.reason };
    };
    await armed;
    return { ws, closed: () => closed };
  }

  async function waitFor(cond: () => boolean, ms = 3000) {
    const end = Date.now() + ms;
    while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
    expect(cond()).toBe(true);
  }

  test("kills a live session, closes the audio socket 4410, and locks re-arming", async () => {
    const s = await armSocket();
    expect(service.live.state).toBe("armed");

    const res = await fetch(`${BASE3}/live/kill`, { method: "POST", body: JSON.stringify({ lockSec: 60 }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; killed: boolean; lockedUntil: string | null; live: { state: string } };
    expect(body.killed).toBe(true);
    expect(body.live.state).toBe("offline");
    expect(body.lockedUntil).toBeTruthy();

    await waitFor(() => s.closed() !== null);
    expect(s.closed()?.code).toBe(4410);
    // Reported as the operator's kill, not re-reported as a socket loss.
    expect(service.live.snapshot.error).toMatch(/killed by operator/);

    // The console's auto-rejoin must not retake the air.
    const rearm = await fetch(`${BASE3}/live/arm`, { method: "POST" });
    expect(rearm.status).toBe(423);

    const unlock = await fetch(`${BASE3}/live/unlock`, { method: "POST" });
    expect(unlock.status).toBe(200);
    const again = await fetch(`${BASE3}/live/arm`, { method: "POST" });
    expect(again.status).toBe(200);
    await fetch(`${BASE3}/live/kill`, { method: "POST", body: JSON.stringify({ lockSec: 0 }) });
  });

  test("is idempotent when nothing is live, and revokes an unused key", async () => {
    await fetch(`${BASE3}/live/unlock`, { method: "POST" });
    const none = await fetch(`${BASE3}/live/kill`, { method: "POST", body: JSON.stringify({ lockSec: 0 }) });
    expect(none.status).toBe(200);
    expect(((await none.json()) as { killed: boolean }).killed).toBe(false);

    const armRes = await fetch(`${BASE3}/live/arm`, { method: "POST" });
    const { key } = (await armRes.json()) as { key: string };
    const k = await fetch(`${BASE3}/live/kill`, { method: "POST", body: JSON.stringify({ lockSec: 0 }) });
    expect(((await k.json()) as { keyRevoked: boolean }).keyRevoked).toBe(true);

    const ws = new WebSocket(`ws://127.0.0.1:${PORT3}/live`);
    const code = await new Promise<number>((res) => {
      ws.onopen = () => ws.send(JSON.stringify({ key }));
      ws.onclose = (ev) => res(ev.code);
    });
    expect(code).toBe(4403);
  });

  test("works without a body, and beats an in-progress hand-back", async () => {
    await fetch(`${BASE3}/live/unlock`, { method: "POST" });
    const s = await armSocket();
    s.ws.send(JSON.stringify({ type: "live.end" })); // hand-back begins; FakeProc never exits on its own
    await new Promise((r) => setTimeout(r, 50));
    const res = await fetch(`${BASE3}/live/kill`, { method: "POST" }); // no body, default lock
    expect(((await res.json()) as { killed: boolean }).killed).toBe(true);
    expect(service.live.state).toBe("offline");
    await fetch(`${BASE3}/live/unlock`, { method: "POST" });
  });
});
