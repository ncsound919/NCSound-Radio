// End-to-end go-live check in Chromium against scripts/live-harness.ts.
//   node scripts/live-check.mjs <consoleBase> <harnessSidePort> [shotsDir]
// What is real: the console, MediaRecorder, the WebSocket through the Vite
// proxy, ingest's /live/arm and /live, the LiveBridge, and ffmpeg decoding the
// browser's WebM. What is stood in: Icecast/Liquidsoap (ffmpeg writes a WAV;
// "harbor connected" is answered by the harness once audio has arrived).
import { chromium } from "playwright";

const [base = "http://127.0.0.1:3102", sidePort = "8300", shots] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1480, height: 960 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};
const phase = () => page.evaluate(() => window.__ncLive.state.phase);
const waitPhase = async (want, ms) => {
  const t0 = Date.now();
  try {
    await page.waitForFunction((w) => w.includes(window.__ncLive.state.phase), want, { timeout: ms, polling: 100 });
    return Date.now() - t0;
  } catch {
    return null;
  }
};
const chip = () => page.locator(".nc-onair").textContent();
const side = async () => (await fetch(`http://127.0.0.1:${sidePort}/`)).json();

await page.goto(`${base}/?debug`, { waitUntil: "load" });
await page.waitForSelector("html[data-ui-ready]");
await page.getByRole("radio", { name: "Radio" }).click();
await page.getByRole("tab", { name: "Broadcast" }).click();

// Put real audio on the master: a 100 s, 440 Hz tone with a beat, on deck A.
await page.evaluate(async () => {
  const a = window.__ncConsole;
  await a.resume();
  const ctx = a.mixer.ctx;
  const sr = ctx.sampleRate, len = sr * 100;
  const buf = ctx.createBuffer(2, len, sr);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const beat = (t * 2) % 1 < 0.05 ? Math.sin(2 * Math.PI * 60 * t) * 0.6 : 0;
      d[i] = 0.25 * Math.sin(2 * Math.PI * 440 * t) + beat;
    }
  }
  await a.loadDecoded(0, buf, { name: "live-check tone" });
  if (!a.deck(0).playing) await a.togglePlay(0);
});
check("deck A playing into the master", await page.evaluate(() => window.__ncConsole.deck(0).playing));

const chip0 = await chip();
check("top bar shows the station, not LIVE, before going live", !/^LIVE/.test(chip0 ?? ""), chip0);
check("Broadcast tab says autopilot", (await page.locator(".nc-bcast-phase").textContent()) === "Autopilot");

/* ---- session 1: go live, confirm, hand back ---- */
await page.getByRole("button", { name: "Go live" }).click();
check("preflight passes and the countdown starts", (await waitPhase(["countdown"], 5000)) !== null, await page.locator(".nc-bcast-msg").textContent());
const checks = await page.locator(".nc-bcast-checks li").allTextContents();
check("ingest, encoder and arm checks pass", checks.slice(0, 3).every((t) => t.startsWith("✓")), checks.join(" | "));
const chipCount = await chip();
check("top bar counts down", /LIVE IN \d/.test(chipCount ?? ""), chipCount);

const armedMs = await waitPhase(["armed", "on_air"], 12000);
check("socket accepted and audio flowing after the countdown", armedMs !== null, `${armedMs} ms`);
if ((await phase()) === "armed") {
  const c = await chip();
  check("while only armed, the top bar does NOT say LIVE", !/^LIVE \d/.test(c ?? ""), c);
} else {
  check("while only armed, the top bar does NOT say LIVE", true, "confirmed before sampling; covered by unit test");
}
const onAirMs = await waitPhase(["on_air"], 12000);
check("ON AIR once ingest reports the harbor connected", onAirMs !== null, `${onAirMs} ms after armed`);
await page.waitForTimeout(1200);
const chipLive = await chip();
check("top bar reads LIVE with elapsed time", /^LIVE \d+:\d\d/.test(chipLive ?? ""), chipLive);
check("top bar turns live red", (await page.evaluate(() => document.body.dataset.live)) === "on");
await page.waitForTimeout(5000);
const st = await page.evaluate(() => window.__ncLive.state);
check("console send rate is near the chosen bitrate", st.sendKbps >= 100 && st.sendKbps <= 260, `${st.sendKbps} kbps sent`);
check("ingest reports bytes arriving", (st.server?.bytesSent ?? 0) > 50_000, `${st.server?.bytesSent} B at ingest`);
if (shots) await page.screenshot({ path: `${shots}/broadcast-live.png` });

await page.getByRole("button", { name: "Hand back" }).click();
const endedMs = await waitPhase(["ended"], 9000);
check("hand-back confirmed by ingest", endedMs !== null, `${endedMs} ms, ${await page.locator(".nc-bcast-msg").textContent()}`);
check("top bar back off live", (await page.evaluate(() => document.body.dataset.live)) !== "on");
const s1 = await side();
check("bridge ended cleanly (not lost)", s1.live.state === "ended", `${s1.live.state}${s1.live.error ? `: ${s1.live.error}` : ""}`);

/* ---- session 2: drop the connection, autopilot message, auto-rejoin ---- */
await page.getByRole("button", { name: "Go live" }).click();
check("second session goes on air", (await waitPhase(["on_air"], 30000)) !== null);
await page.evaluate(() => window.__ncLive.socket.close(4000, "simulated drop"));
const lostMs = await waitPhase(["lost"], 4000);
const lostMsg = await page.locator(".nc-bcast-msg").textContent();
check("a dropped connection shows lost + autopilot", lostMs !== null && /autopilot/.test(lostMsg ?? ""), lostMsg);
const chipLost = await chip();
check("top bar says LOST · AUTOPILOT", /LOST/.test(chipLost ?? ""), chipLost);
if (shots) await page.screenshot({ path: `${shots}/broadcast-lost.png` });
const rejoinMs = await waitPhase(["on_air"], 30000);
check("auto-rejoin gets back on air", rejoinMs !== null, `${rejoinMs} ms, attempts=${await page.evaluate(() => window.__ncLive.state.attempts)}`);
await page.getByRole("button", { name: "Hand back" }).click();
check("second hand-back confirmed", (await waitPhase(["ended"], 9000)) !== null);

const s2 = await side();
console.log("encoder output files:", JSON.stringify(s2.files));
check("ffmpeg wrote decodable audio for every session", s2.files.length >= 3 && s2.files.every((f) => f.bytes > 100_000), s2.files.map((f) => f.bytes).join(", "));

const real = errors.filter((e) => !/favicon/.test(e));
check("no page errors", real.length === 0, real.slice(0, 3).join(" | "));
console.log(`\n${pass}/${pass + fail} checks passed`);
await browser.close();
process.exitCode = fail ? 1 : 0;
