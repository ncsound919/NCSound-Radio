// Enumerate MIDI inputs and capture what the unit sends.
//   node scripts/midi-probe.mjs [baseUrl] [listenMs]
// Grants Web MIDI permission, lists inputs, then listens and prints every
// message as raw bytes + note/CC so a preset can be read off the hardware.
import { chromium } from "playwright";

const [base = "http://127.0.0.1:3102", listenMs = "20000"] = process.argv.slice(2);
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM, headless: false });
const ctx = await browser.newContext({ permissions: ["midi"] });
try {
  await ctx.grantPermissions(["midi"], { origin: new URL(base).origin });
} catch { /* grant may already apply */ }
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", String(e)));

await page.goto(base + "/?debug", { waitUntil: "load" });
await page.waitForSelector("html[data-ui-ready]");

const inputs = await page.evaluate(async () => {
  const access = await navigator.requestMIDIAccess({ sysex: false });
  return {
    supported: true,
    inputs: [...access.inputs.values()].map((i) => ({ id: i.id, name: i.name, manufacturer: i.manufacturer, state: i.state })),
  };
}).catch((e) => ({ supported: false, error: String(e) }));

console.log(JSON.stringify(inputs, null, 2));

const ms = Number(listenMs);
if (inputs.supported && inputs.inputs.length) {
  console.log(`\nListening ${ms} ms. Press pad bank A pad 1, then turn knob K1, then move fader F1...`);
  await page.evaluate((ms) => {
    window.__midiLog = [];
    navigator.requestMIDIAccess({ sysex: false }).then((access) => {
      for (const input of access.inputs.values()) {
        input.onmidimessage = (e) => {
          window.__midiLog.push([...e.data]);
        };
      }
    });
    return new Promise((r) => setTimeout(r, ms));
  }, ms);
  const log = await page.evaluate(() => window.__midiLog);
  const seen = new Map();
  for (const d of log) {
    const kind = d[0] & 0xf0;
    const label = kind === 0x90 ? "note" : kind === 0xb0 ? "cc" : kind === 0x80 ? "noteoff" : `0x${d[0].toString(16)}`;
    seen.set(`${label} ${d[1]}`, (seen.get(`${label} ${d[1]}`) ?? 0) + 1);
  }
  console.log(`captured ${log.length} messages:`);
  for (const [k, v] of [...seen.entries()].sort()) console.log(`  ${k}  x${v}`);
  console.log("raw (first 40):");
  for (const d of log.slice(0, 40)) console.log("  [" + d.join(",") + "]");
} else {
  console.log("\nNo MIDI input found. Is the MPD226 connected and powered?");
}

await browser.close();
