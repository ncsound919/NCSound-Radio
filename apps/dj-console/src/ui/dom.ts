/**
 * DOM access helpers.
 *
 * Every read goes through getElementById, and every write is null-checked,
 * because index.html and main.ts are loaded independently by the bundler and a
 * missing node should degrade a readout rather than throw inside a render loop.
 */

/**
 * Typed getElementById.
 *
 * The cast is unchecked, and that is deliberate: it is the contract this app has
 * always had, and tightening it to `T | null` is a ~200-call-site change that
 * belongs in its own change with its own review. The four writers below do
 * null-check, so the paths that run every frame are safe even when a node is
 * missing. Prefer them over touching `.textContent` directly.
 */
export const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

/** Null-checked text write. */
export function setTxt(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

/** Null-checked innerHTML write. */
export function setHTML(id: string, html: string): void {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

/**
 * Null-checked inline style write.
 *
 * `prop` is a plain string rather than `keyof CSSStyleDeclaration` because that
 * key set contains unique symbols, which cannot be used to index a
 * `Record<string, string>` after the cast.
 */
export function setStyleProp(id: string, prop: string, val: string): void {
  const el = document.getElementById(id);
  if (el) (el.style as unknown as Record<string, string>)[prop] = val;
}

/** Null-checked class toggle. */
export function toggleClass(id: string, cls: string, active: boolean): void {
  const el = document.getElementById(id);
  if (el) el.classList.toggle(cls, active);
}