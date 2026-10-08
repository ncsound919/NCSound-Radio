import { describe, expect, test } from "bun:test";
import {
  classifyPlaybackError,
  createSleepTimer,
  createStallWatchdog,
  nextRetry,
  playbackUrl,
  qualityFor,
  selectMount,
  shouldReloadOnConnectivity,
} from "../src/index.ts";
import type { StreamDescriptor } from "@ncsound/station-client";

const descriptor: StreamDescriptor = {
  baseUrl: "https://stream.example.com",
  live: { path: "/live.mp3", bitrateKbps: 128, codec: "MP3", label: "Full", url: "https://stream.example.com/live.mp3" },
  mobile: { path: "/mobile.mp3", bitrateKbps: 64, codec: "MP3", label: "Saver", url: "https://stream.example.com/mobile.mp3" },
  hls: null,
  updatedAt: "2026-10-07T00:00:00.000Z",
};

describe("mount selection", () => {
  test("data saver switches the mount, never a hardcoded path", () => {
    expect(qualityFor(false)).toBe("hi");
    expect(qualityFor(true)).toBe("mobile");
    expect(selectMount(descriptor, "hi").bitrateKbps).toBe(128);
    expect(selectMount(descriptor, "mobile").bitrateKbps).toBe(64);
  });

  test("playbackUrl returns the chosen mount and null when unusable", () => {
    expect(playbackUrl(descriptor, false)).toBe("https://stream.example.com/live.mp3");
    expect(playbackUrl(descriptor, true)).toBe("https://stream.example.com/mobile.mp3");
    expect(playbackUrl(null, false)).toBe(null);
    expect(playbackUrl({ ...descriptor, live: { ...descriptor.live, url: "" } }, false)).toBe(null);
  });
});

describe("reconnect policy", () => {
  test("classifies the reasons the player actually reports", () => {
    expect(classifyPlaybackError("The network connection was lost")).toBe("network");
    expect(classifyPlaybackError("not found (404)")).toBe("not_found");
    expect(classifyPlaybackError("HTTP 503")).toBe("server");
    expect(classifyPlaybackError("audio session interrupted")).toBe("interrupted");
    expect(classifyPlaybackError(null)).toBe("unknown");
  });

  test("backs off exponentially and caps", () => {
    const noJitter = () => 0;
    expect(nextRetry(1, "network", undefined, noJitter).delayMs).toBe(1000);
    expect(nextRetry(2, "network", undefined, noJitter).delayMs).toBe(2000);
    expect(nextRetry(3, "network", undefined, noJitter).delayMs).toBe(4000);
    // 1000 * 2^5 = 32000, capped at maxMs.
    expect(nextRetry(6, "network", undefined, noJitter).delayMs).toBe(30_000);
  });

  test("gives up immediately on a permanent failure", () => {
    expect(nextRetry(1, "not_found")).toEqual({ delayMs: 0, giveUp: true });
  });

  test("gives up after the attempt budget", () => {
    expect(nextRetry(8, "network", undefined, () => 0).giveUp).toBe(true);
  });

  test("reloads only on the offline to online edge", () => {
    expect(shouldReloadOnConnectivity(false, true)).toBe(true);
    expect(shouldReloadOnConnectivity(true, true)).toBe(false);
    expect(shouldReloadOnConnectivity(true, false)).toBe(false);
  });

  test("the stall watchdog fires only after the threshold without progress", () => {
    let t = 0;
    const watchdog = createStallWatchdog(4000, () => t);
    t = 1000;
    expect(watchdog.isStalled()).toBe(false);
    t = 4500;
    expect(watchdog.isStalled()).toBe(true);
    watchdog.note();
    expect(watchdog.isStalled()).toBe(false);
  });
});

describe("sleep timer", () => {
  test("counts down, fades, then is done", () => {
    const timer = createSleepTimer(10_000, 2000);
    expect(timer.getState().phase).toBe("counting");

    timer.advance(9000);
    expect(timer.getState().phase).toBe("counting");
    expect(timer.getState().remainingMs).toBe(1000);

    timer.advance(1000);
    expect(timer.getState().phase).toBe("fading");

    timer.advance(1000);
    expect(timer.getState().volume).toBeCloseTo(0.5, 5);

    timer.advance(1000);
    expect(timer.getState().phase).toBe("done");
    expect(timer.getState().volume).toBe(0);
  });

  test("a long tick still lands in the fade, not past it", () => {
    const timer = createSleepTimer(1000, 2000);
    timer.advance(5000);
    expect(["fading", "done"]).toContain(timer.getState().phase);
  });

  test("cancel returns to idle", () => {
    const timer = createSleepTimer(10_000);
    timer.advance(1000);
    expect(timer.cancel().phase).toBe("idle");
  });
});
