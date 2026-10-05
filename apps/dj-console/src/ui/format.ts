/**
 * Display formatting and label tables.
 *
 * Pure functions and constant tables only, with no DOM or engine access, so
 * they are safe to unit test and safe to import from anywhere.
 */

/** Seconds as m:ss, for track positions. Negative input clamps to 0:00. */
export const fmt = (s: number): string => {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Drop a file extension. */
export const clean = (n: string): string => n.replace(/\.[^.]+$/, "");

export function formatFileSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * One critic metric, rendered with the unit that metric is actually measured in.
 * Returning "not measured" rather than 0 matters: a null reading is missing
 * evidence, and printing it as zero would read as a passing score.
 */
export function formatCriticMetric(
  name: string,
  val: number | null,
  threshold: number | null
): string {
  if (val === null) return "not measured";
  if (name === "clipping") return `peak=${val.toFixed(2)}`;
  if (name === "gate_clicks") return `jump=${val.toFixed(2)}`;
  if (name === "grid_adherence") return `${val.toFixed(1)}ms`;
  if (name === "density") return `${val.toFixed(0)}/${threshold ?? 0}bar`;
  if (name === "silence") return `rms=${val.toFixed(3)}`;
  if (name === "diversity") return `rep=${val.toFixed(0)}`;
  if (name === "intelligibility") return `${Math.round(val * 100)}%`;
  return `${val.toFixed(2)}`;
}

export function formatMidiAssignment(b: { kind: string; channel: number; number: number }): string {
  const ch = (b.channel + 1).toString().padStart(2, "0");
  return `${b.kind} ch${ch} ${b.number}`;
}

/** Short labels for the transition pad bank, where the full names do not fit. */
export const SHORT_PRESET_LABELS: Record<string, string> = {
  auto: "Auto Variety",
  "drop-cut": "Drop Slam",
  "bass-swap": "Bass Swap",
  filter: "Filter Riser",
  "vinyl-brake": "Vinyl Brake",
  backspin: "Backspin",
  "echo-out": "Echo Out",
  smooth: "Smooth Blend",
  long: "8-Bar Club",
};

/** Short labels plus a bar-count tag for the scratch pad bank. */
export const COMPACT_SCRATCH_LABELS: Record<string, { title: string; tag: string }> = {
  baby: { title: "Baby Scratch", tag: "2B OPEN" },
  flare: { title: "Orbit Flare", tag: "2B 2-CLK" },
  transformer: { title: "Transformer", tag: "2B GATE" },
  chirp: { title: "Chirp Cut", tag: "2B EDGE" },
  crab: { title: "4-Finger Crab", tag: "2B ROLL" },
  tear: { title: "Tear Scratch", tag: "2B SPLIT" },
  backspin: { title: "Backspin", tag: "4B WHIP" },
  uzis: { title: "Laser Stutter", tag: "2B 1/32" },
};