/**
 * Control set for the redesigned console: knob, fader, pad, key, readout, meter,
 * tabs, drawer. Plain DOM factories; each returns { el, ...setters }.
 *
 * Nothing here animates or fakes a signal: a meter shows the level you hand it,
 * a readout shows the text you hand it, and `null` renders as "--".
 */
import "./controls.css";

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

/* ---------- shared slider behaviour (knob + fader) ---------- */

type SliderOpts = {
  label: string;
  min?: number;
  max?: number;
  value?: number;
  /** Value restored by double-click. Defaults to the starting value. */
  reset?: number;
  step?: number;
  format?: (v: number) => string;
  onInput?: (v: number) => void;
};

function bindSlider(el: HTMLElement, o: Required<Pick<SliderOpts, "min" | "max" | "step" | "reset">> & SliderOpts, axis: "y" | "x", apply: (v: number) => void) {
  let value = clamp(o.value ?? o.reset, o.min, o.max);
  const fmt = o.format ?? ((v: number) => String(Math.round(v * 100) / 100));
  const range = o.max - o.min;
  const set = (v: number, emit: boolean) => {
    const snapped = clamp(Math.round((v - o.min) / o.step) * o.step + o.min, o.min, o.max);
    if (snapped === value && el.hasAttribute("aria-valuenow")) return;
    value = snapped;
    el.setAttribute("aria-valuenow", String(value));
    el.setAttribute("aria-valuetext", fmt(value));
    apply((value - o.min) / range);
    if (emit) o.onInput?.(value);
  };
  el.setAttribute("role", "slider");
  el.tabIndex = 0;
  el.setAttribute("aria-label", o.label);
  el.setAttribute("aria-valuemin", String(o.min));
  el.setAttribute("aria-valuemax", String(o.max));
  set(value, false);

  let startPos = 0, startVal = 0;
  el.addEventListener("pointerdown", (e) => {
    el.setPointerCapture(e.pointerId);
    startPos = axis === "y" ? e.clientY : e.clientX;
    startVal = value;
    el.focus();
  });
  el.addEventListener("pointermove", (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    const d = axis === "y" ? startPos - e.clientY : e.clientX - startPos;
    const travel = axis === "y" ? el.clientHeight : el.clientWidth;
    const px = el.classList.contains("nc-knob") ? 160 : Math.max(60, travel - 28);
    set(startVal + (d / px) * range * (e.shiftKey ? 0.2 : 1), true);
  });
  el.addEventListener("dblclick", () => set(o.reset, true));
  el.addEventListener("wheel", (e) => { e.preventDefault(); set(value + (e.deltaY < 0 ? 1 : -1) * o.step * (e.shiftKey ? 1 : Math.max(1, range / o.step / 50)), true); }, { passive: false });
  el.addEventListener("keydown", (e) => {
    const big = Math.max(o.step, range / 10);
    const map: Record<string, number> = { ArrowUp: o.step, ArrowRight: o.step, ArrowDown: -o.step, ArrowLeft: -o.step, PageUp: big, PageDown: -big };
    if (e.key === "Home") { set(o.min, true); e.preventDefault(); }
    else if (e.key === "End") { set(o.max, true); e.preventDefault(); }
    else if (e.key in map) { set(value + map[e.key], true); e.preventDefault(); }
  });
  return { set: (v: number) => set(v, false), get: () => value };
}

function labelled(label: string, control: HTMLElement): HTMLElement {
  const wrap = h("div", "nc-ctl");
  wrap.append(control, h("span", "nc-ctl-label", label));
  return wrap;
}

/* ---------- knob ---------- */

export type KnobOpts = SliderOpts & { size?: "m" | "l" | "xl" };

