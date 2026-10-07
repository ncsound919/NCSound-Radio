/**
 * Remote access through a tunnel or proxy (plan 5, remote/club go-live).
 *
 * cloudflared connects to ingest from 127.0.0.1, so peer-address checks alone
 * would treat the whole internet as local. These tests pin the rule: a request
 * carrying proxy headers is remote, needs INGEST_TOKEN, and is refused outright
 * when no token is configured. They also pin the console-proxy path: a bearer
 * on the WebSocket upgrade replaces the token in the frame, so the token never
 * has to reach the browser.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IngestService } from "../src/server";

class FakeProc {
  written = 0;
  private handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  stdin = {
    write: (c: Uint8Array) => ((this.written += c.byteLength), true),
    end: () => {},
    on: (e: string, cb: (...a: unknown[]) => void) => void (this.handlers[e] ??= []).push(cb),
  };
  stderr = { on: () => {} };
  on(e: string, cb: (...a: unknown[]) => void) {
    (this.handlers[e] ??= []).push(cb);
    return this;
  }
  kill() {
    for (const cb of this.handlers.exit ?? []) cb(0, null);
  }
}

function makeService(port: number, token?: string) {
  return new IngestService({
    port,
    host: "127.0.0.1",
    token,
    engine: { publish: false },
    live: { harbor: { password: "pw" }, spawn: () => new FakeProc() as never },
  } as never);
}

const TUNNEL = { "cf-connecting-ip": "203.0.113.9", "cf-ray": "abc" };

function openLive(port: number, headers: Record<string, string> = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/live`, { headers } as never);
  const frames: string[] = [];
  let closed: { code: number; reason: string } | null = null;
  ws.onmessage = (e) => frames.push(String(e.data));
  ws.onclose = (e) => (closed = { code: e.code, reason: e.reason });
  const opened = new Promise<boolean>((res) => {
    ws.onopen = () => res(true);
    ws.onerror = () => res(false);
  });
  const until = async (pred: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!pred() && Date.now() < end) await Bun.sleep(20);
    return pred();
  };
  return { ws, frames, opened, closed: () => closed, until };
}

describe("no token configured", () => {
  const PORT = 8231;
  let svc: IngestService;
  beforeAll(async () => {
    svc = makeService(PORT);
    svc.listen();
    await svc.engine.start();
  });
  afterAll(async () => svc.shutdown());

  test("a local read is open", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/status`);
    expect(r.status).toBe(200);
  });

  test("a tunnelled read is refused and says why", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/requests`, { headers: TUNNEL });
    expect(r.status).toBe(401);
    expect(((await r.json()) as { error: string }).error).toContain("INGEST_TOKEN");
  });

  test("x-forwarded-for alone also marks a request remote", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/status`, { headers: { "x-forwarded-for": "198.51.100.4" } });
    expect(r.status).toBe(401);
  });

  test("a tunnelled arm is refused", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/live/arm`, { method: "POST", headers: TUNNEL });
    expect(r.status).toBe(401);
    expect(svc.live.state).not.toBe("armed");
  });

  test("a tunnelled live socket is refused at the upgrade", async () => {
    const c = openLive(PORT, TUNNEL);
    expect(await c.opened).toBe(false);
  });

  test("health stays answerable through the tunnel (for the tunnel's own check)", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { headers: TUNNEL });
    expect(r.status).not.toBe(401);
  });
});

describe("token configured", () => {
  const PORT = 8233;
  const TOKEN = "t0ken-for-tests-0123456789";
  let svc: IngestService;
  beforeAll(async () => {
    svc = makeService(PORT, TOKEN);
    svc.listen();
    await svc.engine.start();
  });
  afterAll(async () => svc.shutdown());

  test("a tunnelled read without the bearer is refused", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/status`, { headers: TUNNEL });
    expect(r.status).toBe(401);
  });

  test("a tunnelled read with the bearer is served", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/status`, { headers: { ...TUNNEL, authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(200);
  });

  test("crate audio is never served through the tunnel, even with the token", async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/crate/audio/x.wav`, { headers: { ...TUNNEL, authorization: `Bearer ${TOKEN}` } });
    expect(r.status).toBe(403);
  });

  test("console-proxy path: bearer on the upgrade, only the live key in the frame, goes live", async () => {
    const auth = { ...TUNNEL, authorization: `Bearer ${TOKEN}` };
    const arm = await fetch(`http://127.0.0.1:${PORT}/live/arm`, { method: "POST", headers: auth });
    expect(arm.status).toBe(200);
    const { key } = (await arm.json()) as { key: string };
    const c = openLive(PORT, auth);
    expect(await c.opened).toBe(true);
    c.ws.send(JSON.stringify({ key })); // no token in the frame
    expect(await c.until(() => c.frames.some((f) => f.includes("live.armed")))).toBe(true);
    c.ws.send(JSON.stringify({ type: "live.end" }));
    c.ws.close();
    await c.until(() => svc.live.available);
  });

  test("no bearer and no token in the frame is closed 4401", async () => {
    const arm = await fetch(`http://127.0.0.1:${PORT}/live/arm`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}` } });
    const { key } = (await arm.json()) as { key: string };
    const c = openLive(PORT);
    expect(await c.opened).toBe(true);
    c.ws.send(JSON.stringify({ key }));
    expect(await c.until(() => c.closed() !== null)).toBe(true);
    expect(c.closed()!.code).toBe(4401);
  });
});
