// R2 source: Worker URLs, token header, and the offline cache (fake Cache Storage).
import assert from "node:assert/strict";

const store = new Map<string, Response>();
const mem = new Map<string, string>();
(globalThis as any).location = { origin: "https://console.test" };
(globalThis as any).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
};
(globalThis as any).caches = {
  open: async () => ({
    match: async (req: Request) => store.get(req.url)?.clone(),
    put: async (req: Request, res: Response) => void store.set(req.url, res),
    delete: async (req: Request) => store.delete(req.url),
    keys: async () => [...store.keys()].map((u) => new Request(u)),
  }),
};

const r2 = await import("../src/library/sources/r2");
const cache = await import("../src/library/sources/r2Cache");

let n = 0;
const t = async (name: string, fn: () => Promise<void> | void) => {
  await fn();
  n++;
  console.log("PASS", name);
};

const bytes = (len: number) => new Uint8Array(len).map((_, i) => i % 251);
const okFetch = (log: string[]): typeof fetch => async (input, init) => {
  log.push(String(input) + "|" + JSON.stringify((init as any)?.headers ?? {}));
  const body = bytes(64);
  return new Response(body, { status: 200, headers: { "content-length": "64", "content-type": "audio/mpeg" } });
};

await t("audio URL goes through the Worker and keeps slashes, encodes the rest", () => {
  assert.equal(r2.r2AudioUrl("music/A B/01 - x#1.mp3", "https://api.test"), "https://api.test/audio/music/A%20B/01%20-%20x%231.mp3");
});

await t("no token -> no Authorization header; token -> Bearer", () => {
  assert.deepEqual(r2.r2Headers(), {});
  r2.setR2Token("  abc123  ");
  assert.deepEqual(r2.r2Headers(), { authorization: "Bearer abc123" });
  r2.setR2Token("");
  assert.deepEqual(r2.r2Headers(), {});
});

await t("first load hits the network and is saved; second load is offline", async () => {
  store.clear();
  const log: string[] = [];
  const a = await cache.fetchR2Audio("music/x/1.mp3", okFetch(log));
  assert.equal(a.byteLength, 64);
  assert.equal(log.length, 1);
  assert.equal(await cache.isCachedOffline("music/x/1.mp3"), true);
  const b = await cache.fetchR2Audio("music/x/1.mp3", (() => { throw new Error("offline"); }) as unknown as typeof fetch);
  assert.deepEqual(new Uint8Array(b), new Uint8Array(a));
});

await t("not cached + no network says so by file name", async () => {
  store.clear();
  await assert.rejects(
    cache.fetchR2Audio("music/x/2.mp3", (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch),
    /no network and "2\.mp3" is not saved offline/,
  );
});

await t("401 points at the token setting; 500 is reported; neither is cached", async () => {
  store.clear();
  const mk = (status: number): typeof fetch => (async () => new Response("no", { status })) as unknown as typeof fetch;
  await assert.rejects(cache.fetchR2Audio("a.mp3", mk(401)), /token/);
  await assert.rejects(cache.fetchR2Audio("a.mp3", mk(500)), /\(500\)/);
  assert.equal(await cache.isCachedOffline("a.mp3"), false);
});

await t("a truncated body (length mismatch) is not saved", async () => {
  store.clear();
  const f: typeof fetch = (async () => new Response(bytes(10), { status: 200, headers: { "content-length": "64" } })) as unknown as typeof fetch;
  await cache.fetchR2Audio("short.mp3", f);
  assert.equal(await cache.isCachedOffline("short.mp3"), false);
});

await t("pinOffline downloads missing tracks, reports failures, and is keyed by object key", async () => {
  store.clear();
  const f: typeof fetch = (async (input: RequestInfo | URL) =>
    String(input).includes("bad") ? new Response("x", { status: 404 }) : new Response(bytes(64), { status: 200, headers: { "content-length": "64" } })) as unknown as typeof fetch;
  const seen: number[] = [];
  const p = await cache.pinOffline(["a/1.mp3", "a/bad.mp3", "a/2.mp3"], (x) => seen.push(x.done), 2, f);
  assert.equal(p.done, 3);
  assert.deepEqual(p.failed, ["a/bad.mp3"]);
  assert.equal(p.bytes, 128);
  assert.deepEqual([...(await cache.cachedOfflineKeys())].sort(), ["a/1.mp3", "a/2.mp3"]);
  assert.equal(await cache.removeOffline("a/1.mp3"), true);
  assert.equal(await cache.isCachedOffline("a/1.mp3"), false);
});

await t("token change does not orphan the offline copy", async () => {
  store.clear();
  r2.setR2Token("one");
  await cache.fetchR2Audio("k.mp3", okFetch([]));
  r2.setR2Token("two");
  assert.equal(await cache.isCachedOffline("k.mp3"), true);
  r2.setR2Token("");
});

console.log(`R2 source tests passed (${n})`);
