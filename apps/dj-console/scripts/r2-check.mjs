// Live R2 library acceptance: the console imports the Cloudflare R2 catalog
// through ncsound-api and loads a track's bytes from the bucket.
//   node scripts/r2-check.mjs [baseUrl]
// Skips (exit 0) when the Worker is unreachable, so it is safe without Cloudflare.
import { chromium } from "playwright";

const [base = "http://127.0.0.1:3102"] = process.argv.slice(2);
const API = process.env.R2_API ?? "https://ncsound-api.tap4500.workers.dev";
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

try {
  const res = await fetch(`${API}/health`);
  if (!res.ok) throw new Error(String(res.status));
} catch (e) {
  console.log(`SKIP  ncsound-api not reachable at ${API}: ${e instanceof Error ? e.message : e}`);
  process.exit(0);
}

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

await page.goto(base + "/?debug", { waitUntil: "load" });
await page.waitForSelector("html[data-ui-ready]");
await page.getByRole("tab", { name: "Library" }).click().catch(() => {});
await page.getByRole("button", { name: "R2", exact: true }).click();

await page.waitForSelector(".nc-lib-row", { timeout: 25000 });
const rows = await page.locator(".nc-lib-row").count();
const note = (await page.locator(".nc-lib-note").first().textContent()) ?? "";
check("R2 catalog imported", rows > 0, `${rows} rows`);
check("note names R2", /R2/i.test(note), note.slice(0, 60).trim());

// Loading the first track exercises the whole path: console -> Worker-less
// public bucket URL -> fetch -> decodeAudioData -> deck.
await page.locator(".nc-lib-row").first().dblclick();
await page
  .waitForFunction(() => document.querySelector('.nc-deck[data-loaded="true"]') !== null, null, { timeout: 30000 })
  .catch(() => {});
const loaded = await page.locator('.nc-deck[data-loaded="true"]').count();
check("a track loads from R2", loaded > 0);

check("no page errors", errors.length === 0, errors.slice(0, 2).join(" | "));

await browser.close();
process.exitCode = results.every(Boolean) ? 0 : 1;
