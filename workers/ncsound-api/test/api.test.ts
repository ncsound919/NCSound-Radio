// ncsound-api behaviour against a fake R2 bucket (no network, no Cloudflare).
import { describe, expect, test } from "bun:test";
import worker, { authorised, safeEqual, type Env } from "../src/index";

const FILES: Record<string, Uint8Array> = {
  "music/Album One/01 - Track.mp3": new Uint8Array(Array.from({ length: 100 }, (_, i) => i)),
  "loose.mp3": new Uint8Array([1, 2, 3]),
  "notes.txt": new Uint8Array([9]),
};

function fakeBucket(): R2Bucket {
  const meta = (key: string) => ({
    key,
    size: FILES[key].length,
    uploaded: new Date("2026-10-07T00:00:00Z"),
    httpEtag: '"etag"',
    httpMetadata: { contentType: "audio/mpeg" },
    writeHttpMetadata(h: Headers) { h.set("content-type", "audio/mpeg"); },
  });
  return {
    async list() {
      return { objects: Object.keys(FILES).map(meta), truncated: false };
    },
    async get(key: string, opts?: { range?: Headers }) {
      const bytes = FILES[key];
      if (!bytes) return null;
      let body = bytes;
      const r = opts?.range?.get("range");
      if (r) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(r)!;
        if (m[1] !== "" && Number(m[1]) >= bytes.length) throw new Error("range past end");
        if (m[1] === "") body = bytes.slice(Math.max(0, bytes.length - Number(m[2])));
        else body = bytes.slice(Number(m[1]), m[2] === "" ? undefined : Number(m[2]) + 1);
      }
      return { ...meta(key), body: new Response(body).body } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket;
}

const env = (extra: Partial<Env> = {}): Env => ({ MEDIA: fakeBucket(), ...extra });
const call = (path: string, init: RequestInit = {}, e: Env = env()) => worker.fetch(new Request("https://x.test" + path, init), e);

describe("catalog", () => {
  test("lists objects with album and file name, sorted", async () => {
    const body = (await (await call("/library")).json()) as { count: number; objects: Array<{ key: string; album: string | null; fileName: string }> };
    expect(body.count).toBe(3);
    expect(body.objects.map((o) => o.key)).toEqual(["loose.mp3", "music/Album One/01 - Track.mp3", "notes.txt"]);
    expect(body.objects[1].fileName).toBe("01 - Track.mp3");
    expect(body.objects[0].album).toBeNull();
  });
});

describe("audio and ranges", () => {
  const url = "/audio/" + encodeURIComponent("music/Album One/01 - Track.mp3").replace(/%2F/g, "/");
  test("full file", async () => {
    const r = await call(url);
    expect(r.status).toBe(200);
    expect(new Uint8Array(await r.arrayBuffer()).length).toBe(100);
    expect(r.headers.get("accept-ranges")).toBe("bytes");
  });
  test("closed range -> 206 with Content-Range", async () => {
    const r = await call(url, { headers: { range: "bytes=10-19" } });
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 10-19/100");
    expect(r.headers.get("content-length")).toBe("10");
    expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });
  test("open-ended and suffix ranges", async () => {
    const open = await call(url, { headers: { range: "bytes=90-" } });
    expect(open.headers.get("content-range")).toBe("bytes 90-99/100");
    const suffix = await call(url, { headers: { range: "bytes=-5" } });
    expect(suffix.headers.get("content-range")).toBe("bytes 95-99/100");
  });
  test("range past the end is a 416, not a 500", async () => {
    expect((await call(url, { headers: { range: "bytes=500-600" } })).status).toBe(416);
  });
  test("missing key 404, malformed encoding 400", async () => {
    expect((await call("/audio/nope.mp3")).status).toBe(404);
    expect((await call("/audio/%E0%A4%A")).status).toBe(400);
  });
  test("HEAD returns headers and no body", async () => {
    const r = await call(url, { method: "HEAD" });
    expect(r.status).toBe(200);
    expect(await r.text()).toBe("");
  });
  test("writes are refused", async () => {
    expect((await call(url, { method: "PUT", body: "x" })).status).toBe(405);
  });
});

describe("token gate", () => {
  const gated = env({ LIBRARY_TOKEN: "s3cret-token" });
  test("open when no token is configured", async () => {
    expect((await call("/library")).status).toBe(200);
  });
  test("health stays open, library and audio need the token", async () => {
    expect((await call("/health", {}, gated)).status).toBe(200);
    expect((await call("/library", {}, gated)).status).toBe(401);
    expect((await call("/audio/loose.mp3", {}, gated)).status).toBe(401);
    expect((await call("/library/manifest", {}, gated)).status).toBe(401);
  });
  test("bearer header and ?t= both work; wrong or empty do not", async () => {
    expect((await call("/library", { headers: { authorization: "Bearer s3cret-token" } }, gated)).status).toBe(200);
    expect((await call("/audio/loose.mp3?t=s3cret-token", {}, gated)).status).toBe(200);
    expect((await call("/library", { headers: { authorization: "Bearer wrong" } }, gated)).status).toBe(401);
    expect((await call("/library?t=", {}, gated)).status).toBe(401);
    expect((await call("/library", { headers: { authorization: "Bearer " } }, gated)).status).toBe(401);
  });
  test("preflight is answered without a token and allows Authorization", async () => {
    const r = await call("/library", { method: "OPTIONS", headers: { origin: "https://app.test" } }, gated);
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-headers")).toContain("authorization");
  });
  test("401 carries CORS so the browser can read it", async () => {
    const r = await call("/library", { headers: { origin: "https://app.test" } }, env({ LIBRARY_TOKEN: "t", ALLOWED_ORIGINS: "https://app.test" }));
    expect(r.status).toBe(401);
    expect(r.headers.get("access-control-allow-origin")).toBe("https://app.test");
  });
  test("safeEqual", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(authorised(new Request("https://x.test/library"), new URL("https://x.test/library"), gated)).toBe(false);
  });
});