export function knob(opts: KnobOpts) {
  const min = opts.min ?? 0, max = opts.max ?? 1;
  const reset = opts.reset ?? opts.value ?? min;
  const el = h("div", "nc-knob");
  el.dataset.size = opts.size ?? "m";
  const api = bindSlider(el, { ...opts, min, max, step: opts.step ?? (max - min) / 100, reset }, "y", (p) => {
    el.style.setProperty("--nc-angle", `${-135 + p * 270}deg`);
    el.dataset.lit = String(Math.abs(p - (reset - min) / (max - min)) > 0.001);
  });
  return { el: labelled(opts.label, el), control: el, ...api };
}

/* ---------- fader ---------- */

export type FaderOpts = SliderOpts & { orient?: "v" | "h" };

export function fader(opts: FaderOpts) {
  const min = opts.min ?? 0, max = opts.max ?? 1;
  const el = h("div", "nc-fader");
  el.dataset.orient = opts.orient ?? "v";
  el.append(h("div", "nc-fader-cap"));
  if (opts.orient === "h") el.setAttribute("aria-orientation", "horizontal");
  const api = bindSlider(el, { ...opts, min, max, step: opts.step ?? (max - min) / 200, reset: opts.reset ?? opts.value ?? min }, opts.orient === "h" ? "x" : "y", (p) => el.style.setProperty("--nc-pos", String(p)));
  return { el: labelled(opts.label, el), control: el, ...api };
}

/* ---------- pad ---------- */

export type PadOpts = {
  index: number;
  /** Text under the number. Omit or empty for an unassigned pad. */
  name?: string;
  /** "trigger" fires on press; "toggle" flips aria-pressed. */
  mode?: "trigger" | "toggle";
  tone?: "accent" | "live";
  onPress?: (down: boolean) => void;
  onToggle?: (on: boolean) => void;
};

export function pad(opts: PadOpts) {
  const el = h("button", "nc-pad");
  el.type = "button";
  const empty = !opts.name;
  el.dataset.empty = String(empty);
  if (opts.tone) el.dataset.tone = opts.tone;
  const idx = h("span", "nc-pad-idx", String(opts.index));
  const name = h("span", "nc-pad-name", opts.name || "Empty");
  el.append(idx, name);
  el.setAttribute("aria-label", empty ? `Pad ${opts.index}, empty` : `Pad ${opts.index}, ${opts.name}`);
  const toggle = opts.mode === "toggle";
  if (toggle) el.setAttribute("aria-pressed", "false");
  const press = (down: boolean) => {
    el.dataset.held = String(down);
    opts.onPress?.(down);
  };
  el.addEventListener("pointerdown", (e) => { el.setPointerCapture(e.pointerId); press(true); });
  el.addEventListener("pointerup", () => press(false));
  el.addEventListener("pointercancel", () => press(false));
  el.addEventListener("click", () => {
    if (!toggle) return;
    const on = el.getAttribute("aria-pressed") !== "true";
    el.setAttribute("aria-pressed", String(on));
    opts.onToggle?.(on);
  });
  return {
    el,
    setOn: (on: boolean) => el.setAttribute("aria-pressed", String(on)),
    setName: (n: string | null) => {
      name.textContent = n || "Empty";
      el.dataset.empty = String(!n);
      el.setAttribute("aria-label", n ? `Pad ${opts.index}, ${n}` : `Pad ${opts.index}, empty`);
    },
  };
}

/* ---------- key ---------- */

export type KeyOpts = { label: string; toggle?: boolean; tone?: "live"; onPress?: () => void; onToggle?: (on: boolean) => void };

export function key(opts: KeyOpts) {
  const el = h("button", "nc-key", opts.label);
  el.type = "button";
  if (opts.tone) el.dataset.tone = opts.tone;
  if (opts.toggle) el.setAttribute("aria-pressed", "false");
  el.addEventListener("click", () => {
    if (opts.toggle) {
      const on = el.getAttribute("aria-pressed") !== "true";
      el.setAttribute("aria-pressed", String(on));
      opts.onToggle?.(on);
    }
    opts.onPress?.();
  });
  return { el, setOn: (on: boolean) => el.setAttribute("aria-pressed", String(on)), setDisabled: (d: boolean) => { el.disabled = d; } };
}

/* ---------- readout ---------- */

