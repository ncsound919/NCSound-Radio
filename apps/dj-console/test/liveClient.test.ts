import assert from "node:assert/strict";
import { LiveClient, type LiveDeps, type LiveSocket, type Chunk, COUNTDOWN_SEC } from "../src/radio/live";

console.log("=== Go-live client (plan 5.3 / 5.4) ===");

/* ---------- fakes ---------- */

class Clock {
  t = 1_000_000;
  private q: Array<{ at: number; fn: () => void; id: number }> = [];
  private seq = 0;
  setTimeout = (fn: () => void, ms: number) => {
    const id = ++this.seq;
    this.q.push({ at: this.t + ms, fn, id });
    return id;
  };
  clearTimeout = (h: unknown) => {
    this.q = this.q.filter((x) => x.id !== h);
  };
  now = () => this.t;
  async advance(ms: number) {
    const end = this.t + ms;
    for (;;) {
      await flush();
      this.q.sort((a, b) => a.at - b.at || a.id - b.id);
      const next = this.q[0];
      if (!next || next.at > end) break;
      this.q.shift();
      this.t = next.at;
      next.fn();
    }
    this.t = end;
    await flush();
  }
}

async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

class FakeSocket implements LiveSocket {
  binaryType = "blob";
  bufferedAmount = 0;
  readyState = 0;
  sent: Array<string | Chunk> = [];
  closed: { code?: number; reason?: string } | null = null;
  onopen: LiveSocket["onopen"] = null;
  onmessage: LiveSocket["onmessage"] = null;
  onclose: LiveSocket["onclose"] = null;
  onerror: LiveSocket["onerror"] = null;
  send(d: string | Blob | ArrayBuffer | Uint8Array) {
    this.sent.push(d as string | Chunk);
  }
  close(code?: number, reason?: string) {
    this.closed = { code, reason };
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  serverSays(frame: object) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop(code = 1006, reason = "") {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
  get binarySent() {
    return this.sent.filter((s) => typeof s !== "string").length;
  }
  get texts() {
    return this.sent.filter((s): s is string => typeof s === "string").map((s) => JSON.parse(s));
  }
}

type Live = { state: string; onAirSince?: string | null; error?: string | null };
const snapshot = (l: Live) => ({
  state: l.state, sessionId: "s1", armedAt: null, onAirSince: l.onAirSince ?? null,
  bytesSent: 0, bytesPerSec: 0, driftSec: 0, blockedMs: 0, error: l.error ?? null,
});

function rig(opts: { status?: () => { status: number; body: unknown }; arm?: () => { status: number; body: unknown }; encoderProblem?: string | null; silentEncoder?: boolean } = {}) {
  const clock = new Clock();
  const sockets: FakeSocket[] = [];
  let server: Live = { state: "offline" };
  let arms = 0;
  const enc = { started: 0, stopped: 0, timeslice: 0 };
  let keyN = 0;
  const deps: LiveDeps = {
    token: null,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    async request(path, init) {
      if (path === "/status") return opts.status?.() ?? { status: 200, body: { live: snapshot(server) } };
      if (path === "/live/arm" && init?.method === "POST") {
        arms++;
        return opts.arm?.() ?? { status: 200, body: { ok: true, key: `k${++keyN}`, expiresAt: "" } };
      }
      return { status: 404, body: null };
    },
    openSocket() {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    encoderProblem: () => opts.encoderProblem ?? null,
    createEncoder(_kbps, onChunk) {
      let running = false;
      const tick = () => {
        if (!running) return;
        onChunk(new Uint8Array(6000));
        clock.setTimeout(tick, 250);
      };
      return {
        start(ms) {
          enc.started++;
          enc.timeslice = ms;
          running = true;
          if (!opts.silentEncoder) clock.setTimeout(tick, 250);
        },
        async stop() {
          if (running) enc.stopped++;
          running = false;
        },
      };
    },
  };
  const client = new LiveClient(deps);
  return {
    clock, client, sockets, enc,
    get arms() { return arms; },
    setServer(l: Live) { server = l; },
    get phase() { return client.state.phase; },
  };
}

/** Run a session up to "armed" (audio flowing, not yet confirmed). */
async function toArmed(r: ReturnType<typeof rig>) {
  void r.client.goLive();
  await r.clock.advance(0);
  assert.equal(r.phase, "countdown");
  await r.clock.advance(COUNTDOWN_SEC * 1000);
  assert.equal(r.phase, "connecting");
  const ws = r.sockets.at(-1)!;
  ws.open();
  ws.serverSays({ type: "live.armed", sessionId: "s1" });
  await r.clock.advance(0);
  r.setServer({ state: "armed" });
  return ws;
}

let n = 0;
const ok = (name: string) => console.log(`PASS ${name}`) ?? n++;

/* ---------- preflight ---------- */

{
  const r = rig({ status: () => ({ status: 0, body: null }) });
  await r.client.goLive();
  assert.equal(r.phase, "failed");
  assert.equal(r.client.state.checks.find((c) => c.id === "ingest")!.state, "fail");
  assert.equal(r.arms, 0);
  assert.equal(r.sockets.length, 0);
  ok("unreachable ingest fails preflight and arms nothing");
}
{
  const r = rig({ status: () => ({ status: 200, body: { engine: {} } }) });
  await r.client.goLive();
  assert.equal(r.phase, "failed");
  assert.match(r.client.state.checks[0].detail, /no live bridge/);
  ok("an ingest without a live bridge is reported, not assumed");
}
{
  const r = rig();
  r.setServer({ state: "on_air" });
  await r.client.goLive();
  assert.equal(r.phase, "failed");
  assert.match(r.client.state.message, /someone else/i);
  ok("a mount held by another console is refused before arming");
}
{
  const r = rig({ encoderProblem: "This browser can't encode Opus in WebM. Use Chrome or Edge." });
  await r.client.goLive();
  assert.equal(r.phase, "failed");
  assert.equal(r.arms, 0);
  ok("no Opus encoder fails before a key is spent");
}
{
  const r = rig({ arm: () => ({ status: 401, body: { error: "unauthorized" } }) });
  await r.client.goLive();
  assert.equal(r.phase, "failed");
  assert.match(r.client.state.message, /INGEST_TOKEN/);
  ok("401 on arm names INGEST_TOKEN");
}
{
  const r = rig({ arm: () => ({ status: 403, body: { error: "origin not allowed" } }) });
  await r.client.goLive();
  assert.match(r.client.state.message, /INGEST_ALLOWED_ORIGINS/);
  ok("403 on arm names INGEST_ALLOWED_ORIGINS");
}

/* ---------- countdown ---------- */

{
  const r = rig();
  void r.client.goLive();
  await r.clock.advance(0);
  assert.equal(r.client.state.countdown, COUNTDOWN_SEC);
  await r.clock.advance(COUNTDOWN_SEC * 1000 - 1);
  assert.equal(r.sockets.length, 0, "the mount must not connect before the countdown ends");
  await r.clock.advance(1);
  assert.equal(r.sockets.length, 1);
  ok("the live mount connects only when the 8 s countdown ends");
}
{
  const r = rig();
  void r.client.goLive();
  await r.clock.advance(3000);
  r.client.cancel();
  await r.clock.advance(10_000);
  assert.equal(r.phase, "idle");
  assert.equal(r.sockets.length, 0);
  ok("cancel during the countdown connects nothing");
}

/* ---------- going live, measured not assumed ---------- */

{
  const r = rig();
  const ws = await toArmed(r);
  assert.equal(r.phase, "armed");
  assert.deepEqual(ws.texts[0], { key: "k1" });
  assert.equal(r.enc.timeslice, 250);
  await r.clock.advance(20_000);
  assert.equal(r.phase, "armed", "must NOT claim on air while Liquidsoap has not confirmed");
  assert.ok(ws.binarySent >= 70, `audio flows while armed (${ws.binarySent} chunks)`);
  assert.ok((r.client.state.sendKbps ?? 0) > 150, `send rate measured (${r.client.state.sendKbps} kbps)`);
  r.setServer({ state: "on_air", onAirSince: new Date(r.clock.t).toISOString() });
  await r.clock.advance(1000);
  assert.equal(r.phase, "on_air");
  assert.ok(r.client.state.onAirSince !== null);
  ok("ON AIR only after ingest reports Liquidsoap carries the mount (20 s armed stayed armed)");
}
{
  const r = rig();
  const ws = await toArmed(r);
  ws.drop(4403, "bad or expired live key");
  // A close BEFORE live.armed is a failure, but here we already armed: it is a loss.
  assert.equal(r.phase, "lost");
  ok("a socket close after arming is a loss, not a failure");
}
{
  const r = rig();
  void r.client.goLive({ countdown: false });
  await r.clock.advance(0);
  const ws = r.sockets[0];
  ws.open();
  ws.drop(4403, "bad or expired live key");
  await r.clock.advance(0);
  assert.equal(r.phase, "failed");
  assert.match(r.client.state.message, /key was refused or expired/);
  ok("a refused key before arming fails with the reason");
}
{
  const r = rig();
  void r.client.goLive({ countdown: false });
  await r.clock.advance(0);
  r.sockets[0].open();
  await r.clock.advance(5001);
  assert.equal(r.phase, "failed");
  ok("no live.armed within 5 s fails the attempt");
}

/* ---------- drop-out and rejoin ---------- */

{
  let armReply: { status: number; body: unknown } | null = null;
  const r = rig({ arm: () => armReply ?? { status: 200, body: { ok: true, key: "kx" } } });
  const ws = await toArmed(r);
  r.setServer({ state: "on_air" });
  await r.clock.advance(1000);
  assert.equal(r.phase, "on_air");
  ws.drop(1006);
  assert.equal(r.phase, "lost");
  assert.match(r.client.state.message, /autopilot/);
  assert.ok(r.client.state.retryUntil !== null);
  assert.equal(r.enc.stopped, 1, "encoder stopped on loss");
  r.setServer({ state: "offline" });
  armReply = { status: 409, body: { ok: false, error: "a live session is already in progress" } };
  await r.clock.advance(5000);
  assert.equal(r.phase, "lost");
  assert.equal(r.client.state.attempts, 1);
  armReply = null;
  await r.clock.advance(5000);
  assert.equal(r.client.state.attempts, 2);
  assert.equal(r.sockets.length, 2, "rejoin opened a new socket");
  ok("a drop says autopilot has it, retries every 5 s, and survives a 409 while the old session closes");
}
{
  // Go live once with a working arm, then make every rejoin fail.
  let first = true;
  const r2 = rig({ arm: () => (first ? ((first = false), { status: 200, body: { ok: true, key: "k" } }) : { status: 409, body: { ok: false } }) });
  const ws = await toArmed(r2);
  ws.drop(1006);
  await r2.clock.advance(61_000);
  assert.equal(r2.phase, "lost");
  assert.equal(r2.client.state.retryUntil, null);
  assert.match(r2.client.state.message, /gave up after 60 s/);
  const attempts = r2.client.state.attempts;
  await r2.clock.advance(30_000);
  assert.equal(r2.client.state.attempts, attempts, "no retries after the window");
  ok("rejoin gives up after 60 s and waits for the operator");
}
{
  const r = rig();
  const ws = await toArmed(r);
  ws.bufferedAmount = 200_000; // > 3 s of 192 kbps queued
  await r.clock.advance(3000);
  assert.equal(r.phase, "armed", "not dropped before the 3 s stall window");
  await r.clock.advance(1000);
  assert.equal(r.phase, "lost");
  assert.match(r.client.state.message, /uplink fell more than 3 s behind/);
  ok("an uplink more than 3 s behind is a drop");
}
{
  const r = rig({ silentEncoder: true });
  await toArmed(r);
  await r.clock.advance(5000);
  assert.equal(r.phase, "lost");
  assert.match(r.client.state.message, /encoder stopped producing audio/);
  ok("an encoder that produces nothing is a drop, not a silent broadcast");
}
{
  const r = rig();
  const ws = await toArmed(r);
  r.setServer({ state: "offline", error: "Liquidsoap lost the live harbor source" });
  await r.clock.advance(1000);
  assert.equal(r.phase, "lost");
  assert.match(r.client.state.message, /Liquidsoap lost the live harbor source/);
  void ws;
  ok("the station dropping the session is reported with its reason");
}

/* ---------- hand-back ---------- */

{
  const r = rig();
  const ws = await toArmed(r);
  r.setServer({ state: "on_air" });
  await r.clock.advance(1000);
  await r.client.end();
  assert.equal(r.phase, "ending");
  assert.equal(r.enc.stopped, 1);
  assert.deepEqual(ws.texts.at(-1), { type: "live.end" });
  assert.equal(ws.closed, null, "socket stays open until the bridge confirms");
  r.setServer({ state: "ended" });
  await r.clock.advance(1000);
  assert.equal(r.phase, "ended");
  assert.ok(ws.closed);
  ok("hand-back flushes, sends live.end, and finishes when ingest says ended");
}
{
  const r = rig();
  const ws = await toArmed(r);
  r.setServer({ state: "on_air" });
  await r.clock.advance(1000);
  await r.client.end();
  // Server keeps reporting on_air (never confirms).
  await r.clock.advance(6000);
  assert.equal(r.phase, "ended");
  assert.ok(ws.closed);
  assert.match(r.client.state.message, /did not confirm/);
  ok("an unconfirmed hand-back closes after 6 s and says so");
}
{
  const r = rig();
  void r.client.goLive();
  await r.clock.advance(0);
  void r.client.goLive();
  await r.clock.advance(0);
  assert.equal(r.arms, 1);
  ok("Go live while busy does nothing");
}

console.log(`Go-live client tests passed (${n})`);
