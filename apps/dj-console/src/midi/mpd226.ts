/**
 * Akai MPD226 mapping: the NCSound preset (pad banks A-D, control banks A-B).
 *
 * Pad bank A layout (as seen on the unit):
 *   top row     13-16  hot cues 1-4, deck A
 *   second row   9-12  hot cues 1-4, deck B
 *   third row    5-8   play A, cue A, play B, cue B
 *   bottom row   1-4   sync A, sync B, loop A, loop B
 *
 * The note and CC numbers are the preset defined here and in docs/MPD226-SETUP.md.
 * The top bar's MIDI chip shows the last message received, so a mismatch between
 * the unit and this file is visible immediately.
 */
import type { HotCueKey, Slot } from "../audio/engine";

/**
 * The NCSound MPD226 preset (see docs/MPD226-SETUP.md). Program the unit to
 * these numbers once; this file and the preset are the contract.
 *
 * Pads: banks A-D on notes 36-99 (16 each). Control bank A: knobs 16-19,
 * faders 20-23, switches 24-25 (headphone cue). Control bank B: knobs 28-31,
 * faders 32-35, switches 36-39 (EQ kills). Control bank C is reserved for stems.
 */
export const MPD226 = {
  padNoteBase: 36,
  padBankBBase: 52,
  padBankCBase: 68,
  padBankDBase: 84,
  cc: {
    // Control bank A: mixer + cue
    filterA: 16, filterB: 17, fxWet: 18, fxParam: 19,
    volA: 20, volB: 21, crossfader: 22, samplerVol: 23,
    cueA: 24, cueB: 25,
    // Control bank B: EQ
    eqHighA: 28, eqHighB: 29, trimA: 30, trimB: 31,
    eqLowA: 32, eqLowB: 33, eqMidA: 34, eqMidB: 35,
    killLowA: 36, killLowB: 37, killHighA: 38, killHighB: 39,
  },
  transportNotes: { play: 118, stop: 117, rec: 119 },
} as const;

const EQ_MIN_DB = -24, EQ_MAX_DB = 6, TRIM_MIN_DB = -12, TRIM_MAX_DB = 6;

/** CC 64 is the 0 dB detent: below cuts toward min, above boosts toward max. */
export function detentDb(cc: number, min: number, max: number): number {
  const db = cc <= 64 ? ((64 - cc) / 64) * min : ((cc - 64) / 63) * max;
  return db === 0 ? 0 : db; // normalise -0
}

export type MidiAction =
  | { type: "hotcue"; slot: Slot; key: HotCueKey }
  | { type: "play"; slot: Slot }
  | { type: "cue"; slot: Slot }
  | { type: "sync"; slot: Slot }
  | { type: "loop"; slot: Slot }
  | { type: "volume"; slot: Slot; value: number }
  | { type: "crossfader"; value: number }
  | { type: "filter"; slot: Slot; value: number }
  | { type: "transport"; action: "play" | "stop" | "rec" }
  /** Sampler pad, velocity 0..1 (plan 3D.2, bank B). */
  | { type: "pad"; bank: number; pad: number; velocity: number }
  | { type: "fxOn"; unit: 0 | 1 }
  | { type: "fxDivision"; delta: 1 | -1 }
  | { type: "fxWet"; value: number }
  | { type: "fxParam"; value: number }
  | { type: "samplerVolume"; value: number }
  | { type: "obs"; action: "scene" | "mediaPlay" | "mediaStop" | "camera" | "overlay" | "record"; index?: number }
  /** Control bank B: channel trim in dB. */
  | { type: "trim"; slot: Slot; value: number }
  /** Control bank B: 3-band EQ in dB. */
  | { type: "eq"; slot: Slot; band: "low" | "mid" | "high"; value: number }
  /** Control bank B: isolator kill on/off (a hardware switch). */
  | { type: "eqKill"; slot: Slot; band: "low" | "mid" | "high"; on: boolean }
  /** Control bank A switches: pre-fader headphone cue on/off. */
  | { type: "headphoneCue"; slot: Slot; on: boolean };

const CUE_KEYS: HotCueKey[] = ["intro", "drop", "breakdown", "outro"];

/** Pad number 1-16 -> action. */
function padAction(pad: number): MidiAction | null {
  if (pad >= 13) return { type: "hotcue", slot: 0, key: CUE_KEYS[pad - 13] };
  if (pad >= 9) return { type: "hotcue", slot: 1, key: CUE_KEYS[pad - 9] };
  switch (pad) {
    case 5: return { type: "play", slot: 0 };
    case 6: return { type: "cue", slot: 0 };
    case 7: return { type: "play", slot: 1 };
    case 8: return { type: "cue", slot: 1 };
    case 1: return { type: "sync", slot: 0 };
    case 2: return { type: "sync", slot: 1 };
    case 3: return { type: "loop", slot: 0 };
    case 4: return { type: "loop", slot: 1 };
  }
  return null;
}

/**
 * Pad bank C: FX on/off and beat division. Rolls, brake, backspin and echo-out
 * are the phase 3B.6 performance moves and are not mapped until those exist, so
 * those pads do nothing rather than lying.
 */
function fxPadAction(index: number): MidiAction | null {
  switch (index) {
    case 0: return { type: "fxOn", unit: 0 };
    case 1: return { type: "fxOn", unit: 1 };
    case 2: return { type: "fxDivision", delta: -1 };
    case 3: return { type: "fxDivision", delta: 1 };
  }
  return null;
}

