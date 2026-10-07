/**
 * Mixer view: per channel trim, 3-band EQ with kills, filter, level meter and
 * channel fader; master meter and gain; crossfader with curve; pitch range.
 *
 * Not shown, on purpose: headphone cue. The engine's cue routing splits the one
 * stereo output (cue left, program right), which in a club would put the cue on
 * half the PA. It comes back with an output-device setting.
 */
import type { ConsoleAudio, Slot } from "../../audio/engine";
import { deckName } from "../../audio/engine";
import { consoleStore } from "../../state/console";
import { onFrame } from "../../app/scheduler";
import { fader, key, knob, meter } from "../controls";

type Band = "high" | "mid" | "low";
const BANDS: Array<{ band: Band; label: string }> = [
  { band: "high", label: "Hi" },
  { band: "mid", label: "Mid" },
  { band: "low", label: "Low" },
];
const CURVES = ["blend", "dip", "cut"] as const;
const CURVE_LABEL = { blend: "Blend", dip: "Dip", cut: "Cut" } as const;
const RANGES = [4, 8, 16, 50] as const;

const db = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;

function div(cls: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  return d;
}

function strip(audio: ConsoleAudio, slot: Slot): HTMLElement {
  const name = deckName(slot);
  const mixer = audio.mixer;
  const d = () => audio.deck(slot);
  const el = div("nc-strip");
  el.dataset.deck = name.toLowerCase();
  el.setAttribute("aria-label", `Channel ${name}`);

  const top = div("nc-strip-pair");
  const trim = knob({
    label: "Trim", min: -12, max: 6, value: 0, reset: 0, step: 0.5, format: db,
    onInput: (v) => d().setManualTrim(v, mixer.autoGainEnabled),
  });
  trim.control.setAttribute("aria-label", `Trim ${name}`);
  const filter = knob({
    label: "Filter", min: -1, max: 1, value: 0, reset: 0, step: 0.01,
    format: (v) => (Math.abs(v) < 0.04 ? "Off" : v < 0 ? `Low-pass ${Math.round(-v * 100)}%` : `High-pass ${Math.round(v * 100)}%`),
    onInput: (v) => d().setColorFilter(v),
  });
  filter.control.setAttribute("aria-label", `Filter ${name}`);
  top.append(trim.el, filter.el);
  el.append(top);

  const eq = BANDS.map(({ band, label }) => {
    const row = div("nc-strip-eq");
    const k = knob({
      label, min: -24, max: 6, value: 0, reset: 0, step: 0.5, format: db,
      onInput: (v) => d().setEq(band, v),
    });
    k.control.setAttribute("aria-label", `${label} EQ ${name}`);
    const kill = key({ label: "Kill", toggle: true, onToggle: () => d().toggleEqKill(band) });
    kill.el.setAttribute("aria-label", `Kill ${label} ${name}`);
    row.append(k.el, kill.el);
    el.append(row);
    return { band, k, kill };
  });

  const faderRow = div("nc-strip-fader");
  const lvl = meter(`Level ${name}`, true);
  const vol = fader({
    label: "Vol", min: 0, max: 1, value: 1, reset: 1, step: 0.005,
    format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => mixer.setDeckChannelVolume(slot, v),
  });
  vol.control.setAttribute("aria-label", `Volume ${name}`);
  // Headphone cue for this channel (plan 3A.3).
  const cueK = key({
    label: "CUE",
    toggle: true,
    onToggle: (on) => {
      audio.setDeckCue(slot, on);
      consoleStore.set((s) => {
        const cue = [...s.outputs.cue] as [boolean, boolean];
        cue[slot] = on;
        return { outputs: { ...s.outputs, cue } };
      });
    },
  });
  cueK.el.setAttribute("aria-label", `Cue ${name}`);
  cueK.el.title = `Pre-fader cue for deck ${name} on the headphone output`;
  // Stack the cue key under the fader so the strip does not widen past its column.
  const faderStack = div("nc-strip-fader-stack");
  faderStack.append(vol.el, cueK.el);
  faderRow.append(lvl.el, faderStack);
  el.append(faderRow);

  onFrame(() => {
    const dk = d();
    trim.set(dk.manualTrimDb);
    filter.set(dk.colorValue);
    for (const { band, k, kill } of eq) {
      k.set(band === "high" ? dk.highDb : band === "mid" ? dk.midDb : dk.lowDb);
      kill.setOn(band === "high" ? dk.highKill : band === "mid" ? dk.midKill : dk.lowKill);
    }
    vol.set(dk.channelVolume);
    lvl.set(dk.getLevel());
    cueK.setOn(consoleStore.get().outputs.cue[slot]);
  });
  return el;
}

