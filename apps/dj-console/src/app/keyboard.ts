/**
 * Keyboard shortcuts for the new console.
 *
 *   Space        play / pause the focused deck (the one last touched)
 *   Z / X        play / pause deck A / B
 *   Q / W        cue deck A / B
 *   1-4 / 5-8    hot cues A / B (Shift sets the cue at the playhead)
 *   Left / Right nudge the focused deck by 10 ms (Shift: 50 ms)
 *   [ / ]        focus deck A / B
 *   M            Party / Radio
 *
 * Ignored while typing in a field, with Ctrl/Cmd/Alt held, when a focused
 * slider already used the key, or when the key is Space/Enter on a focused
 * button or link (so the control can still be activated).
 */
import { HOT_CUES, type ConsoleAudio, type Slot } from "../audio/engine";
import { consoleStore } from "../state/console";
import { shortcutBlocked } from "./shortcutScope";

export const SHORTCUTS = "Space play focused deck · Z/X play A/B · Q/W cue A/B · 1-4, 5-8 hot cues (Shift sets) · ←/→ nudge · [ ] focus deck · M mode";

export function bindKeyboard(audio: ConsoleAudio): void {
  document.addEventListener("keydown", (e) => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
    if (shortcutBlocked(e.target, e.code, e.key)) return;
    const focus = consoleStore.get().focusDeck;
    const play = (s: Slot) => { consoleStore.set({ focusDeck: s }); void audio.togglePlay(s); };
    const k = e.key.toLowerCase();
    let handled = true;
    if (e.code === "Space") play(focus);
    else if (k === "z") play(0);
    else if (k === "x") play(1);
    else if (k === "q") audio.cue(0);
    else if (k === "w") audio.cue(1);
    else if (/^Digit[1-8]$/.test(e.code)) {
      const n = Number(e.code.slice(5)) - 1;
      const slot = (n < 4 ? 0 : 1) as Slot;
      audio.hotCue(slot, HOT_CUES[n % 4].key, e.shiftKey);
    } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      audio.nudge(focus, (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 0.05 : 0.01));
    } else if (e.key === "[") consoleStore.set({ focusDeck: 0 });
    else if (e.key === "]") consoleStore.set({ focusDeck: 1 });
    else if (k === "m") consoleStore.set((s) => ({ mode: s.mode === "party" ? "radio" : "party" }));
    else handled = false;
    if (handled) e.preventDefault();
  });
}
