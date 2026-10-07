// Drives the FX tab in Chromium and asserts the controls reach the engine.
//   node scripts/fx-check.mjs [baseUrl] [screenshotDir]
// Exit code 1 on any failed check.
import { chromium } from "playwright";
const [base = "http://127.0.0.1:3102", shots] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const results = [];
const check = (name, ok, detail = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };

await page.goto(base + "/?debug", { waitUntil: "load" });
await page.waitForSelector("html[data-ui-ready]");
await page.evaluate(() => document.fonts.ready);
await page.getByRole("tab", { name: "FX" }).click();
await page.waitForTimeout(200);

const unit0 = page.locator(".nc-fx-unit").first();
const state = () => page.evaluate(() => window.__ncConsole.mixer.fx.units[0].state());

check("FX tab selects", await unit0.isVisible());
check("two units render", (await page.locator(".nc-fx-unit").count()) === 2);
check("default unit is bypassed echo", JSON.stringify(await state()).includes('"target":null'));

await unit0.getByRole("button", { name: "Effect Reverb" }).click();
check("effect picker sets reverb", (await state()).kind === "reverb");

await unit0.getByRole("button", { name: "On", exact: true }).click();
check("on key opens the send", (await state()).on === true);

await unit0.getByRole("button", { name: "Route FX 1" }).click();
const s = await state();
check("route cycles Off -> Deck A", s.target === "A");
check("unit is patched into slot A", await page.evaluate(() => window.__ncConsole.mixer.fx.slots.A.unit === window.__ncConsole.mixer.fx.units[0]));

// Second unit cycles Off -> A -> B. Passing through A evicts unit 1, which must
// report itself unrouted; putting unit 1 back on A then leaves both buses used.
const unit1 = page.locator(".nc-fx-unit").nth(1);
const route2 = unit1.getByRole("button", { name: "Route FX 2" });
await route2.click(); // A (evicts unit 1)
await route2.click(); // B
check("evicted unit reports no route", (await page.evaluate(() => window.__ncConsole.mixer.fx.units[0].state().target)) === null);
check("second unit lands on slot B", await page.evaluate(() => window.__ncConsole.mixer.fx.slots.B.unit === window.__ncConsole.mixer.fx.units[1]));
await unit0.getByRole("button", { name: "Route FX 1" }).click(); // Off -> A again
check("both buses hold a unit independently", await page.evaluate(() =>
  window.__ncConsole.mixer.fx.slots.A.unit === window.__ncConsole.mixer.fx.units[0] &&
  window.__ncConsole.mixer.fx.slots.B.unit === window.__ncConsole.mixer.fx.units[1]));

// Wet knob is a real slider wired to the engine.
const wet = unit0.getByRole("slider", { name: "Wet" });
await wet.focus();
await page.keyboard.press("Home");
check("wet knob reaches 0 in the engine", (await state()).wet === 0);
await page.keyboard.press("End");
check("wet knob reaches 1 in the engine", (await state()).wet === 1);

if (shots) await page.screenshot({ path: `${shots}/fx-tab.png`, fullPage: true });
check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
await browser.close();
process.exitCode = results.every(Boolean) ? 0 : 1;
