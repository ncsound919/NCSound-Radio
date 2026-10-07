/**
 * ncsound-transcode container server.
 *
 * A tiny HTTP server over ffmpeg. The Worker routes audio to it; it normalises
 * to MP3 and measures EBU R128 loudness (integrated LUFS, true peak, LRA) so
 * the console always gets a known-good file and a real loudness figure.
 *
 *   GET  /health             ffmpeg version
 *   POST /loudness           body: audio -> { integratedLufs, truePeakDbfs, lra, durationSec }
 *   POST /transcode[?kbps=]  body: audio -> audio/mpeg bytes, with X-Loudness-* headers
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT ?? 8080);
const MAX_BYTES = 200 * 1024 * 1024;

let ffmpegVersion = "unknown";
try {
  const v = spawn("ffmpeg", ["-version"], { stdio: ["ignore", "pipe", "ignore"] });
  const chunks = [];
  v.stdout.on("data", (d) => chunks.push(d));
  v.on("close", () => {
    const first = Buffer.concat(chunks).toString("utf8").split("\n")[0] ?? "";
    ffmpegVersion = first.trim() || "unknown";
  });
} catch {
  /* reported by /health as unknown */
}

function ffmpeg(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["pipe", "pipe", "pipe"] });
    const out = [];
    const err = [];
    p.stdout.on("data", (d) => out.push(d));
    p.stderr.on("data", (d) => err.push(d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString("utf8") }));
    p.stdin.on("error", () => {});
    p.stdin.end(input);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BYTES) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

const num = (re, s) => {
  // ebur128 prints a running line every ~100 ms and then a summary; the last
  // occurrence is the settled value. Taking the first reads the gate floor
  // (-70 LUFS) for everything.
  const g = new RegExp(re.source, "g");
  let m;
  let last = null;
  while ((m = g.exec(s)) !== null) last = m;
  return last ? Number(last[1]) : null;
};

function durationSec(stderr) {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
}

function parseLoudness(stderr) {
  return {
    integratedLufs: num(/I:\s*(-?\d+(?:\.\d+)?)\s*LUFS/, stderr),
    truePeakDbfs: num(/Peak:\s*(-?\d+(?:\.\d+)?)\s*dBFS/, stderr),
    lra: num(/LRA:\s*(-?\d+(?:\.\d+)?)\s*LU/, stderr),
    durationSec: durationSec(stderr),
  };
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "ncsound-transcode", ffmpeg: ffmpegVersion, port: PORT });
      return;
    }
    if (req.method === "POST" && (url.pathname === "/loudness" || url.pathname === "/transcode")) {
      const input = await readBody(req);
      if (!input.length) {
        sendJson(res, 400, { ok: false, error: "empty body" });
        return;
      }
      if (url.pathname === "/loudness") {
        const { code, stderr } = await ffmpeg(["-hide_banner", "-nostats", "-i", "pipe:0", "-af", "ebur128=peak=true", "-f", "null", "-"], input);
        const stats = parseLoudness(stderr);
        sendJson(res, code === 0 ? 200 : 422, { ok: code === 0, ...stats, error: code === 0 ? undefined : stderr.split("\n").slice(-3).join(" ").trim() });
        return;
      }
      const kbps = Math.min(320, Math.max(64, Number(url.searchParams.get("kbps") ?? 192)));
      // EBU R128 normalisation to -16 LUFS / -1.5 dBTP (a streaming target),
      // then MP3 at `kbps`. Without the loudnorm filter this is a plain
      // re-encode and the console's "Normalise" control would be a lie.
      const { code, stdout, stderr } = await ffmpeg(
        ["-hide_banner", "-nostats", "-i", "pipe:0", "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-c:a", "libmp3lame", "-b:a", `${kbps}k`, "-f", "mp3", "pipe:1"],
        input,
      );
      if (code !== 0 || !stdout.length) {
        sendJson(res, 422, { ok: false, error: stderr.split("\n").slice(-3).join(" ").trim() });
        return;
      }
      // Measure the OUTPUT, not the input: the headers describe the file the
      // client actually receives.
      const { stderr: outErr } = await ffmpeg(["-hide_banner", "-nostats", "-i", "pipe:0", "-af", "ebur128=peak=true", "-f", "null", "-"], stdout);
      const stats = parseLoudness(outErr);
      const headers = { "content-type": "audio/mpeg", "content-length": stdout.length };
      if (stats.integratedLufs !== null) headers["x-loudness-lufs"] = String(stats.integratedLufs);
      if (stats.truePeakDbfs !== null) headers["x-loudness-truepeak-dbfs"] = String(stats.truePeakDbfs);
      res.writeHead(200, headers);
      res.end(stdout);
      return;
    }
    sendJson(res, 404, { ok: false, error: "not found", path: url.pathname });
  } catch (e) {
    sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});

server.listen(PORT, () => console.log(`ncsound-transcode listening on :${PORT}`));
