import assert from "node:assert/strict";
import { mapMpd226, describeMidi, detentDb, MPD226 } from "../src/midi/mpd226";
import { parseTrackName } from "../src/audio/engine";

console.log("=== MPD226 NCSound preset mapping ===");
const on = (note: number, vel = 100, ch = 9) => [0x90 | ch, note, vel];
const cc = (n: number, v: number, ch = 0) => [0xb0 | ch, n, v];
const pad = (p: number) => MPD226.padNoteBase + p - 1;

// top row 13-16: hot cues deck A; second row 9-12: deck B
assert.deepEqual(mapMpd226(on(pad(13))), { type: "hotcue", slot: 0, key: "intro" });
assert.deepEqual(mapMpd226(on(pad(16))), { type: "hotcue", slot: 0, key: "outro" });
assert.deepEqual(mapMpd226(on(pad(9))), { type: "hotcue", slot: 1, key: "intro" });
assert.deepEqual(mapMpd226(on(pad(10))), { type: "hotcue", slot: 1, key: "drop" });
// third row: play A, cue A, play B, cue B
assert.deepEqual(mapMpd226(on(pad(5))), { type: "play", slot: 0 });
assert.deepEqual(mapMpd226(on(pad(6))), { type: "cue", slot: 0 });
assert.deepEqual(mapMpd226(on(pad(7))), { type: "play", slot: 1 });
assert.deepEqual(mapMpd226(on(pad(8))), { type: "cue", slot: 1 });
// bottom row: sync A, sync B, loop A, loop B
assert.deepEqual(mapMpd226(on(pad(1))), { type: "sync", slot: 0 });
assert.deepEqual(mapMpd226(on(pad(2))), { type: "sync", slot: 1 });
assert.deepEqual(mapMpd226(on(pad(3))), { type: "loop", slot: 0 });
assert.deepEqual(mapMpd226(on(pad(4))), { type: "loop", slot: 1 });
// note-off (and note-on velocity 0) do nothing; any channel works
assert.equal(mapMpd226([0x80 | 9, pad(5), 0]), null);
assert.equal(mapMpd226(on(pad(5), 0)), null);
assert.deepEqual(mapMpd226(on(pad(5), 100, 0)), { type: "play", slot: 0 });
// notes outside all three banks are ignored (pad(17) = 52 is bank B now)
assert.deepEqual(mapMpd226(on(pad(17))), { type: "pad", bank: 0, pad: 0, velocity: 100 / 127 });
assert.equal(mapMpd226(on(35)), null);
assert.equal(mapMpd226(on(120)), null);

// control bank A
assert.deepEqual(mapMpd226(cc(MPD226.cc.volA, 127)), { type: "volume", slot: 0, value: 1 });
assert.deepEqual(mapMpd226(cc(MPD226.cc.volB, 0)), { type: "volume", slot: 1, value: 0 });
assert.deepEqual(mapMpd226(cc(MPD226.cc.crossfader, 0)), { type: "crossfader", value: -1 });
assert.deepEqual(mapMpd226(cc(MPD226.cc.crossfader, 127)), { type: "crossfader", value: 1 });
assert.deepEqual(mapMpd226(cc(MPD226.cc.filterB, 127)), { type: "filter", slot: 1, value: 1 });
assert.deepEqual(mapMpd226(cc(MPD226.cc.samplerVol, 64)), { type: "samplerVolume", value: 64 / 127 }); // F4
assert.deepEqual(mapMpd226(cc(18, 127)), { type: "fxWet", value: 1 }); // K3
assert.deepEqual(mapMpd226([0xf8]), null); // clock