export function mixerView(audio: ConsoleAudio): HTMLElement {
  const mixer = audio.mixer;
  const el = document.createElement("section");
  el.className = "nc-zone nc-mixer";
  el.setAttribute("aria-label", "Mixer");

  const center = div("nc-mixer-center");
  const master = meter("Master");
  let masterDb = 0;
  const gain = knob({
    label: "Master", min: -24, max: 6, value: 0, reset: 0, step: 0.5, format: db,
    onInput: (v) => { masterDb = mixer.setMasterGainDb(v).applied; },
  });
  gain.control.setAttribute("aria-label", "Master gain");
  const range = key({
    label: `±${mixer.pitchFaderRange}%`,
    onPress: () => {
      const i = RANGES.indexOf(mixer.pitchFaderRange as (typeof RANGES)[number]);
      mixer.setPitchFaderRange(RANGES[(i + 1) % RANGES.length]);
    },
  });
  range.el.title = "Pitch fader range (both decks)";
  range.el.setAttribute("aria-label", "Pitch fader range");

  // Headphone controls, shown only when a headphone output is enabled (3A.3).
  const hp = div("nc-mixer-hp");
  const hpMix = knob({
    label: "Cue Mix", min: 0, max: 1, value: 1, reset: 1, step: 0.01,
    format: (v) => (v >= 0.99 ? "Cue" : v <= 0.01 ? "Master" : `${Math.round(v * 100)}%`),
    onInput: (v) => { audio.headphone.setMix(v); consoleStore.set((s) => ({ outputs: { ...s.outputs, mix: v } })); },
  });
  const hpLevel = knob({
    label: "Cue Vol", min: 0, max: 1, value: 0.8, reset: 0.8, step: 0.01,
    format: (v) => `${Math.round(v * 100)}%`,
    onInput: (v) => { audio.headphone.setLevel(v); consoleStore.set((s) => ({ outputs: { ...s.outputs, level: v } })); },
  });
  hp.append(hpMix.el, hpLevel.el);
  hp.hidden = true;
  center.append(master.el, gain.el, range.el, hp);
  consoleStore.select((s) => s.outputs.headphoneActive, () => {
    const o = consoleStore.get().outputs;
    hp.hidden = !o.headphoneActive;
    hpMix.set(o.mix);
    hpLevel.set(o.level);
  });

  const strips = div("nc-mixer-strips");
  strips.append(strip(audio, 0), center, strip(audio, 1));

  const xrow = div("nc-mixer-xfade");
  const xf = fader({
    label: "Crossfader", orient: "h", min: -1, max: 1, value: mixer.crossfader, reset: 0, step: 0.01,
    format: (v) => (Math.abs(v) < 0.01 ? "Centre" : v < 0 ? `A ${Math.round(-v * 100)}%` : `B ${Math.round(v * 100)}%`),
    onInput: (v) => mixer.setCrossfader(v),
  });
  const curve = key({
    label: CURVE_LABEL[mixer.crossfaderCurve],
    onPress: () => mixer.setCrossfaderCurve(CURVES[(CURVES.indexOf(mixer.crossfaderCurve) + 1) % CURVES.length]),
  });
  curve.el.title = "Crossfader curve: Blend (equal power), Dip (linear), Cut (scratch)";
  curve.el.setAttribute("aria-label", "Crossfader curve");
  xrow.append(xf.el, curve.el);

  el.append(strips, xrow);

  let lastRange = 0, lastCurve = "";
  onFrame(() => {
    const t = mixer.getMasterTelemetry();
    // -48 dBFS .. 0 dBFS onto the bar; the limiter keeps the output at or under 0.
    master.set((t.masterPeakDb + 48) / 48, t.masterPeakDb > -0.5);
    gain.set(masterDb);
    xf.set(mixer.crossfader);
    if (mixer.pitchFaderRange !== lastRange) {
      lastRange = mixer.pitchFaderRange;
      range.el.textContent = `±${lastRange}%`;
    }
    if (mixer.crossfaderCurve !== lastCurve) {
      lastCurve = mixer.crossfaderCurve;
      curve.el.textContent = CURVE_LABEL[mixer.crossfaderCurve];
    }
  });
  return el;
}
