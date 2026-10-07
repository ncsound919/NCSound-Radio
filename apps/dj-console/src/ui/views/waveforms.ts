/**
 * Scrolling waveforms, one lane per deck: a zoomed 3-band view with a fixed
 * centre playhead, beat grid (downbeat every 4 beats from the analysed first
 * beat), hot cues, cue point and loop; and a full-track overview under it with
 * click-to-seek. Waveform tiles are rendered once per track; a frame blits them.
 */
import { HOT_CUES, deckName, type ConsoleAudio, type Slot } from "../../audio/engine";
import { renderTiles, TILE_W, type WaveTiles } from "../../audio/waveform";
import { consoleStore } from "../../state/console";
import { onFrame } from "../../app/scheduler";

const WINDOW_SEC = 8;

/**
 * Canvas cannot use CSS variables, so the palette is resolved from the design
 * tokens once (lazily, after tokens.css has been injected) rather than duplicated
 * as literals. Change a token and the waveform follows.
 */
type Rgb = [number, number, number];
const hexToRgb = (hex: string): Rgb => {
  const h = hex.replace(/^#/, "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const rgba = ([r, g, b]: Rgb, a: number) => `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${a})`;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const token = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

type Palette = { colors: Array<{ body: string; mid: string; high: string; line: string }>; accent: string; ink: string };
let paletteCache: Palette | null = null;
function getPalette(): Palette {
  if (paletteCache) return paletteCache;
  const ink = hexToRgb(token("--nc-ink", "#eef1f6"));
  const colors = [token("--nc-deck-a", "#7b93d6"), token("--nc-deck-b", "#a585d6")].map((hex) => {
    const tint = hexToRgb(hex);
    return { body: rgba(tint, 0.55), mid: rgba(mix(tint, ink, 0.55), 0.85), high: rgba(ink, 0.9), line: hex };
  });
  paletteCache = { colors, accent: token("--nc-accent", "#e8a33d"), ink: token("--nc-ink", "#eef1f6") };
  return paletteCache;
}

function canvas(cls: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.className = cls;
  return c;
}

function fit(c: HTMLCanvasElement): boolean {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(c.clientWidth * dpr));
  const h = Math.max(1, Math.round(c.clientHeight * dpr));
  if (c.width === w && c.height === h) return false;
  c.width = w;
  c.height = h;
  return true;
}

function lane(audio: ConsoleAudio, slot: Slot, loadFiles: (slot: Slot, files: FileList) => void): HTMLElement {
  const el = document.createElement("div");
  el.className = "nc-wave-lane";
  el.dataset.deck = deckName(slot).toLowerCase();
  const main = canvas("nc-wave-main");
  main.setAttribute("role", "img");
  main.setAttribute("aria-label", `Deck ${deckName(slot)} waveform`);
  const over = canvas("nc-wave-over");
  over.setAttribute("aria-label", `Deck ${deckName(slot)} overview: click to seek`);
  const empty = document.createElement("span");
  empty.className = "nc-wave-empty";
  empty.textContent = `Deck ${deckName(slot)}: no track`;
  const tag = document.createElement("span");
  tag.className = "nc-wave-tag";
  tag.textContent = deckName(slot);
  el.append(main, over, empty, tag);

  el.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  });
  el.addEventListener("drop", (e) => {
    e.preventDefault();
    if (e.dataTransfer?.files.length) loadFiles(slot, e.dataTransfer.files);
  });
  over.addEventListener("click", (e) => {
    const d = audio.deck(slot);
    if (!d.buffer) return;
    const r = over.getBoundingClientRect();
    audio.mixer.seekDeck(slot, ((e.clientX - r.left) / r.width) * d.buffer.duration);
    consoleStore.set({ focusDeck: slot });
  });

  let tiles: WaveTiles | null = null;
  let tilesSeq = -1;
  const overCache = document.createElement("canvas");
  let overKey = "";

  onFrame(() => {
    const r1 = fit(main), r2 = fit(over);
    const resized = r1 || r2;
    const t = audio.tracks[slot];
    const d = audio.deck(slot);
    el.dataset.loaded = String(!!t);
    const g = main.getContext("2d")!;
    const W = main.width, H = main.height;
    g.clearRect(0, 0, W, H);
    const og = over.getContext("2d")!;
    og.clearRect(0, 0, over.width, over.height);
    if (!t || !d.buffer || !d.analysis) return;
    const wf = t.waveform;
    const { colors, accent: ACCENT, ink: INK } = getPalette();
    const col = colors[slot];

    if (tilesSeq !== t.seq) {
      tiles = renderTiles(wf, col);
      tilesSeq = t.seq;
    }
    const dpr = window.devicePixelRatio || 1;
    const pos = d.currentOffset();
    const pps = W / WINDOW_SEC;
    const t0 = pos - WINDOW_SEC / 2;
    const xOf = (sec: number) => (sec - t0) * pps;

    // loop region under the waveform
    const ls = d.loopStartSec;
    if (ls != null) {
      const len = d.loopBars * 4 * (60 / d.analysis.bpm);
      g.fillStyle = "rgba(232,163,61,0.14)";
      g.fillRect(xOf(ls), 0, len * pps, H);
    }

    // waveform tiles
    for (let i = 0; i < tiles!.tiles.length; i++) {
      const tile = tiles!.tiles[i];
      const x = xOf((i * TILE_W) / wf.rate);
      const w = (tile.width / wf.rate) * pps;
      if (x > W || x + w < 0) continue;
      g.drawImage(tile, 0, 0, tile.width, tile.height, x, 0, w, H);
    }

    // played side slightly dimmed
    g.fillStyle = "rgba(7,9,13,0.35)";
    g.fillRect(0, 0, W / 2, H);

    // beat grid
    const spb = 60 / d.analysis.bpm;
    const fb = d.analysis.firstBeat;
    const n0 = Math.max(Math.ceil((t0 - fb) / spb), Math.ceil(-fb / spb)); // no beats before the track starts
    const n1 = Math.floor((t0 + WINDOW_SEC - fb) / spb);
    for (let n = n0; n <= n1; n++) {
      const x = Math.round(xOf(fb + n * spb)) + 0.5;
      const down = ((n % 4) + 4) % 4 === 0;
      g.fillStyle = down ? "rgba(238,241,246,0.55)" : "rgba(238,241,246,0.25)";
      const tick = (down ? 10 : 6) * dpr;
      g.fillRect(x, 0, dpr, tick);
      g.fillRect(x, H - tick, dpr, tick);
    }

    // hot cues and cue point
    g.font = `600 ${11 * dpr}px "Geist Mono", ui-monospace, monospace`;
    g.textBaseline = "top";
    HOT_CUES.forEach((c, i) => {
      const sec = d.analysis!.cuePoints?.[c.key];
      if (sec == null) return;
      const x = xOf(sec);
      if (x < -20 || x > W + 20) return;
      g.fillStyle = col.line;
      g.fillRect(Math.round(x), 0, 2 * dpr, H);
      const label = String(i + 1 + slot * 4);
      g.fillRect(Math.round(x), 0, 14 * dpr, 14 * dpr);
      g.fillStyle = "#07090d";
      g.fillText(label, Math.round(x) + 3 * dpr, 1.5 * dpr);
    });
    const cp = audio.cuePoint[slot];
    if (cp != null) {
      const x = xOf(cp);
      g.fillStyle = ACCENT;
      g.beginPath();
      g.moveTo(x - 6 * dpr, H);
      g.lineTo(x + 6 * dpr, H);
      g.lineTo(x, H - 8 * dpr);
      g.fill();
    }

    // playhead
    g.fillStyle = INK;
    g.fillRect(Math.round(W / 2) - dpr, 0, 2 * dpr, H);

    // overview
    const OW = over.width, OH = over.height;
    const key = `${t.seq}:${OW}x${OH}`;
    if (key !== overKey || resized) {
      overKey = key;
      overCache.width = OW;
      overCache.height = OH;
      const cg = overCache.getContext("2d")!;
      cg.fillStyle = col.body;
      const per = wf.length / OW;
      for (let x = 0; x < OW; x++) {
        let pk = 0;
        const a = Math.floor(x * per), b = Math.min(wf.length, Math.floor((x + 1) * per) + 1);
        for (let i = a; i < b; i++) if (wf.body[i] > pk) pk = wf.body[i];
        const h = Math.max(1, pk * (OH - 2));
        cg.fillRect(x, (OH - h) / 2, 1, h);
      }
    }
    og.drawImage(overCache, 0, 0);
    const px = (pos / d.buffer.duration) * OW;
    og.fillStyle = "rgba(7,9,13,0.5)";
    og.fillRect(0, 0, px, OH);
    HOT_CUES.forEach((c) => {
      const sec = d.analysis!.cuePoints?.[c.key];
      if (sec == null) return;
      og.fillStyle = col.line;
      og.fillRect(Math.round((sec / d.buffer!.duration) * OW), 0, dpr, OH);
    });
    og.fillStyle = INK;
    og.fillRect(Math.round(px), 0, 2 * dpr, OH);
  });
  return el;
}

export function waveformsView(audio: ConsoleAudio, loadFiles: (slot: Slot, files: FileList) => void): HTMLElement {
  const el = document.createElement("section");
  el.className = "nc-zone nc-waves";
  el.setAttribute("aria-label", "Waveforms");
  el.append(lane(audio, 0, loadFiles), lane(audio, 1, loadFiles));
  return el;
}
