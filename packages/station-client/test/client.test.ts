import { test } from "node:test";
import assert from "node:assert/strict";
import { createStationClient, StationApiError } from "../src/index.ts";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("getStream requests the configured base + path", async () => {
  const calls: string[] = [];
  const client = createStationClient({
    baseUrl: "https://api.example.com/",
    fetchImpl: (async (url: string) => {
      calls.push(String(url));
      return jsonResponse({
        baseUrl: "https://stream.example.com",
        live: { path: "/live.mp3", bitrateKbps: 128, codec: "MP3", label: "Full", url: "https://stream.example.com/live.mp3" },
        mobile: { path: "/mobile.mp3", bitrateKbps: 64, codec: "MP3", label: "Data saver", url: "https://stream.example.com/mobile.mp3" },
        hls: null,
        updatedAt: "2026-10-07T00:00:00.000Z",
      });
    }) as unknown as typeof fetch,
  });

  const out = await client.getStream();
  assert.equal(calls[0], "https://api.example.com/api/stream"); // trailing slash trimmed
  assert.equal(out.hls, null);
  assert.equal(out.live.bitrateKbps, 128);
});

test("getNowPlaying returns the offline 503 body instead of throwing", async () => {
  const client = createStationClient({
    baseUrl: "https://api.example.com",
    fetchImpl: (async () =>
      jsonResponse(
        {
          mode: "offline",
          offlineReason: "DJ engine is not reachable",
          station: { name: "NCSound Radio" },
          current: null,
          next: [],
          listeners: { current: null, peak24h: null },
          streamUrl: null,
          serverTime: "2026-10-07T00:00:00.000Z",
        },
        503,
      )) as unknown as typeof fetch,
  });

  const np = await client.getNowPlaying();
  assert.equal(np.mode, "offline");
  assert.equal(np.current, null);
  assert.equal(np.listeners.current, null); // null, not 0
});

test("postRequest sends bearer + json body", async () => {
  let auth: string | null = null;
  let body = "";
  const client = createStationClient({
    baseUrl: "https://api.example.com",
    getAuthToken: () => "tok_123",
    fetchImpl: (async (_url: string, init: RequestInit) => {
      auth = new Headers(init.headers as HeadersInit).get("authorization");
      body = String(init.body ?? "");
      return jsonResponse(
        {
          ok: true,
          request: { id: "r1", trackId: "t1", listenerName: "n", note: null, createdAt: "t" },
          count: 1,
          message: "ok",
        },
        201,
      );
    }) as unknown as typeof fetch,
  });

  const res = await client.postRequest({ trackId: "t1", listenerName: "n" });
  assert.equal(auth, "Bearer tok_123");
  assert.match(body, /"trackId":"t1"/);
  assert.equal(res.count, 1);
});

test("a non-2xx the caller did not allow throws StationApiError with the server message", async () => {
  const client = createStationClient({
    baseUrl: "https://api.example.com",
    fetchImpl: (async () =>
      jsonResponse({ error: "Easy on the shout-outs — try again in a minute." }, 429)) as unknown as typeof fetch,
  });

  await assert.rejects(
    () => client.postRequest({ trackId: "t1", listenerName: "n" }),
    (err: unknown) => {
      assert.ok(err instanceof StationApiError, "is StationApiError");
      assert.equal((err as StationApiError).status, 429);
      assert.match((err as StationApiError).message, /shout-outs/);
      return true;
    },
  );
});

test("no auth token => no Authorization header (anonymous listener)", async () => {
  let auth: string | null = "sentinel";
  const client = createStationClient({
    baseUrl: "https://api.example.com",
    getAuthToken: () => null,
    fetchImpl: (async (_url: string, init: RequestInit) => {
      auth = new Headers(init.headers as HeadersInit).get("authorization");
      return jsonResponse({ tracks: [] });
    }) as unknown as typeof fetch,
  });

  await client.getTracks();
  assert.equal(auth, null);
});
