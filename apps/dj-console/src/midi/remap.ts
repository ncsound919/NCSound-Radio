/**
 * MIDI remap + learn for the Akai MPD226 (or any pad controller).
 *
 * The console's mapper (mpd226.ts) knows one set of note/CC numbers. The unit's
 * internal preset may send different ones (a generic preset on channel 16, say).
 * Rather than require the unit to be reprogrammed, the DJ can LEARN a control:
 * pick what it should do, press it on the unit, and this table rewrites what
 * that physical control sends into the number the mapper expects.
 *
 * Rules:
 *  - Nothing learned and no channel filter -> messages pass through untouched.
 *  - A received control that was learned is rewritten to its target.
 *  - A received control that was NOT learned passes through, unless its raw
 *    number is the target of a learned control (that would fire the wrong
 *    action twice), in which case it is dropped.
 *  - Optional channel filter (1-16); other channels are dropped.
 */
import { MPD226, mapMpd226, type MidiAction } from "./mpd226";

export type ControlKind = "note" | "cc";

export type LearnTarget = {
  id: string;
  label: string;
  group: string;
  kind: ControlKind;
  /** Canonical (mapper) number of the first control. */
  number: number;
  /** >1 = a whole contiguous bank: press its first pad and the rest follow. */
  span: number;
};

export type RemapState = { channel: number | null; map: Record<string, string> };

const STORAGE_KEY = "ncsound.console.midi.remap";
const key = (kind: ControlKind, n: number) => `${kind === "note" ? "n" : "c"}:${n}`;

export function describeAction(a: MidiAction): string {
  const deck = (s: number) => (s === 0 ? "A" : "B");
  switch (a.type) {
    case "hotcue": return `Hot cue ${a.key} ${deck(a.slot)}`;
    case "play": return `Play ${deck(a.slot)}`;
    case "cue": return `Cue ${deck(a.slot)}`;
    case "sync": return `Sync ${deck(a.slot)}`;
    case "loop": return `Loop ${deck(a.slot)}`;
    case "volume": return `Volume ${deck(a.slot)}`;
    case "crossfader": return "Crossfader";
    case "filter": return `Filter ${deck(a.slot)}`;
    case "transport": return `Transport ${a.action}`;
    case "pad": return `Sampler pad ${a.pad + 1}`;
    case "fxOn": return `FX ${a.unit + 1} on/off`;
    case "fxDivision": return a.delta > 0 ? "Beat division +" : "Beat division −";
    case "fxWet": return "FX wet";
    case "fxParam": return "FX parameter";
    case "samplerVolume": return "Sampler volume";
    case "obs": return a.action === "scene" ? `OBS scene ${(a.index ?? 0) + 1}` : `OBS ${a.action}`;
    case "trim": return `Trim ${deck(a.slot)}`;
    case "eq": return `EQ ${a.band} ${deck(a.slot)}`;
    case "eqKill": return `Kill ${a.band} ${deck(a.slot)}`;
    case "headphoneCue": return `Headphone cue ${deck(a.slot)}`;
  }
}

const BANKS: Array<{ name: string; base: number }> = [
  { name: "Pad bank A (decks)", base: MPD226.padNoteBase },
  { name: "Pad bank B (sampler)", base: MPD226.padBankBBase },
  { name: "Pad bank C (FX)", base: MPD226.padBankCBase },
  { name: "Pad bank D (OBS)", base: MPD226.padBankDBase },
];

/** Every control the DJ can teach the console, built from the mapper itself so it cannot drift. */
export function learnTargets(): LearnTarget[] {
  const out: LearnTarget[] = [];
  for (const b of BANKS) {
    out.push({ id: `bank:${b.base}`, label: `${b.name}: all 16 (press pad 1)`, group: "Whole pad banks", kind: "note", number: b.base, span: 16 });
  }
  for (const b of BANKS) {
    for (let i = 0; i < 16; i++) {
      const a = mapMpd226([0x90, b.base + i, 100]);
      if (!a) continue;
      out.push({ id: `n:${b.base + i}`, label: `${b.name.split(" (")[0]} pad ${i + 1}: ${describeAction(a)}`, group: b.name, kind: "note", number: b.base + i, span: 1 });
    }
  }
  for (const [name, n] of Object.entries(MPD226.transportNotes)) {
    out.push({ id: `n:${n}`, label: `Transport ${name}`, group: "Transport", kind: "note", number: n, span: 1 });
  }
  for (const n of Object.values(MPD226.cc).sort((x, y) => x - y)) {
    const a = mapMpd226([0xb0, n, 100]);
    if (!a) continue;
    out.push({ id: `c:${n}`, label: describeAction(a), group: n < 28 ? "Knobs, faders, switches: mixer + cue" : "Knobs, faders, switches: EQ", kind: "cc", number: n, span: 1 });
  }
  return out;
}

