/**
 * The default sampler bank (plan 3C.6): the four synthesised club sounds,
 * rendered into real AudioBuffers once so they behave like any uploaded sample.
 * These replace the oscillator "club FX" that used to sit on the FX surface —
 * they are sounds, not effects (plan 3B.8).
 */
export type ClubSound = { name: string; buffer: AudioBuffer };

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

function makeSound(ctx: BaseAudioContext, seconds: number, fn: (t: number) => number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.max(1, Math.floor(sr * seconds));
  const buf = ctx.createBuffer(1, n, sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = clamp(fn(i / sr), -1, 1);
  return buf;
}

const saw = (f: number, t: number) => 2 * (f * t - Math.floor(f * t + 0.5));
const env = (t: number, attack: number, decay: number) => Math.min(1, t / attack) * Math.exp(-t * decay);

export function renderClubSounds(ctx: BaseAudioContext): ClubSound[] {
  // Air horn: detuned saw stack with a falling pitch and a slow vibrato.
  const airhorn = makeSound(ctx, 1.1, (t) => {
    const bend = 440 * Math.pow(2, (-2.2 * Math.min(1, t / 0.9)) / 12);
    const vib = 1 + 0.008 * Math.sin(2 * Math.PI * 6 * t);
    let s = 0;
    for (const cents of [-14, 0, 12]) {
      s += saw(bend * Math.pow(2, cents / 1200) * vib, t);
    }
    return (s / 3) * env(t, 0.01, 0.6) * 0.8;
  });

  // Siren: a sine sweeping up and down.
  const siren = makeSound(ctx, 1.6, (t) => {
    const f = 700 + 400 * Math.sin(2 * Math.PI * 1.2 * t);
    return Math.sin(2 * Math.PI * f * t) * env(t, 0.02, 0.4) * 0.7;
  });

  // Laser: a saw with a fast downward exponential sweep.
  const laser = makeSound(ctx, 0.6, (t) => {
    const f = 40 + 2600 * Math.exp(-t * 12);
    return saw(f, t) * Math.exp(-t * 6) * 0.7;
  });

  // Sub drop: a low sine falling to near-DC with a long tail.
  const subdrop = makeSound(ctx, 1.4, (t) => {
    const f = 35 + 90 * Math.exp(-t * 3);
    return Math.sin(2 * Math.PI * f * t) * Math.exp(-t * 1.2) * 0.9;
  });

  return [
    { name: "Air Horn", buffer: airhorn },
    { name: "Siren", buffer: siren },
    { name: "Laser", buffer: laser },
    { name: "Sub Drop", buffer: subdrop },
  ];
}

/** Load the default bank into bank 0 pads 0..n. */
export function loadDefaultBank(ctx: BaseAudioContext, target: { setBuffer: (bank: number, pad: number, buffer: AudioBuffer, name: string) => void }): void {
  renderClubSounds(ctx).forEach((s, i) => target.setBuffer(0, i, s.buffer, s.name));
}
