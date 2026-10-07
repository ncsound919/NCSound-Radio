// Drives a real two-deck mix in Chromium through the new console's UI and
// measures the engine while it plays.
//   node scripts/mix-check.mjs <baseUrl> <trackA> <trackB> [screenshotDir]
// Exit code 1 on any failed check.
import { chromium } from "playwright";
const [base, fileA, fileB, shots] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM, args: ["--autoplay-policy=no-user-gesture-required"] });
const [vw, vh] = (process.env.VIEWPORT || "1480x960").split("x").map(Number);
const page = await browser.newPage({ viewport: { width: vw, height: vh } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`); };
const eng = (fn, arg) => page.evaluate(fn, arg);
const deckState = (s) => eng((s) => { const a = window.__ncConsole, d = a.mixer.decks[s];
  return { playing: d.playing, pos: d.currentOffset(), bpm: d.analysis ? d.analysis.bpm * d.rate : null, rate: d.rate, level: d.getLevel(), loop: d.loopBars, cue: a.cuePoint[s], cues: d.analysis?.cuePoints ?? null }; }, s);
const deck = (n) => page.locator(`section.nc-deck[data-deck="${n}"]`);
const wait = (ms) => page.waitForTimeout(ms);

await page.goto(base + "/?debug", { waitUntil: "load" });
await page.waitForSelector("html[data-ui-ready]");
await page.evaluate(() => document.fonts.ready);
if (shots) await page.screenshot({ path: `${shots}/empty.png` });

const t0 = Date.now();
await deck("a").locator("input[type=file]").setInputFiles(fileA);
await deck("a").locator(".nc-deck-title").filter({ hasNotText: "No track loaded" }).waitFor({ timeout: 20000 });
check("deck A loads a file via Load", true, `${Date.now() - t0} ms decode + analysis`);
await deck("b").locator("input[type=file]").setInputFiles(fileB);
await deck("b").locator(".nc-deck-title").filter({ hasNotText: "No track loaded" }).waitFor({ timeout: 20000 });
let A = await deckState(0), B = await deckState(1);
check("analysis BPM A ~124", A.bpm && Math.abs(A.bpm - 124) < 1, `${A.bpm?.toFixed(2)}`);
check("analysis BPM B ~128", B.bpm && Math.abs(B.bpm - 128) < 1, `${B.bpm?.toFixed(2)}`);
check("deck title shows parsed name", (await deck("a").locator(".nc-deck-title").textContent()) === "Groove 124");

await deck("a").getByRole("button", { name: "PLAY" }).click();
await wait(1500);
A = await deckState(0);
const tel = await eng(() => window.__ncConsole.mixer.getMasterTelemetry());
check("PLAY A starts deck A", A.playing && A.pos > 0.8, `pos ${A.pos.toFixed(2)} s`);
check("deck A audio reaches the master", tel.masterPeakDb > -30, `${tel.masterPeakDb} dBFS`);
check("crossfader untouched by play", (await eng(() => window.__ncConsole.mixer.crossfader)) === -1);

// Volume B down, crossfader to centre (keyboard on the slider), start B, sync B.
await page.getByRole("slider", { name: "Crossfader" }).focus();
await page.keyboard.press("Home");
for (let i = 0; i < 5; i++) await page.keyboard.press("PageUp"); // 5 x 0.2 = centre
const xf = await eng(() => window.__ncConsole.mixer.crossfader);
check("crossfader moved to centre by keyboard", Math.abs(xf) < 0.05, `${xf}`);
check("moving the crossfader did not start deck B", !(await deckState(1)).playing);
await deck("b").getByRole("button", { name: "SYNC" }).click();
B = await deckState(1);
// Compare against deck A's measured tempo, not a hardcoded 124: the analyzer's
// reading is what SYNC targets, and a fixture that reads 123.8 must not fail.
const masterBpm = (await deckState(0)).bpm;
check("SYNC B matches B's tempo to A", Math.abs(B.bpm - masterBpm) < 0.05, `${B.bpm.toFixed(2)} -> A ${masterBpm.toFixed(2)} BPM, rate ${B.rate.toFixed(4)}`);
await deck("b").getByRole("button", { name: "PLAY" }).click();
await wait(1500);
A = await deckState(0); B = await deckState(1);
check("both decks playing", A.playing && B.playing);
check("both decks have signal", A.level > 0.01 && B.level > 0.01, `A ${A.level.toFixed(3)}, B ${B.level.toFixed(3)}`);
if (shots) await page.screenshot({ path: `${shots}/mixing.png` });

// EQ kill + filter on B are real: level drops.
const before = B.level;
await page.getByRole("button", { name: "Kill Low B" }).click();
await wait(400);
const killed = (await deckState(1)).level;
check("Kill Low B cuts B's level", killed < before * 0.8, `${before.toFixed(3)} -> ${killed.toFixed(3)}`);
await page.getByRole("button", { name: "Kill Low B" }).click();

// Channel fader B to zero via keyboard.
await page.getByRole("slider", { name: "Volume B" }).focus();
await page.keyboard.press("Home");
await wait(300);
check("Volume B to zero", (await eng(() => window.__ncConsole.mixer.decks[1].channelVolume)) === 0);
await page.keyboard.press("End");

// Loop on A.
await deck("a").getByRole("button", { name: /^Loop/ }).click();
A = await deckState(0);
check("LOOP A engages a loop", A.loop > 0, `${A.loop} bars`);
await deck("a").getByRole("button", { name: /^Loop/ }).click();
check("LOOP A again releases it", (await deckState(0)).loop === 0);

// Hot cue: jump to the Drop cue on B.
B = await deckState(1);
if (B.cues?.drop != null) {
  await deck("b").getByRole("button", { name: /Pad \d+, Drop/ }).click();
  await wait(300);
  const after = await deckState(1);
  check("hot cue Drop jumps B to its cue", Math.abs(after.pos - B.cues.drop) < 1.0, `cue ${B.cues.drop}, now ${after.pos.toFixed(2)}`);
} else check("hot cue Drop exists after analysis", false);

// Keyboard: Q = CUE A while playing -> stops and returns to the cue point.
await page.locator(".nc-brand").click(); // move focus off any control
await page.keyboard.press("q");
await wait(200);
A = await deckState(0);
check("Q (CUE A) stops A at its cue point", !A.playing && Math.abs(A.pos - (A.cue ?? -9)) < 0.05, `pos ${A.pos.toFixed(2)}, cue ${A.cue?.toFixed(2)}`);
await page.keyboard.press("x");
await wait(200);
check("X pauses B", !(await deckState(1)).playing);

// Overview click seeks.
const ov = page.locator(".nc-wave-lane[data-deck=a] .nc-wave-over");
const bb = await ov.boundingBox();
await page.mouse.click(bb.x + bb.width * 0.5, bb.y + bb.height / 2);
A = await deckState(0);
const durA = await eng(() => window.__ncConsole.mixer.decks[0].buffer.duration);
check("overview click seeks A to the middle", Math.abs(A.pos - durA / 2) < 1.5, `${A.pos.toFixed(2)} of ${durA.toFixed(0)} s`);

check("no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
if (shots) await page.screenshot({ path: `${shots}/after.png` });
await browser.close();
process.exitCode = results.every((r) => r.ok) ? 0 : 1;
