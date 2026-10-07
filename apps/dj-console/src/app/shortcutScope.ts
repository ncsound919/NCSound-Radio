/**
 * Decides whether a global keyboard shortcut should be suppressed for a given
 * event target. Extracted from `keyboard.ts` so it can be unit-tested without a
 * DOM (duck-typed rather than `instanceof HTMLElement`).
 *
 * Two rules:
 *  - Text fields swallow everything; the DJ is typing, not mixing.
 *  - Buttons and links activate on Space / Enter. A global handler must not
 *    steal those keys, or a keyboard user can never trigger a focused control
 *    (verified: Space on a focused REC button started nothing). Other shortcut
 *    keys (letters, digits, arrows) still work with a button focused, because
 *    buttons do not consume them.
 */
type ElLike = { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown };

export function shortcutBlocked(target: unknown, code: string, key: string): boolean {
  const el = target as ElLike | null;
  if (!el || typeof el !== "object") return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable) return true;
  if (code === "Space" || key === "Enter") {
    if (tag === "BUTTON" || tag === "A") return true;
    return typeof el.closest === "function" && !!el.closest("button, a");
  }
  return false;
}
