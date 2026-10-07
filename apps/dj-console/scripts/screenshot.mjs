// Capture full-page screenshots of the console.
//   node scripts/screenshot.mjs <baseUrl> <outDir> [name=path ...]
// Default shot: "console" at "/". Requires the vite dev server to be running.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const [base = "http://127.0.0.1:3102", outDir = "test/screenshots/current", ...pairs] = process.argv.slice(2);
const shots = pairs.length ? pairs.map((p) => { const i = p.indexOf("="); return [p.slice(0, i), p.slice(i + 1)]; }) : [["console", "/"]];
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: 1 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
for (const [name, path] of shots) {
  await page.goto(base + path, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: true });
  await page.screenshot({ path: `${outDir}/${name}-fold.png`, fullPage: false });
  console.log(`saved ${outDir}/${name}.png`);
}
if (errors.length) console.log("page errors:\n  " + errors.join("\n  "));
await browser.close();
