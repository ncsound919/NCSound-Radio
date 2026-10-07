import assert from "node:assert/strict";
import { AudibleDeckTracker } from "../src/audio/audibleDeck";

console.log("=== OBS overlay audible-deck hold ===");
const lvl = (playing: boolean, gain: number) => ({ playing, gain });

// Nothing playing -> no announcement; the first audible deck shows at once.
{
  const t = new AudibleDeckTracker(4000);
  assert.equal(t.update(0, [lvl(false, 0), lvl(false, 0)]), null);
  assert.equal(t.update(100, [lvl(true, 1), lvl(false, 0)]), 0);
}

// A quick flick to B and back does not switch.
{
  const t = new AudibleDeckTracker(4000);
  assert.equal(t.update(0, [lvl(true, 1), lvl(true, 0.1)]), 0);
  assert.equal(t.update(1000, [lvl(true, 0.1), lvl(true, 1)]), 0); // B leads, but only just
  assert.equal(t.update(1500, [lvl(true, 1), lvl(true, 0.1)]), 0); // back to A before the hold
  assert.equal(t.slot, 0);
}

// A sustained lead past the hold switches.
{
  const t = new AudibleDeckTracker(4000);
  t.update(0, [lvl(true, 1), lvl(true, 0.1)]);
  assert.equal(t.update(1000, [lvl(true, 0.1), lvl(true, 1)]), 0);
  assert.equal(t.update(3000, [lvl(true, 0.1), lvl(true, 1)]), 0); // 2s < hold
  assert.equal(t.update(5000, [lvl(true, 0.1), lvl(true, 1)]), 1); // 4s >= hold
  assert.equal(t.slot, 1);
}

// A deck paused (not playing) is never the audible deck.
{
  const t = new AudibleDeckTracker(4000);
  t.update(0, [lvl(true, 0.5), lvl(false, 1)]);
  assert.equal(t.slot, 0);
}

console.log("Audible-deck tracker tests passed");
