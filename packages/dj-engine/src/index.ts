export { Mixer } from "./engine/mixer";
export { Deck } from "./engine/deck";
export { analyze } from "./engine/analysis";
export { runTransition } from "./engine/transitions";
export { BUILTIN_TRACK_SPECS, synthesizeStudioTrack } from "./engine/synthTracks";
export { pickNextMarathonTrack, pickSmartTransitionPreset, sequenceCrateForParty, scoreNextTrackCandidate } from "./engine/marathon";
export { SCRATCH_PATTERNS } from "./engine/scratch";

export * from "./audio/index";
export * from "./ingest/index";

export { HeadlessEngine } from "./engine-service";
export type { HeadlessEngineOptions, HeadlessEngineStatus } from "./engine-service";