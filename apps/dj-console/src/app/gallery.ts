/**
 * Component gallery (/?ui=gallery): every control in every state, with
 * hand-set demo values. Nothing here is a live signal; it exists to review and
 * audit the control set before the performance screen is built from it.
 */
import "../ui/tokens.css";
import "./gallery.css";
import { knob, fader, pad, key, readout, meter, tabs, drawer } from "../ui/controls";

function row(title: string, ...kids: HTMLElement[]): HTMLElement {
  const s = document.createElement("section");
  s.className = "gal-row";
  const t = document.createElement("h2");
  t.textContent = title;
  const body = document.createElement("div");
  body.className = "gal-body";
  body.append(...kids);
  s.append(t, body);
  return s;
}

export function mountGallery(root: HTMLElement): void {
  root.innerHTML = "";
  root.className = "gal";
  const frame = document.createElement("main");
  frame.dataset.frame = "";
  frame.className = "gal-frame";
  const intro = document.createElement("p");
  intro.className = "gal-intro";
  intro.textContent = "Control set review. Demo values are hand-set; nothing on this page is a live signal.";
  frame.append(intro);

  frame.append(
    row("Knob: M / L / XL, centred, off-centre",
      knob({ label: "Trim", size: "m", min: -12, max: 12, value: 0, step: 0.5, format: (v) => `${v} dB` }).el,
      knob({ label: "Filter", size: "l", min: -1, max: 1, value: 0.4, reset: 0, step: 0.01 }).el,
      knob({ label: "Gain", size: "xl", min: 0, max: 100, value: 70, reset: 50, step: 1, format: (v) => `${v}%` }).el),
    row("Fader: vertical, horizontal",
      fader({ label: "Channel", min: 0, max: 1, value: 0.75, reset: 0.75 }).el,
      fader({ label: "Cross", orient: "h", min: -1, max: 1, value: 0, reset: 0 }).el),
    row("Pad: trigger, toggle, empty, live",
      pad({ index: 1, name: "Siren", mode: "trigger" }).el,
      pad({ index: 2, name: "Reload", mode: "toggle" }).el,
      pad({ index: 3, name: "Air horn long name", mode: "toggle" }).el,
      pad({ index: 4 }).el,
      (() => { const p = pad({ index: 5, name: "Go live", mode: "toggle", tone: "live" }); p.setOn(true); return p.el; })()),
    row("Key: idle, toggle, on, live, disabled",
      key({ label: "CUE" }).el,
      key({ label: "SYNC", toggle: true }).el,
      (() => { const k = key({ label: "LOOP", toggle: true }); k.setOn(true); return k.el; })(),
      (() => { const k = key({ label: "REC", toggle: true, tone: "live" }); k.setOn(true); return k.el; })(),
      (() => { const k = key({ label: "STEMS" }); k.setDisabled(true); return k.el; })()),
    row("Readout: value, accent, live, empty",
      readout("BPM", "124.0").el,
      readout("Key", "8A", "accent").el,
      readout("On air", "00:12:48", "live").el,
      readout("BPM", null).el),
    row("Meter: low, high, clip (hand-set levels)",
      (() => { const m = meter("L"); m.set(0.35); return m.el; })(),
      (() => { const m = meter("R"); m.set(0.82); return m.el; })(),
      (() => { const m = meter("Master"); m.set(1, true); return m.el; })()),
  );

  const p1 = document.createElement("div"); p1.textContent = "Library panel";
  const p2 = document.createElement("div"); p2.textContent = "Sampler panel";
  const p3 = document.createElement("div"); p3.textContent = "FX panel";
  const dBody = document.createElement("div"); dBody.textContent = "Drawer content sits here.";
  frame.append(
    row("Tabs and drawer", tabs([{ id: "lib", label: "Library", panel: p1 }, { id: "smp", label: "Sampler", panel: p2 }, { id: "fx", label: "FX", panel: p3 }]).el, drawer("Advanced", dBody, true).el),
  );
  root.append(frame);
}
