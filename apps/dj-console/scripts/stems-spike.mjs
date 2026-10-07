import { chromium } from "playwright";

const args = process.argv.slice(2);
const base = args.find((a) => !a.startsWith("--")) ?? "http://127.0.0.1:3102";
const headed = args.includes("--headed");
const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM, headless: !headed });
try {
  const page = await browser.newPage();
  await page.goto(`${base}/spike/stems.html`, { waitUntil: "load" });
  const capability = await page.evaluate(async () => {
    const ctx = new AudioContext();
    const result = {
      webgpuApi: !!navigator.gpu,
      adapter: null,
      adapterError: null,
      crossOriginIsolated,
      hardwareConcurrency: navigator.hardwareConcurrency,
      audioWorklet: !!window.AudioWorkletNode,
      renderCapacity: "renderCapacity" in ctx,
    };
    await ctx.close();
    if (!navigator.gpu) return result;
    try {
      const adapter = await Promise.race([
        navigator.gpu.requestAdapter({ powerPreference: "high-performance" }),
        new Promise((_, reject) => setTimeout(() => reject(new Error("GPU adapter timeout")), 8000)),
      ]);
      if (adapter) {
        result.adapter = {
          fallback: adapter.isFallbackAdapter ?? null,
          info: adapter.info ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device } : null,
          limits: {
            maxBufferSize: adapter.limits.maxBufferSize,
            maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
          },
        };
      }
    } catch (error) {
      result.adapterError = error instanceof Error ? error.message : String(error);
    }
    return result;
  });
  console.log(JSON.stringify({
    browser: headed ? "headed" : "headless",
    capability,
    gate: "unmeasured-no-four-minute-model-inference",
    providerVerified: false,
    inferenceWallSec: null,
    peakMemoryBytes: null,
    modelBytes: 180534758,
  }, null, 2));
  await page.close();
} finally {
  await browser.close();
}
process.exitCode = 2;
