// Mic talkover reaches the live feed, measured. Chromium's fake capture device
// plays a known file as the microphone; the console goes live with a 440 Hz
// tone on deck A; the Mic key is pressed half way through; the harness's
// ffmpeg writes what ingest received to a WAV, which is analysed here.
//   node scripts/mic-check.mjs <consoleBase> <harnessSidePort> <micTone.wav>
// Expects scripts/live-harness.ts in stand-in mode and a 1500 Hz mic file.
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const [base = "http://127.0.0.1:3102", sidePort = "8300", micFile] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM,
  args: [
    "--autoplay-policy=no-user-gesture-required",
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-audio-capture=${micFile}`,
  ],
});
const context = await browser.newContext({ viewport: { width: 1480, height: 960 }, permissions: ["microphone"] });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const waitPhase = (want, ms) =>
  page.waitForFunction((w) => w.includes(window.__ncLive.state.phase), want, { timeout: ms, polling: 100 }).then(() => true, () => false);

await page.goto(`${base}/?debug`);
await page.waitForSelector("html[data-ui-ready]");
await page.getByRole("radio", { name: "Radio" }).click();
await page.getByRole("tab", { name: "Broadcast" }).click();
await page.evaluate(async () => {
  const a = window.__ncConsole;
  await a.resume();
  const ctx = a.mixer.ctx, sr = ctx.sampleRate, len = sr * 60;
  const buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) d[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / sr);
  }
  await a.loadDecoded(0, buf, { name: "mic-check music" });
  if (!a.deck(0).playing) await a.togglePlay(0);
});

await page.evaluate(() => window.__ncLive.goLive({ countdown: false }));
check("live", await waitPhase(["armed", "on_air"], 12000));
await page.waitForTimeout(6000);
await page.getByRole("button", { name: "Mic", exact: true }).click();
await page.waitForFunction(() => window.__ncConsole.mixer.micActive === true, null, { timeout: 8000 }).catch(() => {});
const micOn = await page.evaluate(() => window.__ncConsole.mixer.micActive);
check("Mic key opened the (fake) microphone", micOn, await page.locator(".nc-top-status").textContent());
const micLabel = await page.locator(".nc-bcast select").nth(1).locator("option").allTextContents();
check("mic input list filled after permission", micLabel.length >= 2, micLabel.join(" | "));
await page.waitForTimeout(6000);
await page.getByRole("button", { name: "Hand back" }).click();
check("handed back", await waitPhase(["ended"], 9000));
await page.getByRole("button", { name: "Mic", exact: true }).click(); // mic off

const side = await (await fetch(`http://127.0.0.1:${sidePort}/`)).json();
const wav = side.files.at(-1)?.file;
check("ingest wrote the session", !!wav, wav);

// --- analysis: Goertzel magnitude of 440 Hz (music) and 1500 Hz (mic) per 0.5 s ---
const b = readFileSync(wav);
const sr = b.readUInt32LE(24), ch = b.readUInt16LE(22);
let off = 12;
while (off < b.length - 8 && b.toString("ascii", off, off + 4) !== "data") off += 8 + b.readUInt32LE(off + 4);
const data = off + 8, frames = Math.floor((b.length - data) / (2 * ch));
const sample = (i) => b.readInt16LE(data + i * 2 * ch) / 32768;
const goertzel = (start, n, f) => {
  const k = (2 * Math.cos((2 * Math.PI * f) / sr));
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) { const s0 = sample(start + i) + k * s1 - s2; s2 = s1; s1 = s0; }
  return Math.sqrt(s1 * s1 + s2 * s2 - k * s1 * s2) / (n / 2);
};
const win = Math.floor(sr / 2), rows = [];
for (let s = 0; s + win <= frames; s += win) rows.push({ t: s / sr, m: goertzel(s, win, 440), v: goertzel(s, win, 1500) });
const db = (x) => (x > 0 ? 20 * Math.log10(x) : -120);
console.log("   t(s)  music440(dB)  mic1500(dB)");
for (const r of rows) console.log(`   ${r.t.toFixed(1).padStart(4)}  ${db(r.m).toFixed(1).padStart(11)}  ${db(r.v).toFixed(1).padStart(11)}`);
const early = rows.filter((r) => r.t >= 1 && r.t < 5);
const late = rows.slice(-6, -1);
const avg = (xs, k) => xs.reduce((a, r) => a + db(r[k]), 0) / Math.max(1, xs.length);
const micBefore = avg(early, "v"), micAfter = avg(late, "v");
const musicBefore = avg(early, "m"), musicAfter = avg(late, "m");
check("no mic in the feed before the Mic key", micBefore < -45, `${micBefore.toFixed(1)} dB`);
check("mic is in the live feed after the Mic key", micAfter > -30, `${micAfter.toFixed(1)} dB`);
check("music ducked about 10 dB under the mic", musicBefore - musicAfter > 7 && musicBefore - musicAfter < 14, `${(musicBefore - musicAfter).toFixed(1)} dB`);
check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
console.log(`\n${pass}/${pass + fail} checks passed`);
await browser.close();
process.exitCode = fail ? 1 : 0;
