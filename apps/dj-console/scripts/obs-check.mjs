// Drives the Visuals tab and the OBS overlay in Chromium. OBS is not running,
// so this verifies the honest disconnected state, not OBS control.
//   node scripts/obs-check.mjs [baseUrl] [screenshotDir]
// Exit code 1 on any failed check.
import { chromium } from "playwright";
const [base = "http://127.0.0.1:3102", shots] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
// Vite optimizes obs-websocket-js on first request and can emit one transient 404;
// a refused WebSocket to an absent OBS is the honest disconnected state, not an error.
const isNoise = (m) => /Failed to load resource|WebSocket connection|ERR_CONNECTION_REFUSED/i.test(m);

// 1. Unconfigured console.
{
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !isNoise(m.text()) && errors.push(m.text()));
  await page.goto(base + "/?debug", { waitUntil: "load" });
  await page.waitForSelector("html[data-ui-ready]");
  await page.evaluate(() => document.fonts.ready);
  await page.getByRole("tab", { name: "Visuals" }).click();
  await page.waitForTimeout(200);
  check("Visuals tab renders", await page.locator(".nc-visuals").isVisible());
  check("says no OBS address is set", /no obs address/i.test(await page.locator(".nc-visuals-note").first().textContent()));
  check("scene controls absent before connect", (await page.locator(".nc-visuals-scenes button").count()) === 0);
  check("top-bar OBS chip hidden when unconfigured", !(await page.locator("header .nc-chip", { hasText: "OBS" }).first().isVisible()));
  if (shots) await page.screenshot({ path: `${shots}/visuals.png`, fullPage: true });
  check("no page errors (unconfigured)", errors.length === 0, errors.slice(0, 2).join(" | "));
  await page.close();
}

// 2. Configured but OBS absent: it must try, fail honestly, and never fake control.
{
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !isNoise(m.text()) && errors.push(m.text()));
  await page.addInitScript(() => {
    localStorage.setItem("ncsound.console.obs.address", "127.0.0.1:4455");
    localStorage.setItem("ncsound.console.obs.password", "");
  });
  await page.goto(base + "/?debug", { waitUntil: "load" });
  await page.waitForSelector("html[data-ui-ready]");
  await page.getByRole("tab", { name: "Visuals" }).click();
  await page.waitForTimeout(1200);
  const status = await page.evaluate(() => window.__ncObs?.state.status);
  check("configured OBS chip appears", await page.locator("header .nc-chip", { hasText: "OBS" }).first().isVisible());
  check("does not claim connected without OBS", status !== "connected", String(status));
  check("no page errors (configured)", errors.length === 0, errors.slice(0, 2).join(" | "));
  await page.close();
}

// 3. Overlay page renders and waits for the console.
{
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && !isNoise(m.text()) && errors.push(m.text()));
  await page.goto(`${base}/?ui=overlay&debug`, { waitUntil: "load" });
  await page.waitForSelector("html[data-ui-ready]", { state: "attached" });
  check("overlay renders", await page.locator(".nc-overlay").isVisible());
  check("overlay waits for the console", /waiting/i.test(await page.locator(".nc-overlay-title").textContent()));
  if (shots) await page.screenshot({ path: `${shots}/overlay.png`, fullPage: false });
  check("no page errors (overlay)", errors.length === 0, errors.slice(0, 2).join(" | "));
  await page.close();
}

await browser.close();
process.exitCode = results.every(Boolean) ? 0 : 1;