/**
 * Pad bank D: OBS. Scenes 1-8 in OBS order, media play/stop, camera toggle,
 * overlay toggle and OBS record. With OBS disconnected every action is inert.
 */
function obsPadAction(index: number): MidiAction | null {
  if (index <= 7) return { type: "obs", action: "scene", index };
  switch (index) {
    case 8: return { type: "obs", action: "mediaPlay" };
    case 9: return { type: "obs", action: "mediaStop" };
    case 10: return { type: "obs", action: "camera" };
    case 11: return { type: "obs", action: "overlay" };
    case 12: return { type: "obs", action: "record" };
  }
  return null;
}

/** Raw MIDI bytes -> console action, or null. Channel is ignored. Note-offs do nothing. */
export function mapMpd226(data: ArrayLike<number>): MidiAction | null {
  if (data.length < 3) return null;
  const kind = data[0] & 0xf0;
  const d1 = data[1], d2 = data[2];
  if (kind === 0x90 && d2 > 0) {
    const padA = d1 - MPD226.padNoteBase + 1;
    if (padA >= 1 && padA <= 16) return padAction(padA);
    const padB = d1 - MPD226.padBankBBase;
    if (padB >= 0 && padB <= 15) return { type: "pad", bank: 0, pad: padB, velocity: d2 / 127 };
    const padC = d1 - MPD226.padBankCBase;
    if (padC >= 0 && padC <= 15) return fxPadAction(padC);
    const padD = d1 - MPD226.padBankDBase;
    if (padD >= 0 && padD <= 15) return obsPadAction(padD);
    if (d1 === MPD226.transportNotes.play) return { type: "transport", action: "play" };
    if (d1 === MPD226.transportNotes.stop) return { type: "transport", action: "stop" };
    if (d1 === MPD226.transportNotes.rec) return { type: "transport", action: "rec" };
    return null;
  }
  if (kind === 0xb0) {
    const v = d2 / 127;
    switch (d1) {
      case MPD226.cc.volA: return { type: "volume", slot: 0, value: v };
      case MPD226.cc.volB: return { type: "volume", slot: 1, value: v };
      case MPD226.cc.crossfader: return { type: "crossfader", value: v * 2 - 1 };
      case MPD226.cc.filterA: return { type: "filter", slot: 0, value: v * 2 - 1 };
      case MPD226.cc.filterB: return { type: "filter", slot: 1, value: v * 2 - 1 };
      case MPD226.cc.fxWet: return { type: "fxWet", value: v };
      case MPD226.cc.fxParam: return { type: "fxParam", value: v };
      case MPD226.cc.samplerVol: return { type: "samplerVolume", value: v };
      // Control bank A switches.
      case MPD226.cc.cueA: return { type: "headphoneCue", slot: 0, on: d2 >= 64 };
      case MPD226.cc.cueB: return { type: "headphoneCue", slot: 1, on: d2 >= 64 };
      // Control bank B: trim and EQ (detented at CC 64 = 0 dB).
      case MPD226.cc.trimA: return { type: "trim", slot: 0, value: detentDb(d2, TRIM_MIN_DB, TRIM_MAX_DB) };
      case MPD226.cc.trimB: return { type: "trim", slot: 1, value: detentDb(d2, TRIM_MIN_DB, TRIM_MAX_DB) };
      case MPD226.cc.eqHighA: return { type: "eq", slot: 0, band: "high", value: detentDb(d2, EQ_MIN_DB, EQ_MAX_DB) };
      case MPD226.cc.eqHighB: return { type: "eq", slot: 1, band: "high", value: detentDb(d2, EQ_MIN_DB, EQ_MAX_DB) };
      case MPD226.cc.eqLowA: return { type: "eq", slot: 0, band: "low", value: detentDb(d2, EQ_MIN_DB, EQ_MAX_DB) };
      case MPD226.cc.eqLowB: return { type: "eq", slot: 1, band: "low", value: detentDb(d2, EQ_MIN_DB, EQ_MAX_DB) };
      case MPD226.cc.eqMidA: return { type: "eq", slot: 0, band: "mid", value: detentDb(d2, EQ_MIN_DB, EQ_MAX_DB) };
      case MPD226.cc.eqMidB: return { type: "eq", slot: 1, band: "mid", value: detentDb(d2, EQ_MIN_DB, EQ_MAX_DB) };
      // Control bank B switches: EQ kills.
      case MPD226.cc.killLowA: return { type: "eqKill", slot: 0, band: "low", on: d2 >= 64 };
      case MPD226.cc.killLowB: return { type: "eqKill", slot: 1, band: "low", on: d2 >= 64 };
      case MPD226.cc.killHighA: return { type: "eqKill", slot: 0, band: "high", on: d2 >= 64 };
      case MPD226.cc.killHighB: return { type: "eqKill", slot: 1, band: "high", on: d2 >= 64 };
    }
  }
  return null;
}

/** Human-readable summary for the status chip, e.g. "Note 48 ch 10 vel 96". */
export function describeMidi(data: ArrayLike<number>): string {
  const kind = data[0] & 0xf0, ch = (data[0] & 0x0f) + 1;
  if (kind === 0x90) return `Note ${data[1]} ch ${ch} vel ${data[2]}`;
  if (kind === 0x80) return `Note off ${data[1]} ch ${ch}`;
  if (kind === 0xb0) return `CC ${data[1]} ch ${ch} = ${data[2]}`;
  return `Status 0x${data[0].toString(16)}`;
}
