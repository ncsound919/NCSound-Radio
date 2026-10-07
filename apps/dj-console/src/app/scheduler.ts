/**
 * The one requestAnimationFrame loop. Views register a frame callback that
 * reads engine state and writes the DOM only where something changed.
 */
type Frame = (now: number) => void;
const frames = new Set<Frame>();
let running = false;

function tick(now: number) {
  for (const f of frames) {
    try {
      f(now);
    } catch (e) {
      console.error("[frame]", e);
    }
  }
  requestAnimationFrame(tick);
}

export function onFrame(f: Frame): () => void {
  frames.add(f);
  if (!running) {
    running = true;
    requestAnimationFrame(tick);
  }
  return () => frames.delete(f);
}
