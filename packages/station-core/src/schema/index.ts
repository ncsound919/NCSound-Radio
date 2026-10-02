import { z } from "zod";
import { COMMAND_TYPES } from "../contract/control";

export const elementKindSchema = z.enum(["MUSIC", "STATION_ID", "AD_SPOT", "TALK"]);

export const crossfaderCurveSchema = z.enum(["blend", "dip", "cut"]);

export const pitchFaderRangeSchema = z.union([
  z.literal(4),
  z.literal(8),
  z.literal(16),
  z.literal(50),
]);

export const scratchPatternIdSchema = z.enum([
  "baby",
  "flare",
  "transformer",
  "chirp",
  "crab",
  "tear",
  "backspin",
  "uzis",
]);

export const actorSchema = z.object({
  id: z.string().min(1).max(128),
  role: z.enum(["ops", "console", "automation", "system"]),
  label: z.string().min(1).max(128),
});

const unit = z.number().min(0).max(1);
const biUnit = z.number().min(-1).max(1);
const slot = z.union([z.literal(0), z.literal(1)]);

export const djCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("transport.play") }),
  z.object({ type: z.literal("transport.pause") }),
  z.object({ type: z.literal("transport.toggle") }),
  z.object({ type: z.literal("transport.stop") }),

  z.object({ type: z.literal("mix.mixNext"), presetId: z.string().max(64).optional() }),
  z.object({ type: z.literal("mix.skip") }),
  z.object({ type: z.literal("mix.panic") }),
  z.object({ type: z.literal("mix.setCrossfader"), position: biUnit }),
  z.object({ type: z.literal("mix.setCrossfaderCurve"), curve: crossfaderCurveSchema }),
  z.object({ type: z.literal("mix.setDeckVolume"), slot, volume: unit }),
  z.object({
    type: z.literal("mix.setEq"),
    slot,
    band: z.enum(["low", "mid", "high"]),
    db: z.number().min(-60).max(6),
  }),
  z.object({ type: z.literal("mix.setFilter"), slot, bipolar: biUnit }),
  z.object({ type: z.literal("mix.setMasterGain"), gain: unit }),
  z.object({ type: z.literal("mix.setAutoGain"), enabled: z.boolean() }),
  z.object({ type: z.literal("mix.setTransitionBars"), bars: z.number().int().min(1).max(64) }),

  z.object({ type: z.literal("cue.track"), trackId: z.string().min(1).max(128), slot: slot.optional() }),
  z.object({ type: z.literal("cue.request"), requestId: z.string().min(1).max(128) }),
  z.object({ type: z.literal("cue.seek"), slot, seconds: z.number().min(0).max(3600) }),
  z.object({
    type: z.literal("cue.hotCue"),
    slot,
    cue: z.enum(["intro", "drop", "breakdown", "outro"]),
  }),
  z.object({ type: z.literal("cue.loop"), slot, enabled: z.boolean() }),

  z.object({
    type: z.literal("sync.deck"),
    slot,
    multiplier: z.union([z.literal(1), z.literal(2), z.literal(0.5)]).optional(),
  }),
  z.object({ type: z.literal("sync.both"), targetBpm: z.number().min(40).max(300).optional() }),
  z.object({ type: z.literal("sync.masterBpm"), bpm: z.number().min(40).max(300) }),
  z.object({ type: z.literal("sync.phaseAlign"), slot: slot.optional() }),

  z.object({ type: z.literal("scratch.pattern"), patternId: scratchPatternIdSchema, deck: slot.optional() }),
  z.object({
    type: z.literal("scratch.agent"),
    bars: z.union([z.literal(2), z.literal(4)]).optional(),
    style: z.enum(["sparse", "medium", "busy"]).optional(),
    seed: z.number().int().min(0).max(2 ** 31).optional(),
    useLlm: z.boolean().optional(),
  }),
  z.object({ type: z.literal("scratch.stop") }),

  z.object({ type: z.literal("imaging.play"), jingleId: z.string().min(1).max(128) }),

  z.object({ type: z.literal("autopilot.set"), enabled: z.boolean() }),
  z.object({ type: z.literal("autopilot.setVibe"), templateId: z.string().min(1).max(128) }),
  z.object({
    type: z.literal("autopilot.resequence"),
    targetEnergy: z.number().min(0).max(1).optional(),
  }),
  z.object({ type: z.literal("autopilot.setEnergyTarget"), energy: unit }),

  z.object({ type: z.literal("library.load"), path: z.string().min(1).max(4096), slot: slot.optional() }),
  z.object({
    type: z.literal("library.analyze"),
    trackIds: z.array(z.string().min(1).max(128)).min(1).max(500),
    analyzer: z.enum(["engine", "essentia", "madmom", "demucs", "manual"]).optional(),
  }),
  z.object({ type: z.literal("library.setPitchRange"), range: pitchFaderRangeSchema }),
  z.object({
    type: z.literal("library.setPreset"),
    preset: z.object({
      id: z.string().min(1).max(64),
      name: z.string().min(1).max(128),
      bars: z.number().int().min(1).max(64),
      curve: z.enum(["equal-power", "linear", "cut"]),
      filterSweep: z.boolean().optional(),
      bassSwap: z.boolean().optional(),
      style: z.string().optional(),
    }),
  }),

  z.object({ type: z.literal("query.status") }),
  z.object({ type: z.literal("query.queue") }),
  z.object({ type: z.literal("query.crate") }),
  z.object({ type: z.literal("query.setlist") }),
  z.object({ type: z.literal("query.analysis"), trackId: z.string().min(1).max(128) }),
  z.object({ type: z.literal("query.stream") }),
]);

export const commandEnvelopeSchema = z.object({
  id: z.string().min(1).max(128),
  issuedAt: z.string().min(1),
  actor: actorSchema,
  command: djCommandSchema,
});

export const knownCommandTypeSchema = z.enum(COMMAND_TYPES);

export type DjCommandInput = z.infer<typeof djCommandSchema>;
export type CommandEnvelopeInput = z.infer<typeof commandEnvelopeSchema>;

export function parseCommandEnvelope(raw: unknown): CommandEnvelopeInput {
  return commandEnvelopeSchema.parse(raw);
}

export function safeParseCommandEnvelope(raw: unknown) {
  return commandEnvelopeSchema.safeParse(raw);
}