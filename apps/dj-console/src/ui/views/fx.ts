/**
 * FX tab: two real FX units (plan phase 3B.7). Everything is read back from the
 * engine each frame; the controls only call engine methods.
 */
import type { ConsoleAudio, Slot } from "../../audio/engine";
import type { FxDivision, FxKind, FxTarget } from "@ncsound/dj-engine/fx";
import { FX_DIVISIONS, FX_KINDS } from "@ncsound/dj-engine/fx";
import { onFrame } from "../../app/scheduler";
import { key, knob, readout } from "../controls";

const KIND_LABEL: Record<FxKind, string> = {
  echo: "Echo",
  reverb: "Reverb",
  flanger: "Flanger",
  bitcrush: "Bitcrush",
  gater: "Gater",
};

const DIV_LABEL: Record<number, string> = { 0.25: "1/16", 0.5: "1/8", 1: "1/4", 2: "1/2", 4: "1 bar" };

const TARGET_LABEL: Record<string, string> = { A: "Deck A", B: "Deck B", master: "Master" };
const TARGET_CYCLE: Array<FxTarget | null> = ["A", "B", "master", null];

const pct = (v: number) => `${Math.round(v * 100)}%`;

function div(cls: string, text?: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  if (text !== undefined) d.textContent = text;
  return d;
}

function unitCard(audio: ConsoleAudio, index: 0 | 1): HTMLElement {
  const unit = audio.mixer.fx.units[index];
  const el = div("nc-fx-unit");
  el.setAttribute("aria-label", `FX unit ${index + 1}`);

  const head = div("nc-fx-head", `FX ${index + 1}`);
  el.append(head);

  // Effect picker: one key per kind.
  const picker = div("nc-fx-row nc-fx-pick");
  const kindKeys = FX_KINDS.map((kind) => {
    const k = key({ label: KIND_LABEL[kind], onPress: () => unit.setEffect(kind) });
    k.el.setAttribute("aria-label", `Effect ${KIND_LABEL[kind]}`);
    picker.append(k.el);
    return { kind, k };
  });
  el.append(picker);

  const controls = div("nc-fx-row nc-fx-controls");
  const on = key({ label: "On", toggle: true, onToggle: (v) => unit.setOn(v) });
  on.el.classList.add("nc-fx-on");
  const wet = knob({ label: "Wet", min: 0, max: 1, value: 0.5, reset: 0.5, step: 0.01, format: pct, onInput: (v) => unit.setWet(v) });
  const param = knob({ label: "Param", min: 0, max: 1, value: 0.5, reset: 0.5, step: 0.01, format: pct, onInput: (v) => unit.setParam(v) });
  controls.append(on.el, wet.el, param.el);
  el.append(controls);

  const routing = div("nc-fx-row nc-fx-routing");
  const assign = key({
    label: "Off",
    onPress: () => {
      const cur = unit.state().target;
      const next = TARGET_CYCLE[(TARGET_CYCLE.indexOf(cur) + 1) % TARGET_CYCLE.length];
      audio.mixer.assignFx(index, next);
    },
  });
  assign.el.setAttribute("aria-label", `Route FX ${index + 1}`);
  assign.el.title = "Route this unit to Deck A, Deck B, the master bus, or off";
  const division = key({
    label: "1/8",
    onPress: () => {
      const cur = unit.state().division;
      const next = FX_DIVISIONS[(FX_DIVISIONS.indexOf(cur) + 1) % FX_DIVISIONS.length];
      unit.setDivision(next);
    },
  });
  division.el.setAttribute("aria-label", `Beat division FX ${index + 1}`);
  division.el.title = "Beat division the effect is synced to";
  const divR = readout("Division", "1/8");
  const routeR = readout("Route", "Off");
  routing.append(division.el, assign.el, divR.el, routeR.el);
  el.append(routing);

  onFrame(() => {
    const s = unit.state();
    for (const { kind, k } of kindKeys) k.setOn(kind === s.kind);
    on.setOn(s.on);
    wet.set(s.wet);
    param.set(s.param);
    assign.el.textContent = s.target ? TARGET_LABEL[s.target] : "Off";
    division.el.textContent = DIV_LABEL[s.division] ?? String(s.division);
    divR.set(DIV_LABEL[s.division] ?? String(s.division));
    routeR.set(s.target ? TARGET_LABEL[s.target] : "Off");
  });

  return el;
}

export function fxView(audio: ConsoleAudio): HTMLElement {
  const el = document.createElement("div");
  el.className = "nc-fx";
  el.append(unitCard(audio, 0), unitCard(audio, 1));

  // Tempo follower: each unit's division tracks the effective BPM of the bus it
  // is on, so a pitch change or a sync retunes the delay/gate/comb.
  const last = ["", ""];
  onFrame(() => {
    audio.mixer.fx.units.forEach((unit, i) => {
      const s = unit.state();
      if (!s.target) return;
      // Deck buses follow their own deck; master follows the tempo deck.
      const slot: Slot = s.target === "A" ? 0 : s.target === "B" ? 1 : (audio.mixer.active as Slot);
      const deck = audio.deck(slot);
      const bpm = deck.analysis ? deck.analysis.bpm * deck.rate : 120;
      const k = `${bpm.toFixed(3)}:${s.division}`;
      if (k === last[i]) return;
      last[i] = k;
      unit.setSync(bpm, s.division);
    });
  });

  return el;
}
