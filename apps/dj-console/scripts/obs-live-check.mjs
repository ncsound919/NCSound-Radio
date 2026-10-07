// Live-OBS acceptance for the console's OBS integration (plan phase 6).
// Unlike obs-check.mjs (which asserts the honest disconnected state), this
// needs a running OBS with obs-websocket enabled and drives real scenes.
//
//   OBS_PASSWORD=... node scripts/obs-live-check.mjs [baseUrl]
//
// Exits 1 on any failed check. If OBS is not reachable it prints SKIP and exits
// 0, so a machine without OBS is not treated as a failure.
import { chromium } from "playwright";
import OBSWebSocket from "obs-websocket-js";

const [base = "http://127.0.0.1:3102"] = process.argv.slice(2);
const ADDRESS = process.env.OBS_ADDRESS ?? "127.0.0.1:4455";
const PASSWORD = process.env.OBS_PASSWORD ?? "";
const TEST_SCENE = "NC Acceptance";

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

const obs = new OBSWebSocket();
try {
  await obs.connect(`ws://${ADDRESS}`, PASSWORD || undefined);
} catch (e) {
  console.log(`SKIP  OBS not reachable at ${ADDRESS}: ${e instanceof Error ? e.message : e}`);
  process.exit(0);
}
const version = await obs.call("GetVersion");
console.log(`OBS ${version.obsVersion} connected at ${ADDRESS}`);

let browser;
let createdScene = false;
let priorScene = null;
try {
  // Make a scene to prove the console reads what OBS reports, not a fixed list.
  const before = await obs.call("GetSceneList");
  priorScene = before.currentProgramSceneName;
  if (!before.scenes.some((s) => s.sceneName === TEST_SCENE)) {
    await obs.call("CreateScene", { sceneName: TEST_SCENE });
    createdScene = true;
  }

  browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.addInitScript(
    ([addr, pw]) => {
      localStorage.setItem("ncsound.console.obs.address", addr);
      localStorage.setItem("ncsound.console.obs.password", pw);
    },
    [ADDRESS, PASSWORD],
  );
  await page.goto(base + "/?debug", { waitUntil: "load" });
  await page.waitForSelector("html[data-ui-ready]");

  // Wait for the console to actually report connected (read back, not assumed).
  await page
    .waitForFunction(() => window.__ncObs?.state.status === "connected", null, { timeout: 8000 })
    .catch(() => {});
  const status = await page.evaluate(() => window.__ncObs?.state.status);
  check("console connects to a live OBS", status === "connected", String(status));

  await page.getByRole("tab", { name: "Visuals" }).click();
  await page.waitForTimeout(300);

  // Scenes are read back; the test scene we created must appear.
  const scenes = await page.evaluate(() => window.__ncObs?.state.scenes ?? []);
  check("scene list is read back from OBS", Array.isArray(scenes) && scenes.includes(TEST_SCENE), scenes.join(", "));
  check("scene buttons rendered", (await page.locator(".nc-visuals-scenes button").count()) >= 1);

  // Switching a scene from the console must change OBS's program scene.
  await page.evaluate((name) => window.__ncObs.setScene(name), TEST_SCENE);
  await page.waitForTimeout(500);
  const now = await obs.call("GetSceneList");
  check("console switches OBS's program scene", now.currentProgramSceneName === TEST_SCENE, String(now.currentProgramSceneName));

  // The stream control is a real read-back: it starts enabled when connected
  // and never claims "streaming" without OBS confirming it.
  const streamBtn = page.locator(".nc-visuals-row button", { hasText: /stream|live/i }).first();
  check("stream control enabled when connected", await streamBtn.isEnabled());
  const before0 = await page.evaluate(() => window.__ncObs?.state.streaming);
  await page.evaluate(() => window.__ncObs.startStream());
  await page.waitForTimeout(7500);
  const streaming = await page.evaluate(() => window.__ncObs?.state.streaming);
  if (streaming) {
    // A stream key was configured: prove it really started, then stop it.
    const st = await obs.call("GetStreamStatus");
    check("start stream reflects OBS status", st.outputActive === true);
    await page.evaluate(() => window.__ncObs.stopStream());
    await page.waitForTimeout(1500);
    check("stop stream reflects OBS status", (await page.evaluate(() => window.__ncObs?.state.streaming)) === false);
  } else {
    // No stream key: OBS refuses and the console must say so, not fake it.
    const msg = await page.evaluate(() => window.__ncObs?.state.message ?? "");
    check("a refused start is reported, never faked live", before0 === false && msg.length > 0, msg.slice(0, 80));
  }

  check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));
} finally {
  try {
    const now = await obs.call("GetSceneList");
    if (priorScene && now.currentProgramSceneName !== priorScene) {
      await obs.call("SetCurrentProgramScene", { sceneName: priorScene }).catch(() => {});
    }
    if (createdScene) await obs.call("RemoveScene", { sceneName: TEST_SCENE }).catch(() => {});
  } catch {
    /* best-effort cleanup */
  }
  if (browser) await browser.close();
  await obs.disconnect().catch(() => {});
}

process.exitCode = results.every(Boolean) ? 0 : 1;
