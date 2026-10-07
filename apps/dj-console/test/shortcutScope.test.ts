import assert from "node:assert/strict";
import { shortcutBlocked } from "../src/app/shortcutScope";

console.log("=== Global shortcut scope (do not steal Space/Enter from controls) ===");

// Duck-typed elements, as the browser would pass them.
const el = (tagName: string, extra: Record<string, unknown> = {}) => ({ tagName, ...extra });
const button = () => el("BUTTON", { closest: () => null });
const insideButton = el("SPAN", { closest: (s: string) => (s.includes("button") ? {} : null) });

// Text fields swallow everything.
assert.equal(shortcutBlocked(el("INPUT"), "Space", " "), true);
assert.equal(shortcutBlocked(el("TEXTAREA"), "KeyA", "a"), true);
assert.equal(shortcutBlocked(el("SELECT"), "KeyA", "a"), true);
assert.equal(shortcutBlocked(el("DIV", { isContentEditable: true }), "KeyA", "a"), true);

// A focused button owns Space and Enter.
assert.equal(shortcutBlocked(button(), "Space", " "), true);
assert.equal(shortcutBlocked(button(), "Enter", "Enter"), true);
assert.equal(shortcutBlocked(insideButton, "Space", " "), true);
assert.equal(shortcutBlocked(el("A", { closest: () => null }), "Enter", "Enter"), true);

// ...but not the mixing keys: those stay global even with a button focused.
assert.equal(shortcutBlocked(button(), "KeyZ", "z"), false);
assert.equal(shortcutBlocked(button(), "KeyQ", "q"), false);
assert.equal(shortcutBlocked(button(), "Digit3", "3"), false);
assert.equal(shortcutBlocked(button(), "ArrowLeft", "ArrowLeft"), false);

// Body / null / non-element targets are never blocked.
assert.equal(shortcutBlocked(el("BODY", { closest: () => null }), "Space", " "), false);
assert.equal(shortcutBlocked(null, "Space", " "), false);
assert.equal(shortcutBlocked(undefined, "Space", " "), false);

console.log("Shortcut scope tests passed");
