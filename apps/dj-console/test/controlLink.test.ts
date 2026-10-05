import assert from "node:assert/strict";
import { ControlLink, type SocketLike } from "../src/engine/controlLink";

console.log("=== Testing ControlLink (console -> ingest WebSocket) ===");

/** Minimal WebSocket stand-in: handlers are assigned, not listened for. */
class FakeSocket implements SocketLike {
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;

  send(data: string): void {
    if (this.readyState !== 1) throw new Error("socket not open");
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = 3;
    const handler = this.onclose;
    handler?.();
  }

  /** Client side of the handshake. */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** Deliver a server frame as the browser would. */
  deliver(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
}

const ACTOR = { id: "console", role: "console", label: "dj console" } as const;

function ready(socket: FakeSocket): void {
  socket.deliver({ type: "connection.ready", at: new Date().toISOString(), actor: ACTOR });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeLink() {
  const sockets: FakeSocket[] = [];
  const link = new ControlLink({
    socketFactory: () => {
      const s = new FakeSocket();
      sockets.push(s);
      return s;
    },
    minBackoffMs: 5,
    maxBackoffMs: 20,
    connectTimeoutMs: 40,
    commandTimeoutMs: 60,
  });
  return { link, sockets };
}

// 1. A command sent over an open socket is framed for the console actor and
//    resolves with the engine's own verdict.
{
  const { link, sockets } = makeLink();
  link.start();
  const s = sockets[0];
  s.open();
  ready(s);

  const pending = link.send({ type: "transport.play" });
  assert.equal(s.sent.length, 1, "one frame written for one send");
  const frame = JSON.parse(s.sent[0]) as { id: string; actor: { role: string }; command: { type: string } };
  assert.equal(frame.actor.role, "console", "the frame identifies as the console");
  assert.equal(frame.command.type, "transport.play");
  assert.ok(frame.id.length > 0, "client mints the envelope id for replay pairing");
  assert.equal(link.status.transport, "websocket");

  s.deliver({
    type: "command.result",
    at: new Date().toISOString(),
    result: { id: frame.id, ok: true, appliedAt: new Date().toISOString(), result: { state: "playing" } },
  });
  const result = await pending;
  assert.equal(result.ok, true, "the engine's success reaches the caller");
  assert.equal(link.status.lastResult?.ok, true);
  link.stop();
}

// 2. The server sends every result twice (a direct reply plus a broadcast to
//    all sockets). Neither the failure count nor the pending promise may be
//    touched by the copy.
{
  const { link, sockets } = makeLink();
  link.start();
  const s = sockets[0];
  s.open();
  ready(s);

  const pending = link.send({ type: "mix.panic" });
  const frame = JSON.parse(s.sent[0]) as { id: string };
  const result = {
    id: frame.id,
    ok: false as const,
    appliedAt: new Date().toISOString(),
    code: "NO_SUCH_TRACK" as const,
    error: "crate is empty",
  };
  s.deliver({ type: "command.result", at: new Date().toISOString(), result });
  s.deliver({ type: "command.result", at: new Date().toISOString(), result });

  const got = await pending;
  assert.equal(got.ok, false, "a refusal is returned, not thrown");
  assert.equal(link.status.failed, 1, "duplicate frame is ignored");
  link.stop();
}

// 3. With no socket open the same command goes out over HTTP, so a failed
//    upgrade degrades instead of going dead.
{
  const originalFetch = globalThis.fetch;
  const captured: { url: string; body: { id: string; actor: { role: string } } }[] = [];
  globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
    const body = JSON.parse(String(init?.body)) as { id: string; actor: { role: string } };
    captured.push({ url: String(_url), body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ id: body.id, ok: true, appliedAt: new Date().toISOString() }),
    } as unknown as Response;
  }) as typeof fetch;

  const link = new ControlLink({ commandTimeoutMs: 60 });
  const result = await link.send({ type: "transport.pause" });
  assert.equal(result.ok, true, "HTTP fallback answers");
  assert.equal(captured.length, 1, "one POST issued");
  assert.ok(captured[0].url.includes("/ingest/command"), `posted to ingest, got ${captured[0].url}`);
  assert.equal(captured[0].body.actor.role, "console");
  link.stop();
  globalThis.fetch = originalFetch;
}

// 4. A dropped socket schedules a reconnect with backoff.
{
  const { link, sockets } = makeLink();
  link.start();
  assert.equal(sockets.length, 1, "first connection attempted");
  sockets[0].open();
  ready(sockets[0]);

  sockets[0].close();
  assert.equal(link.status.ready, false, "a closed socket is no longer ready");
  await sleep(30);
  assert.ok(sockets.length >= 2, `reconnected after a drop, saw ${sockets.length} sockets`);
  assert.ok(link.status.reconnects >= 1, "the drop was counted");
  link.stop();
}

// 5. An inbound stream status replaces the previous one.
{
  const { link, sockets } = makeLink();
  link.start();
  const s = sockets[0];
  s.open();
  ready(s);
  assert.equal(link.status.stream, null, "no stream status before the first push");

  s.deliver({
    type: "stream.status",
    at: new Date().toISOString(),
    status: { onAir: false, ingestHealthy: true, mounts: [] },
  });
  assert.equal(link.status.stream?.onAir, false, "pushed status applied");

  s.deliver({
    type: "stream.status",
    at: new Date().toISOString(),
    status: { onAir: true, ingestHealthy: true, mounts: [] },
  });
  assert.equal(link.status.stream?.onAir, true, "fresher push replaces it");
  link.stop();
}

// 6. A command the engine never answers must not hang the operator's click.
{
  const { link, sockets } = makeLink();
  link.start();
  const s = sockets[0];
  s.open();
  ready(s);

  const result = await link.send({ type: "query.status" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "ENGINE_OFFLINE", "silence is reported as offline");
  link.stop();
}

// 7. Shutting down resolves everything still in flight.
{
  const { link, sockets } = makeLink();
  link.start();
  const s = sockets[0];
  s.open();
  ready(s);

  const pending = link.send({ type: "cue.track", trackId: "t1" });
  link.stop();
  const result = await pending;
  assert.equal(result.ok, false);
  assert.equal(result.code, "ENGINE_OFFLINE");
  assert.equal(link.status.transport, "offline");
}

// 8. The engine's HTTP status is still the only source for engine state —
//    the socket carries stream state, not engine state.
{
  const { link, sockets } = makeLink();
  link.start();
  const s = sockets[0];
  s.open();
  ready(s);
  s.deliver({ type: "stream.status", at: new Date().toISOString(), status: { onAir: true } });
  assert.equal(link.status.engineState, null, "engine state stays with GET /status");
  link.stop();
}

console.log("All controlLink tests passed successfully!");
