import assert from "node:assert/strict";
import { MidiRemap, learnTargets, receivedControl } from "../src/midi/remap";
import { mapMpd226 } from "../src/midi/mpd226";

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) };
};
const on = (note: number, ch = 1, vel = 100) => [0x90 | (ch - 1), note, vel];
const cc = (n: number, v: number, ch = 1) => [0xb0 | (ch - 1), n, v];
const target = (id: string) => learnTargets().find((t) => t.id === id)!;
let n = 0;
const t = (name: string, fn: () => void) => { fn(); n++; console.log("PASS", name); };

t("untouched remap passes messages through unchanged", () => {
  const r = new MidiRemap(mem());
  assert.deepEqual([...r.process(on(40))!], on(40));
  assert.deepEqual([...r.process(cc(20, 99))!], cc(20, 99));
});

t("learn a note: the unit's number is rewritten to the mapper's", () => {
  const r = new MidiRemap(mem());
  r.startLearn(target("n:40")); // Bank A pad 5 = Play A
  assert.equal(r.process(on(60, 16)), null, "the learn press itself is consumed");
  assert.deepEqual(mapMpd226(r.process(on(60, 16))!), { type: "play", slot: 0 });
});

t("after learning, the raw number that now means something else is dropped, not double-fired", () => {
  const r = new MidiRemap(mem());
  r.startLearn(target("n:40"));
  r.process(on(60));
  assert.equal(r.process(on(40)), null);
});

t("a whole bank: press pad 1 and the 16 follow", () => {
  const r = new MidiRemap(mem());
  r.startLearn(target("bank:36"));
  r.process(on(100)); // generic preset: bank A starts at note 100
  assert.deepEqual(mapMpd226(r.process(on(104))!), { type: "play", slot: 0 }); // pad 5
  assert.deepEqual(mapMpd226(r.process(on(112))!), { type: "hotcue", slot: 0, key: "intro" }); // pad 13
  assert.equal(r.learnedCount, 16);
});

t("learn a CC and keep the value", () => {
  const r = new MidiRemap(mem());
  r.startLearn(target("c:22")); // crossfader
  r.process(cc(7, 0));
  const a = mapMpd226(r.process(cc(7, 127))!);
  assert.deepEqual(a, { type: "crossfader", value: 1 });
});

t("while learning a CC, a pad press is ignored and learning continues", () => {
  const r = new MidiRemap(mem());
  r.startLearn(target("c:22"));
  assert.equal(r.process(on(50)), null);
  assert.ok(r.learningTarget);
  r.process(cc(9, 10));
  assert.equal(r.learningTarget, null);
});

t("relearning a target removes its previous source", () => {
  const r = new MidiRemap(mem());
  r.startLearn(target("c:22")); r.process(cc(7, 1));
  r.startLearn(target("c:22")); r.process(cc(8, 1));
  assert.equal(r.learnedCount, 1);
  assert.deepEqual(mapMpd226(r.process(cc(8, 127))!), { type: "crossfader", value: 1 });
  assert.equal(mapMpd226(r.process(cc(7, 127)) ?? [0, 0, 0]), null);
});

t("channel filter: only the chosen channel gets through", () => {
  const r = new MidiRemap(mem());
  r.setChannel(16);
  assert.ok(r.process(on(40, 16)));
  assert.equal(r.process(on(40, 1)), null);
  assert.equal(r.process(cc(20, 5, 10)), null);
  r.setChannel(null);
  assert.ok(r.process(on(40, 1)));
});

t("learning respects the channel filter", () => {
  const r = new MidiRemap(mem());
  r.setChannel(16);
  r.startLearn(target("n:40"));
  assert.equal(r.process(on(60, 1)), null);
  assert.ok(r.learningTarget, "a press on another channel does not complete the learn");
  r.process(on(60, 16));
  assert.equal(r.learningTarget, null);
});

t("mapping and channel survive a reload; reset keeps the channel", () => {
  const store = mem();
  const a = new MidiRemap(store);
  a.setChannel(16);
  a.startLearn(target("n:40")); a.process(on(60, 16));
  const b = new MidiRemap(store);
  assert.equal(b.state.channel, 16);
  assert.deepEqual(mapMpd226(b.process(on(60, 16))!), { type: "play", slot: 0 });
  b.reset();
  assert.equal(b.learnedCount, 0);
  assert.equal(b.state.channel, 16);
});

t("corrupt stored data is ignored", () => {
  const store = mem();
  store.setItem("ncsound.console.midi.remap", "{not json");
  assert.equal(new MidiRemap(store).learnedCount, 0);
  store.setItem("ncsound.console.midi.remap", JSON.stringify({ channel: 99, map: { "n:1": "x", "c:2": "c:3" } }));
  const r = new MidiRemap(store);
  assert.equal(r.state.channel, null);
  assert.deepEqual(r.state.map, { "c:2": "c:3" });
});

t("note-off, clock and sysex are not controls", () => {
  assert.equal(receivedControl([0x80, 40, 0]), null);
  assert.equal(receivedControl([0x90, 40, 0]), null);
  assert.equal(receivedControl([0xf8]), null);
});

t("learn list is built from the mapper: every target maps to a real action", () => {
  for (const x of learnTargets().filter((x) => x.span === 1)) {
    const bytes = x.kind === "note" ? [0x90, x.number, 100] : [0xb0, x.number, 100];
    assert.ok(mapMpd226(bytes), `${x.label} should map`);
  }
  assert.ok(learnTargets().length > 40);
});

console.log(`MIDI remap tests passed (${n})`);