// Pad bank B: sampler triggers with velocity.
assert.deepEqual(mapMpd226(on(MPD226.padBankBBase)), { type: "pad", bank: 0, pad: 0, velocity: 100 / 127 });
assert.deepEqual(mapMpd226(on(MPD226.padBankBBase + 3, 64)), { type: "pad", bank: 0, pad: 3, velocity: 64 / 127 });
// Pad bank C: FX on/off and beat division.
assert.deepEqual(mapMpd226(on(MPD226.padBankCBase)), { type: "fxOn", unit: 0 });
assert.deepEqual(mapMpd226(on(MPD226.padBankCBase + 1)), { type: "fxOn", unit: 1 });
assert.deepEqual(mapMpd226(on(MPD226.padBankCBase + 2)), { type: "fxDivision", delta: -1 });
assert.deepEqual(mapMpd226(on(MPD226.padBankCBase + 3)), { type: "fxDivision", delta: 1 });
assert.equal(mapMpd226(on(MPD226.padBankCBase + 8)), null); // rolls/backspin not implemented yet

// Pad bank D: OBS scenes 1-8, media, camera, overlay, record.
assert.deepEqual(mapMpd226(on(MPD226.padBankDBase)), { type: "obs", action: "scene", index: 0 });
assert.deepEqual(mapMpd226(on(MPD226.padBankDBase + 7)), { type: "obs", action: "scene", index: 7 });
assert.deepEqual(mapMpd226(on(MPD226.padBankDBase + 8)), { type: "obs", action: "mediaPlay" });
assert.deepEqual(mapMpd226(on(MPD226.padBankDBase + 9)), { type: "obs", action: "mediaStop" });
assert.deepEqual(mapMpd226(on(MPD226.padBankDBase + 10)), { type: "obs", action: "camera" });
assert.deepEqual(mapMpd226(on(MPD226.padBankDBase + 11)), { type: "obs", action: "overlay" });
assert.deepEqual(mapMpd226(on(MPD226.padBankDBase + 12)), { type: "obs", action: "record" });
assert.equal(mapMpd226(on(MPD226.padBankDBase + 15)), null); // bank D pad 16 unassigned

// Control bank B: EQ and trim, detented at CC 64 = 0 dB.
assert.equal(detentDb(64, -24, 6), 0);
assert.equal(detentDb(0, -24, 6), -24);
assert.equal(detentDb(127, -24, 6), 6);
assert.equal(detentDb(32, -24, 6), -12);
assert.deepEqual(mapMpd226(cc(MPD226.cc.trimA, 64)), { type: "trim", slot: 0, value: 0 });
assert.deepEqual(mapMpd226(cc(MPD226.cc.trimB, 127)), { type: "trim", slot: 1, value: 6 });
assert.deepEqual(mapMpd226(cc(MPD226.cc.eqHighA, 0)), { type: "eq", slot: 0, band: "high", value: -24 });
assert.deepEqual(mapMpd226(cc(MPD226.cc.eqLowB, 64)), { type: "eq", slot: 1, band: "low", value: 0 });
assert.deepEqual(mapMpd226(cc(MPD226.cc.eqMidA, 127)), { type: "eq", slot: 0, band: "mid", value: 6 });
// Control bank B switches: EQ kills.
assert.deepEqual(mapMpd226(cc(MPD226.cc.killLowA, 127)), { type: "eqKill", slot: 0, band: "low", on: true });
assert.deepEqual(mapMpd226(cc(MPD226.cc.killHighB, 0)), { type: "eqKill", slot: 1, band: "high", on: false });
// Control bank A switches: headphone cue.
assert.deepEqual(mapMpd226(cc(MPD226.cc.cueA, 127)), { type: "headphoneCue", slot: 0, on: true });
assert.deepEqual(mapMpd226(cc(MPD226.cc.cueB, 0)), { type: "headphoneCue", slot: 1, on: false });
// Bank C control CCs are reserved (stems) and do nothing yet.
assert.equal(mapMpd226(cc(40, 64)), null);

assert.equal(describeMidi(on(48, 96)), "Note 48 ch 10 vel 96");
assert.equal(describeMidi(cc(20, 64)), "CC 20 ch 1 = 64");

console.log("=== Track name parsing ===");
assert.deepEqual(parseTrackName("Daft Punk - One More Time.mp3"), { artist: "Daft Punk", title: "One More Time" });
assert.deepEqual(parseTrackName("untitled_mix_03.wav"), { artist: "", title: "untitled mix 03" });

console.log("MPD226 mapping tests passed");
