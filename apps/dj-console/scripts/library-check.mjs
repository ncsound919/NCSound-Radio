// Drives the Library tab in Chromium: import, background index, search, queue,
// crate and load-to-deck. Downloads two synthetic WAVs, so no fixtures needed.
//   node scripts/library-check.mjs [baseUrl] [screenshotDir]
// Exit code 1 on any failed check.
import { chromium } from "playwright";

// Hard cap so a stuck wait can never hang the harness.
const watchdog = setTimeout(() => {
  console.log("FAIL  watchdog: check exceeded 100 s");
  process.exit(2);
}, 100000);
watchdog.unref?.();

const [base = "http://127.0.0.1:3102", shots] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

/** A short click track as a 16-bit mono PCM WAV. */
function wav(seconds = 12, bpm = 124, sr = 44100) {
  const n = seconds * sr;
  const data = Buffer.alloc(n * 2);
  const p = 60 / bpm;
  for (let t = 0; t < seconds; t += p) {
    const s = Math.round(t * sr);
    for (let k = 0; k < 3000 && s + k < n; k++) {
      const v = Math.sin(k * 0.2) * Math.exp(-k / 300) * 0.8;
      data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * 32767))), (s + k) * 2);
    }
  }
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + data.length, 4); h.write("WAVE", 8);
  h.write("fmt ", 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sr, 24); h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

await page.goto(base + "/?debug", { waitUntil: "load" });
await page.waitForSelector("html[data-ui-ready]");
await page.evaluate(() => document.fonts.ready);

check("library tab is the Party default", await page.locator(".nc-library").isVisible());
check("empty state shows no rows", (await page.locator(".nc-lib-row").count()) === 0);

const fileInput = page.locator(".nc-library input[type=file]");
await fileInput.setInputFiles([
  { name: "Checker - Alpha.wav", mimeType: "audio/wav", buffer: wav(12, 124) },
  { name: "Checker - Beta.wav", mimeType: "audio/wav", buffer: wav(10, 128) },
]);

// Background indexing must reach "ready" in the Worker without page errors.
await page.waitForFunction(
  () => document.querySelectorAll('.nc-lib-status[data-status="ready"]').length >= 2,
  null,
  { timeout: 45000 },
).catch(() => {});
check("both tracks indexed to ready", (await page.locator('.nc-lib-status[data-status="ready"]').count()) >= 2);

const rows = page.locator(".nc-lib-row");
check("two rows render", (await rows.count()) >= 2);

const firstBpm = await page.locator(".nc-lib-row .nc-lib-bpm").first().textContent();
check("a measured BPM is shown (not '--')", /^\d/.test((firstBpm || "").trim()), `bpm="${firstBpm}"`);
check("analysed key is shown", (await page.locator(".nc-lib-row .nc-lib-key").count()) > 0);

// Search narrows the list.
await page.locator(".nc-lib-search").fill("Alpha");
await page.waitForTimeout(150);
check("search narrows to the matching row", (await page.locator(".nc-lib-row").count()) === 1);
await page.locator(".nc-lib-search").fill("");

// Queue + crate.
await page.locator(".nc-lib-row").first().locator("button").click();
await page.waitForTimeout(100);
check("Up Next receives the track", (await page.locator(".nc-lib-queue, .nc-lib-item").count()) >= 1);
await page.locator(".nc-lib-crate-name").fill("check-crate");
await page.getByRole("button", { name: "Save" }).click();
await page.waitForTimeout(100);
check("crate saved", (await page.locator(".nc-lib-item").filter({ hasText: "check-crate" }).count()) >= 1);

// Double-click loads to the idle deck, using the cached analysis.
await page.locator(".nc-lib-row").first().dblclick();
await page.waitForFunction(
  () => {
    const t = document.querySelector('.nc-deck[data-deck="a"] .nc-deck-title');
    return !!t && t.textContent && !/No track/.test(t.textContent);
  },
  null,
  { timeout: 20000 },
).catch(() => {});
const deckTitle = await page.locator('.nc-deck[data-deck="a"] .nc-deck-title').textContent();
check("load to deck A sets the title", !!deckTitle && !/No track/.test(deckTitle), `title="${deckTitle}"`);
check("loaded track carries a waveform", await page.evaluate(() => !!window.__ncConsole.tracks[0]?.waveform?.length));

// Up Next: "Load next" must consume the head, not reload it.
const upNext = page.locator('ul[aria-label="Up Next queue"] li');
await page.getByRole("button", { name: "Clear" }).click();
await page.locator(".nc-lib-row").nth(0).locator("button").click();
await page.locator(".nc-lib-row").nth(1).locator("button").click();
await page.waitForTimeout(150);
const queueBefore = await upNext.count();
check("Up Next holds both queued tracks", queueBefore === 2, `count=${queueBefore}`);
await page.getByRole("button", { name: "Load next" }).click();
await page.waitForTimeout(500);
const queueAfter = await upNext.count();
check("Load next consumes the queue head", queueAfter === queueBefore - 1, `${queueBefore} -> ${queueAfter}`);

if (shots) await page.screenshot({ path: `${shots}/library.png`, fullPage: true });
check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));

await browser.close();
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
