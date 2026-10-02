/**
 * SynthEngine — generative "studio preview" loop for the WAVC 91.3 web player.
 *
 * A chill instrumental hip-hop beat at ~88 BPM with swing:
 *   - kick   : sine osc with 150 -> 48 Hz pitch drop, 0.28 s envelope
 *   - snare  : bandpass-filtered noise burst (~1800 Hz) + 190 Hz body
 *   - hats   : highpass noise (8 kHz), short decay, accents, occasional open hat
 *   - bass   : triangle osc through a 300 Hz lowpass, 2-bar note loop
 *   - pad    : two detuned sawtooth oscs per note through a 900 Hz lowpass,
 *              one chord per bar (Am7 -> Fmaj7 -> Cmaj7 -> G6), very low gain
 *   - crackle: looping sparse-impulse buffer (vinyl dust), tiny gain
 *
 * Master chain: voice bus -> gentle lowpass -> master gain (0.5 ceiling) -> out.
 * Everything is defensive: without an AudioContext the engine is a no-op, and
 * every public call is wrapped so audio failures can never break the UI.
 *
 * Started lazily AFTER a user gesture via the zustand player store
 * (dynamic `import('@/lib/synth-engine')` — no SSR issues).
 */

const BPM = 88
const STEP_SEC = 60 / BPM / 4 // one 16th note
const STEPS_PER_BAR = 16
const LOOP_STEPS = STEPS_PER_BAR * 4 // 4-bar harmonic cycle
const SWING_SEC = 0.024 // late 16th off-beats
const LOOKAHEAD_SEC = 0.12
const TICK_MS = 25
const MASTER_CEILING = 0.5
const MASTER_LOWPASS_HZ = 7200

// Drum patterns laid out on a 2-bar (32-step) grid.
const KICK_STEPS = new Set([0, 7, 10, 16, 23, 26])
const SNARE_STEPS = new Set([4, 12, 20, 28])
const OPEN_HAT_STEPS = new Set([14, 30]) // occasional open hat on step 14

// Bass: one note per quarter across a 2-bar loop.
// A1, A1, C2, E2 | G1, A1, E2, D2
const BASS_STEPS = [0, 4, 8, 12, 16, 20, 24, 28]
const BASS_NOTES = [55.0, 55.0, 65.41, 82.41, 49.0, 55.0, 82.41, 73.42]

// Pad: one chord per bar, 4-bar progression.
const CHORDS: number[][] = [
  [110.0, 130.81, 164.81, 196.0], // Am7
  [87.31, 110.0, 130.81, 164.81], // Fmaj7
  [130.81, 164.81, 196.0, 246.94], // Cmaj7
  [98.0, 123.47, 146.83, 164.81], // G6
]

export class SynthEngine {
  private ctx: AudioContext | null = null
  private bus: GainNode | null = null
  private master: GainNode | null = null
  private noise: AudioBuffer | null = null
  private sources = new Set<AudioScheduledSourceNode>()
  private timer: ReturnType<typeof setInterval> | null = null
  private nextStepTime = 0
  private step = 0
  private volume = 0.8
  private running = false

  get isRunning(): boolean {
    return this.running
  }

  /** Must be called from a user gesture path. Creates/resumes the AudioContext. */
  start(): void {
    if (this.running) return
    try {
      if (typeof window === 'undefined') return
      const Ctor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return
      if (!this.ctx) this.ctx = new Ctor()
      const ctx = this.ctx
      void ctx.resume()
      if (!this.noise) this.noise = this.makeNoiseBuffer(ctx)

      this.buildMasterChain(ctx)
      this.startCrackle(ctx)

      this.nextStepTime = ctx.currentTime + 0.08
      this.step = 0
      this.running = true
      this.timer = setInterval(() => this.tick(), TICK_MS)
    } catch {
      this.running = false
    }
  }

