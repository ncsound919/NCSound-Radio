import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { responseSchemas } from "@ncsound/station-core/http";
import { createStationClient, StationResponseError, type ResponseValidator } from "../src/index.ts";

/**
 * The validator is injected from station-core here (station-client never
 * imports it), so the client itself stays free of zod.
 */
const validate: ResponseValidator = (schemaKey, body) =>
  responseSchemas[schemaKey].safeParse(body);

/**
 * Fixtures mirror the real route responses (see `apps/station-web/src/app/api/*`).
 * They are the contract sample: if a schema and a route disagree, this is where
 * the disagreement shows up. The server echoes them; the client is constructed
 * with the injected `validate` above, so every call is zod-checked against the
 * station-core HTTP schemas before it returns.
 */

const track = {
  id: "t1",
  title: "Carolina Pressure",
  artist: "NCSound",
  album: null,
  durationSec: 180,
  explicit: false,
  playlist: "Heat",
  bpm: 142,
};

const routes: Record<string, unknown> = {
  "/api/stream": {
    baseUrl: "https://stream.example.com",
    live: { path: "/live.mp3", bitrateKbps: 128, codec: "MP3", label: "Full quality", url: "https://stream.example.com/live.mp3" },
    mobile: { path: "/mobile.mp3", bitrateKbps: 64, codec: "MP3", label: "Data saver", url: "https://stream.example.com/mobile.mp3" },
    hls: null,
    updatedAt: "2026-10-07T00:00:00.000Z",
  },
  "/api/video": {
    configured: true,
    live: true,
    inputId: "in_1",
    videoId: "vid_1",
    hls: "https://customer-x.cloudflarestream.com/vid_1/manifest/video.m3u8",
    dash: null,
    dvrHls: null,
    player: "https://customer-x.cloudflarestream.com/vid_1/iframe",
    promote: true,
    show: { id: "s1", name: "The Morning Drive", host: "DJ NC", kind: "LIVE", isVideo: true },
    reason: null,
    updatedAt: "2026-10-07T00:00:00.000Z",
  },
  "/api/nowplaying": {
    station: { name: "NCSound Radio", tagline: "Independent hip-hop", timezone: "America/New_York", bitrateKbps: 128 },
    mode: "live",
    current: { track, startedAt: "2026-10-07T00:00:00.000Z", elapsed: 30, duration: 180, remaining: 150, progress: 0.16 },
    next: [{ ...track, id: "t2", elementKind: "MUSIC", sponsorName: null }],
    element: { kind: "MUSIC" },
    daypart: { clean: true, label: "Music only" },
    liveShow: null,
    standbyReason: null,
    broadcastComponents: { enginePlaying: true, outputLive: true, mountConnected: true },
    heat: { t1: 4 },
    requestedBy: { t1: ["Jaz"] },
    wheel: [{ kind: "MUSIC", durSec: 180 }],
    cycleIndex: 0,
    cycleSec: 180,
    listeners: { current: 12, peak24h: 20, source: "icecast" },
    engine: { state: "playing", crateSize: 10, autopilot: true, uptimeSec: 3600, lastError: null, spectrum: [1, 2, 3] },
    stream: { onAir: true, encoder: "mp3", icecast: "2.4.4", mounts: [{ mount: "/live.mp3", bitrateKbps: 128, listeners: 12, peakListeners24h: 20, lastMetadata: "NCSound - Carolina Pressure" }] },
    streamUrl: "https://stream.example.com/live.mp3",
    serverTime: "2026-10-07T00:00:30.000Z",
  },
  "/api/schedule": {
    timezone: "America/New_York",
    now: { dayOfWeek: 3, minutes: 600, label: "Wed 10:00 ET" },
    shows: [
      {
        id: "s1", name: "The Morning Drive", slug: "morning-drive", description: "Wake up", host: "DJ NC",
        dayOfWeek: 3, startHour: 8, startMinute: 0, durationMin: 120, explicit: false,
        kind: "LIVE", accent: "#f0f", active: true,
      },
    ],
    currentShowId: "s1",
  },
  "/api/requests": {
    top: [{ trackId: "t1", title: "Carolina Pressure", artist: "NCSound", explicit: false, count: 4, lastRequestedAt: "2026-10-07T00:00:00.000Z" }],
    recent: [{ id: "r1", listenerName: "Jaz", note: null, trackTitle: "Carolina Pressure", trackArtist: "NCSound", createdAt: "2026-10-07T00:00:00.000Z" }],
    totalToday: 3,
    totalAllTime: 40,
  },
  "/api/tracks": {
    tracks: [{ id: "t1", title: "Carolina Pressure", artist: "NCSound", playlist: "Heat", durationSec: 180, explicit: false }],
  },
};

const requestResult = {
  ok: true,
  request: { id: "r1", trackId: "t1", listenerName: "Jaz", note: null, createdAt: "2026-10-07T00:00:00.000Z" },
  count: 4,
  message: "Request logged",
};

let server: Server;
let baseUrl: string;

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "POST" && url.pathname === "/api/requests") {
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify(requestResult));
      return;
    }
    const body = routes[url.pathname];
    if (!body) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(() => {
  server.close();
});

function validatedClient() {
  return createStationClient({ baseUrl, validateResponse: validate });
}

test("every endpoint's real response shape validates against the station-core schemas", async () => {
  const client = validatedClient();
  await client.getStream();
  await client.getVideo();
  await client.getNowPlaying();
  await client.getSchedule();
  await client.getRequests();
  await client.getTracks();
  const res = await client.postRequest({ trackId: "t1", listenerName: "Jaz" });
  assert.equal(res.ok, true);
});

test("a response that drifts from the schema throws StationResponseError, not a silent pass", async () => {
  const client = createStationClient({
    baseUrl,
    validateResponse: validate,
    fetchImpl: (async () =>
      new Response(
        JSON.stringify({
          baseUrl: "https://stream.example.com",
          live: { path: "/live.mp3", bitrateKbps: "128" },
          mobile: { path: "/mobile.mp3", bitrateKbps: 64, codec: "MP3", label: "Data saver", url: "x" },
          hls: null,
          updatedAt: "2026-10-07T00:00:00.000Z",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch,
  });

  await assert.rejects(
    () => client.getStream(),
    (err: unknown) => {
      assert.ok(err instanceof StationResponseError, "is StationResponseError");
      assert.equal((err as StationResponseError).schemaKey, "getStream");
      return true;
    },
  );
});

test("validation stays off by default: a drifted body passes through untouched", async () => {
  const client = createStationClient({ baseUrl });
  const mine = createStationClient({
    baseUrl: "https://x",
    fetchImpl: (async () =>
      new Response(JSON.stringify({ totally: "wrong" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch,
  });
  assert.ok(client);
  const out = await mine.getStream();
  assert.deepEqual(out, { totally: "wrong" } as never);
});
