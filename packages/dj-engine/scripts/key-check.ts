/**
 * Key detection over real audio files (plan: Phase 4 spot-check).
 *
 * Decodes the first 90 s of each file with ffmpeg to 44.1 kHz stereo WAV, runs
 * the engine's analyze(), and prints the detected Camelot key, the key name, the
 * BPM, and the distribution. There is no ground-truth key source for this
 * library, so this reports the detected keys and flags a degenerate result
 * (all the same, or empty) rather than a hit rate.
 *
 *   bun scripts/key-check.ts "<dir>" [limit]
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { analyze } from "../src/engine/analysis";
import { createHeadlessContext } from "../src/audio/context";

const dir = process.argv[2];
const limit = Number(process.argv[3] ?? 20);
if (!dir) {
  console.error("usage: bun scripts/key-check.ts <dir> [limit]");
  process.exit(2);
}

function walk(d: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(d)) {
    const p = join(d, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(mp3|wav|flac|m4a|aiff?|ogg)$/i.test(name)) out.push(p);
  }
  return out;
}

const files = walk(dir).slice(0, limit);
const ctx = createHeadlessContext({ sampleRate: 44100 });
const tmp = mkdtempSync(join(tmpdir(), "keychk-"));

type Row = { file: string; key: string | null; keyName: string | null; bpm: number | null; error?: string };
const rows: Row[] = [];
for (const src of files) {
  const wav = join(tmp, "one.wav");
  const name = basename(src);
  try {
    execFileSync("ffmpeg", ["-v", "error", "-y", "-t", "90", "-i", src, "-ac", "2", "-ar", "44100", wav], { stdio: "ignore" });
    const b = readFileSync(wav);
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    const buf = await ctx.decodeAudioData(ab);
    const a = analyze(buf);
    rows.push({ file: name, key: a.key ?? null, keyName: a.keyName ?? null, bpm: +a.bpm.toFixed(1) });
  } catch (e) {
    rows.push({ file: name, key: null, keyName: null, bpm: null, error: String(e).slice(0, 100) });
  }
}

console.log(JSON.stringify(rows, null, 2));
const detected = rows.filter((r) => r.key);
const dist = new Map<string, number>();
for (const r of detected) dist.set(r.key!, (dist.get(r.key!) ?? 0) + 1);
console.log(`\n${detected.length}/${rows.length} detected a key`);
console.log("distribution:", [...dist.entries()].sort().map(([k, v]) => `${k}:${v}`).join(" "));
const degenerate = detected.length > 1 && dist.size === 1;
if (degenerate) console.log("WARNING: every track got the same key — the detector looks broken.");
if (detected.length === 0) console.log("WARNING: no track got a key.");
void ctx.close();
