// Drives the Sampler tab in Chromium and asserts the pads reach the engine.
//   node scripts/sampler-check.mjs [baseUrl] [screenshotDir]
// Exit code 1 on any failed check.
import { chromium } from "playwright";
const [base = "http://127.0.0.1:3102", shots] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

await page.goto(base + "/?debug", { waitUntil: "load" });
await page.waitForSelector("html[data-ui-ready]");
await page.evaluate(() => document.fonts.ready);
await page.getByRole("tab", { name: "Sampler" }).click();
await page.waitForTimeout(500);

const hasDefault = await page.evaluate(() => {
  const s = window.__ncConsole.sampler;
  return s.hasBuffer(0, 0) && s.getPad(0, 0).name.length > 0;
});
check("default bank A loads the club sounds", hasDefault, await page.evaluate(() => window.__ncConsole.sampler.getPad(0, 0).name));

// Click a pad -> a voice is created.
await page.locator(".nc-sampler-grid .nc-pad").first().click();
const voices = await page.evaluate(() => window.__ncConsole.sampler.activeCount());
check("clicking a pad triggers a voice", voices > 0, `${voices} voice(s)`);

// Bank switch changes the grid to an empty bank.
await page.getByRole("button", { name: "Sampler bank B" }).click();
const bankBEmpty = await page.evaluate(() => !window.__ncConsole.sampler.hasBuffer(1, 0));
check("bank B is empty", bankBEmpty);

// Shift-click opens the editor.
await page.getByRole("button", { name: "Sampler bank A" }).click();
await page.locator(".nc-sampler-grid .nc-pad").nth(1).click({ modifiers: ["Shift"] });
await page.waitForTimeout(150);
check("Shift-click opens the pad editor", await page.locator(".nc-sampler-editor").isVisible());

// Gain knob reaches the engine for the selected pad.
const gain = page.locator(".nc-sampler-editor").getByRole("slider", { name: "Gain" });
await gain.focus();
await page.keyboard.press("Home");
check("gain knob reaches the engine", await page.evaluate(() => window.__ncConsole.sampler.getPad(0, 1).gain === 0));

// MIDI bank B velocity path (simulate the mapper output).
const played = await page.evaluate(() => window.__ncConsole.sampler.trigger(0, 2, { velocity: 0.5 }) != null);
check("velocity trigger reaches the engine", played);

// Settings panel opens and lists outputs.
await page.getByRole("button", { name: "Settings" }).click();
await page.waitForTimeout(200);
check("settings panel opens", await page.locator(".nc-settings").isVisible());
check("master output select renders", await page.getByRole("combobox", { name: "Master output device" }).isVisible());

// CUE keys exist in the mixer.
check("mixer has per-deck CUE keys", (await page.getByRole("button", { name: /^Cue [AB]$/ }).count()) === 2);

if (shots) {
  await page.getByRole("tab", { name: "Sampler" }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${shots}/sampler-tab.png`, fullPage: true });
  await page.getByRole("button", { name: "Settings" }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${shots}/settings.png`, fullPage: false });
}
check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
process.exitCode = results.every(Boolean) ? 0 : 1;
