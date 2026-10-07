import { chromium } from "playwright";

const args = process.argv.slice(2);
const base = args.find((a) => !a.startsWith("--")) ?? "http://127.0.0.1:3102";
const sec = args.find((a) => a.startsWith("--sec="))?.slice(6) ?? "60";
const headed = args.includes("--headed");
const timeoutMs = Number(args.find((a) => a.startsWith("--timeout="))?.slice(10) ?? 600000);
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM, headless: !headed });
let result = null;
try {
  const page = await browser.newPage();
  const pageErrors = [];
  let crashed = null;
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  page.on("crash", () => { crashed = "page crashed (likely out of memory or GPU fault)"; });
  page.on("close", () => { crashed ??= "page closed unexpectedly"; });
  try {
    await page.goto(`${base}/spike/stems-run.html?sec=${sec}`, { waitUntil: "load" });
    await page.waitForFunction(() => window.__stemPilot?.result != null, null, { timeout: timeoutMs });
    result = await page.evaluate(() => window.__stemPilot.result);
  } catch (error) {
    result = {
      ok: false,
      error: crashed ?? String(error),
      progress: await page.evaluate(() => window.__stemPilot).catch(() => null),
    };
  }
  console.log(JSON.stringify({ ...result, pageErrors: pageErrors.slice(0, 3) }, null, 2));
  if (!crashed) await page.close();
} finally {
  await browser.close().catch(() => {});
}
process.exitCode = result?.ok === true ? 0 : 2;
