import { useEffect, useMemo, useRef, useState } from "react";
import { buildSliceBank, gridFromBpm } from "../analysis/slicerLite";
import { llmDirector } from "../director/llmDirector";
import { runScratchAgent, rulesDirectorFn } from "../pipeline";
import type { DirectorFn, RunResult } from "../pipeline";
import { applyHeadroom } from "../scratch/render";
import type { Style } from "../schemas";

export interface ScratchPanelProps {
  /** Hook/loop to scratch. If omitted the panel shows a file picker. */
  buffer?: AudioBuffer | null;
  audioContext?: AudioContext;
  defaultBpm?: number;
  /** Called with the rendered scratch-only buffer so the host app can route it into its mixer. */
  onRendered?: (scratch: AudioBuffer, result: RunResult) => void;
}

const mono = (b: AudioBuffer) => {
  const out = new Float32Array(b.length);
  for (let c = 0; c < b.numberOfChannels; c++) {
    const ch = b.getChannelData(c);
    for (let i = 0; i < b.length; i++) out[i] += ch[i] / b.numberOfChannels;
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] /= peak; // gate-click threshold assumes peak 1
  return out;
};

const field = "w-full rounded bg-zinc-900 border border-zinc-700 px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-amber-400";

export default function ScratchPanel({ buffer: bufferProp, audioContext, defaultBpm = 90, onRendered }: ScratchPanelProps) {
  const ctx = useMemo(() => audioContext ?? new AudioContext(), [audioContext]);
  const [buffer, setBuffer] = useState<AudioBuffer | null>(bufferProp ?? null);
  const [bpm, setBpm] = useState(defaultBpm);
  const [offset, setOffset] = useState(0);
  const [startBar, setStartBar] = useState(0);
  const [bars, setBars] = useState<2 | 4>(2);
  const [style, setStyle] = useState<Style>("medium");
  const [mode, setMode] = useState<"answer" | "hook">("hook");
  const [seed, setSeed] = useState(1);
  const [useLlm, setUseLlm] = useState(false);
  const [llmUrl, setLlmUrl] = useState("http://localhost:11434/v1/chat/completions");
  const [llmModel, setLlmModel] = useState("");
  const [result, setResult] = useState<RunResult | null>(null);
  const [scratch, setScratch] = useState<AudioBuffer | null>(null);
  const [withHook, setWithHook] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const playing = useRef<AudioBufferSourceNode[]>([]);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => setBuffer(bufferProp ?? null), [bufferProp]);

  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setBuffer(await ctx.decodeAudioData(await f.arrayBuffer()));
    setResult(null);
    setScratch(null);
  };

  const run = async () => {
    if (!buffer) return;
    setBusy(true);
    setError(null);
    await new Promise((r) => setTimeout(r, 0)); // let the button state paint before the render blocks
    try {
      const src = mono(buffer);
      const bank = buildSliceBank(src, buffer.sampleRate);
      const grid = gridFromBpm(bpm, offset, buffer.duration);
      const director: DirectorFn = useLlm
        ? async (c, s) => (await llmDirector(c, { llm_url: llmUrl, llm_model: llmModel, temperature: 0.7, seed: s })).plan
        : rulesDirectorFn;
      const res = await runScratchAgent({
        src, fs: buffer.sampleRate, bank, grid, bars, style, seed, director,
        phraseStartBeat: startBar * 4,
        cfg: { placement_mode: mode },
      });
      const pcm = applyHeadroom(res.audio, res.cfg.headroom_db);
      const out = ctx.createBuffer(1, pcm.length, buffer.sampleRate);
      out.copyToChannel(pcm, 0);
      setResult(res);
      setScratch(out);
      onRendered?.(out, res);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e)); // fatal Critic invariants surface here, not silently fixed
    } finally {
      setBusy(false);
    }
  };

  const stop = () => {
    playing.current.forEach((s) => { try { s.stop(); } catch { /* already stopped */ } });
    playing.current = [];
  };
  const play = async () => {
    if (!scratch || !buffer) return;
    stop();
    await ctx.resume();
    const t = ctx.currentTime + 0.05;
    for (const b of withHook ? [buffer, scratch] : [scratch]) {
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.connect(ctx.destination);
      s.start(t);
      playing.current.push(s);
    }
  };
  useEffect(() => stop, []);

  // waveform with slice onsets (dim) and scratch events (amber)
  useEffect(() => {
    const c = canvas.current;
    if (!c || !buffer) return;
    const g = c.getContext("2d")!;
    const w = (c.width = c.clientWidth * devicePixelRatio);
    const h = (c.height = 96 * devicePixelRatio);
    g.clearRect(0, 0, w, h);
    const d = buffer.getChannelData(0);
    const step = Math.max(1, Math.floor(d.length / w));
    g.fillStyle = "#71717a";
    for (let x = 0; x < w; x++) {
      let m = 0;
      for (let i = 0; i < step; i++) m = Math.max(m, Math.abs(d[x * step + i] ?? 0));
      g.fillRect(x, (h - m * h) / 2, 1, m * h);
    }
    if (result) {
      for (const e of result.events) {
        const x = (e.t0 / buffer.duration) * w;
        g.fillStyle = "#fbbf24";
        g.fillRect(x, 0, 2 * devicePixelRatio, h);
      }
    }
  }, [buffer, result]);

  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-950 p-4 text-zinc-100 space-y-4">
      <header className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Scratch agent</h2>
        {!bufferProp && (
          <input type="file" accept="audio/*" onChange={(e) => onFile(e.target.files?.[0])} className="text-xs" />
        )}
      </header>

      <canvas ref={canvas} className="w-full h-24 rounded bg-zinc-900" aria-label="Waveform with scratch events" />

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
        <label>BPM<input className={field} type="number" step="0.1" value={bpm} onChange={(e) => setBpm(+e.target.value)} /></label>
        <label>First beat (s)<input className={field} type="number" step="0.01" value={offset} onChange={(e) => setOffset(+e.target.value)} /></label>
        <label>Start bar<input className={field} type="number" min={0} value={startBar} onChange={(e) => setStartBar(+e.target.value)} /></label>
        <label>Seed<input className={field} type="number" value={seed} onChange={(e) => setSeed(+e.target.value)} /></label>
        <label>Length
          <select className={field} value={bars} onChange={(e) => setBars(+e.target.value as 2 | 4)}>
            <option value={2}>2 bars</option><option value={4}>4 bars</option>
          </select>
        </label>
        <label>Density
          <select className={field} value={style} onChange={(e) => setStyle(e.target.value as Style)}>
            <option value="sparse">sparse</option><option value="medium">medium</option><option value="busy">busy</option>
          </select>
        </label>
        <label>Placement
          <select className={field} value={mode} onChange={(e) => setMode(e.target.value as "answer" | "hook")}>
            <option value="hook">hook (scratch the hook)</option><option value="answer">answer (land in vocal gaps)</option>
          </select>
        </label>
        <label>Director
          <select className={field} value={useLlm ? "llm" : "rules"} onChange={(e) => setUseLlm(e.target.value === "llm")}>
            <option value="rules">rules (no model)</option><option value="llm">local LLM</option>
          </select>
        </label>
      </div>

      {useLlm && (
        <div className="grid sm:grid-cols-2 gap-3 text-xs">
          <label>Endpoint<input className={field} value={llmUrl} onChange={(e) => setLlmUrl(e.target.value)} /></label>
          <label>Model name<input className={field} placeholder="as your server lists it" value={llmModel} onChange={(e) => setLlmModel(e.target.value)} /></label>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <button onClick={run} disabled={!buffer || busy || (useLlm && !llmModel)} className="rounded bg-amber-400 px-3 py-1.5 text-sm font-medium text-zinc-950 disabled:opacity-40 focus-visible:ring-2 focus-visible:ring-white">
          {busy ? "Rendering…" : "Render scratch"}
        </button>
        <button onClick={play} disabled={!scratch} className="rounded border border-zinc-600 px-3 py-1.5 text-sm disabled:opacity-40">Play</button>
        <button onClick={stop} disabled={!scratch} className="rounded border border-zinc-600 px-3 py-1.5 text-sm disabled:opacity-40">Stop</button>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={withHook} onChange={(e) => setWithHook(e.target.checked)} />Play over the hook</label>
      </div>

      {error && <p role="alert" className="text-sm text-red-400">{error}</p>}

      {result && (
        <div className="space-y-2 text-xs">
          <p>
            {result.passed ? "Passed the Critic" : "Did not pass the Critic"} on attempt {result.attempts.length} of {result.cfg.max_tries} (seed {result.seed}) — {result.events.length} events.
          </p>
          <table className="w-full text-left">
            <thead className="text-zinc-400"><tr><th>Check</th><th>Value</th><th>Limit</th><th>Result</th></tr></thead>
            <tbody>
              {result.attempts.at(-1)!.report.checks.map((c) => (
                <tr key={c.name} className="border-t border-zinc-800">
                  <td className="py-1">{c.name}</td>
                  <td>{c.value === null ? "NOT MEASURED" : c.value.toFixed(3)}</td>
                  <td>{c.threshold ?? "–"}</td>
                  <td className={c.passed ? "text-emerald-400" : "text-red-400"}>{c.value === null ? "–" : c.passed ? "pass" : `fail (${c.action})`}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.attempts.length > 1 && (
            <ul className="text-zinc-400">
              {result.attempts.map((a, i) => (
                <li key={i}>Try {i + 1} (seed {a.seed}): {a.failing.join(", ") || "passed"}{a.cfgChanges.length ? ` → ${a.cfgChanges.join(", ")}` : ""}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
