// 2-hour soak (plan 8.6): two decks looping, sampler firing, recording on,
// watching JS-heap growth, audio-context state, the longest frame, and errors.
//   node scripts/soak.mjs <baseUrl> <trackA> <trackB> [--dur=7200] [report.jsonl]
// A short --dur (e.g. --dur=90) is a smoke check; the real run is --dur=7200.
import { chromium } from "playwright";
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const [base, fileA, fileB, reportPath = "test/soak.jsonl"] = args.filter((a) => !a.startsWith("--"));
const durSec = Number((args.find((a) => a.startsWith("--dur=")) ?? "").slice(6) || 7200);

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM, args: ["--autoplay-policy=no-user-gesture-required", "--enable-precise-memory-info"] });
const page = await browser.newPage({ viewport: { width: 1480, height: 960 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(base + "/?debug", { waitUntil: "load" });
await page.waitForSelector("html[data-ui-ready]");
await page.evaluate(() => document.fonts.ready);

const deck = (n) => page.locator(`section.nc-deck[data-deck="${n}"]`);
await deck("a").locator("input[type=file]").setInputFiles(fileA);
await deck("a").locator(".nc-deck-title").filter({ hasNotText: "No track loaded" }).waitFor({ timeout: 20000 });
await deck("b").locator("input[type=file]").setInputFiles(fileB);
await deck("b").locator(".nc-deck-title").filter({ hasNotText: "No track loaded" }).waitFor({ timeout: 20000 });

await deck("a").getByRole("button", { name: "PLAY" }).click();
await page.getByRole("slider", { name: "Crossfader" }).focus();
await page.keyboard.press("Home");
for (let i = 0; i < 5; i++) await page.keyboard.press("PageUp"); // centre
await deck("b").getByRole("button", { name: "SYNC" }).click();
await deck("b").getByRole("button", { name: "PLAY" }).click();

// Keep both decks looping so audio plays for the whole soak (not just the
// track length): engage a 4-bar loop on each once and leave it.
await deck("a").getByRole("button", { name: /^Loop/ }).click();
await deck("b").getByRole("button", { name: /^Loop/ }).click();

// REC on.
await page.getByRole("button", { name: "REC" }).click();
await page.waitForTimeout(1500);

// Steady-state longest-frame tracker (reset after the load/start spike, so the
// reported figure is not the one-off decode freeze).
await page.evaluate(() => {
  window.__soakFrame = { longest: 0, window: 0, stateChanges: 0 };
  window.__ncConsole.mixer.ctx.addEventListener("statechange", () => { window.__soakFrame.stateChanges++; });
  let last = performance.now();
  (function tick(t) { const g = t - last; last = t; if (g > window.__soakFrame.longest) window.__soakFrame.longest = g; if (g > window.__soakFrame.window) window.__soakFrame.window = g; requestAnimationFrame(tick); })(performance.now());
});

writeFileSync(reportPath, "");
const t0 = Date.now();
let pad = 0;
let maxHeap = 0;
const report = (row) => appendFileSync(reportPath, JSON.stringify(row) + "\n");

while ((Date.now() - t0) / 1000 < durSec) {
  await page.waitForTimeout(15000);
  const elapsed = Math.round((Date.now() - t0) / 1000);
  // Exercise the engine: a sampler hit each tick, cycling pads.
  await page.evaluate((p) => window.__ncConsole.sampler.trigger(0, p % 4, { velocity: 1 }), pad++);
  const m = await page.evaluate(() => ({
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null,
    peakDb: window.__ncConsole.mixer.getMasterTelemetry().masterPeakDb,
    state: window.__ncConsole.mixer.ctx.state,
    rec: window.__ncConsole.mixer.getMasterTelemetry().recordingActive,
    longestFrameMs: Math.round(window.__soakFrame.longest),
    windowFrameMs: Math.round(window.__soakFrame.window),
    stateChanges: window.__soakFrame.stateChanges,
  }));
  await page.evaluate(() => { window.__soakFrame.window = 0; });
  m.elapsed = elapsed;
  if (m.heapMB != null) maxHeap = Math.max(maxHeap, m.heapMB);
  report(m);
  console.log(`t=${elapsed}s heap=${m.heapMB}MB peak=${m.peakDb}dB state=${m.state} rec=${m.rec} longestFrame=${m.longestFrameMs}ms`);
}

// Stop recording and summarise.
await page.getByRole("button", { name: "REC" }).click();
const summary = { durSec, maxHeapMB: maxHeap, pageErrors: errors.length, errors: errors.slice(0, 10) };
console.log("SUMMARY " + JSON.stringify(summary));
await browser.close();
process.exitCode = errors.length ? 1 : 0;