export type ReceivedControl = { kind: ControlKind; number: number; channel: number };

/** Note-on (velocity > 0) or CC -> the control it came from; anything else null. */
export function receivedControl(data: ArrayLike<number>): ReceivedControl | null {
  if (data.length < 2) return null;
  const status = data[0] & 0xf0;
  const channel = (data[0] & 0x0f) + 1;
  if (status === 0x90 && (data[2] ?? 0) > 0) return { kind: "note", number: data[1], channel };
  if (status === 0xb0) return { kind: "cc", number: data[1], channel };
  return null;
}

export class MidiRemap {
  state: RemapState = { channel: null, map: {} };
  private learning: LearnTarget | null = null;
  private listeners = new Set<() => void>();
  /** Words for the settings panel: what the last learn did / what it is waiting for. */
  message = "";

  constructor(private storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null = safeStorage()) {
    this.load();
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  get learningTarget(): LearnTarget | null {
    return this.learning;
  }
  get learnedCount(): number {
    return Object.keys(this.state.map).length;
  }

  private load(): void {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (!raw) return;
      const p = JSON.parse(raw) as Partial<RemapState>;
      const ch = typeof p.channel === "number" && p.channel >= 1 && p.channel <= 16 ? p.channel : null;
      const map: Record<string, string> = {};
      for (const [k, v] of Object.entries(p.map ?? {})) if (/^[nc]:\d+$/.test(k) && /^[nc]:\d+$/.test(String(v))) map[k] = String(v);
      this.state = { channel: ch, map };
    } catch {
      /* corrupt or unavailable: start clean */
    }
  }
  private save(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      /* private mode: lasts until reload */
    }
  }

  setChannel(channel: number | null): void {
    this.state = { ...this.state, channel: channel && channel >= 1 && channel <= 16 ? channel : null };
    this.save();
    this.emit();
  }

  reset(): void {
    this.state = { channel: this.state.channel, map: {} };
    this.learning = null;
    this.message = "Mapping reset to the console's own numbers.";
    this.save();
    this.emit();
  }

  startLearn(target: LearnTarget): void {
    this.learning = target;
    this.message = target.span > 1 ? `Press pad 1 of that bank on the unit…` : `Press or turn the control on the unit…`;
    this.emit();
  }
  cancelLearn(): void {
    this.learning = null;
    this.message = "";
    this.emit();
  }

  /**
   * Feed every incoming message through here. Returns the bytes the mapper
   * should see, or null if the message is consumed (learning) or dropped.
   */
  process(data: ArrayLike<number>): Uint8Array | null {
    const rc = receivedControl(data);
    if (this.state.channel !== null && rc && rc.channel !== this.state.channel) return null;
    if (this.state.channel !== null && !rc && data.length >= 1 && (data[0] & 0xf0) < 0xf0 && ((data[0] & 0x0f) + 1) !== this.state.channel) return null;

    if (this.learning && rc && rc.kind === this.learning.kind) {
      this.assign(this.learning, rc);
      return null;
    }
    if (this.learning && rc) return null; // wrong kind while learning: ignore, keep waiting

    const out = Uint8Array.from(data as ArrayLike<number>);
    if (!rc) return out;
    const mapped = this.state.map[key(rc.kind, rc.number)];
    if (mapped) {
      out[1] = Number(mapped.slice(2));
      return out;
    }
    if (this.claimed().has(key(rc.kind, rc.number))) return null;
    return out;
  }

  private claimed(): Set<string> {
    return new Set(Object.values(this.state.map));
  }

  private assign(target: LearnTarget, rc: ReceivedControl): void {
    const map = { ...this.state.map };
    const span = Math.max(1, target.span);
    for (let i = 0; i < span; i++) {
      const canonical = key(target.kind, target.number + i);
      // One physical control per target: drop any older source for it.
      for (const [src, dst] of Object.entries(map)) if (dst === canonical) delete map[src];
      map[key(rc.kind, rc.number + i)] = canonical;
    }
    // Never leave an identity entry that would shadow itself.
    for (const [src, dst] of Object.entries(map)) if (src === dst) delete map[src];
    this.state = { ...this.state, map };
    this.learning = null;
    const what = rc.kind === "note" ? `Note ${rc.number}${span > 1 ? `–${rc.number + span - 1}` : ""}` : `CC ${rc.number}`;
    this.message = `${what} ch ${rc.channel} → ${target.label.replace(/: all 16.*/, "")}.`;
    this.save();
    this.emit();
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/** The one remap shared by the MIDI input and the Settings panel. */
export const midiRemap = new MidiRemap();
