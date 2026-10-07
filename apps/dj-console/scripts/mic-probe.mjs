// Enumerate real microphone inputs as the browser sees them.
//   node scripts/mic-probe.mjs [baseUrl]
// Opens the real default input (no fake device) and lists audioinput labels.
import { chromium } from "playwright";

const [base = "http://127.0.0.1:3102"] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: process.env.PW_CHROMIUM,
  args: ["--use-fake-ui-for-media-stream"], // auto-accept the permission prompt
});
const ctx = await browser.newContext({ permissions: ["microphone"] });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", String(e)));

await page.goto(base + "/?debug", { waitUntil: "load" });
await page.waitForSelector("html[data-ui-ready]");

const result = await page.evaluate(async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const track = stream.getAudioTracks()[0];
    const settings = track?.getSettings() ?? {};
    stream.getTracks().forEach((t) => t.stop());
    const devices = await navigator.mediaDevices.enumerateDevices();
    return {
      inputCount: devices.filter((d) => d.kind === "audioinput").length,
      inputs: devices.filter((d) => d.kind === "audioinput").map((d, i) => ({ i, label: d.label || "(no label)", id: d.deviceId.slice(0, 8) })),
      activeSettings: { sampleRate: settings.sampleRate, channelCount: settings.channelCount, deviceId: (settings.deviceId ?? "").slice(0, 8) },
    };
  } catch (e) {
    return { error: String(e) };
  }
});
console.log(JSON.stringify(result, null, 2));
await browser.close();
