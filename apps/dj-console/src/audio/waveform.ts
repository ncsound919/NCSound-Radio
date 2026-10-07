/**
 * Waveform data for the scrolling deck view.
 *
 * The engine's analysis keeps 480 buckets per track (about half a second each
 * on a 4-minute track), which is fine for an overview and far too coarse for a
 * zoomed view. This computes three bands at RATE buckets per second from the
 * decoded audio, once, at load. Everything drawn is derived from these arrays;
 * nothing is computed per frame from raw audio.
 *
 * Bands: one-pole splits at 250 Hz and 3 kHz (the same split the engine's
 * analysis uses), RMS per bucket, plus the bucket's absolute peak.
 */
export const WAVE_RATE = 150; // buckets per second

/**
 * The audio a waveform needs. AudioBuffer satisfies this structurally; a Worker
 * (no AudioBuffer) is served by `computeWaveformChannels` with plain Float32Arrays.
 */
export interface WaveSource {
  readonly sampleRate: number;
  readonly length: number;
  readonly numberOfChannels: number;
  readonly duration?: number;
  getChannelData(channel: number): Float32Array;
}

export type DeckWaveform = {
  rate: number;
  duration: number;
  length: number;
  /** Per bucket, 0..1 after normalisation. body = all bands, mid = mid+high, high = high only. */
  body: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  peak: Float32Array;
};

export function computeWaveform(buf: WaveSource, rate = WAVE_RATE): DeckWaveform {
  const sr = buf.sampleRate;
  const n = buf.length;
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const per = Math.max(1, Math.round(sr / rate));
  const length = Math.ceil(n / per);
  const body = new Float32Array(length);
  const mid = new Float32Array(length);
  const high = new Float32Array(length);
  const peak = new Float32Array(length);

  const aLow = 1 - Math.exp((-2 * Math.PI * 250) / sr);
  const aHigh = 1 - Math.exp((-2 * Math.PI * 3000) / sr);
  let lp1 = 0, lp2 = 0;
  const inv = 1 / chans.length;

  for (let b = 0; b < length; b++) {
    const start = b * per;
    const end = Math.min(n, start + per);
    let sl = 0, sm = 0, sh = 0, pk = 0;
    for (let i = start; i < end; i++) {
      let x = 0;
      for (let c = 0; c < chans.length; c++) x += chans[c][i];
      x *= inv;
      lp1 += aLow * (x - lp1);
      lp2 += aHigh * (x - lp2);
      const m = lp2 - lp1;
      const h = x - lp2;
      sl += lp1 * lp1;
      sm += m * m;
      sh += h * h;
      const ax = x < 0 ? -x : x;
      if (ax > pk) pk = ax;
    }
    const cnt = Math.max(1, end - start);
    const l = sl / cnt, mm = sm / cnt, hh = sh / cnt;
    body[b] = Math.sqrt(l + mm + hh);
    mid[b] = Math.sqrt(mm + hh);
    high[b] = Math.sqrt(hh);
    peak[b] = pk;
  }

  // One shared scale for the three bands so their relative size stays true;
  // a 0.7 display curve lifts quiet detail without reordering anything.
  let maxBody = 1e-9, maxPeak = 1e-9;
  for (let b = 0; b < length; b++) {
    if (body[b] > maxBody) maxBody = body[b];
    if (peak[b] > maxPeak) maxPeak = peak[b];
  }
  for (let b = 0; b < length; b++) {
    body[b] = Math.pow(body[b] / maxBody, 0.7);
    mid[b] = Math.pow(mid[b] / maxBody, 0.7);
    high[b] = Math.pow(high[b] / maxBody, 0.7);
    peak[b] = peak[b] / maxPeak;
  }
  return { rate, duration: buf.duration ?? buf.length / buf.sampleRate, length, body, mid, high, peak };
}

/** Worker entry point: same waveform, from decoded channels instead of an AudioBuffer. */
export function computeWaveformChannels(channels: Float32Array[], sampleRate: number, rate = WAVE_RATE): DeckWaveform {
  if (!channels.length) throw new Error("computeWaveformChannels needs at least one channel");
  const length = channels[0].length;
  return computeWaveform(
    {
      sampleRate,
      length,
      numberOfChannels: channels.length,
      duration: length / sampleRate,
      getChannelData: (c: number) => channels[c] ?? channels[0],
    },
    rate,
  );
}

/** Pre-rendered strips of the waveform, so a frame only blits images. */
export type WaveTiles = { width: number; height: number; tiles: HTMLCanvasElement[] };

export const TILE_W = 2048;

export function renderTiles(w: DeckWaveform, colors: { body: string; mid: string; high: string }, height = 160): WaveTiles {
  const tiles: HTMLCanvasElement[] = [];
  const half = height / 2;
  for (let t0 = 0; t0 < w.length; t0 += TILE_W) {
    const cv = document.createElement("canvas");
    const tw = Math.min(TILE_W, w.length - t0);
    cv.width = tw;
    cv.height = height;
    const g = cv.getContext("2d")!;
    const layers: Array<[Float32Array, string]> = [[w.body, colors.body], [w.mid, colors.mid], [w.high, colors.high]];
    for (const [arr, col] of layers) {
      g.fillStyle = col;
      for (let x = 0; x < tw; x++) {
        const hgt = Math.max(0.5, arr[t0 + x] * (half - 2));
        g.fillRect(x, half - hgt, 1, hgt * 2);
      }
    }
    tiles.push(cv);
  }
  return { width: w.length, height, tiles };
}