  /** Stops the loop and cleans up all scheduled nodes. */
  stop(): void {
    try {
      if (this.timer) {
        clearInterval(this.timer)
        this.timer = null
      }
      this.sources.forEach((src) => {
        try {
          src.stop()
        } catch {
          /* already stopped */
        }
      })
      this.sources.clear()
      try {
        this.bus?.disconnect()
      } catch {}
      try {
        this.master?.disconnect()
      } catch {}
      this.bus = null
      this.master = null
      try {
        void this.ctx?.suspend()
      } catch {}
    } catch {}
    this.running = false
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v))
    if (this.master && this.ctx) {
      try {
        this.master.gain.setTargetAtTime(this.volume * MASTER_CEILING, this.ctx.currentTime, 0.05)
      } catch {}
    }
  }

  dispose(): void {
    this.stop()
    const ctx = this.ctx
    this.ctx = null
    this.noise = null
    try {
      void ctx?.close()
    } catch {}
  }

  // ---------------------------------------------------------------- internals

  private buildMasterChain(ctx: AudioContext): void {
    const warm = ctx.createBiquadFilter()
    warm.type = 'lowpass'
    warm.frequency.value = MASTER_LOWPASS_HZ
    warm.Q.value = 0.0001

    const master = ctx.createGain()
    master.gain.value = this.volume * MASTER_CEILING

    const bus = ctx.createGain()
    bus.gain.value = 1

    bus.connect(warm)
    warm.connect(master)
    master.connect(ctx.destination)

    this.bus = bus
    this.master = master
  }

  private makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const len = Math.floor(ctx.sampleRate)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
    return buf
  }

  private makeCrackleBuffer(ctx: AudioContext): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * 2)
    const buf = ctx.createBuffer(1, len, ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < len; i++) {
      if (Math.random() < 0.0004) {
        data[i] = (Math.random() * 2 - 1) * (0.15 + Math.random() * 0.5)
      }
    }
    return buf
  }

  private track<T extends AudioScheduledSourceNode>(node: T): T {
    this.sources.add(node)
    node.onended = () => {
      this.sources.delete(node)
    }
    return node
  }

  private startCrackle(ctx: AudioContext): void {
    if (!this.bus) return
    const src = ctx.createBufferSource()
    src.buffer = this.makeCrackleBuffer(ctx)
    src.loop = true
    const gain = ctx.createGain()
    gain.gain.value = 0.06
    src.connect(gain)
    gain.connect(this.bus)
    src.start()
    this.track(src)
  }

  private tick(): void {
    const ctx = this.ctx
    if (!ctx || !this.running) return
    try {
      while (this.nextStepTime < ctx.currentTime + LOOKAHEAD_SEC) {
        this.scheduleStep(this.step, this.nextStepTime)
        this.nextStepTime += STEP_SEC
        this.step = (this.step + 1) % LOOP_STEPS
      }
    } catch {
      /* keep the UI safe */
    }
  }

  private scheduleStep(step: number, base: number): void {
    if (!this.ctx || !this.bus || !this.noise) return
    const t = base + (step % 2 === 1 ? SWING_SEC : 0)
    const in2 = step % 32 // 2-bar drum/bass cycle
    const bar = Math.floor(step / STEPS_PER_BAR) % 4
    const inBar = step % STEPS_PER_BAR

    if (KICK_STEPS.has(in2)) this.playKick(t)
    if (SNARE_STEPS.has(in2)) this.playSnare(t)

    if (inBar % 2 === 0) {
      const open = OPEN_HAT_STEPS.has(in2)
      const accent = inBar % 4 === 0 ? 1 : inBar % 4 === 2 ? 0.75 : 0.6
      this.playHat(t, open, open ? 1.1 : accent)
    }

    const bassIndex = BASS_STEPS.indexOf(in2)
    if (bassIndex >= 0) {
      const note = BASS_NOTES[bassIndex] ?? 55
      this.playBass(t, note)
    }

    if (inBar === 0) {
      const chord = CHORDS[bar % CHORDS.length] ?? CHORDS[0]
      if (chord) this.playPad(t, chord, STEP_SEC * STEPS_PER_BAR)
    }
  }

  private playKick(t: number): void {
    const ctx = this.ctx
    const bus = this.bus
    if (!ctx || !bus) return
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.setValueAtTime(150, t)
    osc.frequency.exponentialRampToValueAtTime(48, t + 0.12)
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.linearRampToValueAtTime(0.85, t + 0.006)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.28)
    osc.connect(gain)
    gain.connect(bus)
    osc.start(t)
    osc.stop(t + 0.3)
    this.track(osc)
  }

  private playSnare(t: number): void {
    const ctx = this.ctx
    const bus = this.bus
    if (!ctx || !bus || !this.noise) return

    // filtered noise burst
    const noise = ctx.createBufferSource()
    noise.buffer = this.noise
    const band = ctx.createBiquadFilter()
    band.type = 'bandpass'
    band.frequency.value = 1800
    band.Q.value = 0.9
    const nGain = ctx.createGain()
    nGain.gain.setValueAtTime(0.0001, t)
    nGain.gain.linearRampToValueAtTime(0.42, t + 0.003)
    nGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.18)
    noise.connect(band)
    band.connect(nGain)
    nGain.connect(bus)
    noise.start(t)
    noise.stop(t + 0.2)
    this.track(noise)

    // tonal body
    const body = ctx.createOscillator()
    body.type = 'triangle'
    body.frequency.value = 190
    const bGain = ctx.createGain()
    bGain.gain.setValueAtTime(0.22, t)
    bGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.12)
    body.connect(bGain)
    bGain.connect(bus)
    body.start(t)
    body.stop(t + 0.14)
    this.track(body)
  }

  private playHat(t: number, open: boolean, accent: number): void {
    const ctx = this.ctx
    const bus = this.bus
    if (!ctx || !bus || !this.noise) return
    const noise = ctx.createBufferSource()
    noise.buffer = this.noise
    const hp = ctx.createBiquadFilter()
    hp.type = 'highpass'
    hp.frequency.value = 8000
    const gain = ctx.createGain()
    const peak = (open ? 0.16 : 0.11) * accent
    const dur = open ? 0.28 : 0.05
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.linearRampToValueAtTime(peak, t + 0.002)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    noise.connect(hp)
    hp.connect(gain)
    gain.connect(bus)
    noise.start(t)
    noise.stop(t + dur + 0.02)
    this.track(noise)
  }

  private playBass(t: number, freq: number): void {
    const ctx = this.ctx
    const bus = this.bus
    if (!ctx || !bus) return
    const osc = ctx.createOscillator()
    osc.type = 'triangle'
    osc.frequency.value = freq
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 300
    lp.Q.value = 0.5
    const gain = ctx.createGain()
    const dur = STEP_SEC * 3.2
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.linearRampToValueAtTime(0.32, t + 0.02)
    gain.gain.setValueAtTime(0.32, t + dur * 0.6)
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur)
    osc.connect(lp)
    lp.connect(gain)
    gain.connect(bus)
    osc.start(t)
    osc.stop(t + dur + 0.05)
    this.track(osc)
  }

  private playPad(t: number, freqs: number[], dur: number): void {
    const ctx = this.ctx
    const bus = this.bus
    if (!ctx || !bus) return
    const lp = ctx.createBiquadFilter()
    lp.type = 'lowpass'
    lp.frequency.value = 900
    lp.Q.value = 0.3
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0.0001, t)
    gain.gain.linearRampToValueAtTime(0.045, t + dur * 0.25)
    gain.gain.setValueAtTime(0.045, t + dur * 0.7)
    gain.gain.linearRampToValueAtTime(0.0001, t + dur)
    lp.connect(gain)
    gain.connect(bus)

    for (const freq of freqs) {
      for (const detune of [-6, 6]) {
        const osc = ctx.createOscillator()
        osc.type = 'sawtooth'
        osc.frequency.value = freq
        osc.detune.value = detune
        osc.connect(lp)
        osc.start(t)
        osc.stop(t + dur + 0.05)
        this.track(osc)
      }
    }
  }
}

// ------------------------------------------------------------------ singleton

let instance: SynthEngine | null = null

export function getSynthEngine(): SynthEngine {
  if (!instance) instance = new SynthEngine()
  return instance
}
