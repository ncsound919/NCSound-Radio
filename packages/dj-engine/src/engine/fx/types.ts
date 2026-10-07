/**
 * FX unit types (plan phase 3B).
 *
 * A `FxUnit` is a beat-synced insert effect that can be patched onto Deck A,
 * Deck B or the master bus. Two units exist. Each has an effect, an on/off
 * (which opens or closes the send into the effect, so tails ring out), a wet
 * amount, one parameter, and a beat division.
 */
export type FxKind = "echo" | "reverb" | "flanger" | "bitcrush" | "gater";

/** Where a unit is patched. `null` = not in any path (bypassed). */
export type FxTarget = "A" | "B" | "master";

/** Beat divisions the UI cycles, in beats. 0.25 = 1/16, 4 = 4 beats. */
export const FX_DIVISIONS = [0.25, 0.5, 1, 2, 4] as const;
export type FxDivision = (typeof FX_DIVISIONS)[number];

export type FxState = {
  kind: FxKind;
  target: FxTarget | null;
  on: boolean;
  wet: number;
  param: number;
  division: FxDivision;
};

export const FX_KINDS: FxKind[] = ["echo", "reverb", "flanger", "bitcrush", "gater"];
