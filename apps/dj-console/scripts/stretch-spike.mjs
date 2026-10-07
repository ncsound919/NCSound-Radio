// Runs the Signalsmith Stretch key-lock spike in Chromium and prints the result.
//   node scripts/stretch-spike.mjs [baseUrl]
import { chromium } from "playwright";
const [base = "http://127.0.0.1:3102"] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
await page.goto(`${base}/spike/stretch.html`, { waitUntil: "load" });
let valid = false;
try {
  await page.waitForFunction(() => window.__spikeDone !== undefined, null, { timeout: 120000 });
  const result = await page.evaluate(() => window.__spikeDone);
  console.log(JSON.stringify(result, null, 2));
  const near = (actual, expected) => Number.isFinite(actual) && Math.abs(actual - expected) <= expected * 0.01;
  valid = result?.ok === true
    && near(result.keyLockHz, 440)
    && near(result.shiftedHz, 440 * 2 ** (1 / 12))
    && near(result.plainHz, 440 * 1.08)
    && near(result.twoDecks?.firstHz, 440)
    && near(result.twoDecks?.secondHz, 330)
    && result.twoDecks.firstRms > 0.02
    && result.twoDecks.secondRms > 0.02
    && result.twoDecks.contextState === "running";
  console.log(`spectral and two-deck signal check: ${valid ? "PASS" : "FAIL"}`);
} catch (e) {
  const steps = await page.evaluate(() => window.__steps ?? []).catch(() => []);
  console.log("spike did not finish:", String(e));
  console.log("steps:", JSON.stringify(steps, null, 2));
}
console.log("page errors:", errors.length, errors.slice(0, 3).join(" | "));
await browser.close();
process.exitCode = errors.length || !valid ? 1 : 0;
