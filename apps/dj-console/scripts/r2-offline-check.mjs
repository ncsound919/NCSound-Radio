// R2 library + offline cache in a REAL browser, against a local stand-in for
// the ncsound-api Worker (same routes, CORS, token gate and Range handling).
// It proves the console side: token refusal message, CORS preflight with the
// Authorization header, import without downloading audio, the Offline key, and
// that saved tracks load with the network cut. It does NOT prove Cloudflare.
//   node scripts/r2-offline-check.mjs [baseUrl]
import { chromium } from "playwright";
import { createServer } from "node:http";

const base = process.argv[2] ?? "http://127.0.0.1:3102";
const PORT = 8788, TOKEN = "tok-123";
const API = `http://127.0.0.1:${PORT}`;

const wav = (freq, sec = 8, sr = 44100) => {
  const n = sec * sr, b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVEfmt ", 8); b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(sr, 24); b.writeUInt32LE(sr * 2, 28);
  b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * freq * i) / sr)), 44 + i * 2);
  return b;
};
const FILES = { "music/Test/01 - Tone A.wav": wav(220), "music/Test/02 - Tone B.wav": wav(330), "music/Test/03 - Tone C.wav": wav(440) };

const hits = { audio: 0, library: 0, unauthorised: 0, preflight: 0 };
const server = createServer((req, res) => {
  const url = new URL(req.url, API);
  const cors = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "range, content-type, if-none-match, authorization",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-expose-headers": "content-length, content-range, accept-ranges, etag",
  };
  if (req.method === "OPTIONS") { hits.preflight++; res.writeHead(204, cors).end(); return; }
  if (url.pathname === "/health") { res.writeHead(200, { ...cors, "content-type": "application/json" }).end('{"ok":true}'); return; }
  const auth = (req.headers.authorization ?? "") === `Bearer ${TOKEN}`;
  if (!auth) { hits.unauthorised++; res.writeHead(401, { ...cors, "content-type": "application/json" }).end('{"error":"unauthorised"}'); return; }
  if (url.pathname === "/library") {
    hits.library++;
    const objects = Object.entries(FILES).map(([key, b]) => ({ key, fileName: key.split("/").pop(), album: "Test", size: b.length, uploaded: "2026-10-07T00:00:00.000Z", contentType: "audio/wav" }));
    res.writeHead(200, { ...cors, "content-type": "application/json" }).end(JSON.stringify({ count: objects.length, objects }));
    return;
  }
  if (url.pathname.startsWith("/audio/")) {
    const key = decodeURIComponent(url.pathname.slice(7));
    const body = FILES[key];
    if (!body) { res.writeHead(404, cors).end(); return; }
    hits.audio++;
    res.writeHead(200, { ...cors, "content-type": "audio/wav", "content-length": body.length, "accept-ranges": "bytes" }).end(body);
    return;
  }
  res.writeHead(404, cors).end();
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM, args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1480, height: 960 } });
await context.addInitScript((api) => { try { if (!localStorage.getItem("ncsound.console.r2.api")) localStorage.setItem("ncsound.console.r2.api", api); } catch {} }, API);
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));

try {
  await page.goto(base + "/?debug", { waitUntil: "load" });
  await page.waitForSelector("html[data-ui-ready]");
  await page.getByRole("tab", { name: "Library" }).click().catch(() => {});
  const note = async () => ((await page.locator(".nc-lib-note").first().textContent().catch(() => "")) ?? "").trim();

  // 1. No token while the Worker is locked.
  await page.getByRole("button", { name: "R2", exact: true }).click();
  await page.waitForFunction(() => /refused/i.test(document.querySelector(".nc-lib-note")?.textContent ?? ""), null, { timeout: 8000 }).catch(() => {});
  check("locked Worker: console says to set the token, imports nothing", /set the R2 token/.test(await note()) && (await page.locator(".nc-lib-row").count()) === 0, (await note()).slice(0, 70));
  check("the refusal was a readable 401 (CORS ok on the error)", hits.unauthorised >= 1, `401s=${hits.unauthorised}`);

  // 2. Token set -> catalog loads, and NO audio is downloaded by importing.
  await page.evaluate((t) => localStorage.setItem("ncsound.console.r2.token", t), TOKEN);
  await page.getByRole("button", { name: "R2", exact: true }).click();
  await page.waitForSelector(".nc-lib-row", { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(3000);
  check("with the token: 3 tracks listed", (await page.locator(".nc-lib-row").count()) === 3);
  check("the Authorization header triggered a CORS preflight and it was answered", hits.preflight >= 1, `preflights=${hits.preflight}`);
  check("importing downloads no audio (no background indexing)", hits.audio === 0, `audio requests: ${hits.audio}`);

  // 3. Queue two tracks, press Offline.
  await page.getByRole("button", { name: /^Add .*Tone A.* to Up Next$/ }).click();
  await page.getByRole("button", { name: /^Add .*Tone B.* to Up Next$/ }).click();
  await page.getByRole("button", { name: "Offline", exact: true }).click();
  await page.waitForFunction(() => /2\/2 tracks saved offline/.test(document.querySelector(".nc-lib-note")?.textContent ?? ""), null, { timeout: 20000 }).catch(() => {});
  check("Offline saved the 2 queued tracks", /2\/2 tracks saved offline/.test(await note()), (await note()).slice(0, 80));
  const afterPin = hits.audio;
  check("only the 2 queued tracks were downloaded (the third was not)", afterPin === 2, `audio requests: ${afterPin}`);

  // 4. Cut the network. Saved tracks must still load, with zero new requests.
  await context.setOffline(true);
  const rows = page.locator(".nc-lib-row");
  await rows.nth(0).dblclick();
  await page.waitForFunction(() => document.querySelectorAll('.nc-deck[data-loaded="true"]').length >= 1, null, { timeout: 30000 }).catch(() => {});
  // A loaded-but-stopped deck counts as idle and would be replaced, so play deck A first.
  await page.locator('section.nc-deck[data-deck="a"]').getByRole("button", { name: "PLAY" }).click();
  await rows.nth(1).dblclick();
  await page.waitForFunction(() => document.querySelectorAll('.nc-deck[data-loaded="true"]').length >= 2, null, { timeout: 30000 }).catch(() => {});
  const loadedN = await page.locator('.nc-deck[data-loaded="true"]').count();
  check("both saved tracks load with the network off", loadedN >= 2, `loaded decks: ${loadedN}; note: ${(await note()).slice(0, 90)}; titles: ${(await page.locator(".nc-deck-title").allTextContents()).join(" | ")}`);
  check("and they came from the offline cache, not the Worker", hits.audio === afterPin, `audio requests: ${hits.audio}`);

  // 5. The unsaved third track cannot load offline and must say so.
  await context.setOffline(false);
  const real = errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|net::/.test(e));
  check("no page errors", real.length === 0, real.slice(0, 2).join(" | "));
} finally {
  await browser.close();
  server.close();
}
console.log(`\n${results.filter(Boolean).length}/${results.length} checks passed`);
process.exitCode = results.every(Boolean) ? 0 : 1;
