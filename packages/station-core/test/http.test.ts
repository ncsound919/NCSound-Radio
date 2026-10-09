import { describe, expect, test } from "bun:test";
import {
  nowPlayingSchema,
  responseSchemas,
  streamDescriptorSchema,
} from "../src/http/index.ts";

describe("station HTTP response schemas", () => {
  test("the 503 offline now-playing body validates (and is not treated as live)", () => {
    const r = nowPlayingSchema.safeParse({
      station: { name: "NCSound Radio", tagline: "t", timezone: "America/New_York", bitrateKbps: 128 },
      current: null,
      next: [],
      heat: {},
      requestedBy: {},
      wheel: [],
      cycleIndex: 0,
      cycleSec: 0,
      listeners: { current: null, peak24h: null },
      mode: "offline",
      offlineReason: "DJ engine is not reachable",
      streamUrl: null,
      serverTime: "2026-10-07T00:00:00.000Z",
    });
    expect(r.success).toBe(true);
    expect(r.success && r.data.mode).toBe("offline");
    expect(r.success && r.data.listeners.current).toBe(null);
  });

  test("the offline/live mode must agree with whether a track is current", () => {
    const base = {
      station: { name: "NCSound Radio", tagline: "t", timezone: "America/New_York", bitrateKbps: 128 },
      next: [],
      listeners: { current: null, peak24h: null },
      streamUrl: null,
      serverTime: "2026-10-07T00:00:00.000Z",
    };
    const track = {
      track: {
        id: "t", title: "T", artist: "A", album: null, durationSec: 100,
        explicit: false, playlist: "General", bpm: 120,
      },
      startedAt: "2026-10-07T00:00:00.000Z",
      elapsed: 1, duration: 100, remaining: 99, progress: 0.01,
    };
    // offline with a current track is a state the UI cannot render honestly.
    expect(nowPlayingSchema.safeParse({ ...base, mode: "offline", current: track }).success).toBe(false);
    // live with no current track is likewise impossible.
    expect(nowPlayingSchema.safeParse({ ...base, mode: "live", current: null }).success).toBe(false);
    // the honest pairings pass.
    expect(nowPlayingSchema.safeParse({ ...base, mode: "offline", current: null }).success).toBe(true);
    expect(nowPlayingSchema.safeParse({ ...base, mode: "live", current: track }).success).toBe(true);
  });

  test("a stream mount missing its url is rejected", () => {
    const r = streamDescriptorSchema.safeParse({
      baseUrl: "https://stream.example.com",
      live: { path: "/live.mp3", bitrateKbps: 128, codec: "MP3", label: "Full" },
      mobile: { path: "/mobile.mp3", bitrateKbps: 64, codec: "MP3", label: "Saver", url: "x" },
      hls: null,
      updatedAt: "2026-10-07T00:00:00.000Z",
    });
    expect(r.success).toBe(false);
  });

  test("unknown fields pass through so an older client survives a newer server", () => {
    const r = streamDescriptorSchema.safeParse({
      baseUrl: "https://stream.example.com",
      live: { path: "/live.mp3", bitrateKbps: 128, codec: "MP3", label: "Full", url: "x", futureField: 1 },
      mobile: { path: "/mobile.mp3", bitrateKbps: 64, codec: "MP3", label: "Saver", url: "y" },
      hls: null,
      updatedAt: "2026-10-07T00:00:00.000Z",
      anotherFutureField: true,
    });
    expect(r.success).toBe(true);
  });

  test("responseSchemas covers every client operation", () => {
    expect(Object.keys(responseSchemas).sort()).toEqual([
      "getNowPlaying",
      "getRequests",
      "getSchedule",
      "getStream",
      "getTracks",
      "getVideo",
      "postRequest",
    ]);
  });
});
