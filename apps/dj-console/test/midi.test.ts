import assert from "node:assert/strict";
import { MidiControllerEngine } from "../src/engine/midi";
import type { MidiActionCallbacks } from "../src/engine/midi";

console.log("=== Testing MIDI Engine & Hardware Mappings ===");

let playedDeckA = false;
let crossfaderVal = -1;
let scratchPadTriggered = -1;
let pad16Index = -1;

const callbacks: MidiActionCallbacks = {
  onPlayToggle: (deck) => {
    if (deck === 0) playedDeckA = true;
  },
  onCue: () => {},
  onHotCue: () => {},
  onCrossfader: (val) => {
    crossfaderVal = val;
  },
  onPitchPct: () => {},
  onChannelVolume: () => {},
  onEq: () => {},
  onEqKill: () => {},
  onColorFilter: () => {},
  onJogNudge: () => {},
  onScratchPad: (patternId) => {
    scratchPadTriggered = 1;
  },
  on16PadHit: (padIndex) => {
    pad16Index = padIndex;
  },
  onDrop90sAgent: () => {},
  onSeekNormalized: () => {},
  onPlatterTouch: () => {},
  onJogScratchVelocity: () => {},
  onSyncDeck: () => {},
  onSmartMix: () => {},
};

const midiEngine = new MidiControllerEngine(callbacks);

// 1. Profile Registration & Selection
assert.equal(midiEngine.activeProfile, "pioneer-ddj", "Default profile should be pioneer-ddj");

midiEngine.applyControllerProfile("akai-mpd226");
assert.equal(midiEngine.activeProfile, "akai-mpd226", "Profile switched to Akai MPD226");

midiEngine.applyControllerProfile("pioneer-ddj");
assert.equal(midiEngine.activeProfile, "pioneer-ddj");

midiEngine.applyControllerProfile("akai-mpd226");
assert.equal(midiEngine.activeProfile, "akai-mpd226");

// 2. Raw MIDI Message Parsing - Note On (Pad Hit)
// MPD226 Pad 1 sends Note On (0x90) note 36 velocity 100 on channel 1 (0x90)
midiEngine.handleRawMidiBytes(new Uint8Array([0x90, 36, 100]), 100);
assert.equal(pad16Index, 0, "Note On 36 must trigger 16-pad index 0");

// Note On 37
midiEngine.handleRawMidiBytes(new Uint8Array([0x90, 37, 100]), 110);
assert.equal(pad16Index, 1, "Note On 37 must trigger 16-pad index 1");

// 3. Raw MIDI Message Parsing - Control Change (Crossfader CC 22 on Akai MPD226)
// CC 22 value 0 -> Crossfader -1.0
midiEngine.handleRawMidiBytes(new Uint8Array([0xb0, 22, 0]), 120);
assert.equal(crossfaderVal, -1.0, "CC 22 value 0 maps to crossfader -1.0");

// CC 22 value 127 -> Crossfader +1.0
midiEngine.handleRawMidiBytes(new Uint8Array([0xb0, 22, 127]), 130);
assert.equal(crossfaderVal, 1.0, "CC 22 value 127 maps to crossfader +1.0");

// CC 22 value 64 -> Crossfader 0.0 (center)
midiEngine.handleRawMidiBytes(new Uint8Array([0xb0, 22, 64]), 140);
assert.ok(Math.abs(crossfaderVal) < 0.05, "CC 22 value 64 maps near crossfader 0.0 (center)");

// 4. Pickup Mode & Soft Takeover Logic
// Switch profile again to reset pickup controls set
midiEngine.applyControllerProfile("akai-mpd226");
midiEngine.setSoftTakeover(true);
assert.equal(midiEngine.softTakeoverEnabled, true, "Soft pickup mode enabled");

// Set target software value to 0.8
midiEngine.setSoftwareTargetNormalized("crossfader", 0.8);

// Seed the previous hardware position on the same side (0.1)
midiEngine.handleRawMidiBytes(new Uint8Array([0xb0, 22, 13]), 190);

// Send another value on the same side (25 -> ~0.2): should be blocked because it didn't cross or get within tolerance of 0.8
crossfaderVal = -999;
midiEngine.handleRawMidiBytes(new Uint8Array([0xb0, 22, 25]), 200);
assert.equal(crossfaderVal, -999, "Crossfader value should be blocked by soft takeover");

// Now send a value close to 0.8 (102 -> 0.803): should match and pass through
midiEngine.handleRawMidiBytes(new Uint8Array([0xb0, 22, 102]), 210);
assert.ok(Math.abs(crossfaderVal - 0.603) < 0.05, "Crossfader should pass through once matched");

console.log("All MIDI Engine & Hardware Mappings unit tests passed successfully!");
