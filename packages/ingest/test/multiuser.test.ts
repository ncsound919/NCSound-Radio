/**
 * Multi-user control: the owner mints host/guest sessions, and the server (not
 * the client) decides what each may do.
 *
 * Unit tests cover the store and the permission table; the service tests run
 * over real sockets with a faked encoder process.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { IngestService } from "../src/server";
import { rolePermits } from "../src/permissions";
import { SessionStore } from "../src/sessions";

describe("SessionStore", () => {
  test("issues a token that verifies, and never stores it in the clear", () => {
    const s = new SessionStore();
    const { session, token } = s.issue({ role: "guest", label: "DJ Marcus", ttlMs: 3_600_000 });
    expect(token.startsWith("ncs_")).toBe(true);
    expect(s.verify(token)?.id).toBe(session.id);
    expect(JSON.stringify(s.list())).not.toContain(token);
  });

  test("expires, revokes, and rejects unknown tokens", () => {
    let t = 1_000_000;
    const s = new SessionStore({ now: () => t });
    const a = s.issue({ role: "guest", label: "a", ttlMs: 120_000 });
    const b = s.issue({ role: "host", label: "b", ttlMs: 3_600_000 });
    t += 121_000;
    expect(s.verify(a.token)).toBeNull(); // expired
    expect(s.verify(b.token)).not.toBeNull();
    expect(s.revoke(b.session.id)).toBe(true);
    expect(s.verify(b.token)).toBeNull(); // revoked
    expect(s.revoke(b.session.id)).toBe(false);
    expect(s.verify("ncs_" + "0".repeat(48))).toBeNull();
    expect(s.verify("not-a-session-token")).toBeNull();
  });

  test("ttl is capped at 24 h", () => {
    const s = new SessionStore();
    const { session } = s.issue({ role: "guest", label: "x", ttlMs: 10 * 24 * 3_600_000 });
    expect(Date.parse(session.expiresAt) - Date.parse(session.createdAt)).toBeLessThanOrEqual(24 * 3_600_000);
  });
});

describe("role permissions (deny by default)", () => {
  test("owner roles keep everything", () => {
    for (const r of ["ops", "console"] as const) {
      expect(rolePermits(r, "transport.stop")).toBe(true);
      expect(rolePermits(r, "library.load")).toBe(true);
    }
  });

  test("a guest cannot touch transport, mixing, autopilot or the library", () => {
    for (const c of ["transport.stop", "transport.offAir", "mix.panic", "mix.setMasterGain", "autopilot.set", "library.load", "library.analyze", "mix.skip"]) {
      expect(rolePermits("guest", c)).toBe(false);
    }
    expect(rolePermits("guest", "imaging.play")).toBe(true);
    expect(rolePermits("guest", "query.status")).toBe(true);
  });

  test("a host can steer the rotation but cannot stop the station", () => {
    expect(rolePermits("host", "mix.skip")).toBe(true);
    expect(rolePermits("host", "cue.request")).toBe(true);
    for (const c of ["transport.stop", "transport.offAir", "autopilot.set", "library.load", "mix.panic"]) {
      expect(rolePermits("host", c)).toBe(false);
    }
  });

  test("automation and system are read-only here", () => {
    expect(rolePermits("automation", "transport.stop")).toBe(false);
    expect(rolePermits("system", "query.status")).toBe(true);
  });
});

const PORT = 8205;
const BASE = `http://127.0.0.1:${PORT}`;
const MASTER = "master-secret-for-tests";

class FakeProc {
  private handlers: Record<string, ((...a: unknown[]) => void)[]> = {};
  stdin = { write: () => true, end: () => {}, on: (_e: string, _cb: (...a: unknown[]) => void) => {} };
  stderr = { on: (_e: "data", _cb: (chunk: Buffer) => void) => {} };
  on(event: string, cb: (...a: unknown[]) => void) {
    (this.handlers[event] ??= []).push(cb);
    return this;
  }
  kill() {
    for (const cb of this.handlers.exit ?? []) cb(0, null);
  }
}

describe("multi-user over the service", () => {
  let service: IngestService;

  beforeAll(async () => {
    service = new IngestService({
      port: PORT,
      host: "127.0.0.1",
      token: MASTER,
      engine: { publish: false },
      live: { harbor: { password: "pw" }, spawn: () => new FakeProc() as never },
    });
    service.listen();
    await service.engine.start();
  });

  afterAll(async () => {
    await service.shutdown();
  });

  const post = (path: string, token: string | null, body?: unknown) =>
    fetch(`${BASE}${path}`, {
      method: "POST",
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const get = (path: string, token: string | null) =>
    fetch(`${BASE}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });

  async function mint(role: "host" | "guest", label: string, extra: Record<string, unknown> = {}) {
    const res = await post("/sessions", MASTER, { role, label, ...extra });
    expect(res.status).toBe(200);
    return (await res.json()) as { session: { id: string }; token: string };
  }

  const cmd = (type: string, actor: unknown = { id: "x", role: "ops", label: "spoof" }) => ({
    id: crypto.randomUUID(),
    issuedAt: new Date().toISOString(),
    actor,
    command: { type },
  });

  test("only the owner can mint, list or revoke sessions", async () => {
    const g = await mint("guest", "DJ Marcus");
    expect((await post("/sessions", null, { role: "guest", label: "x" })).status).toBe(401);
    expect((await post("/sessions", g.token, { role: "host", label: "x" })).status).toBe(403);
    expect((await get("/sessions", g.token)).status).toBe(403);
    expect((await post("/sessions/revoke", g.token, { id: g.session.id })).status).toBe(403);
    const list = (await (await get("/sessions", MASTER)).json()) as { sessions: { id: string; token?: string }[] };
    expect(list.sessions.some((s) => s.id === g.session.id)).toBe(true);
    expect(JSON.stringify(list)).not.toContain(g.token);
  });

  test("validates the mint request", async () => {
    expect((await post("/sessions", MASTER, { role: "ops", label: "x" })).status).toBe(400);
    expect((await post("/sessions", MASTER, { role: "guest", label: "" })).status).toBe(400);
    expect((await post("/sessions", MASTER, { role: "guest", label: "x", ttlMin: 99999 })).status).toBe(400);
  });

  test("a guest cannot claim a higher role in the request body", async () => {
    const g = await mint("guest", "DJ Spoof");
    const res = await post("/", g.token, cmd("transport.stop", { id: "console", role: "ops", label: "dj console" }));
    const body = (await res.json()) as { ok: boolean; code?: string; error?: string };
    expect(body.ok).toBe(false);
    expect(body.code).toBe("UNAUTHORIZED");
    expect(body.error).toMatch(/^guest may not issue/);
  });

  test("a guest is limited to status reads and cannot use break-glass", async () => {
    const g = await mint("guest", "DJ Reads");
    expect((await get("/status", g.token)).status).toBe(200);
    expect((await get("/requests", g.token)).status).toBe(403);
    expect((await get("/crate", g.token)).status).toBe(403);
    expect((await post("/live/kill", g.token)).status).toBe(403);
    expect((await post("/live/unlock", g.token)).status).toBe(403);
  });

  test("a revoked or unknown token is refused", async () => {
    const g = await mint("guest", "DJ Gone");
    expect((await get("/status", g.token)).status).toBe(200);
    expect((await post("/sessions/revoke", MASTER, { id: g.session.id })).status).toBe(200);
    expect((await post("/live/arm", g.token)).status).toBe(401);
    expect((await post("/live/arm", "ncs_" + "1".repeat(48))).status).toBe(401);
  });

  test("a session without canLive cannot arm", async () => {
    const g = await mint("guest", "DJ Talk", { canLive: false });
    expect((await post("/live/arm", g.token)).status).toBe(403);
  });

  test("a live key belongs to the user who armed it", async () => {
    const a = await mint("guest", "DJ A");
    const b = await mint("guest", "DJ B");
    const armed = (await (await post("/live/arm", a.token)).json()) as { key: string };

    const wsB = new WebSocket(`ws://127.0.0.1:${PORT}/live`);
    const codeB = await new Promise<number>((res) => {
      wsB.onopen = () => wsB.send(JSON.stringify({ token: b.token, key: armed.key }));
      wsB.onclose = (ev) => res(ev.code);
    });
    expect(codeB).toBe(4403);

    // B did not burn A's key.
    const wsA = new WebSocket(`ws://127.0.0.1:${PORT}/live`);
    const gotArmed = await new Promise<boolean>((res) => {
      const t = setTimeout(() => res(false), 4000);
      wsA.onopen = () => wsA.send(JSON.stringify({ token: a.token, key: armed.key }));
      wsA.onmessage = (ev) => {
        if (String(ev.data).includes("live.armed")) {
          clearTimeout(t);
          res(true);
        }
      };
    });
    expect(gotArmed).toBe(true);

    // Revoking A while live drops them off the air and closes their socket.
    const closed = new Promise<number>((res) => (wsA.onclose = (ev) => res(ev.code)));
    const rev = (await (await post("/sessions/revoke", MASTER, { id: a.session.id })).json()) as { killedLive: boolean };
    expect(rev.killedLive).toBe(true);
    expect(await closed).toBe(4410);
    expect(service.live.state).toBe("offline");
  });

  test("control socket: a guest's frame runs as a guest, whatever it claims", async () => {
    const g = await mint("guest", "DJ Socket");
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    const result = await new Promise<{ ok: boolean; code?: string }>((res, rej) => {
      const t = setTimeout(() => rej(new Error("no result")), 4000);
      ws.onopen = () =>
        ws.send(JSON.stringify({ token: g.token, id: "t1", actor: { id: "console", role: "ops", label: "x" }, command: { type: "transport.stop" } }));
      ws.onmessage = (ev) => {
        const f = JSON.parse(String(ev.data));
        if (f.type === "command.result") {
          clearTimeout(t);
          res(f.result);
        }
      };
    });
    expect(result.ok).toBe(false);
    expect(result.code).toBe("UNAUTHORIZED");
    ws.close();
  });

  test("whoami reports the caller, and reads are scoped by role", async () => {
    const g = await mint("guest", "DJ Who");
    const h = await mint("host", "Morning Show");
    const gw = (await (await get("/whoami", g.token)).json()) as { kind: string; role: string; commands: string[]; reads: string[] };
    expect(gw.kind).toBe("session");
    expect(gw.role).toBe("guest");
    expect(gw.commands).toContain("imaging.play");
    expect(gw.commands).not.toContain("transport.stop");
    expect(gw.reads).not.toContain("/requests");
    const hw = (await (await get("/whoami", h.token)).json()) as { reads: string[]; commands: string[] };
    expect(hw.reads).toContain("/requests");
    expect(hw.commands).toContain("mix.skip");

    expect((await get("/requests", g.token)).status).toBe(403);
    expect((await get("/requests", h.token)).status).not.toBe(403);
    expect((await get("/imaging", g.token)).status).not.toBe(403);
    expect((await get("/crate", h.token)).status).toBe(403);

    const owner = (await (await get("/whoami", MASTER)).json()) as { kind: string; role: string };
    expect(owner.kind).toBe("master");
    expect((await get("/whoami", null)).status).toBe(401);
  });

  test("the owner is unaffected", async () => {
    const res = await post("/", MASTER, cmd("query.status", { id: "console", role: "console", label: "dj console" }));
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true);
  });
});

describe("a lapsed session loses the air", () => {
  const PORT2 = 8206;
  const BASE2 = `http://127.0.0.1:${PORT2}`;
  let clock = 1_000_000_000_000;
  let service: IngestService;

  beforeAll(async () => {
    service = new IngestService({
      port: PORT2,
      host: "127.0.0.1",
      token: MASTER,
      engine: { publish: false },
      sessionStore: new SessionStore({ now: () => clock }),
      live: { harbor: { password: "pw" }, spawn: () => new FakeProc() as never },
    });
    service.listen();
    await service.engine.start();
  });

  afterAll(async () => {
    await service.shutdown();
  });

  test("expiry drops a live guest within a few seconds", async () => {
    const mintRes = await fetch(`${BASE2}/sessions`, {
      method: "POST",
      headers: { authorization: `Bearer ${MASTER}`, "content-type": "application/json" },
      body: JSON.stringify({ role: "guest", label: "DJ Timer", ttlMin: 1 }),
    });
    const { token } = (await mintRes.json()) as { token: string };
    const armRes = await fetch(`${BASE2}/live/arm`, { method: "POST", headers: { authorization: `Bearer ${token}` } });
    const { key } = (await armRes.json()) as { key: string };

    const ws = new WebSocket(`ws://127.0.0.1:${PORT2}/live`);
    const armed = new Promise<void>((res, rej) => {
      const t = setTimeout(() => rej(new Error("no live.armed")), 4000);
      ws.onopen = () => ws.send(JSON.stringify({ token, key }));
      ws.onmessage = (ev) => {
        if (String(ev.data).includes("live.armed")) {
          clearTimeout(t);
          res();
        }
      };
    });
    const closed = new Promise<number>((res) => (ws.onclose = (ev) => res(ev.code)));
    await armed;
    expect(service.live.state).toBe("armed");

    clock += 2 * 60_000; // past the 1 minute ttl
    expect(await closed).toBe(4410);
    expect(service.live.state).toBe("offline");
    expect(service.live.snapshot.error).toMatch(/session expired/);
  });
});
