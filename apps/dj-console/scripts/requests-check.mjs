// Requests tab and Broadcast autopilot controls, in Chromium, against
// scripts/live-harness.ts --fixtures (real ingest, real request store reading a
// real SQLite file, real imaging player).
//   node scripts/requests-check.mjs <consoleBase> [shotsDir]
import { chromium } from "playwright";

const [base = "http://127.0.0.1:3102", shots] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM, args: ["--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1480, height: 960 } });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && !/Failed to load resource/.test(m.text()) && errors.push(m.text()));
// HTTP errors are recorded by URL, so an expected refusal (the engine saying
// NO_SUCH_REQUEST with a 400) is told apart from a broken route.
const httpErrors = [];
page.on("response", async (r) => {
  if (r.status() < 400) return;
  let body = "";
  try { body = (await r.text()).slice(0, 120); } catch {}
  httpErrors.push({ url: new URL(r.url()).pathname, status: r.status(), body });
});
let pass = 0, fail = 0;
const check = (name, ok, detail = "") => {
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

await page.goto(`${base}/?debug`);
await page.waitForSelector("html[data-ui-ready]");
await page.getByRole("radio", { name: "Radio" }).click();
await page.getByRole("tab", { name: "Requests" }).click();

/* ---- requests ---- */
await page.waitForSelector(".nc-req", { timeout: 8000 }).catch(() => {});
const titles = await page.locator(".nc-req-title").allTextContents();
check("requests listed from the station database, newest first", titles.length === 3 && titles[0].includes("Midnight Warehouse") && titles[2].includes("live-check tone"), titles.join(" | "));
const meta = await page.locator(".nc-req-meta").first().textContent();
check("listener, age and note shown", /for Dana · \d+ min ago · “birthday shout please”/.test(meta ?? ""), meta);
check("no Load to deck without a library match", (await page.getByRole("button", { name: "Load to deck" }).count()) === 0);

await page.locator(".nc-req").nth(0).getByRole("button", { name: "Cue for autopilot" }).click();
await page.waitForSelector(".nc-req-fb", { timeout: 15000 }).catch(() => {});
const fb0 = await page.locator(".nc-req").nth(0).locator(".nc-req-fb").textContent().catch(() => null);
console.log("      cue r1 ->", fb0);
await page.locator(".nc-req").nth(1).getByRole("button", { name: "Cue for autopilot" }).click();
await page.waitForFunction(() => document.querySelectorAll(".nc-req-fb").length >= 2, null, { timeout: 15000 }).catch(() => {});
const fb1 = await page.locator(".nc-req").nth(1).locator(".nc-req-fb").textContent().catch(() => null);
check("a request with no crate track says so instead of pretending", /Not cued: .*no queued request|Not cued/.test(fb1 ?? ""), fb1);
check("the engine's answer is shown for a crate track", fb0 !== null && fb0.length > 0, fb0);

await page.locator(".nc-req").nth(1).getByRole("button", { name: "Dismiss" }).click();
check("dismiss hides the request", (await page.locator(".nc-req").count()) === 2);
await page.reload();
await page.waitForSelector("html[data-ui-ready]");
await page.getByRole("tab", { name: "Requests" }).click();
await page.waitForSelector(".nc-req", { timeout: 8000 }).catch(() => {});
check("dismiss persists on this console across a reload", (await page.locator(".nc-req").count()) === 2);
if (shots) await page.screenshot({ path: `${shots}/requests.png` });

/* ---- broadcast: autopilot + imaging ---- */
await page.getByRole("tab", { name: "Broadcast" }).click();
await page.waitForSelector(".nc-bcast-pads .nc-key", { timeout: 8000 }).catch(() => {});
const pads = await page.locator(".nc-bcast-pads .nc-key").allTextContents();
check("imaging pads listed from ingest", pads.join(",") === "station-id,sweeper", pads.join(","));
await page.getByRole("button", { name: "station-id" }).click();
await page.waitForFunction(() => /Play station-id: (done|failed)/.test(document.querySelector(".nc-bcast-col:last-child .nc-bcast-note:nth-of-type(n)")?.textContent ?? "") || [...document.querySelectorAll(".nc-bcast-note")].some((n) => /Play station-id: (done|failed)/.test(n.textContent ?? "")), null, { timeout: 15000 }).catch(() => {});
const notes = await page.locator(".nc-bcast-note").allTextContents();
const playNote = notes.find((n) => n.startsWith("Play station-id"));
check("imaging pad fires and shows the engine's answer", !!playNote, playNote);

// Hold/Resume follows the engine's reported state, not the button.
await page.waitForFunction(() => window.__ncConsole && true);
const before = await page.getByRole("button", { name: /^(Hold|Resume)$/ }).textContent();
await page.getByRole("button", { name: /^(Hold|Resume)$/ }).click();
await page.waitForFunction((b) => {
  const k = [...document.querySelectorAll(".nc-key")].find((e) => /^(Hold|Resume)$/.test(e.textContent ?? ""));
  return k && k.textContent !== b;
}, before, { timeout: 12000 }).catch(() => {});
const after = await page.getByRole("button", { name: /^(Hold|Resume)$/ }).textContent();
check("Hold/Resume flips only after ingest reports the new autopilot state", before !== after, `${before} -> ${after}`);
await page.getByRole("button", { name: /^(Hold|Resume)$/ }).click(); // restore
await page.getByRole("button", { name: "Skip" }).click();
await page.waitForFunction(() => [...document.querySelectorAll(".nc-bcast-note")].some((n) => /^Skip(: done| failed)/.test(n.textContent ?? "")), null, { timeout: 15000 }).catch(() => {});
const skipNote = (await page.locator(".nc-bcast-note").allTextContents()).find((n) => n.startsWith("Skip"));
check("Skip shows the engine's answer", /^Skip(: done\.| failed: .+)/.test(skipNote ?? ""), skipNote);
if (shots) await page.screenshot({ path: `${shots}/broadcast-autopilot.png` });

const unexpected = httpErrors.filter((h) => !(h.url === "/ingest/command" && h.status === 400 && /NO_SUCH_REQUEST/.test(h.body)));
console.log("      HTTP errors seen:", JSON.stringify(httpErrors));
check("the only HTTP error is the engine refusing the uncrated request", unexpected.length === 0, JSON.stringify(unexpected));
const real = errors.filter((e) => !/favicon/.test(e));
check("no page errors", real.length === 0, real.slice(0, 3).join(" | "));
console.log(`\n${pass}/${pass + fail} checks passed`);
await browser.close();
process.exitCode = fail ? 1 : 0;