export function readout(label: string, initial: string | null = null, tone?: "accent" | "live") {
  const el = h("div", "nc-readout");
  if (tone) el.dataset.tone = tone;
  const value = h("span", "nc-readout-value");
  el.append(h("span", "nc-ctl-label", label), value);
  const set = (text: string | null) => {
    const t = text ?? "--";
    if (value.textContent === t) return;
    value.textContent = t;
    el.dataset.empty = String(text === null);
  };
  set(initial);
  return { el, set };
}

/* ---------- meter ---------- */

/** `compact`: no CLIP text and no visible label (the label stays as the accessible name). */
export function meter(label: string, compact = false) {
  const el = h("div", "nc-meter");
  el.setAttribute("role", "meter");
  el.setAttribute("aria-label", label);
  el.setAttribute("aria-valuemin", "0");
  el.setAttribute("aria-valuemax", "1");
  const bar = h("div", "nc-meter-bar");
  const fill = h("div", "nc-meter-fill");
  bar.append(fill);
  if (compact) el.append(bar);
  else el.append(bar, h("span", "nc-meter-clip", "CLIP"), h("span", "nc-ctl-label", label));
  /** level 0..1 (linear, already scaled by the caller); clip lights when true. */
  let lastL = -1, lastClip = false;
  const set = (level: number, clip = false) => {
    const l = Math.round(clamp(level, 0, 1) * 200) / 200;
    if (l === lastL && clip === lastClip) return;
    lastL = l;
    lastClip = clip;
    el.setAttribute("aria-valuenow", l.toFixed(2));
    fill.style.setProperty("--nc-level", String(l));
    el.dataset.clip = String(clip);
  };
  set(0);
  return { el, set };
}

/* ---------- tabs ---------- */

let tabsUid = 0;

export function tabs(items: Array<{ id: string; label: string; panel: HTMLElement }>, onChange?: (id: string) => void) {
  const group = `nc-tabs-${++tabsUid}`;
  const el = h("div", "");
  const list = h("div", "nc-tabs");
  list.setAttribute("role", "tablist");
  const btns = new Map<string, HTMLButtonElement>();
  const select = (id: string) => {
    for (const it of items) {
      const on = it.id === id;
      btns.get(it.id)!.setAttribute("aria-selected", String(on));
      btns.get(it.id)!.tabIndex = on ? 0 : -1;
      it.panel.hidden = !on;
    }
    onChange?.(id);
  };
  for (const it of items) {
    const tabId = `${group}-tab-${it.id}`;
    const panelId = `${group}-panel-${it.id}`;
    const b = h("button", "nc-tab", it.label);
    b.type = "button";
    b.id = tabId;
    b.setAttribute("role", "tab");
    b.setAttribute("aria-controls", panelId);
    b.addEventListener("click", () => select(it.id));
    b.addEventListener("keydown", (e) => {
      const i = items.findIndex((x) => x.id === it.id);
      const n = e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : -1;
      if (n < 0) return;
      const next = items[(n + items.length) % items.length];
      select(next.id);
      btns.get(next.id)!.focus();
    });
    it.panel.classList.add("nc-tabpanel");
    it.panel.id = panelId;
    it.panel.setAttribute("role", "tabpanel");
    it.panel.setAttribute("aria-labelledby", tabId);
    btns.set(it.id, b);
    list.append(b);
  }
  el.append(list, ...items.map((i) => i.panel));
  select(items[0].id);
  return { el, select };
}

/* ---------- drawer ---------- */

export function drawer(title: string, body: HTMLElement, open = false) {
  const el = h("section", "nc-drawer");
  const head = h("button", "nc-drawer-head", title);
  head.type = "button";
  body.classList.add("nc-drawer-body");
  const set = (o: boolean) => { head.setAttribute("aria-expanded", String(o)); body.hidden = !o; };
  head.addEventListener("click", () => set(head.getAttribute("aria-expanded") !== "true"));
  el.append(head, body);
  set(open);
  return { el, set };
}
