/**
 * Web MIDI hookup for the new console. Asks for access only when the DJ presses
 * the MIDI chip, or at boot if the browser already granted it.
 */
import { consoleStore } from "../state/console";
import { describeMidi, mapMpd226, type MidiAction } from "./mpd226";
import { midiRemap } from "./remap";

export async function autoConnectMidi(onAction: (a: MidiAction) => void): Promise<void> {
  if (typeof navigator.requestMIDIAccess !== "function") {
    consoleStore.set({ midi: { kind: "unsupported" } });
    return;
  }
  try {
    const p = await navigator.permissions?.query({ name: "midi" as PermissionName });
    if (p?.state === "granted") await connectMidi(onAction);
  } catch {
    /* permissions API without "midi": wait for the button */
  }
}

export async function connectMidi(onAction: (a: MidiAction) => void): Promise<void> {
  if (typeof navigator.requestMIDIAccess !== "function") {
    consoleStore.set({ midi: { kind: "unsupported" } });
    return;
  }
  let access: MIDIAccess;
  try {
    access = await navigator.requestMIDIAccess({ sysex: false });
  } catch {
    consoleStore.set({ midi: { kind: "denied" } });
    return;
  }
  let last = "";
  const attach = () => {
    const names: string[] = [];
    access.inputs.forEach((input) => {
      names.push(input.name ?? "MIDI input");
      input.onmidimessage = (e) => {
        if (!e.data || (e.data[0] & 0xf0) === 0xf0) return; // ignore clock / sysex
        last = describeMidi(e.data);
        const cur = consoleStore.get().midi;
        if (cur.kind === "connected") consoleStore.set({ midi: { ...cur, last } });
        const data = midiRemap.process(e.data);
        if (!data) return; // learning, or dropped by the channel filter / a claimed number
        const a = mapMpd226(data);
        if (a) onAction(a);
      };
    });
    consoleStore.set({ midi: names.length ? { kind: "connected", names, last } : { kind: "no-device" } });
  };
  access.onstatechange = attach;
  attach();
}
