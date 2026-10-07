// End-to-end go-live on a REAL station chain:
//   console (Chromium) -> vite proxy -> ingest (real, harness --real)
//   -> ffmpeg -> Liquidsoap 2.2 harbor "live" (the repo's ncsound.liq)
//   -> Icecast /live.mp3 -> listener probe (scripts/station-probe.py)
// Only the autopilot feed is a stand-in (ffmpeg pushing a 660 Hz tone into
// the "dj" harbor where the engine normally publishes).
//
//   node scripts/station-e2e.mjs <consoleBase> <harnessSidePort> <events.json>
// Writes wall-clock event times; scripts/station-e2e-report.py correlates
// them with what the probe heard.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const [base = "http://127.0.0.1:3102", sidePort = "8300", outFile = "events.json"] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1480, height: 960 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const events = [];
const mark = (name, extra = {}) => {
  const e = { name, t: Date.now(), ...extra };
  events.push(e);
  console.log(`${new Date(e.t).toISOString().slice(11, 23)}  ${name}${Object.keys(extra).length ? " " + JSON.stringify(extra) : ""}`);
};
const phase = () => page.evaluate(() => window.__ncLive.state.phase);
const waitPhase = async (want, ms) => {
  try {
    await page.waitForFunction((w) => w.includes(window.__ncLive.state.phase), want, { timeout: ms, polling: 50 });
    return true;
  } catch {
    return false;
  }
};
const side = (path, init) => fetch(`http://127.0.0.1:${sidePort}${path}`, init).then((r) => r.json());

await page.goto(`${base}/?debug`);
await page.waitForSelector("html[data-ui-ready]");
await page.getByRole("radio", { name: "Radio" }).click();
await page.getByRole("tab", { name: "Broadcast" }).click();

// Deck A: 440 Hz (the console). Deck B: 523 Hz marker, cued, crossfader hard A.
await page.evaluate(async () => {
  const a = window.__ncConsole;
  await a.resume();
  const ctx = a.mixer.ctx, sr = ctx.sampleRate;
  const tone = (f) => {
    const len = sr * 240, buf = ctx.createBuffer(2, len, sr);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      for (let i = 0; i < len; i++) d[i] = 0.3 * Math.sin((2 * Math.PI * f * i) / sr);
    }
    return buf;
  };
  await a.loadDecoded(0, tone(440), { name: "console 440" });
  await a.loadDecoded(1, tone(523), { name: "marker 523" });
  a.mixer.setCrossfader(-1);
  if (!a.deck(0).playing) await a.togglePlay(0);
});
mark("console_playing_440");
await page.waitForTimeout(4000);

/* 1. Go live */
mark("go_live_pressed");
await page.evaluate(() => window.__ncLive.goLive({ countdown: false }));
if (await waitPhase(["armed"], 15000)) mark("armed_sending");
if (await waitPhase(["on_air"], 20000)) mark("console_says_on_air");
else mark("never_on_air", { phase: await phase(), msg: await page.evaluate(() => window.__ncLive.state.message) });
await page.waitForTimeout(5000);

/* 2. Delay marker: cut to deck B (523 Hz) at a known instant. */
await page.evaluate(async () => {
  const a = window.__ncConsole;
  if (!a.deck(1).playing) await a.togglePlay(1);
  a.mixer.setCrossfader(1);
});
mark("marker_523_cut");
await page.waitForTimeout(8000);
const s1 = await page.evaluate(() => window.__ncLive.state);
mark("health", { sendKbps: s1.sendKbps, behindSec: s1.server?.driftMeasured ? -s1.server.driftSec : null, ingestKbps: s1.server ? Math.round(s1.server.bytesPerSec * 8 / 1000) : null });

/* 3. Stall: ingest stops receiving audio, every socket stays open (a venue
      network that silently stops delivering). */
await side("/stall?on=1", { method: "POST" });
mark("stall_started");
if (await waitPhase(["lost"], 25000)) mark("console_says_lost", { msg: await page.evaluate(() => window.__ncLive.state.message) });
await side("/stall?on=0", { method: "POST" });
mark("stall_cleared");
if (await waitPhase(["on_air"], 30000)) mark("rejoined_on_air", { attempts: await page.evaluate(() => window.__ncLive.state.attempts) });
await page.waitForTimeout(5000);

/* 4. Drop: the live socket closes (Wi-Fi gone, laptop lid). */
await page.evaluate(() => window.__ncLive.socket.close(4000, "e2e drop"));
mark("socket_dropped");
if (await waitPhase(["lost"], 5000)) mark("console_says_lost_2");
if (await waitPhase(["on_air"], 30000)) mark("rejoined_on_air_2");
await page.waitForTimeout(5000);

/* 5. Hand back. */
await page.getByRole("button", { name: "Hand back" }).click();
mark("hand_back_pressed");
if (await waitPhase(["ended"], 10000)) mark("console_says_ended");
await page.waitForTimeout(6000);

const snap = await side("/");
mark("bridge_final", { state: snap.live.state, error: snap.live.error });
mark("page_errors", { count: errors.length, first: errors[0] ?? null });
writeFileSync(outFile, JSON.stringify(events, null, 1));
await browser.close();
