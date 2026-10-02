import "./style.css";
import { Mixer } from "./engine/mixer";
import type { AgentTriggerOutput, ScratchArchetypeId } from "./engine/mixer";
import { MidiControllerEngine } from "./engine/midi";
import type { MidiControlId, MidiControllerProfileId, MidiJogMode } from "./engine/midi";
import {
  interpolateEnergyCurve,
  pickNextMarathonTrack,
  pickSmartScratchProfile,
  pickSmartTransitionPreset,
  scoreNextTrackCandidate,
  sequenceCrateForParty,
} from "./engine/marathon";
import { BATTLE_CUT_SLICES, SCRATCH_PATTERNS } from "./engine/scratch";
import {
  calculatePitchedKey,
  computeBeatPhaseDifference,
  detectTempoMultiplierCandidate,
  evaluateHarmonicMatch,
  pickExactSyncRate,
} from "./engine/sync";
import { calculateHarmonicKeyShift } from "./engine/timePitchEngine";
import { BUILTIN_TRACK_SPECS, synthesizeStudioTrack } from "./engine/synthTracks";
import {
  categorizeTrackAcoustics,
  clearIndexedDbCrate,
  loadPersistedCrateTracks,
  parseAudioFileMetadata,
  persistTrackToIndexedDb,
  removeTrackFromIndexedDb,
  searchAndFilterCrate,
} from "./engine/crateIndexer";
import type { CrateIndexRecord, CrateSearchFilters, CrateSearchResultItem } from "./engine/crateIndexer";
import { applyHeadroom, encodeWav16 } from "./scratch-agent";
import type { Style } from "./scratch-agent";
import transitions from "./presets/transitions.json";
import partyTemplates from "./presets/party-templates.json";
import type {
  BattleSampleId,
  CrossfaderCurve,
  EnergyTier,
  PartyTemplate,
  PitchFaderRange,
  ScratchCutMode,
  ScratchQuantizeMode,
  ScratchSourceMode,
  SetlistEntry,
  TrackAnalysis,
  TransitionPreset,
} from "./engine/types";
import { RadioBroadcastEngine } from "./engine/radioBroadcast";
import type { RadioNowPlayingPayload, RadioSongRequest, StationSweeper } from "./engine/radioBroadcast";

const presets = transitions as TransitionPreset[];
const templates = partyTemplates as PartyTemplate[];
const mixer = new Mixer();
const radio = new RadioBroadcastEngine(mixer.ctx);
mixer.getMasterOutputNode().connect(radio.inputNode);
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function setTxt(id: string, text: string) {
  const el = $(id);
  if (el) el.textContent = text;
}

function setHTML(id: string, html: string) {
  const el = $(id);
  if (el) el.innerHTML = html;
}

function setStyleProp(id: string, prop: keyof CSSStyleDeclaration, val: string) {
  const el = $(id);
  if (el) (el.style as any)[prop] = val;
}

function toggleClass(id: string, cls: string, active: boolean) {
  const el = $(id);
  if (el) el.classList.toggle(cls, active);
}
const RING = 351.86; // circumference of r=56 ring

interface CrateTrack {
  id: string;
  name: string;
  artist: string;
  genre: string;
  tags?: string[];
  energyTier?: EnergyTier;
  buffer?: AudioBuffer;
  file?: File;
  analysis: TrackAnalysis;
  playCount?: number;
  lastPlayedAtMs?: number;
  dateAddedMs?: number;
  persistedToIdb?: boolean;
}

type DeckSlotMeta = {
  id: string;
  name: string;
  artist: string;
  genre: string;
  analysis: TrackAnalysis;
} | undefined;

const slots: [DeckSlotMeta, DeckSlotMeta] = [undefined, undefined];
const crate: CrateTrack[] = [];
const queue: CrateTrack[] = [];
const setlistHistory: SetlistEntry[] = [];

let selectedPresetId = "auto";
let selectedTemplateId = templates[0].id;
let autoPilotEnabled = true;
let autoScratchDrops = true;
let autoScratchFiredForTrackId = "";
let userPinnedScratchArchetype = false;
let crateSearchQuery = "";
let crateHarmonicOnly = false;
let crateActiveQuickFilter = "all";
let crateSortBy: CrateSearchFilters["sortBy"] = "smart";
let marathonDurationMins = 240; // 0 = endless 60m wave
let sessionStartedAtMs = 0;
let wakeLockSentinel: WakeLockSentinel | null = null;
let loading = false;
let freePending = false;
let toastTimer = 0;

const PREFS_STORAGE_KEY = "party_dj_studio_booth_prefs_v1";
function saveBoothPrefs() {
  try {
    localStorage.setItem(
      PREFS_STORAGE_KEY,
      JSON.stringify({
        selectedPresetId,
        selectedTemplateId,
        autoPilotEnabled,
        autoScratchDrops,
        marathonDurationMins,
        autoGainEnabled: mixer.autoGainEnabled,
        crossfaderCurve: mixer.crossfaderCurve,
      })
    );
  } catch {
    // ignore storage quota errors
  }
}

function loadBoothPrefs() {
  try {
    const raw = localStorage.getItem(PREFS_STORAGE_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (typeof parsed.selectedPresetId === "string") selectedPresetId = parsed.selectedPresetId;
    if (typeof parsed.selectedTemplateId === "string" && templates.some(t => t.id === parsed.selectedTemplateId)) {
      selectedTemplateId = parsed.selectedTemplateId;
    }
    if (typeof parsed.autoPilotEnabled === "boolean") autoPilotEnabled = parsed.autoPilotEnabled;
    if (typeof parsed.autoScratchDrops === "boolean") autoScratchDrops = parsed.autoScratchDrops;
    if (typeof parsed.marathonDurationMins === "number") marathonDurationMins = parsed.marathonDurationMins;
    if (typeof parsed.autoGainEnabled === "boolean") mixer.setAutoGain(parsed.autoGainEnabled);
    if (parsed.crossfaderCurve === "blend" || parsed.crossfaderCurve === "dip" || parsed.crossfaderCurve === "cut") {
      mixer.setCrossfaderCurve(parsed.crossfaderCurve);
    }
  } catch {
    // ignore malformed storage
  }
}
loadBoothPrefs();

// Interface Mode: "simple" (few controls) vs "advanced" (full DJ controls + scratch)
let uiMode: "simple" | "advanced" = "simple";
const UI_MODE_STORAGE_KEY = "party_dj_studio_ui_mode_v1";

function setUiMode(mode: "simple" | "advanced", notify = true) {
  uiMode = mode;
  try {
    localStorage.setItem(UI_MODE_STORAGE_KEY, mode);
  } catch {
    // ignore quota
  }
  document.body.classList.toggle("mode-simple", mode === "simple");
  document.body.classList.toggle("mode-advanced", mode === "advanced");

  const simpleBtn = $("simpleModeBtn");
  const advBtn = $("advancedModeBtn");
  if (simpleBtn && advBtn) {
    simpleBtn.classList.toggle("active", mode === "simple");
    advBtn.classList.toggle("active", mode === "advanced");
    simpleBtn.setAttribute("aria-pressed", String(mode === "simple"));
    advBtn.setAttribute("aria-pressed", String(mode === "advanced"));
  }

  if (notify) {
    toast(
      mode === "simple"
        ? "Simple Mode: Clean, streamlined controls for effortless party playback"
        : "Advanced DJ Mode: Turntables, 90s Scratch Agent, Hot Cues, Loops & Tone EQ unlocked"
    );
  }
}

function loadUiMode() {
  try {
    const saved = localStorage.getItem(UI_MODE_STORAGE_KEY);
    if (saved === "advanced" || saved === "simple") {
      setUiMode(saved, false);
      return;
    }
  } catch {
    // ignore
  }
  setUiMode("simple", false);
}
loadUiMode();

// 90s Scratch Agent State
let agentArchetype: ScratchArchetypeId = "philly";
let agentBars: 2 | 4 = 2;
let agentStyle: Style = "medium";
let agentPlacementMode: "hook" | "answer" | "sentence" = "answer";
let lastAgentOutput: AgentTriggerOutput | null = null;
let agentRunning = false;

// Platter rotation tracking (degrees)
const platterAngles = [0, 0];
let lastFrameTime = performance.now();

const fmt = (s: number) => {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
const clean = (n: string) => n.replace(/\.[^.]+$/, "");

function toast(msg: string) {
  $("toast").textContent = msg;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    $("toast").textContent = autoPilotEnabled
      ? "Auto-DJ Pilot Active - Phrase Automix Armed"
      : "Ready - Press Start Party or trigger any scratch pad (keys 1-8)";
  }, 4500);
}

// 1. Render Fast Interlocking Transition Preset Keys (Auto Variety + 8 Real DJ Mixing Techniques)
const SHORT_PRESET_LABELS: Record<string, string> = {
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

const recentTransitionPresetIds: string[] = [];

const blendContainer = $("blend");
const allBlendOptions: Array<{ id: string; name: string; sub: string }> = [
  { id: "auto", name: "Auto Variety", sub: "Smart AI" },
  ...presets.map(p => ({
    id: p.id,
    name: SHORT_PRESET_LABELS[p.id] ?? p.name,
    sub: p.bars ? `${p.bars}B` : "Instant",
  })),
];

if (blendContainer) {
  for (const opt of allBlendOptions) {
    const l = document.createElement("label");
    const i = document.createElement("input");
    const s = document.createElement("span");
    const sm = document.createElement("small");
    i.type = "radio";
    i.name = "blend";
    i.value = opt.id;
    i.checked = opt.id === selectedPresetId;
    s.textContent = opt.name;
    sm.textContent = opt.sub;
    s.append(sm);
    l.append(i, s);
    blendContainer.append(l);
  }
  blendContainer.addEventListener("change", e => {
    selectedPresetId = (e.target as HTMLInputElement).value;
    saveBoothPrefs();
    if (selectedPresetId === "auto") {
      toast("Transition mode: Auto-DJ Variety (Dynamically picks Drop Slam, Bass Swap, Filter Riser, Brake, Spinback, or Smooth Blend)");
    } else {
      const p = presets.find(x => x.id === selectedPresetId);
      if (p) toast(`Transition mode locked: ${p.name} (${p.bars} bars)`);
    }
  });
}

function resolveActiveTransitionPreset(): { preset: TransitionPreset; autoReason?: string } {
  if (selectedPresetId !== "auto") {
    const manual = presets.find(p => p.id === selectedPresetId) ?? presets[0];
    return { preset: manual };
  }
  const fromMeta = slots[mixer.active] ?? slots[0];
  const toMeta = slots[mixer.idle] ?? slots[1];
  if (!fromMeta || !toMeta) {
    return { preset: presets[0] };
  }
  const picked = pickSmartTransitionPreset(
    {
      bpm: mixer.info()?.effBpm ?? fromMeta.analysis.bpm,
      key: fromMeta.analysis.key,
      energy: fromMeta.analysis.energy,
    },
    {
      bpm: toMeta.analysis.bpm,
      key: toMeta.analysis.key,
      energy: toMeta.analysis.energy,
    },
    recentTransitionPresetIds
  );
  const preset = presets.find(p => p.id === picked.presetId) ?? presets[0];
  recentTransitionPresetIds.push(preset.id);
  if (recentTransitionPresetIds.length > 8) recentTransitionPresetIds.shift();
  return { preset, autoReason: picked.reason };
}

// 2. Render 8 Fitted Autoscratch Performance Pads (4x2 Matrix)
const COMPACT_SCRATCH_LABELS: Record<string, { title: string; tag: string }> = {
  baby: { title: "Baby Scratch", tag: "2B OPEN" },
  flare: { title: "Orbit Flare", tag: "2B 2-CLK" },
  transformer: { title: "Transformer", tag: "2B GATE" },
  chirp: { title: "Chirp Cut", tag: "2B EDGE" },
  crab: { title: "4-Finger Crab", tag: "2B ROLL" },
  tear: { title: "Tear Scratch", tag: "2B SPLIT" },
  backspin: { title: "Backspin", tag: "4B WHIP" },
  uzis: { title: "Laser Stutter", tag: "2B 1/32" },
};

const scratchPadsContainer = $("scratchPads");
if (scratchPadsContainer) {
  SCRATCH_PATTERNS.forEach((pat, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "scratch-pad-btn";
    btn.dataset.scratchId = pat.id;
    btn.title = `${pat.name}: ${pat.description} (Key ${idx + 1})`;

    const compact = COMPACT_SCRATCH_LABELS[pat.id] ?? {
      title: pat.name,
      tag: `${pat.beats}B`,
    };

    const topRow = document.createElement("div");
    topRow.className = "scratch-pad-top";
    const keySpan = document.createElement("span");
    keySpan.className = "scratch-pad-key";
    keySpan.textContent = `0${idx + 1}`;
    const tagSpan = document.createElement("span");
    tagSpan.textContent = compact.tag;
    topRow.append(keySpan, tagSpan);

    const title = document.createElement("strong");
    title.textContent = compact.title;

    btn.append(topRow, title);

    btn.addEventListener("click", async () => {
      await mixer.ctx.resume();
      const res = mixer.triggerAutoscratch(pat.id);
      if (res.ok) toast(`Autoscratch: ${res.message}`);
    });

    scratchPadsContainer.append(btn);
  });
}

// Scratch Source Mode, Quantize Grid, Optical Fader Cut-In, Intensity & Battle Cut Sample Switches
document.querySelectorAll<HTMLButtonElement>("[data-scratch-source]").forEach(btn => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll<HTMLButtonElement>("[data-scratch-source]")
      .forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    mixer.scratchSourceMode = btn.dataset.scratchSource as ScratchSourceMode;
    void autoStageScratchRoutine();
    toast(
      mixer.scratchSourceMode === "vinyl"
        ? "Scratch Source: Direct Vinyl Track (Warps & moves active music track playhead)"
        : mixer.scratchSourceMode === "slip"
          ? "Scratch Source: Slip-Mat Active Deck (Warps active track, preserves bar grid)"
          : mixer.scratchSourceMode === "incoming"
            ? "Scratch Source: Incoming Deck B Drop Transient"
            : "Scratch Source: 90s Battle Vocal Cuts (4-Formant + M44-7 Stylus Bite)"
    );
  });
});

const commitTrackModBtn = $<HTMLButtonElement>("commitTrackModBtn");
commitTrackModBtn?.addEventListener("click", () => {
  mixer.commitTrackMod = !mixer.commitTrackMod;
  commitTrackModBtn.classList.toggle("active", mixer.commitTrackMod);
  commitTrackModBtn.setAttribute("aria-pressed", String(mixer.commitTrackMod));
  commitTrackModBtn.textContent = `MOD TRACK: ${mixer.commitTrackMod ? "ON" : "OFF"}`;
  toast(
    mixer.commitTrackMod
      ? "Track Modification ON: Scratches permanently splice into the deck's AudioBuffer & waveform"
      : "Track Modification OFF: Scratches manipulate live playback without overwriting track PCM"
  );
});

$("restoreTrackModBtn")?.addEventListener("click", () => {
  const slot = mixer.active as 0 | 1;
  const ok = mixer.restoreDeckOriginal(slot);
  if (ok) {
    toast(`Restored Deck ${slot === 0 ? "A" : "B"} ("${slots[slot]?.name ?? "Track"}") to original unmodified audio`);
  }
});

$("exportModTrackBtn")?.addEventListener("click", () => {
  const slot = mixer.active as 0 | 1;
  const exported = mixer.exportDeckWav(slot);
  if (!exported) return toast("Load a track into the active deck first");
  const trackTitle = (slots[slot]?.name ?? `deck_${slot === 0 ? "a" : "b"}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_");
  const blob = new Blob([exported.wavBytes.buffer as ArrayBuffer], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${trackTitle}_scratched_${exported.modCount}mods.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(
    `Exported Deck ${slot === 0 ? "A" : "B"} stereo WAV (${exported.modCount} scratch modification${exported.modCount === 1 ? "" : "s"} baked in)`
  );
});

document.querySelectorAll<HTMLButtonElement>("[data-scratch-quantize]").forEach(btn => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll<HTMLButtonElement>("[data-scratch-quantize]")
      .forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    mixer.scratchQuantize = (btn.dataset.scratchQuantize as ScratchQuantizeMode) || "1/16";
    toast(
      mixer.scratchQuantize === "instant"
        ? "Scratch Quantize: INSTANT (<4ms Zero-Latency Battle Pad Trigger)"
        : `Scratch Quantize: ${mixer.scratchQuantize} Beat Grid Pocket Lock`
    );
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-scratch-cut]").forEach(btn => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll<HTMLButtonElement>("[data-scratch-cut]")
      .forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    mixer.scratchCutMode = (btn.dataset.scratchCut as ScratchCutMode) || "mag-four";
    void autoStageScratchRoutine();
    toast(
      mixer.scratchCutMode === "mag-four"
        ? "Optical Fader Edge: Rane Mag-Four (0.55ms Ultra-Sharp Cut-In)"
        : "Optical Fader Edge: Classic Club VCA (1.6ms Smooth Envelope)"
    );
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-battle-sample]").forEach(btn => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll<HTMLButtonElement>("[data-battle-sample]")
      .forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    mixer.battleSampleId = (btn.dataset.battleSample as BattleSampleId) || "auto";
    toast(
      mixer.battleSampleId === "auto"
        ? "Battle Cut Sample: AUTO (Matches syllable timbre to each scratch pattern)"
        : `Battle Cut Sample Locked: "${mixer.battleSampleId.toUpperCase()}"`
    );
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-scratch-intensity]").forEach(btn => {
  btn.addEventListener("click", () => {
    document
      .querySelectorAll<HTMLButtonElement>("[data-scratch-intensity]")
      .forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    mixer.scratchIntensity = parseFloat(btn.dataset.scratchIntensity || "1.0");
    toast(`Scratch intensity: ${btn.textContent}`);
  });
});

// 2B. 90s Scratch Agent Controls, Critic QA Inspector & WAV Export
const sentenceInputRow = $("sentenceInputRow");
const sentenceWordsInput = $<HTMLInputElement>("sentenceWordsInput");
const wordBankPills = $("wordBankPills");

function syncAgentUiState() {
  document.querySelectorAll<HTMLButtonElement>("[data-agent-archetype]").forEach(b => {
    b.classList.toggle("active", b.dataset.agentArchetype === agentArchetype);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-agent-bars]").forEach(b => {
    b.classList.toggle("active", Number(b.dataset.agentBars) === agentBars);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-agent-style]").forEach(b => {
    b.classList.toggle("active", b.dataset.agentStyle === agentStyle);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-agent-mode]").forEach(b => {
    b.classList.toggle("active", b.dataset.agentMode === agentPlacementMode);
  });
  if (sentenceInputRow) sentenceInputRow.hidden = agentPlacementMode !== "sentence";
}

// Populate clickable 90s Battle Cut word chips for Sentence Mode
if (wordBankPills && sentenceWordsInput) {
  for (const syl of BATTLE_CUT_SLICES) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "word-pill-btn";
    chip.textContent = `+${syl.text}`;
    chip.title = `Append "${syl.text}" (${Math.round(syl.len * 1000)}ms cut word) to sentence`;
    chip.addEventListener("click", () => {
      const cur = sentenceWordsInput.value.trim();
      const tokens = cur ? cur.split(/\s+/) : [];
      if (tokens.length >= 6) tokens.shift();
      tokens.push(syl.text);
      sentenceWordsInput.value = tokens.join(" ");
    });
    wordBankPills.append(chip);
  }
}

function parseSentenceTokens(raw: string): (string | number)[] {
  return raw
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(tok => (/^\d+$/.test(tok) ? parseInt(tok, 10) : tok));
}

document.querySelectorAll<HTMLButtonElement>("[data-agent-archetype]").forEach(btn => {
  btn.addEventListener("click", () => {
    const arch = (btn.dataset.agentArchetype as ScratchArchetypeId) || "philly";
    userPinnedScratchArchetype = true;
    agentArchetype = arch;
    if (arch === "premier") {
      agentPlacementMode = "sentence";
      agentStyle = "sparse";
      agentBars = 2;
      toast("Archetype: DJ Premier (Sentence-Hook, forward strokes, sparse + swing)");
    } else if (arch === "philly") {
      agentPlacementMode = "answer";
      agentStyle = "busy";
      agentBars = 2;
      toast("Archetype: Philly Transform (Rigid 16th grid, high-density fader chops)");
    } else if (arch === "bombsquad") {
      agentPlacementMode = "hook";
      agentStyle = "busy";
      agentBars = 4;
      toast("Archetype: Bomb Squad (4-Bar collage, wide sustained strokes)");
    }
    syncAgentUiState();
    void autoStageScratchRoutine();
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-agent-bars]").forEach(btn => {
  btn.addEventListener("click", () => {
    agentBars = Number(btn.dataset.agentBars) === 4 ? 4 : 2;
    syncAgentUiState();
    toast(`90s Agent phrase length: ${agentBars} bars`);
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-agent-style]").forEach(btn => {
  btn.addEventListener("click", () => {
    agentStyle = (btn.dataset.agentStyle as Style) || "medium";
    syncAgentUiState();
    toast(`90s Agent style: ${agentStyle.toUpperCase()}`);
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-agent-mode]").forEach(btn => {
  btn.addEventListener("click", () => {
    const m = btn.dataset.agentMode;
    agentPlacementMode = m === "hook" ? "hook" : m === "sentence" ? "sentence" : "answer";
    syncAgentUiState();
    toast(
      agentPlacementMode === "sentence"
        ? "90s Agent pocket: SENTENCE (Ordered multi-source words/slices, 1 forward stroke each)"
        : agentPlacementMode === "answer"
          ? "90s Agent pocket: ANSWER (Beats 1-2 open for vocal, scratch on beats 3-4)"
          : "90s Agent pocket: HOOK (Scratch across all beats)"
    );
  });
});

const agentSeedInput = $<HTMLInputElement>("agentSeedInput");
const agentWithHookInput = $<HTMLInputElement>("agentWithHook");
const agentExportWavBtn = $<HTMLButtonElement>("agentExportWavBtn");

function formatCriticMetric(name: string, val: number | null, threshold: number | null): string {
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

function renderAgentInspector(out: AgentTriggerOutput) {
  const res = out.result;
  if (!res) return;

  const badge = $("criticStatusBadge");
  if (badge) {
    badge.classList.remove("pass", "warn");
    badge.classList.add(res.passed ? "pass" : "warn");
    badge.textContent = `${res.passed ? "CRITIC PASS" : "CRITIC WARN"} / TRY ${res.attempts.length}/${res.cfg.max_tries} / SEED ${res.seed}`;
  }

  setTxt("agentInspectorSummary", `CRITIC QA: ${res.passed ? "PASS" : "WARN"} (${res.events.length} EVENTS / ${out.bank?.slices.length ?? 0} SLICES / SEED ${res.seed})`);

  const checksGrid = $("agentCriticChecks");
  if (checksGrid) {
    checksGrid.replaceChildren();
    const lastAttempt = res.attempts[res.attempts.length - 1];
    if (lastAttempt) {
      for (const c of lastAttempt.report.checks) {
        const chip = document.createElement("span");
        const isUnmeasured = c.value === null;
        chip.className = `critic-check-chip ${c.passed ? "ok" : "fail"}`;
        const b = document.createElement("b");
        b.textContent = isUnmeasured ? "N/A" : c.passed ? "OK" : "WARN";
        const txt = document.createElement("span");
        const metricStr = formatCriticMetric(c.name, c.value, c.threshold);
        txt.textContent = metricStr ? `${c.name} (${metricStr})` : c.name;
        chip.append(b, txt);
        checksGrid.append(chip);
      }
    }
  }

  const eventsStrip = $("agentEventPills");
  if (eventsStrip) {
    eventsStrip.replaceChildren();
    const secPerBeat = 60 / (mixer.info()?.effBpm ?? slots[mixer.active]?.analysis.bpm ?? 124);
    const byId = new Map((out.bank?.slices ?? []).map(s => [s.id, s]));
    res.events.forEach((ev, idx) => {
      const pill = document.createElement("button");
      pill.type = "button";
      pill.className = "event-chip";
      pill.title = "Click to cycle scratch primitive (Baby -> Flare -> Chirp -> Stab -> Cut -> Tear -> Crab -> Transform) · Shift+Click to drop live";
      const beatPos = (ev.t0 / secPerBeat).toFixed(2);
      const sl = byId.get(ev.slice_id);
      const srcTag = sl?.text ? `${sl.src_id ?? "cut"}:"${sl.text}"` : `${sl?.src_id ?? "main"}:S${ev.slice_id}`;
      const rateTag = ev.params.avg_rate !== undefined ? ` / ${ev.params.avg_rate.toFixed(2)}x` : "";
      pill.innerHTML = `<b>#${idx + 1} ${ev.primitive}</b> @ ${beatPos}B (${srcTag}, ${ev.n_strokes}x${rateTag})`;
      pill.addEventListener("click", async e => {
        if (!lastAgentOutput) return;
        if (e.shiftKey) await mixer.ctx.resume();
        const updated = mixer.cycleScratchAgentEventPrimitive(lastAgentOutput, idx, e.shiftKey);
        if (updated) {
          lastAgentOutput = updated;
          renderAgentInspector(updated);
          toast(updated.message);
        }
      });
      eventsStrip.append(pill);
    });
  }

  if (agentExportWavBtn) agentExportWavBtn.disabled = false;
}

async function trigger90sScratchAgent(incrementSeed = false) {
  if (agentRunning) return;
  agentRunning = true;
  const dropBtn = $<HTMLButtonElement>("agentDropBtn");
  if (dropBtn) dropBtn.disabled = true;
  try {
    await mixer.ctx.resume();
    let seed = parseInt(agentSeedInput?.value || "7", 10);
    if (Number.isNaN(seed)) seed = 7;
    if (incrementSeed) {
      seed += 1;
      if (agentSeedInput) agentSeedInput.value = String(seed);
    }
    const sentenceWords =
      agentPlacementMode === "sentence" && sentenceWordsInput
        ? parseSentenceTokens(sentenceWordsInput.value)
        : undefined;
    const out = await mixer.triggerScratchAgent({
      bars: agentBars,
      style: agentStyle,
      placementMode: agentPlacementMode,
      seed,
      archetype: agentArchetype,
      sentenceWords,
      withHook: agentWithHookInput ? agentWithHookInput.checked : true,
    });
    lastAgentOutput = out;
    if (out.result && agentSeedInput) {
      agentSeedInput.value = String(out.result.seed);
    }
    renderAgentInspector(out);
    toast(`90s Scratch Agent: ${out.message}`);
  } catch (err) {
    toast(`90s Scratch Agent error: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    agentRunning = false;
    if (dropBtn) dropBtn.disabled = false;
  }
}

async function autoStageScratchRoutine() {
  if (agentRunning) return;
  const activeMeta = slots[mixer.active] ?? slots[0];
  if (activeMeta && !userPinnedScratchArchetype) {
    const prof = pickSmartScratchProfile({
      bpm: activeMeta.analysis.bpm,
      energy: activeMeta.analysis.energy,
      genre: activeMeta.genre,
    });
    agentArchetype = prof.archetype;
    agentBars = prof.bars;
    agentStyle = prof.style;
    agentPlacementMode = prof.placementMode;
    syncAgentUiState();
  }
  try {
    const seed = parseInt(agentSeedInput?.value || "7", 10) || 7;
    const sentenceWords =
      agentPlacementMode === "sentence" && sentenceWordsInput
        ? parseSentenceTokens(sentenceWordsInput.value)
        : undefined;
    const out = await mixer.triggerScratchAgent({
      bars: agentBars,
      style: agentStyle,
      placementMode: agentPlacementMode,
      seed,
      archetype: agentArchetype,
      sentenceWords,
      withHook: agentWithHookInput ? agentWithHookInput.checked : true,
      previewOnly: true,
    });
    lastAgentOutput = out;
    renderAgentInspector(out);
  } catch {
    // ignore background preview errors
  }
}

$("agentDropBtn")?.addEventListener("click", () => void trigger90sScratchAgent(false));
$("agentRerollBtn")?.addEventListener("click", () => void trigger90sScratchAgent(true));

agentExportWavBtn?.addEventListener("click", () => {
  const res = lastAgentOutput?.result;
  const sr = lastAgentOutput?.sourceBuffer?.sampleRate ?? mixer.ctx.sampleRate;
  if (!res) return;
  const pcm = applyHeadroom(res.audio, res.cfg.headroom_db);
  const wavBytes = encodeWav16(pcm, sr);
  const blob = new Blob([wavBytes.buffer as ArrayBuffer], { type: "audio/wav" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `90s_scratch_agent_${res.plan.bars}b_${res.plan.style}_seed${res.seed}.wav`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`Exported 16-bit PCM WAV (Seed ${res.seed})`);
});

// 3. Render Party Energy Templates & Marathon Sequencer Controls
function getActiveTemplate(): PartyTemplate {
  return templates.find(t => t.id === selectedTemplateId) ?? templates[0];
}

function getSessionProgress01(): number {
  if (!sessionStartedAtMs || !mixer.playing) return 0;
  const elapsedMin = (Date.now() - sessionStartedAtMs) / 60000;
  if (marathonDurationMins <= 0) {
    // Endless mode: 60-minute wave cycle
    return (elapsedMin % 60) / 60;
  }
  return Math.min(1, elapsedMin / marathonDurationMins);
}

function getCurrentTargetEnergy(): number {
  const tpl = getActiveTemplate();
  return interpolateEnergyCurve(tpl.energyCurve, getSessionProgress01());
}

/**
 * Evicts decoded 32-bit AudioBuffers from user-uploaded File tracks that are not in
 * Deck A, Deck B, or the next 2 queue slots so 4-hour 100-track sets stay under ~250MB RAM.
 */
function countBuffersInRam(): number {
  let count = 0;
  for (const item of crate) {
    if (item.buffer) count++;
  }
  return count;
}

function updateRamAndWakeBadge() {
  const badge = $("wakeLockBadge");
  const ramCount = countBuffersInRam();
  badge.classList.toggle("active", mixer.playing);
  const wlText = wakeLockSentinel ? "WAKELOCK ON" : "WAKELOCK OFF";
  badge.textContent = `RAM: ${ramCount}/${crate.length} BUFFERS · ${wlText}`;
}

function evictIdleCrateBuffers() {
  const keepIds = new Set<string>();
  if (slots[0]?.id) keepIds.add(slots[0].id);
  if (slots[1]?.id) keepIds.add(slots[1].id);
  if (queue[0]?.id) keepIds.add(queue[0].id);
  if (queue[1]?.id) keepIds.add(queue[1].id);

  for (const item of crate) {
    if (item.file && item.buffer && !keepIds.has(item.id)) {
      item.buffer = undefined;
    }
  }
  updateRamAndWakeBadge();
}

async function syncWakeLock() {
  if (!mixer.playing) {
    if (wakeLockSentinel) {
      try {
        await wakeLockSentinel.release();
      } catch {
        // Ignore release errors
      }
      wakeLockSentinel = null;
    }
    updateRamAndWakeBadge();
    return;
  }

  if ("wakeLock" in navigator && !wakeLockSentinel) {
    try {
      wakeLockSentinel = await navigator.wakeLock.request("screen");
      wakeLockSentinel.addEventListener("release", () => {
        wakeLockSentinel = null;
        updateRamAndWakeBadge();
      });
    } catch {
      wakeLockSentinel = null;
    }
  }
  updateRamAndWakeBadge();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && mixer.playing) {
    void syncWakeLock();
  }
});

function logTrackToSetlist(meta: DeckSlotMeta, presetName: string, harmonicMatch: string) {
  if (!meta) return;
  if (!sessionStartedAtMs) sessionStartedAtMs = Date.now();
  const elapsedMin = +((Date.now() - sessionStartedAtMs) / 60000).toFixed(1);
  const crateItem = crate.find(c => c.id === meta.id);
  const fileName = crateItem?.file?.name ?? `${meta.id}.synth.wav`;

  setlistHistory.push({
    index: setlistHistory.length + 1,
    playedAtIso: new Date().toISOString(),
    elapsedSessionMin: elapsedMin,
    title: meta.name,
    artist: meta.artist,
    fileName,
    bpm: +meta.analysis.bpm.toFixed(1),
    key: meta.analysis.key ?? "8A",
    energy: Math.round((meta.analysis.energy ?? 0.75) * 100),
    transitionPreset: presetName,
    harmonicMatch,
  });
  $("setlistCountBadge").textContent = String(setlistHistory.length);

  if (crateItem) {
    crateItem.playCount = (crateItem.playCount ?? 0) + 1;
    crateItem.lastPlayedAtMs = Date.now();
  }
}

const partyTemplatesBar = $("partyTemplates");
function renderPartyTemplates() {
  partyTemplatesBar.replaceChildren();
  for (const t of templates) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `template-btn ${t.id === selectedTemplateId ? "active" : ""}`;
    btn.textContent = `${t.name}`;
    btn.addEventListener("click", () => {
      selectedTemplateId = t.id;
      $("marathonArcLabel").textContent = `ENERGY ARC: ${t.name.toUpperCase()}`;
      autoSequenceQueueSilently();
      renderQueue();
      renderPartyTemplates();
      saveBoothPrefs();
      toast(`Party Vibe: ${t.name} (Queue auto-sequenced to ${t.name} energy curve)`);
    });
    partyTemplatesBar.append(btn);
  }
}
renderPartyTemplates();

// Marathon Duration & Queue Auto-Sequencer Controls
document.querySelectorAll<HTMLButtonElement>("[data-marathon-mins]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll<HTMLButtonElement>("[data-marathon-mins]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    marathonDurationMins = parseInt(btn.dataset.marathonMins || "240", 10);
    saveBoothPrefs();
    toast(
      marathonDurationMins > 0
        ? `Marathon set target: ${marathonDurationMins} minutes (${marathonDurationMins / 60}H)`
        : "Marathon set target: ENDLESS (60m wave cycle)"
    );
  });
});

$("autoSequenceBtn").addEventListener("click", () => {
  const activeMeta = slots[mixer.active] ?? slots[0];
  const anchor = {
    bpm: activeMeta?.analysis.bpm ?? 124,
    key: activeMeta?.analysis.key ?? "8A",
  };
  if (queue.length < 2) {
    const activeIds = new Set([slots[0]?.id, slots[1]?.id, ...queue.map(q => q.id)]);
    for (const c of crate) {
      if (!activeIds.has(c.id)) queue.push(c);
    }
  }
  const tpl = getActiveTemplate();
  const reordered = sequenceCrateForParty(anchor, queue, tpl.energyCurve, getSessionProgress01());
  queue.splice(0, queue.length, ...reordered);
  renderQueue();
  void fill();
  toast(`Auto-sequenced ${queue.length} track(s) by Camelot Key + BPM + ${tpl.name} Energy Curve`);
});

const autoGainToggle = $<HTMLButtonElement>("autoGainToggle");
autoGainToggle.addEventListener("click", () => {
  mixer.setAutoGain(!mixer.autoGainEnabled);
  autoGainToggle.classList.toggle("active", mixer.autoGainEnabled);
  autoGainToggle.setAttribute("aria-pressed", String(mixer.autoGainEnabled));
  autoGainToggle.textContent = `AUTO-GAIN: ${mixer.autoGainEnabled ? "ON" : "OFF"}`;
  saveBoothPrefs();
  toast(
    mixer.autoGainEnabled
      ? "Club Auto-Gain Enabled (-11.5 dBFS RMS target)"
      : "Club Auto-Gain Bypassed (0dB raw deck levels)"
  );
});

const splitCueToggle = $<HTMLButtonElement>("splitCueToggle");
function updateCueUiState() {
  splitCueToggle.classList.toggle("active", mixer.splitCueEnabled);
  splitCueToggle.setAttribute("aria-pressed", String(mixer.splitCueEnabled));
  splitCueToggle.textContent = `SPLIT CUE (L:MST / R:CUE): ${mixer.splitCueEnabled ? "ON" : "OFF"}`;
  $("cueListenA").classList.toggle("active", mixer.auditioningSlot === 0);
  $("cueListenB").classList.toggle("active", mixer.auditioningSlot === 1);
}

splitCueToggle.addEventListener("click", () => {
  mixer.setSplitCue(!mixer.splitCueEnabled);
  updateCueUiState();
  toast(
    mixer.splitCueEnabled
      ? "Split-Cue Active: Left = Master PA, Right = Pre-Fader Headphone Cue"
      : "Split-Cue Off: Standard Stereo Master Output"
  );
});

$("cueListenA").addEventListener("click", async () => {
  await mixer.ctx.resume();
  const on = mixer.toggleCueAudition(0);
  updateCueUiState();
  toast(on ? "Headphone Cue: Auditioning Deck A (Right Channel)" : "Headphone Cue: Deck A released");
});

$("cueListenB").addEventListener("click", async () => {
  await mixer.ctx.resume();
  const on = mixer.toggleCueAudition(1);
  updateCueUiState();
  toast(on ? "Headphone Cue: Auditioning Deck B (Right Channel)" : "Headphone Cue: Deck B released");
});

const autoScratchToggle = $<HTMLButtonElement>("autoScratchToggle");
autoScratchToggle.addEventListener("click", () => {
  autoScratchDrops = !autoScratchDrops;
  autoScratchToggle.classList.toggle("active", autoScratchDrops);
  autoScratchToggle.setAttribute("aria-pressed", String(autoScratchDrops));
  autoScratchToggle.textContent = `AUTO-SCRATCH DROPS: ${autoScratchDrops ? "ON" : "OFF"}`;
  toast(
    autoScratchDrops
      ? "Auto-Scratch Drops Armed: Will drop a 90s Scratch Agent phrase 6 bars before Auto-DJ transitions"
      : "Auto-Scratch Drops Disabled"
  );
});

$("exportSetlistBtn").addEventListener("click", () => {
  if (setlistHistory.length === 0 && slots[mixer.active]) {
    logTrackToSetlist(slots[mixer.active], "Opening Track", "Initial Lock");
  }
  const lines = [
    "#EXTM3U",
    `#PLAYLIST:Party DJ Studio - ${getActiveTemplate().name} Setlist`,
    ...setlistHistory.flatMap(entry => [
      `#EXTINF:-1,${entry.artist} - ${entry.title} [${entry.bpm} BPM | Key ${entry.key} | Energy ${entry.energy}% | Mix: ${entry.transitionPreset} | ${entry.harmonicMatch} @ +${entry.elapsedSessionMin}m]`,
      entry.fileName,
    ]),
  ];
  const blob = new Blob([lines.join("\n")], { type: "audio/x-mpegurl" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `party_dj_setlist_${Date.now()}.m3u8`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`Exported Setlist (.M3U8) with ${setlistHistory.length} played track(s)`);
});

// Auto-DJ Pilot, Mic Talkover & Live Set Recorder Toggles
const autoPilotBtn = $<HTMLButtonElement>("autoPilotBtn");
autoPilotBtn.addEventListener("click", () => {
  autoPilotEnabled = !autoPilotEnabled;
  autoPilotBtn.setAttribute("aria-pressed", String(autoPilotEnabled));
  autoPilotBtn.innerHTML = `<span class="switch-led"></span><span>Auto-DJ: ${autoPilotEnabled ? "On" : "Off"}</span>`;
  toast(
    autoPilotEnabled
      ? "Auto-DJ Pilot Enabled - Will auto-blend tracks at phrase outro"
      : "Auto-DJ Pilot Disabled"
  );
});

const micTalkoverBtn = $<HTMLButtonElement>("micTalkoverBtn");
micTalkoverBtn.addEventListener("click", async () => {
  const res = await mixer.toggleMicTalkover();
  micTalkoverBtn.setAttribute("aria-pressed", String(res.active));
  $("micTalkoverLabel").textContent = `Mic: ${res.active ? "On (-10dB)" : "Off"}`;
  toast(res.message);
});

const recSetBtn = $<HTMLButtonElement>("recSetBtn");
recSetBtn.addEventListener("click", async () => {
  const res = await mixer.toggleRecording();
  recSetBtn.setAttribute("aria-pressed", String(res.recording));
  if (!res.recording) {
    $("recSetLabel").textContent = "Rec Set";
    if (res.blob) {
      const url = URL.createObjectURL(res.blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `party_dj_live_set_${Date.now()}.${res.ext ?? "webm"}`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }
  }
  toast(res.message);
});

// Master BPM Nudge Controls
$("bpmDownBtn").addEventListener("click", () => {
  const cur = mixer.info()?.effBpm ?? slots[0]?.analysis.bpm ?? 124;
  mixer.setMasterBpm(cur - 1);
  syncPitchSlidersFromDecks();
  toast(`Master Tempo nudged to ${(cur - 1).toFixed(1)} BPM`);
});
$("bpmUpBtn").addEventListener("click", () => {
  const cur = mixer.info()?.effBpm ?? slots[0]?.analysis.bpm ?? 124;
  mixer.setMasterBpm(cur + 1);
  syncPitchSlidersFromDecks();
  toast(`Master Tempo nudged to ${(cur + 1).toFixed(1)} BPM`);
});
$("bpmResetBtn").addEventListener("click", () => {
  const native = slots[mixer.active]?.analysis.bpm ?? 124;
  mixer.setMasterBpm(native);
  syncPitchSlidersFromDecks();
  toast(`Master Tempo synced to ${native.toFixed(1)} BPM`);
});

// Universal Key Selector & Global Pitch Transpose
let masterKey = "8A";
let globalKeyTransposeEnabled = false;

const universalKeySelect = $<HTMLSelectElement>("universalKeySelect");
const globalKeyTransposeBtn = $<HTMLButtonElement>("globalKeyTransposeBtn");

function updateUniversalKeyTranspose() {
  if (universalKeySelect) {
    masterKey = universalKeySelect.value || "8A";
  }
  if (globalKeyTransposeBtn) {
    globalKeyTransposeBtn.classList.toggle("active", globalKeyTransposeEnabled);
    globalKeyTransposeBtn.textContent = `KEY SHIFT: ${globalKeyTransposeEnabled ? "ON" : "OFF"}`;
  }
  for (let slot = 0 as 0 | 1; slot <= 1; slot = (slot + 1) as 0 | 1) {
    const d = mixer.decks[slot];
    if (globalKeyTransposeEnabled && d.analysis?.key) {
      const shift = calculateHarmonicKeyShift(d.analysis.key, masterKey);
      d.setPitchShiftSemitones(shift.semitones);
    } else if (!globalKeyTransposeEnabled) {
      d.setPitchShiftSemitones(0);
    }
    updatePitchedKeyBadge(slot);
  }
}

universalKeySelect?.addEventListener("change", () => {
  updateUniversalKeyTranspose();
  toast(`Universal Master Key set to ${universalKeySelect.value}`);
});

globalKeyTransposeBtn?.addEventListener("click", () => {
  globalKeyTransposeEnabled = !globalKeyTransposeEnabled;
  updateUniversalKeyTranspose();
  toast(
    globalKeyTransposeEnabled
      ? `Global Key Shift ON — Decks pitched to match Universal Key (${masterKey})`
      : "Global Key Shift OFF — Decks restored to native keys"
  );
});

// Transition Speed Bar Selectors (1/2B, 1B, 2B, 4B, 8B, 16B, 32B)
document.querySelectorAll<HTMLButtonElement>("[data-trans-bars]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll<HTMLButtonElement>("[data-trans-bars]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const bars = parseFloat(btn.dataset.transBars || "2");
    mixer.setTransitionDurationBars(bars);
    toast(`Transition Speed configured to ${bars} bar(s)`);
  });
});

// 4A. Per-Deck Transport, Sync, Beat-Jump, Phase Align & Pitch/Key Sliders
function updatePitchedKeyBadge(slot: 0 | 1) {
  const prefix = slot === 0 ? "A" : "B";
  const otherSlot = (1 - slot) as 0 | 1;
  const d = mixer.decks[slot];
  const other = mixer.decks[otherSlot];
  const el = $(`pitchedKey${prefix}`);
  const keyLockBtn = $(`keyLockBtn${prefix}`);
  const keyMatchBtn = $(`keyMatchBtn${prefix}`);

  if (keyLockBtn) {
    keyLockBtn.classList.toggle("active", d.keyLockEnabled);
    keyLockBtn.textContent = d.keyLockEnabled ? "MT: ON" : "MT: OFF";
  }

  if (keyMatchBtn && other.analysis?.key) {
    keyMatchBtn.title = `Harmonically match Deck ${prefix} key to Deck ${prefix === "A" ? "B" : "A"} (${other.getEffectiveKey()})`;
  }

  if (!el) return;
  if (!d.analysis?.key) {
    el.textContent = "--";
    el.classList.remove("shifted");
    return;
  }

  const effectiveKey = d.getEffectiveKey();
  const shifted = effectiveKey !== d.analysis.key;
  el.classList.toggle("shifted", shifted);

  if (shifted) {
    const shiftLabel = d.pitchShiftSemitones !== 0 ? ` (${d.pitchShiftSemitones >= 0 ? "+" : ""}${d.pitchShiftSemitones}st)` : "";
    el.textContent = `${d.analysis.key} → ${effectiveKey}${shiftLabel}`;
    el.title = `Native Key: ${d.analysis.key} · Effective Key: ${effectiveKey}${shiftLabel} · Key Lock: ${d.keyLockEnabled ? "ACTIVE" : "OFF"}`;
  } else {
    el.textContent = `${effectiveKey}${d.keyLockEnabled ? " [MT]" : ""}`;
    el.title = `Native Key: ${effectiveKey} (${d.keyLockEnabled ? "Master Tempo Lock Active" : "Vinyl Pitch Link"})`;
  }
}

function syncPitchSlidersFromDecks() {
  const limit = mixer.pitchFaderRange;
  for (let slot = 0 as 0 | 1; slot <= 1; slot = (slot + 1) as 0 | 1) {
    const prefix = slot === 0 ? "A" : "B";
    const pct = mixer.decks[slot].pitchPct;
    const slider = $<HTMLInputElement>(`pitchSlider${prefix}`);
    slider.min = String(-limit);
    slider.max = String(limit);
    slider.value = String(Math.max(-limit, Math.min(limit, pct)));
    $(`pitchVal${prefix}`).textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
    updatePitchedKeyBadge(slot);
    if (typeof midiEngine !== "undefined") {
      midiEngine.setSoftwareTargetNormalized(
        slot === 0 ? "pitchA" : "pitchB",
        Math.max(0, Math.min(1, (pct + limit) / (2 * limit)))
      );
    }
  }
}

// Global master Phase Align button (locks transient coincidence between playing decks)
$("phaseAlignMasterBtn").addEventListener("click", async () => {
  await mixer.ctx.resume();
  const idleSlot = mixer.idle as 0 | 1;
  const ok = mixer.phaseAlignDeck(idleSlot);
  if (ok) {
    toast(`Deck ${idleSlot === 0 ? "A" : "B"} Kick Phase locked into pocket with Master Deck`);
  } else {
    toast("Load and play both decks to lock beat phase");
  }
});

// Pitch fader range selector buttons (±4%, ±8%, ±16%, ±50%)
document.querySelectorAll<HTMLButtonElement>(".pitch-range-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const range = parseInt(btn.dataset.range || "8", 10) as PitchFaderRange;
    mixer.setPitchFaderRange(range);
    document.querySelectorAll<HTMLButtonElement>(".pitch-range-btn").forEach(b => {
      b.classList.toggle("active", parseInt(b.dataset.range || "8", 10) === range);
    });
    syncPitchSlidersFromDecks();
    toast(`Pitch Fader Range configured to ±${range}%`);
  });
});

([0, 1] as const).forEach(slot => {
  const prefix = slot === 0 ? "A" : "B";
  $(`deckPlay${prefix}`).addEventListener("click", async () => {
    await mixer.ctx.resume();
    if (!slots[slot]) return toast(`Load a track into Deck ${prefix} first`);
    const nowPlaying = mixer.toggleDeckPlay(slot);
    if (nowPlaying && !sessionStartedAtMs) sessionStartedAtMs = Date.now();
    void syncWakeLock();
    toast(nowPlaying ? `Deck ${prefix} Playing` : `Deck ${prefix} Paused`);
  });

  $(`deckSync${prefix}`).addEventListener("click", async () => {
    await mixer.ctx.resume();
    if (!slots[slot]) return toast(`Load a track into Deck ${prefix} first`);
    const res = mixer.syncDeckTempo(slot);
    syncPitchSlidersFromDecks();
    toast(`Deck ${prefix} SYNC: Locked to exact ${res.syncedBpm.toFixed(1)} BPM (${res.pct >= 0 ? "+" : ""}${res.pct.toFixed(2)}%)`);
  });

  $(`keyLockBtn${prefix}`)?.addEventListener("click", () => {
    const on = mixer.toggleDeckKeyLock(slot);
    updatePitchedKeyBadge(slot);
    toast(`Deck ${prefix} Master Tempo / Key Lock: ${on ? "ON (Pitch Preserved)" : "OFF (Turntable Mode)"}`);
  });

  $(`keyMatchBtn${prefix}`)?.addEventListener("click", async () => {
    await mixer.ctx.resume();
    if (!slots[slot]) return toast(`Load a track into Deck ${prefix} first`);
    const shift = mixer.matchHarmonicKey(slot);
    if (shift) {
      updatePitchedKeyBadge(slot);
      toast(`Deck ${prefix} Key Matched: Shifted ${shift.semitones >= 0 ? "+" : ""}${shift.semitones} semitones to ${shift.targetKey} (Harmonic Match ${shift.score}%)`);
    } else {
      toast("Load audio on both decks to harmonically match key");
    }
  });

  $(`phaseAlign${prefix}`).addEventListener("click", async () => {
    await mixer.ctx.resume();
    if (!slots[slot]) return toast(`Load a track into Deck ${prefix} first`);
    const ok = mixer.phaseAlignDeck(slot);
    if (ok) {
      toast(`Deck ${prefix} Phase Aligned — kick transients locked to pocket`);
    } else {
      toast("Load and play both decks to lock beat phase");
    }
  });

  const pitchSlider = $<HTMLInputElement>(`pitchSlider${prefix}`);
  const applyPitch = () => {
    const pct = parseFloat(pitchSlider.value || "0");
    const newBpm = mixer.setDeckPitchPct(slot, pct);
    $(`pitchVal${prefix}`).textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
    updatePitchedKeyBadge(slot);
    if (newBpm > 0) {
      toast(`Deck ${prefix} Pitch: ${pct >= 0 ? "+" : ""}${pct.toFixed(2)}% (${newBpm.toFixed(1)} BPM)`);
    }
  };
  pitchSlider.addEventListener("input", applyPitch);
  pitchSlider.addEventListener("dblclick", () => {
    pitchSlider.value = "0";
    applyPitch();
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-beatjump-deck]").forEach(btn => {
  btn.addEventListener("click", async () => {
    await mixer.ctx.resume();
    const slot = Number(btn.dataset.beatjumpDeck) as 0 | 1;
    const beats = parseInt(btn.dataset.beats || "4", 10);
    if (!slots[slot]) return toast(`Load a track into Deck ${slot === 0 ? "A" : "B"} first`);
    const newOff = mixer.beatJump(slot, beats);
    const bars = beats / 4;
    toast(`Deck ${slot === 0 ? "A" : "B"} Beat Jump ${bars > 0 ? `+${bars}` : bars}B -> ${fmt(newOff)}`);
  });
});

// 4B. Quantized Hot Cues (Click = Jump, Shift+Click / Right-Click = Set at Current Playhead) & Beat Loops
document.querySelectorAll<HTMLButtonElement>(".cue-btn").forEach(btn => {
  const handleSetCue = () => {
    const deckIdx = Number(btn.dataset.deck) as 0 | 1;
    const cueKey = btn.dataset.cue as "intro" | "drop" | "breakdown" | "outro";
    const snapped = mixer.setHotCue(deckIdx, cueKey);
    if (snapped === null) return toast("Load a track on this deck first");
    if (slots[deckIdx]?.analysis.cuePoints) {
      slots[deckIdx]!.analysis.cuePoints![cueKey] = snapped;
    }
    updateDeckStaticLabels(deckIdx);
    toast(`Set Deck ${deckIdx === 0 ? "A" : "B"} ${cueKey.toUpperCase()} Cue at ${fmt(snapped)}`);
  };

  btn.addEventListener("contextmenu", e => {
    e.preventDefault();
    handleSetCue();
  });

  btn.addEventListener("click", async e => {
    await mixer.ctx.resume();
    if (e.shiftKey) {
      handleSetCue();
      return;
    }
    const deckIdx = Number(btn.dataset.deck) as 0 | 1;
    const cueKey = btn.dataset.cue as "intro" | "drop" | "breakdown" | "outro";
    const meta = slots[deckIdx];
    if (!meta?.analysis.cuePoints) return toast("Load a track on this deck first");
    const targetSec = meta.analysis.cuePoints[cueKey];
    mixer.seekDeck(deckIdx, targetSec);
    toast(`Deck ${deckIdx === 0 ? "A" : "B"} jumped to ${cueKey.toUpperCase()} (${fmt(targetSec)})`);
  });
});

document.querySelectorAll<HTMLButtonElement>(".loop-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const deckIdx = Number(btn.dataset.deck) as 0 | 1;
    const bars = parseFloat(btn.dataset.bars || "0");
    const d = mixer.decks[deckIdx];
    if (!d.buffer) return toast("Load a track on this deck first");
    d.setLoop(bars);
    updateLoopButtons(deckIdx);
    toast(
      d.loopBars > 0
        ? `Deck ${deckIdx === 0 ? "A" : "B"} locked in ${d.loopBars}-bar loop`
        : `Deck ${deckIdx === 0 ? "A" : "B"} loop released`
    );
  });
});

document.querySelectorAll<HTMLButtonElement>(".loop-op-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    const deckIdx = Number(btn.dataset.deck) as 0 | 1;
    const op = btn.dataset.loopOp;
    const d = mixer.decks[deckIdx];
    if (!d.buffer) return toast("Load a track on this deck first");
    if (op === "halve") d.halveLoop();
    else d.doubleLoop();
    updateLoopButtons(deckIdx);
    toast(`Deck ${deckIdx === 0 ? "A" : "B"} loop roll: ${d.loopBars} bars`);
  });
});

function updateLoopButtons(deckIdx: 0 | 1) {
  const activeBars = mixer.decks[deckIdx].loopBars;
  document
    .querySelectorAll<HTMLButtonElement>(`.loop-btn[data-deck="${deckIdx}"]`)
    .forEach(b => {
      const bars = parseFloat(b.dataset.bars || "0");
      b.classList.toggle("active", activeBars === bars);
    });
  $(deckIdx === 0 ? "loopStatusA" : "loopStatusB").textContent =
    activeBars > 0 ? `${activeBars}B ACTIVE` : "OFF";
}

// 5. 3-Band Isolator EQ, Kill Switches, Channel Volume Faders, Color Filter & Crossfader Controls
document.querySelectorAll<HTMLInputElement>("[data-eq-deck]").forEach(input => {
  const updateEq = () => {
    const deckIdx = Number(input.dataset.eqDeck) as 0 | 1;
    const band = input.dataset.eqBand as "low" | "mid" | "high";
    const db = parseFloat(input.value);
    mixer.decks[deckIdx].setEq(band, db);
    const labelId = `eqVal${deckIdx === 0 ? "A" : "B"}${band.charAt(0).toUpperCase() + band.slice(1)}`;
    $(labelId).textContent = `${db > 0 ? "+" : ""}${db.toFixed(0)}dB`;
  };
  input.addEventListener("input", updateEq);
  input.addEventListener("dblclick", () => {
    input.value = "0";
    updateEq();
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-kill-deck]").forEach(btn => {
  btn.addEventListener("click", () => {
    const deckIdx = Number(btn.dataset.killDeck) as 0 | 1;
    const band = btn.dataset.killBand as "low" | "mid" | "high";
    const killed = mixer.decks[deckIdx].toggleEqKill(band);
    btn.classList.toggle("active", killed);
    toast(`Deck ${deckIdx === 0 ? "A" : "B"} ${band.toUpperCase()} EQ ${killed ? "KILLED (-48dB)" : "Restored"}`);
  });
});

([0, 1] as const).forEach(slot => {
  const prefix = slot === 0 ? "A" : "B";
  const input = $<HTMLInputElement>(`chanVol${prefix}`);
  input.addEventListener("input", () => {
    const v = parseFloat(input.value || "1");
    mixer.setDeckChannelVolume(slot, v);
    $(`chanVolVal${prefix}`).textContent = `${Math.round(v * 100)}%`;
  });
  input.addEventListener("dblclick", () => {
    input.value = "1";
    mixer.setDeckChannelVolume(slot, 1);
    $(`chanVolVal${prefix}`).textContent = "100%";
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-cf-curve]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll<HTMLButtonElement>("[data-cf-curve]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    const curve = (btn.dataset.cfCurve as CrossfaderCurve) || "blend";
    mixer.setCrossfaderCurve(curve);
    toast(
      curve === "cut"
        ? "Crossfader Curve: Turntablist Sharp Cut (12% edge)"
        : curve === "dip"
          ? "Crossfader Curve: Linear Club Dip"
          : "Crossfader Curve: Constant-Power Smooth Blend"
    );
  });
});

document.querySelectorAll<HTMLInputElement>("[data-color-deck]").forEach(input => {
  const updateColor = () => {
    const deckIdx = Number(input.dataset.colorDeck) as 0 | 1;
    const val = parseFloat(input.value);
    mixer.decks[deckIdx].setColorFilter(val);
    const label = $(deckIdx === 0 ? "colorValA" : "colorValB");
    if (Math.abs(val) < 0.05) label.textContent = "FLAT";
    else if (val < 0) label.textContent = `LP ${Math.round((1 + val) * 100)}%`;
    else label.textContent = `HP ${Math.round(val * 100)}%`;
  };
  input.addEventListener("input", updateColor);
  input.addEventListener("dblclick", () => {
    input.value = "0";
    updateColor();
  });
});

const crossfaderInput = $<HTMLInputElement>("crossfaderInput");
crossfaderInput.addEventListener("input", () => {
  mixer.setCrossfader(parseFloat(crossfaderInput.value));
});
crossfaderInput.addEventListener("dblclick", () => {
  crossfaderInput.value = "0";
  mixer.setCrossfader(0);
  toast("Crossfader centered (Both Deck A & Deck B live)");
});

// Club FX One-Shot Keys
document.querySelectorAll<HTMLButtonElement>("[data-fx]").forEach(btn => {
  btn.addEventListener("click", async () => {
    await mixer.ctx.resume();
    const fx = btn.dataset.fx as "dub-siren" | "sub-drop" | "laser-riser" | "vinyl-brake";
    mixer.triggerClubFX(fx);
    toast(`Triggered FX: ${btn.title || btn.textContent}`);
  });
});

// 5B. Hardware Web MIDI Controller Engine & Interactive MIDI Learn Matrix
let selectedMidiCategory = "all";

const midiEngine = new MidiControllerEngine({
  onCrossfader: pos => {
    mixer.setCrossfader(pos);
    crossfaderInput.value = pos.toFixed(2);
  },
  onChannelVolume: (deck, val01) => {
    mixer.setDeckChannelVolume(deck, val01);
    const prefix = deck === 0 ? "A" : "B";
    $<HTMLInputElement>(`chanVol${prefix}`).value = val01.toFixed(2);
    $(`chanVolVal${prefix}`).textContent = `${Math.round(val01 * 100)}%`;
  },
  onEq: (deck, band, db) => {
    mixer.decks[deck].setEq(band, db);
    const prefix = deck === 0 ? "A" : "B";
    const input = document.querySelector<HTMLInputElement>(
      `[data-eq-deck="${deck}"][data-eq-band="${band}"]`
    );
    if (input) input.value = String(db);
    const labelId = `eqVal${prefix}${band.charAt(0).toUpperCase() + band.slice(1)}`;
    $(labelId).textContent = `${db > 0 ? "+" : ""}${db.toFixed(0)}dB`;
  },
  onEqKill: (deck, band) => {
    const killed = mixer.decks[deck].toggleEqKill(band);
    const btn = document.querySelector<HTMLButtonElement>(
      `[data-kill-deck="${deck}"][data-kill-band="${band}"]`
    );
    if (btn) btn.classList.toggle("active", killed);
    const killId = `kill${band.charAt(0).toUpperCase() + band.slice(1)}${deck === 0 ? "A" : "B"}` as MidiControlId;
    midiEngine.sendControlLed(killId, killed);
    toast(`MIDI Deck ${deck === 0 ? "A" : "B"} ${band.toUpperCase()} EQ ${killed ? "KILLED (-48dB)" : "Restored"}`);
  },
  onColorFilter: (deck, val) => {
    mixer.decks[deck].setColorFilter(val);
    const input = document.querySelector<HTMLInputElement>(`[data-color-deck="${deck}"]`);
    if (input) input.value = val.toFixed(2);
    const label = $(deck === 0 ? "colorValA" : "colorValB");
    if (Math.abs(val) < 0.05) label.textContent = "FLAT";
    else if (val < 0) label.textContent = `LP ${Math.round((1 + val) * 100)}%`;
    else label.textContent = `HP ${Math.round(val * 100)}%`;
  },
  onPitchPct: (deck, pct) => {
    const newBpm = mixer.setDeckPitchPct(deck, pct);
    const prefix = deck === 0 ? "A" : "B";
    $<HTMLInputElement>(`pitchSlider${prefix}`).value = String(pct);
    $(`pitchVal${prefix}`).textContent = `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
    if (newBpm > 0) {
      $(`waveLabel${prefix}`).textContent = `${slots[deck]?.name ?? "Track"} (${newBpm.toFixed(0)} BPM)`;
    }
  },
  onSeekNormalized: (deck, ratio01) => {
    const d = mixer.decks[deck];
    if (!d.buffer) return;
    const targetSec = ratio01 * d.buffer.duration;
    mixer.seekDeckContinuous(deck, targetSec);
  },
  onJogNudge: (deck, deltaSec, deltaDeg) => {
    platterAngles[deck] = (platterAngles[deck] + deltaDeg) % 360;
    mixer.nudgePlayhead(deck, deltaSec);
  },
  onBeatJump: (deck, deltaBeats) => {
    const newSec = mixer.beatJump(deck, deltaBeats);
    const sign = deltaBeats > 0 ? "+" : "";
    toast(`MIDI Deck ${deck === 0 ? "A" : "B"} Beatjump ${sign}${deltaBeats} Beats -> ${fmt(newSec)}`);
  },
  onPlatterTouch: (deck, touched) => {
    void mixer.ctx.resume();
    if (touched) {
      mixer.startManualScratch(deck);
    } else {
      const res = mixer.endManualScratch();
      if (res?.spliced) {
        toast(`MIDI Jog scratch spliced into Deck ${res.deck === 0 ? "A" : "B"} @ ${fmt(res.playheadSec)}`);
      }
    }
  },
  onJogScratchVelocity: (deck, velocity, deltaDeg) => {
    platterAngles[deck] = (platterAngles[deck] + deltaDeg) % 360;
    mixer.moveManualScratch(velocity);
  },
  onPlayToggle: deck => {
    void mixer.ctx.resume().then(() => {
      if (!slots[deck]) return;
      const nowPlaying = mixer.toggleDeckPlay(deck);
      if (nowPlaying && !sessionStartedAtMs) sessionStartedAtMs = Date.now();
      midiEngine.sendControlLed(deck === 0 ? "playA" : "playB", nowPlaying);
      void syncWakeLock();
      toast(`MIDI Deck ${deck === 0 ? "A" : "B"} ${nowPlaying ? "Playing" : "Paused"}`);
    });
  },
  onSyncDeck: deck => {
    if (!slots[deck]) return;
    const res = mixer.syncDeck(deck);
    syncPitchSlidersFromDecks();
    toast(`MIDI Deck ${deck === 0 ? "A" : "B"} Synced to ${res.syncedBpm.toFixed(1)} BPM`);
  },
  onPflToggle: deck => {
    const btn = $<HTMLButtonElement>(deck === 0 ? "cueListenA" : "cueListenB");
    btn.click();
    midiEngine.sendControlLed(deck === 0 ? "pflA" : "pflB", mixer.auditioningSlot === deck);
  },
  onLoopAction: (deck, action) => {
    const d = mixer.decks[deck];
    if (!d.buffer) return;
    if (action === "toggle") {
      d.setLoop(d.loopBars > 0 ? 0 : 4);
    } else if (action === "halve") {
      d.halveLoop();
    } else {
      d.doubleLoop();
    }
    updateLoopButtons(deck);
    midiEngine.sendControlLed(deck === 0 ? "loopToggleA" : "loopToggleB", d.loopBars > 0);
    toast(
      d.loopBars > 0
        ? `MIDI Deck ${deck === 0 ? "A" : "B"} Loop: ${d.loopBars}B`
        : `MIDI Deck ${deck === 0 ? "A" : "B"} Loop Released`
    );
  },
  onClubFx: fx => {
    void mixer.ctx.resume();
    mixer.triggerClubFX(fx);
    toast(`MIDI Club FX: ${fx.toUpperCase()}`);
  },
  onHotCue: (deck, cue) => {
    void mixer.ctx.resume();
    const meta = slots[deck];
    if (!meta?.analysis.cuePoints) return;
    const targetSec = meta.analysis.cuePoints[cue];
    mixer.seekDeck(deck, targetSec);
    toast(`MIDI Deck ${deck === 0 ? "A" : "B"} -> ${cue.toUpperCase()} (${fmt(targetSec)})`);
  },
  onScratchPad: patternId => {
    void mixer.ctx.resume();
    const res = mixer.triggerAutoscratch(patternId);
    if (res.ok) toast(`MIDI Pad: ${res.message}`);
  },
  on16PadHit: padIndex => {
    void execute16PadAction(padIndex);
  },
  onDrop90sAgent: () => {
    void trigger90sScratchAgent(false);
  },
  onSmartMix: () => {
    pad.click();
  },
  onStateChange: () => {
    renderMidiUi();
  },
  onLearned: binding => {
    toast(`MIDI Learned: ${binding.label} -> CH${binding.channel + 1} ${binding.kind.toUpperCase()}#${binding.number}`);
  },
  onMidiActivity: summary => {
    $("midiMonitorReadout").textContent = summary;
  },
});

function formatMidiAssignment(b: { kind: string; channel: number; number: number }): string {
  const ch = b.channel < 0 ? "ANY" : `CH${b.channel + 1}`;
  const kind =
    b.kind === "cc"
      ? `CC#${b.number}`
      : b.kind === "pitchbend"
        ? "PITCHBEND"
        : `NOTE#${b.number}`;
  return `${ch} ${kind}`;
}

function renderMidiUi() {
  const connectBtn = $<HTMLButtonElement>("midiConnectBtn");
  const connectLabel = $("midiConnectLabel");
  const devReadout = $("midiDevicesReadout");
  const summaryEl = $("midiDrawerSummary");
  const grid = $("midiMappingGrid");

  const nDevs = midiEngine.connectedInputs.length;
  connectBtn.setAttribute("aria-pressed", String(midiEngine.accessGranted));
  if (midiEngine.learningControlId) {
    connectLabel.textContent = "MIDI: LEARN";
  } else if (nDevs > 0) {
    connectLabel.textContent = `MIDI: ${nDevs} DECK${nDevs === 1 ? "" : "S"}`;
  } else if (midiEngine.accessGranted) {
    connectLabel.textContent = "MIDI: ARMED";
  } else {
    connectLabel.textContent = "MIDI: Standby";
  }

  devReadout.textContent =
    nDevs > 0
      ? `DEVICES (${nDevs}): ${midiEngine.connectedInputs.join(" · ").toUpperCase()}`
      : midiEngine.accessGranted
        ? "DEVICES: 0 PLUGGED IN (WEB MIDI ARMED)"
        : "DEVICES: CLICK CONNECT MIDI";

  summaryEl.textContent =
    nDevs > 0
      ? `WEB MIDI LIVE (${nDevs} CONTROLLER${nDevs === 1 ? "" : "S"} · CLICK ANY CONTROL TO LEARN)`
      : "HARDWARE WEB MIDI CONTROLLER & LEARN MATRIX";

  document.querySelectorAll<HTMLButtonElement>("[data-midi-profile]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.midiProfile === midiEngine.activeProfile);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-midi-jog-mode]").forEach(btn => {
    btn.classList.toggle("active", btn.dataset.midiJogMode === midiEngine.jogWheelMode);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-midi-jog-sens]").forEach(btn => {
    btn.classList.toggle(
      "active",
      Math.abs(parseFloat(btn.dataset.midiJogSens || "1.0") - midiEngine.jogSensitivity) < 0.05
    );
  });
  const pickupBtn = $<HTMLButtonElement>("midiSoftTakeoverBtn");
  pickupBtn.classList.toggle("active", midiEngine.softTakeoverEnabled);
  pickupBtn.setAttribute("aria-pressed", String(midiEngine.softTakeoverEnabled));
  pickupBtn.textContent = `PICKUP: ${midiEngine.softTakeoverEnabled ? "ON" : "OFF"}`;

  const clockBtn = $<HTMLButtonElement>("midiClockOutBtn");
  clockBtn.classList.toggle("active", midiEngine.midiClockOutEnabled);
  clockBtn.setAttribute("aria-pressed", String(midiEngine.midiClockOutEnabled));
  clockBtn.textContent = `24PPQN CLK: ${midiEngine.midiClockOutEnabled ? "ON" : "OFF"}`;

  grid.replaceChildren();
  const visible = midiEngine.bindings.filter(
    b => selectedMidiCategory === "all" || b.category === selectedMidiCategory
  );
  for (const b of visible) {
    const row = document.createElement("button");
    row.type = "button";
    const isLearning = midiEngine.learningControlId === b.controlId;
    row.className = `midi-map-row ${isLearning ? "learning" : ""}`;
    row.title = isLearning
      ? "Move any physical knob, fader, jog wheel, or pad on your MIDI controller now (or click again to cancel)"
      : `Click to arm MIDI Learn for ${b.label}`;

    const lbl = document.createElement("span");
    lbl.className = "midi-map-label";
    lbl.textContent = b.label;

    const code = document.createElement("span");
    code.className = "midi-map-code";
    code.textContent = isLearning ? "MOVE MIDI..." : formatMidiAssignment(b);

    row.append(lbl, code);
    row.addEventListener("click", async () => {
      if (!midiEngine.accessGranted && midiEngine.supported) {
        await midiEngine.connect();
      }
      midiEngine.armLearn(b.controlId);
    });
    grid.append(row);
  }
}

async function handleConnectMidiClick() {
  const drawer = $<HTMLDetailsElement>("midiControllerDrawer");
  drawer.open = true;
  const res = await midiEngine.connect();
  renderMidiUi();
  toast(res.message);
}

$("midiConnectBtn").addEventListener("click", () => void handleConnectMidiClick());
$("midiScanBtn").addEventListener("click", () => void handleConnectMidiClick());
$("midiResetMapBtn").addEventListener("click", () => {
  midiEngine.resetDefaultBindings();
  toast("Restored default Pioneer DDJ hardware controller MIDI mappings");
});

type Pad16Mode = "transitions" | "fx" | "scratches" | "hotcues";
let active16PadMode: Pad16Mode = "transitions";

interface Pad16Config {
  label: string;
  sub: string;
  color: string;
  action: () => void | Promise<void>;
}

function get16PadsConfig(): Pad16Config[] {
  if (active16PadMode === "transitions") {
    return [
      { label: "1B BLEND", sub: "Power", color: "#f59e0b", action: () => { const r = mixer.next({ id: "blend-1b", name: "1B Power Blend", bars: 1, curve: "equal-power", style: "blend" }); if (r.ok) toast("🔀 Pad 1: 1B Power Blend Triggered"); } },
      { label: "2B BLEND", sub: "Club", color: "#f59e0b", action: () => { const r = mixer.next({ id: "blend-2b", name: "2B Power Blend", bars: 2, curve: "equal-power", style: "blend" }); if (r.ok) toast("🔀 Pad 2: 2B Club Blend Triggered"); } },
      { label: "4B BLEND", sub: "Extended", color: "#f59e0b", action: () => { const r = mixer.next({ id: "blend-4b", name: "4B Deep Blend", bars: 4, curve: "equal-power", style: "blend" }); if (r.ok) toast("🔀 Pad 3: 4B Extended Blend Triggered"); } },
      { label: "8B BLEND", sub: "Marathon", color: "#f59e0b", action: () => { const r = mixer.next({ id: "blend-8b", name: "8B Epic Blend", bars: 8, curve: "equal-power", style: "blend" }); if (r.ok) toast("🔀 Pad 4: 8B Epic Blend Triggered"); } },
      { label: "1B BASS SWAP", sub: "Drop", color: "#fbbf24", action: () => { const r = mixer.next({ id: "bass-swap-1b", name: "1B Bass Swap", bars: 1, curve: "equal-power", style: "bass-swap" }); if (r.ok) toast("🔀 Pad 5: 1B Bass Swap Triggered"); } },
      { label: "2B BASS SWAP", sub: "Smooth", color: "#fbbf24", action: () => { const r = mixer.next({ id: "bass-swap-2b", name: "2B Bass Swap", bars: 2, curve: "equal-power", style: "bass-swap" }); if (r.ok) toast("🔀 Pad 6: 2B Bass Swap Triggered"); } },
      { label: "4B RISER", sub: "Filter", color: "#38bdf8", action: () => { const r = mixer.next({ id: "filter-riser-4b", name: "4B Filter Riser", bars: 4, curve: "equal-power", style: "filter-riser" }); if (r.ok) toast("🔀 Pad 7: 4B Filter Riser Triggered"); } },
      { label: "8B RISER", sub: "Build", color: "#38bdf8", action: () => { const r = mixer.next({ id: "filter-riser-8b", name: "8B Filter Riser", bars: 8, curve: "equal-power", style: "filter-riser" }); if (r.ok) toast("🔀 Pad 8: 8B Filter Riser Triggered"); } },
      { label: "VINYL BRAKE", sub: "Motor Stop", color: "#ef4444", action: () => { const r = mixer.next({ id: "vinyl-brake", name: "Vinyl Brake", bars: 1, curve: "equal-power", style: "vinyl-brake" }); if (r.ok) toast("🔀 Pad 9: Vinyl Brake Transition Triggered"); } },
      { label: "BACKSPIN", sub: "Rewind", color: "#c084fc", action: () => { const r = mixer.next({ id: "backspin", name: "Backspin", bars: 1, curve: "equal-power", style: "backspin" }); if (r.ok) toast("🔀 Pad 10: Backspin Transition Triggered"); } },
      { label: "ECHO OUT", sub: "Delay Tail", color: "#34d399", action: () => { const r = mixer.next({ id: "echo-out", name: "Echo Out", bars: 2, curve: "equal-power", style: "echo-out" }); if (r.ok) toast("🔀 Pad 11: Echo Out Transition Triggered"); } },
      { label: "DROP CUT", sub: "Instant", color: "#f43f5e", action: () => { const r = mixer.next({ id: "drop-cut", name: "Drop Cut", bars: 0.5, curve: "equal-power", style: "drop-cut" }); if (r.ok) toast("🔀 Pad 12: Instant Drop Cut Triggered"); } },
      { label: "SPIN WHIP", sub: "Flange", color: "#a855f7", action: () => { const r = mixer.next({ id: "spin-whip", name: "Spin Whip", bars: 1, curve: "equal-power", style: "spin-whip" }); if (r.ok) toast("🔀 Pad 13: Spin Whip Transition Triggered"); } },
      { label: "REVERB TAIL", sub: "Spill", color: "#22c55e", action: () => { const r = mixer.next({ id: "reverb-tail", name: "Reverb Tail", bars: 2, curve: "equal-power", style: "echo-out" }); if (r.ok) toast("🔀 Pad 14: Reverb Tail Slam Triggered"); } },
      { label: "1/2B SLAM", sub: "Quick Cut", color: "#f97316", action: () => { const r = mixer.next({ id: "slam-cut", name: "1/2B Slam Cut", bars: 0.5, curve: "equal-power", style: "drop-cut" }); if (r.ok) toast("🔀 Pad 15: 1/2-Bar Slam Cut Triggered"); } },
      { label: "REV CROSS", sub: "Crossover", color: "#e11d48", action: () => { const r = mixer.next({ id: "reverse-crossover", name: "Reverse Crossover", bars: 1, curve: "equal-power", style: "bass-swap" }); if (r.ok) toast("🔀 Pad 16: Reverse Crossover Triggered"); } },
    ];
  } else if (active16PadMode === "fx") {
    return [
      { label: "DUB SIREN", sub: "Reggae", color: "#38bdf8", action: () => { mixer.triggerClubFX("dub-siren"); toast("🔊 Pad 1: Dub Siren FX"); } },
      { label: "808 DROP", sub: "Sub Bass", color: "#38bdf8", action: () => { mixer.triggerClubFX("sub-drop"); toast("🔊 Pad 2: 808 Sub Drop"); } },
      { label: "LASER RISER", sub: "Swoosh", color: "#38bdf8", action: () => { mixer.triggerClubFX("laser-riser"); toast("🔊 Pad 3: Laser Riser FX"); } },
      { label: "VINYL BRAKE", sub: "Stop", color: "#ef4444", action: () => { mixer.triggerClubFX("vinyl-brake"); toast("🔊 Pad 4: Vinyl Brake FX"); } },
      { label: "STUTTER A", sub: "1/16 Roll", color: "#f59e0b", action: () => { mixer.triggerStutterRoll(0, 0.25); toast("🔊 Pad 5: Deck A 1/16 Stutter Roll"); } },
      { label: "STUTTER B", sub: "1/16 Roll", color: "#38bdf8", action: () => { mixer.triggerStutterRoll(1, 0.25); toast("🔊 Pad 6: Deck B 1/16 Stutter Roll"); } },
      { label: "HPF SWEEP A", sub: "Hi-Pass", color: "#f59e0b", action: () => { mixer.decks[0].setColorFilter(0.85); setTimeout(()=>mixer.decks[0].setColorFilter(0), 1200); toast("🔊 Pad 7: Deck A High-Pass Sweep"); } },
      { label: "HPF SWEEP B", sub: "Hi-Pass", color: "#38bdf8", action: () => { mixer.decks[1].setColorFilter(0.85); setTimeout(()=>mixer.decks[1].setColorFilter(0), 1200); toast("🔊 Pad 8: Deck B High-Pass Sweep"); } },
      { label: "LPF SWEEP A", sub: "Low-Pass", color: "#f59e0b", action: () => { mixer.decks[0].setColorFilter(-0.85); setTimeout(()=>mixer.decks[0].setColorFilter(0), 1200); toast("🔊 Pad 9: Deck A Low-Pass Sweep"); } },
      { label: "LPF SWEEP B", sub: "Low-Pass", color: "#38bdf8", action: () => { mixer.decks[1].setColorFilter(-0.85); setTimeout(()=>mixer.decks[1].setColorFilter(0), 1200); toast("🔊 Pad 10: Deck B Low-Pass Sweep"); } },
      { label: "GATER 1/8", sub: "Trance", color: "#34d399", action: () => { mixer.triggerGaterEffect(0.5); toast("🔊 Pad 11: 1/8 Gater Pulse"); } },
      { label: "PING PONG", sub: "Echo", color: "#a855f7", action: () => { mixer.triggerClubFX("laser-riser"); toast("🔊 Pad 12: Ping-Pong Delay"); } },
      { label: "REVERB TAIL", sub: "Splash", color: "#22c55e", action: () => { mixer.triggerClubFX("sub-drop"); toast("🔊 Pad 13: Reverb Splash"); } },
      { label: "BITCRUSH", sub: "8-Bit", color: "#f43f5e", action: () => { mixer.triggerClubFX("dub-siren"); toast("🔊 Pad 14: Bitcrush Crush"); } },
      { label: "PITCH SLIDE", sub: "Riser", color: "#fbbf24", action: () => { mixer.triggerClubFX("laser-riser"); toast("🔊 Pad 15: Pitch Riser Slide"); } },
      { label: "AIRHORN", sub: "Sample", color: "#e11d48", action: () => { radio.triggerJingle(); toast("🔊 Pad 16: Station Airhorn / Jingle"); } },
    ];
  } else if (active16PadMode === "scratches") {
    return SCRATCH_PATTERNS.slice(0, 8).map((pat, idx) => ({
      label: pat.name.toUpperCase(),
      sub: `${(pat.beats / 4).toFixed(0)}B / ${pat.subtitle}`,
      color: "#22c55e",
      action: () => {
        const res = mixer.triggerAutoscratch(pat.id);
        if (res.ok) toast(`🎛️ Pad ${idx + 1}: Scratch ${pat.name}`);
      },
    })).concat([
      { label: "90s ROUTINE", sub: "Agent Cut", color: "#f59e0b", action: () => { void trigger90sScratchAgent(false); toast("🎛️ Pad 9: 90s Scratch Agent Routine Triggered"); } },
      { label: "'FRESH!' CUT", sub: "Vocal", color: "#22c55e", action: () => { mixer.triggerScratchPad("chirp"); toast("🎛️ Pad 10: 'Fresh!' Chirp Scratch"); } },
      { label: "'AHHH!' CUT", sub: "Vocal", color: "#22c55e", action: () => { mixer.triggerScratchPad("transformer"); toast("🎛️ Pad 11: 'Ahhh!' Transformer Cut"); } },
      { label: "LASER STAB", sub: "Battle", color: "#38bdf8", action: () => { mixer.triggerScratchPad("uzis"); toast("🎛️ Pad 12: Laser Stutter Scratch"); } },
      { label: "HORN STAB", sub: "Shred", color: "#fbbf24", action: () => { mixer.triggerScratchPad("crab"); toast("🎛️ Pad 13: 4-Finger Crab Scratch"); } },
      { label: "TEAR DRAG", sub: "Heavy", color: "#c084fc", action: () => { mixer.triggerScratchPad("tear"); toast("🎛️ Pad 14: Tear Drag Scratch"); } },
      { label: "ORBIT FLARE", sub: "3-Click", color: "#34d399", action: () => { mixer.triggerScratchPad("flare"); toast("🎛️ Pad 15: Orbit Flare Scratch"); } },
      { label: "REWIND FX", sub: "Backspin", color: "#ef4444", action: () => { mixer.triggerScratchPad("backspin"); toast("🎛️ Pad 16: Backspin Rewind Scratch"); } },
    ]);
  } else {
    // hotcues Mode
    const cues = ["intro", "drop", "breakdown", "outro"] as const;
    const labels = ["INTRO", "DROP", "BREAK", "OUTRO"];
    return [
      ...cues.map((c, i) => ({
        label: `CUE A: ${labels[i]}`,
        sub: "Deck A",
        color: "#f59e0b",
        action: () => {
          if (slots[0]?.analysis.cuePoints) {
            mixer.seekDeck(0, slots[0].analysis.cuePoints[c]);
            toast(`🔥 Pad ${i + 1}: Deck A Hot Cue ${labels[i]}`);
          } else toast("Load track into Deck A first");
        },
      })),
      ...cues.map((c, i) => ({
        label: `CUE B: ${labels[i]}`,
        sub: "Deck B",
        color: "#38bdf8",
        action: () => {
          if (slots[1]?.analysis.cuePoints) {
            mixer.seekDeck(1, slots[1].analysis.cuePoints[c]);
            toast(`🔥 Pad ${i + 5}: Deck B Hot Cue ${labels[i]}`);
          } else toast("Load track into Deck B first");
        },
      })),
      { label: "LOOP A 1B", sub: "Auto-Loop", color: "#f59e0b", action: () => { mixer.decks[0].setLoop(1); updateLoopButtons(0); toast("🔥 Pad 9: Deck A 1-Bar Loop"); } },
      { label: "LOOP A 4B", sub: "Auto-Loop", color: "#f59e0b", action: () => { mixer.decks[0].setLoop(4); updateLoopButtons(0); toast("🔥 Pad 10: Deck A 4-Bar Loop"); } },
      { label: "JUMP A -4B", sub: "Beatjump", color: "#f59e0b", action: () => { mixer.beatJump(0, -4); toast("🔥 Pad 11: Deck A Beatjump -4B"); } },
      { label: "JUMP A +4B", sub: "Beatjump", color: "#f59e0b", action: () => { mixer.beatJump(0, 4); toast("🔥 Pad 12: Deck A Beatjump +4B"); } },
      { label: "LOOP B 1B", sub: "Auto-Loop", color: "#38bdf8", action: () => { mixer.decks[1].setLoop(1); updateLoopButtons(1); toast("🔥 Pad 13: Deck B 1-Bar Loop"); } },
      { label: "LOOP B 4B", sub: "Auto-Loop", color: "#38bdf8", action: () => { mixer.decks[1].setLoop(4); updateLoopButtons(1); toast("🔥 Pad 14: Deck B 4-Bar Loop"); } },
      { label: "JUMP B -4B", sub: "Beatjump", color: "#38bdf8", action: () => { mixer.beatJump(1, -4); toast("🔥 Pad 15: Deck B Beatjump -4B"); } },
      { label: "JUMP B +4B", sub: "Beatjump", color: "#38bdf8", action: () => { mixer.beatJump(1, 4); toast("🔥 Pad 16: Deck B Beatjump +4B"); } },
    ];
  }
}

async function execute16PadAction(padIndex: number) {
  if (padIndex < 0 || padIndex >= 16) return;
  await mixer.ctx.resume();
  const cfg = get16PadsConfig();
  const target = cfg[padIndex];
  if (!target) return;

  const mainPadEl = document.querySelector<HTMLElement>(`.matrix-pad-16[data-pad-idx="${padIndex}"]`);
  if (mainPadEl) {
    mainPadEl.classList.add("hit");
    setTimeout(() => mainPadEl.classList.remove("hit"), 180);
  }

  const mpdPadEl = document.querySelector<HTMLElement>(`.mpd226-pad-item[data-mpd-pad="${padIndex + 1}"]`);
  if (mpdPadEl) {
    mpdPadEl.classList.add("hit");
    setTimeout(() => mpdPadEl.classList.remove("hit"), 180);
  }

  await target.action();
}

function render16PadMatrixUI() {
  const container = $("performancePadsMatrix");
  if (!container) return;
  container.innerHTML = "";
  const cfg = get16PadsConfig();

  cfg.forEach((pad, idx) => {
    const el = document.createElement("button");
    el.type = "button";
    el.className = "matrix-pad-16";
    el.dataset.padIdx = String(idx);
    el.style.setProperty("--pad-accent-color", pad.color);
    el.innerHTML = `
      <span class="pad-num-badge">PAD ${idx + 1} · ${pad.sub}</span>
      <span class="pad-action-title" style="color: ${pad.color};">${pad.label}</span>
    `;
    el.onclick = () => void execute16PadAction(idx);
    container.appendChild(el);
  });

  renderMpd226Pads();
}

function renderMpd226Pads() {
  const container = $("mpd226PadsGrid");
  if (!container) return;
  container.innerHTML = "";
  const cfg = get16PadsConfig();

  for (let i = 0; i < 16; i++) {
    const padConfig = cfg[i];
    const pad = document.createElement("div");
    pad.className = "mpd226-pad-item";
    pad.dataset.mpdPad = String(i + 1);
    pad.style.borderColor = padConfig?.color || "#f59e0b";
    pad.innerHTML = `<span class="mpd226-pad-num">PAD ${i + 1}</span><span class="mpd226-pad-tag">${padConfig?.label || `P${i + 1}`}</span>`;
    pad.onclick = () => void execute16PadAction(i);
    container.appendChild(pad);
  }
}

document.querySelectorAll<HTMLButtonElement>(".pad-mode-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll<HTMLButtonElement>(".pad-mode-btn").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    active16PadMode = (btn.dataset.padMode as Pad16Mode) || "transitions";
    render16PadMatrixUI();
    toast(`16-Pad Performance Matrix Mode: ${active16PadMode.toUpperCase()}`);
  });
});

render16PadMatrixUI();

document.querySelectorAll<HTMLButtonElement>("[data-midi-profile]").forEach(btn => {
  btn.addEventListener("click", () => {
    const profile = (btn.dataset.midiProfile as MidiControllerProfileId) || "pioneer-ddj";
    midiEngine.applyControllerProfile(profile);
    const label =
      profile === "pioneer-ddj"
        ? "Pioneer DDJ-400 / FLX4 / SB3"
        : profile === "akai-mpd226"
          ? "Akai MPD226 16 RGB Velocity Pads + 4 Q-Link Faders & Knobs"
          : profile === "numark-hercules"
            ? "Numark Mixtrack / Hercules Inpulse"
            : "Generic Single-Channel USB Knob/Pad Bank";
    renderMidiUi();
    toast(`MIDI Profile loaded: ${label}`);
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-midi-jog-mode]").forEach(btn => {
  btn.addEventListener("click", () => {
    const mode = (btn.dataset.midiJogMode as MidiJogMode) || "vinyl";
    midiEngine.setJogWheelMode(mode);
    toast(
      mode === "vinyl"
        ? "MIDI Jog Mode: Direct Vinyl Scratch (Kaiser-Sinc + M44-7)"
        : "MIDI Jog Mode: Continuous Playhead Nudge (Phase Bend)"
    );
  });
});

document.querySelectorAll<HTMLButtonElement>("[data-midi-jog-sens]").forEach(btn => {
  btn.addEventListener("click", () => {
    const sens = parseFloat(btn.dataset.midiJogSens || "1.0");
    midiEngine.setJogSensitivity(sens);
    toast(`MIDI Jog Sensitivity set to ${sens.toFixed(1)}x`);
  });
});

$("midiSoftTakeoverBtn").addEventListener("click", () => {
  midiEngine.setSoftTakeover(!midiEngine.softTakeoverEnabled);
  toast(
    midiEngine.softTakeoverEnabled
      ? "MIDI Soft-Takeover (Pickup Mode) ON — pots must cross current software value before changing"
      : "MIDI Soft-Takeover OFF — immediate 1:1 pot response"
  );
});

$("midiClockOutBtn").addEventListener("click", () => {
  midiEngine.midiClockOutEnabled = !midiEngine.midiClockOutEnabled;
  renderMidiUi();
  toast(
    midiEngine.midiClockOutEnabled
      ? "24 PPQN MIDI Timing Clock Out (0xF8) ARMED — syncing external hardware to Master BPM"
      : "24 PPQN MIDI Timing Clock Out OFF"
  );
});

$("midiExportJsonBtn").addEventListener("click", () => {
  const json = midiEngine.exportBindingsJson();
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `party_dj_midi_map_${midiEngine.activeProfile}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`Exported MIDI mapping JSON (${midiEngine.bindings.length} controls)`);
});

$<HTMLInputElement>("midiImportJsonInput").addEventListener("change", async e => {
  const input = e.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const res = midiEngine.importBindingsJson(text);
    toast(res.message);
  } finally {
    input.value = "";
  }
});

document.querySelectorAll<HTMLButtonElement>("[data-midi-cat]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll<HTMLButtonElement>("[data-midi-cat]").forEach(b => b.classList.remove("active"));
    btn.classList.add("active");
    selectedMidiCategory = btn.dataset.midiCat || "all";
    renderMidiUi();
  });
});

renderMidiUi();

// 6. Interactive Turntable Platter Drag-to-Scratch
function bindInteractivePlatter(platterId: string, deckIdx: 0 | 1) {
  const el = $(platterId);
  let dragging = false;
  let prevAngle = 0;
  let prevTime = 0;

  const getAngle = (clientX: number, clientY: number) => {
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width * 0.5;
    const cy = rect.top + rect.height * 0.5;
    return Math.atan2(clientY - cy, clientX - cx);
  };

  el.addEventListener("pointerdown", async e => {
    await mixer.ctx.resume();
    dragging = true;
    el.setPointerCapture(e.pointerId);
    prevAngle = getAngle(e.clientX, e.clientY);
    prevTime = performance.now();
    mixer.startManualScratch(deckIdx);
  });

  el.addEventListener("pointermove", e => {
    if (!dragging) return;
    const now = performance.now();
    const dt = Math.max(4, now - prevTime) / 1000;
    const curAngle = getAngle(e.clientX, e.clientY);
    let dTheta = curAngle - prevAngle;
    if (dTheta > Math.PI) dTheta -= 2 * Math.PI;
    if (dTheta < -Math.PI) dTheta += 2 * Math.PI;

    const radPerSec = dTheta / dt;
    const velocity = radPerSec / 3.49;
    platterAngles[deckIdx] += (dTheta * 180) / Math.PI;
    mixer.moveManualScratch(velocity);

    prevAngle = curAngle;
    prevTime = now;
  });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    const res = mixer.endManualScratch();
    if (res?.spliced) {
      toast(
        `Spliced manual platter scratch into Deck ${res.deck === 0 ? "A" : "B"} @ ${fmt(res.playheadSec)}`
      );
    }
  };
  el.addEventListener("pointerup", endDrag);
  el.addEventListener("pointercancel", endDrag);
}
bindInteractivePlatter("platterA", 0);
bindInteractivePlatter("platterB", 1);

// 7. Crate & Queue Management (Concise Hardware Track List with Metadata Matching)
interface MetadataLogEntry {
  id: string;
  timeStr: string;
  name: string;
  relativePath: string;
  sizeFormatted: string;
  specs: string;
  bpm: number;
  key: string;
  keyName: string;
  energyPct: number;
  energyTier: string;
  tags: string[];
  genre: string;
  autoGainDb: number;
  rmsDb: number;
  status: "OK" | "PARSED" | "FAILED";
  durationSec: number;
}

const metadataLogs: MetadataLogEntry[] = [];

function formatFileSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function renderMetadataLog() {
  const tbody = $("metadataLogTableBody");
  if (!tbody) return;
  const countStr = String(metadataLogs.length);
  const countEl1 = $("metadataLogCount");
  const countEl2 = $("metadataLogCountBadge");
  if (countEl1) countEl1.textContent = countStr;
  if (countEl2) countEl2.textContent = countStr;

  if (metadataLogs.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="log-empty">No files uploaded yet this session. Upload folders, bulk audio, or single files above to see full metadata logs.</td></tr>`;
    return;
  }

  tbody.replaceChildren();
  for (const log of metadataLogs) {
    const tr = document.createElement("tr");
    const tierSlug = log.energyTier.toLowerCase().replace(/\s+/g, "-");
    tr.innerHTML = `
      <td class="log-time">${log.timeStr}</td>
      <td class="log-file" title="${log.relativePath}"><strong>${log.name}</strong><br><small class="dim-txt">${log.relativePath}</small></td>
      <td class="log-size">${log.sizeFormatted}</td>
      <td class="log-specs">${log.specs}</td>
      <td class="log-bpm"><strong class="bpm-val">${log.bpm.toFixed(1)}</strong></td>
      <td class="log-key"><span class="key-badge">${log.key}</span> <small class="dim-txt">${log.keyName}</small></td>
      <td class="log-energy"><span class="tier-badge tier-${tierSlug}">${log.energyTier}</span> <strong>${log.energyPct}%</strong></td>
      <td class="log-tags"><span class="genre-badge">${log.genre}</span> ${log.tags.map(t => `<span class="acoustic-tag-chip">${t}</span>`).join(" ")}</td>
      <td class="log-gain">${log.autoGainDb >= 0 ? "+" : ""}${log.autoGainDb.toFixed(1)} dB</td>
      <td class="log-status"><span class="log-status-badge ${log.status === "OK" ? "ok" : "err"}">${log.status}</span></td>
    `;
    tbody.append(tr);
  }
}

// Wire Metadata Log Panel Actions
$("toggleMetadataLogBtn")?.addEventListener("click", () => {
  const panel = $("metadataLogPanel");
  if (!panel) return;
  const isHidden = panel.style.display === "none";
  panel.style.display = isHidden ? "block" : "none";
  if (isHidden) renderMetadataLog();
});

$("closeLogBtn")?.addEventListener("click", () => {
  const panel = $("metadataLogPanel");
  if (panel) panel.style.display = "none";
});

$("clearLogBtn")?.addEventListener("click", () => {
  metadataLogs.length = 0;
  renderMetadataLog();
  toast("Cleared session metadata log");
});

$("exportLogJsonBtn")?.addEventListener("click", () => {
  if (metadataLogs.length === 0) {
    return toast("No metadata log entries to export yet");
  }
  const json = JSON.stringify(metadataLogs, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `party_dj_metadata_log_${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`Exported JSON log (${metadataLogs.length} entries)`);
});

// Category & Column Arrangement Selectors
$<HTMLSelectElement>("crateCategorySelect")?.addEventListener("change", e => {
  const val = (e.target as HTMLSelectElement).value;
  crateActiveQuickFilter = val;
  renderCrateList();
});

$<HTMLSelectElement>("crateColConfig")?.addEventListener("change", e => {
  const val = (e.target as HTMLSelectElement).value;
  const table = $("crateTable");
  if (!table) return;
  table.classList.remove("cols-compact", "cols-performance");
  if (val === "compact") table.classList.add("cols-compact");
  else if (val === "performance") table.classList.add("cols-performance");
  toast(`Crate column layout: ${val.toUpperCase()}`);
});

// Table Header Click-to-Sort Listeners
document.querySelectorAll<HTMLElement>(".crate-table th.sortable").forEach(th => {
  th.addEventListener("click", () => {
    const col = th.dataset.sort;
    if (!col) return;
    if (col === "title") {
      crateSortBy = "title";
    } else if (col === "bpm") {
      crateSortBy = crateSortBy === "bpm-asc" ? "bpm-desc" : "bpm-asc";
    } else if (col === "key") {
      crateSortBy = "key";
    } else if (col === "match") {
      crateSortBy = "smart";
    } else if (col === "energy") {
      crateSortBy = crateSortBy === "energy-desc" ? "energy-asc" : "energy-desc";
    } else if (col === "genre") {
      crateSortBy = "smart";
    } else if (col === "time") {
      crateSortBy = "recent";
    }
    const select = $<HTMLSelectElement>("crateSortSelect");
    if (select) select.value = crateSortBy || "smart";
    renderCrateList();
  });
});

async function loadTrackIntoDeck(slot: 0 | 1, item: CrateTrack) {
  if (mixer.playing && slot === mixer.active && !mixer.busy) {
    return toast(`Deck ${slot === 0 ? "A" : "B"} is live on air. Load into Deck ${slot === 0 ? "B" : "A"}.`);
  }
  try {
    let analysis = item.analysis;
    if (item.buffer) {
      analysis = mixer.loadBuffer(slot, item.buffer, item.analysis);
    } else if (item.file) {
      analysis = await mixer.loadFile(slot, item.file);
      item.analysis = analysis;
      item.buffer = mixer.decks[slot].buffer;
    }
    slots[slot] = {
      id: item.id,
      name: item.name,
      artist: item.artist,
      genre: item.genre,
      analysis,
    };
    // Automatically pre-sync incoming deck BPM to the active Master Deck so no manual SYNC click is needed
    if (slot === mixer.idle && slots[mixer.active]) {
      mixer.syncDeck(slot);
      syncPitchSlidersFromDecks();
    }
    updateDeckStaticLabels(slot);
    renderCrateList();
    if (slot === mixer.active) {
      void autoStageScratchRoutine();
    }
  } catch {
    toast(`Couldn't decode ${item.name}. Try MP3, WAV, FLAC, or M4A.`);
  }
}

function updateDeckStaticLabels(slot: 0 | 1) {
  const m = slots[slot];
  const prefix = slot === 0 ? "A" : "B";
  if (!m) return;
  $(`deck${prefix}Title`).textContent = m.name;
  $(`waveLabel${prefix}`).textContent = `${m.name} (${m.analysis.bpm.toFixed(0)} BPM)`;
  const energyPct = Math.round((m.analysis.energy ?? 0.8) * 100);
  const agDb = m.analysis.autoGainDb ?? 0;
  const agStr = `${agDb >= 0 ? "+" : ""}${agDb.toFixed(1)}dB`;
  $(`deck${prefix}Meta`).textContent = `${m.analysis.bpm.toFixed(1)} BPM / Key ${m.analysis.key ?? "8A"} / E:${energyPct}% / AG:${agStr}`;

  if (m.analysis.cuePoints) {
    $(`cueTime${prefix}Intro`).textContent = fmt(m.analysis.cuePoints.intro);
    $(`cueTime${prefix}Drop`).textContent = fmt(m.analysis.cuePoints.drop);
    $(`cueTime${prefix}Break`).textContent = fmt(m.analysis.cuePoints.breakdown);
    $(`cueTime${prefix}Outro`).textContent = fmt(m.analysis.cuePoints.outro);
  }
  updateLoopButtons(slot);
}

function updateCrateStatsReadout() {
  const el = $("crateStatsReadout");
  if (!el) return;
  const userTracks = crate.filter(t => t.persistedToIdb || t.id.startsWith("user-")).length;
  let totalDurationSec = 0;
  for (const t of crate) {
    totalDurationSec += t.buffer?.duration ?? 45;
  }
  const mins = (totalDurationSec / 60).toFixed(1);
  el.textContent = `INDEXED: ${crate.length} TRACKS | IDB CACHED: ${userTracks} | TOTAL: ${mins}M`;
}

function getFilteredCrate(): CrateSearchResultItem<CrateTrack>[] {
  const activeKey = slots[mixer.active]?.analysis.key ?? "8A";
  const filters: CrateSearchFilters = {
    query: crateSearchQuery,
    activeKey,
    harmonicOnly: crateHarmonicOnly || crateActiveQuickFilter === "harmonic",
    energyTier: crateActiveQuickFilter.startsWith("tier:")
      ? (crateActiveQuickFilter.slice(5) as EnergyTier)
      : undefined,
    genre: crateActiveQuickFilter.startsWith("genre:")
      ? crateActiveQuickFilter.slice(6)
      : undefined,
    sortBy: crateSortBy,
    targetEnergy: getCurrentTargetEnergy(),
  };

  if (crateActiveQuickFilter.startsWith("tag:")) {
    const tag = crateActiveQuickFilter.slice(4);
    if (!filters.query.includes(`tag:${tag}`)) {
      filters.query = filters.query ? `${filters.query} tag:${tag}` : `tag:${tag}`;
    }
  }

  return searchAndFilterCrate(crate, filters);
}

$<HTMLInputElement>("crateSearchInput").addEventListener("input", e => {
  crateSearchQuery = (e.target as HTMLInputElement).value;
  renderCrateList();
});

$("clearSearchBtn").addEventListener("click", () => {
  crateSearchQuery = "";
  $<HTMLInputElement>("crateSearchInput").value = "";
  renderCrateList();
});

$<HTMLSelectElement>("crateSortSelect").addEventListener("change", e => {
  crateSortBy = (e.target as HTMLSelectElement).value as CrateSearchFilters["sortBy"];
  renderCrateList();
});

const crateKeyFilterBtn = $<HTMLButtonElement>("crateKeyFilterBtn");
crateKeyFilterBtn.addEventListener("click", () => {
  crateHarmonicOnly = !crateHarmonicOnly;
  crateKeyFilterBtn.classList.toggle("active", crateHarmonicOnly);
  crateKeyFilterBtn.setAttribute("aria-pressed", String(crateHarmonicOnly));
  crateKeyFilterBtn.textContent = `HARMONIC LOCK: ${crateHarmonicOnly ? "ON" : "OFF"}`;
  renderCrateList();
});

$("queueAllCrateBtn").addEventListener("click", () => {
  const filtered = getFilteredCrate();
  let added = 0;
  for (const { item } of filtered) {
    if (!queue.some(q => q.id === item.id)) {
      queue.push(item);
      added++;
    }
  }
  renderQueue();
  void fill();
  toast(added > 0 ? `Queued ${added} track(s) from crate` : "All matching crate tracks are already in queue");
});

$("clearCrateCacheBtn").addEventListener("click", async () => {
  await clearIndexedDbCrate();
  // Remove user-uploaded tracks from memory crate
  for (let i = crate.length - 1; i >= 0; i--) {
    if (crate[i].persistedToIdb || crate[i].id.startsWith("user-")) {
      crate.splice(i, 1);
    }
  }
  renderCrateList();
  renderQueue();
  updateCrateStatsReadout();
  toast("Cleared IndexedDB Crate Cache — restored default studio crate");
});

async function removeTrackFromCrate(trackId: string) {
  const idx = crate.findIndex(t => t.id === trackId);
  if (idx >= 0) {
    const [removed] = crate.splice(idx, 1);
    await removeTrackFromIndexedDb(trackId);
    // Also remove from queue if present
    const qIdx = queue.findIndex(q => q.id === trackId);
    if (qIdx >= 0) queue.splice(qIdx, 1);
    renderCrateList();
    renderQueue();
    updateCrateStatsReadout();
    toast(`Removed "${removed.name}" from crate`);
  }
}

$("shuffleQueueBtn").addEventListener("click", () => {
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }
  renderQueue();
  toast("Shuffled Up Next Queue");
});

$("clearQueueBtn").addEventListener("click", () => {
  queue.length = 0;
  renderQueue();
  toast("Cleared Up Next Queue");
});

function renderQueue() {
  const ol = $("queue");
  ol.replaceChildren();
  $("queueCount").textContent = `${queue.length}`;
  const anchorMeta = slots[mixer.active] ?? slots[0];
  let prevBpm = anchorMeta?.analysis.bpm ?? 124;
  let prevKey = anchorMeta?.analysis.key ?? "8A";
  const targetE = getCurrentTargetEnergy();

  queue.forEach((item, i) => {
    const li = document.createElement("li");
    const s = document.createElement("span");
    const act = document.createElement("div");
    act.className = "queue-item-actions";
    const sc = scoreNextTrackCandidate({ bpm: prevBpm, key: prevKey }, item, targetE);
    prevBpm = item.analysis.bpm;
    prevKey = item.analysis.key ?? prevKey;

    s.textContent = `${item.name} (${item.analysis.bpm.toFixed(0)} BPM · ${item.analysis.key ?? "8A"} · Fit ${Math.round(sc.total * 100)}%)`;

    if (i > 0) {
      const topBtn = document.createElement("button");
      topBtn.type = "button";
      topBtn.textContent = "Top";
      topBtn.title = "Move to top of queue (Play Next)";
      topBtn.onclick = () => {
        const [picked] = queue.splice(i, 1);
        queue.unshift(picked);
        renderQueue();
      };
      act.append(topBtn);
    }

    const b = document.createElement("button");
    b.type = "button";
    b.textContent = "Remove";
    b.setAttribute("aria-label", `Remove ${item.name}`);
    b.onclick = () => {
      queue.splice(i, 1);
      renderQueue();
    };
    act.append(b);
    li.append(s, act);
    ol.append(li);
  });
}

function renderCrateList() {
  const tbody = $("crateTableBody");
  if (!tbody) return;
  tbody.replaceChildren();

  const visible = getFilteredCrate();
  const activeDeckSlot = mixer.active;
  const activeMeta = slots[activeDeckSlot] ?? slots[0];
  const masterBpm = mixer.info()?.effBpm ?? activeMeta?.analysis.bpm ?? 124;
  const masterKey = activeMeta?.analysis.key ?? "8A";

  // Update sort icons on table headers
  document.querySelectorAll<HTMLElement>(".crate-table th.sortable").forEach(th => {
    const col = th.dataset.sort;
    const icon = $(`sortIcon-${col}`);
    if (icon) {
      if (
        crateSortBy === col ||
        (col === "bpm" && (crateSortBy === "bpm-asc" || crateSortBy === "bpm-desc")) ||
        (col === "energy" && (crateSortBy === "energy-asc" || crateSortBy === "energy-desc"))
      ) {
        icon.textContent = crateSortBy && crateSortBy.endsWith("desc") ? "▼" : "▲";
      } else {
        icon.textContent = "";
      }
    }
  });

  if (visible.length === 0) {
    const tr = document.createElement("tr");
    tr.innerHTML = `<td colspan="10" class="log-empty">No matching tracks in crate for query "${crateSearchQuery}". Try clearing filters or uploading audio files.</td>`;
    tbody.append(tr);
    return;
  }

  visible.forEach(({ item, harmonicLabel, harmonicScore }, idx) => {
    const tr = document.createElement("tr");
    const isPlayingA = slots[0]?.id === item.id;
    const isPlayingB = slots[1]?.id === item.id;
    if (isPlayingA) tr.classList.add("row-playing-a");
    if (isPlayingB) tr.classList.add("row-playing-b");

    // 1. # Index
    const tdNum = document.createElement("td");
    tdNum.className = "td-num";
    tdNum.textContent = String(idx + 1);

    // 2. Load buttons (Deck A, Deck B, +Q)
    const tdLoad = document.createElement("td");
    tdLoad.className = "td-load";
    const btnGroup = document.createElement("div");
    btnGroup.className = "load-btn-group";

    const btnA = document.createElement("button");
    btnA.type = "button";
    btnA.className = "btn-load-deck btn-load-a";
    btnA.textContent = "A";
    btnA.title = `Load "${item.name}" into Deck A`;
    btnA.onclick = e => {
      e.stopPropagation();
      void loadTrackIntoDeck(0, item);
      toast(`Loaded "${item.name}" into Deck A`);
    };

    const btnB = document.createElement("button");
    btnB.type = "button";
    btnB.className = "btn-load-deck btn-load-b";
    btnB.textContent = "B";
    btnB.title = `Load "${item.name}" into Deck B`;
    btnB.onclick = e => {
      e.stopPropagation();
      void loadTrackIntoDeck(1, item);
      toast(`Loaded "${item.name}" into Deck B`);
    };

    const btnQ = document.createElement("button");
    btnQ.type = "button";
    btnQ.className = "btn-load-deck btn-load-q";
    btnQ.textContent = "+Q";
    btnQ.title = `Add "${item.name}" to Up Next Queue`;
    btnQ.onclick = e => {
      e.stopPropagation();
      queue.push(item);
      renderQueue();
      void fill();
      toast(`Queued "${item.name}"`);
    };

    btnGroup.append(btnA, btnB, btnQ);
    tdLoad.append(btnGroup);

    // 3. Title & Artist
    const tdTitle = document.createElement("td");
    tdTitle.className = "td-title-cell";
    const titleDiv = document.createElement("div");
    titleDiv.className = "td-title-text";
    if (isPlayingA) {
      const b = document.createElement("span");
      b.className = "td-now-playing-badge badge-a";
      b.textContent = "DECK A";
      titleDiv.append(b);
    } else if (isPlayingB) {
      const b = document.createElement("span");
      b.className = "td-now-playing-badge badge-b";
      b.textContent = "DECK B";
      titleDiv.append(b);
    }
    titleDiv.append(document.createTextNode(item.name));

    const artistDiv = document.createElement("div");
    artistDiv.className = "td-artist-text";
    artistDiv.textContent = item.artist;

    tdTitle.append(titleDiv, artistDiv);

    // 4. BPM & Delta
    const tdBpm = document.createElement("td");
    tdBpm.className = "th-bpm";
    const bpmVal = item.analysis.bpm;
    const bpmDiff = bpmVal - masterBpm;
    const pctShift = (bpmVal / masterBpm - 1) * 100;
    const bpmDeltaClass =
      Math.abs(bpmDiff) < 0.1
        ? "bpm-delta-exact"
        : Math.abs(pctShift) <= 6
          ? "bpm-delta-close"
          : "bpm-delta-wide";
    const bpmDeltaStr =
      Math.abs(bpmDiff) < 0.1 ? "= SYNC" : `${pctShift >= 0 ? "+" : ""}${pctShift.toFixed(1)}%`;
    tdBpm.innerHTML = `<span class="bpm-val">${bpmVal.toFixed(1)}</span> <span class="bpm-delta ${bpmDeltaClass}">(${bpmDeltaStr})</span>`;

    // 5. Camelot Key & Harmonic Match Badge
    const tdKey = document.createElement("td");
    tdKey.className = "th-key";
    const key = item.analysis.key || "8A";
    const match = evaluateHarmonicMatch(masterKey, key);
    const harmClass =
      match.tier === "perfect"
        ? "harm-perfect"
        : match.tier === "harmonic"
          ? "harm-harmonic"
          : match.tier === "energy-boost"
            ? "harm-boost"
            : "harm-clash";
    tdKey.innerHTML = `<span class="key-badge">${key}</span> <span class="harmonic-tag ${harmClass}">${harmonicLabel}</span>`;

    // 6. Match Details
    const tdMatch = document.createElement("td");
    tdMatch.className = "th-match col-match";
    const scoreVal = Math.round(harmonicScore);
    const scoreClass = scoreVal >= 80 ? "score-high" : scoreVal >= 60 ? "score-med" : "score-low";
    const breakdownReason = `${match.label} · BPM Δ ${Math.abs(pctShift).toFixed(1)}%`;
    tdMatch.innerHTML = `<span class="match-score-pill ${scoreClass}">${scoreVal}% MATCH</span><small class="match-breakdown-sub" title="${breakdownReason}">${breakdownReason}</small>`;

    // 7. Energy Tier & Meter
    const tdEnergy = document.createElement("td");
    tdEnergy.className = "th-energy col-energy";
    const tier = item.energyTier || item.analysis.categorization?.energyTier || "Groove";
    const tierSlug = tier.toLowerCase().replace(/\s+/g, "-");
    const energyPct = Math.round((item.analysis.energy ?? 0.75) * 100);
    tdEnergy.innerHTML = `
      <div class="energy-bar-wrap">
        <span class="tier-badge tier-${tierSlug}">${tier.toUpperCase()}</span>
        <div class="energy-micro-track"><div class="energy-micro-fill" style="width:${energyPct}%"></div></div>
      </div>
    `;

    // 8. Genre & Acoustic Tags
    const tdGenre = document.createElement("td");
    tdGenre.className = "th-genre col-genre";
    const genre = item.genre || item.analysis.categorization?.genre || "Electronic";
    const tags = (item.tags || item.analysis.categorization?.tags || []).slice(0, 2);
    tdGenre.innerHTML = `
      <div class="genre-tag-group">
        <span class="genre-badge">${genre}</span>
        ${tags.map(t => `<span class="acoustic-tag-chip">${t}</span>`).join("")}
      </div>
    `;

    // 9. Duration Time
    const tdTime = document.createElement("td");
    tdTime.className = "th-time col-time td-time";
    const durSec = item.buffer?.duration ?? 45;
    tdTime.textContent = fmt(durSec);

    // 10. Actions (Delete user uploaded tracks)
    const tdAct = document.createElement("td");
    tdAct.className = "th-act col-actions td-act";
    if (item.persistedToIdb || item.id.startsWith("user-")) {
      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "btn-delete-track";
      delBtn.textContent = "✕";
      delBtn.title = "Delete track from crate";
      delBtn.onclick = e => {
        e.stopPropagation();
        void removeTrackFromCrate(item.id);
      };
      tdAct.append(delBtn);
    } else {
      tdAct.innerHTML = `<span class="dim-txt">—</span>`;
    }

    // Row double click -> load into idle deck!
    tr.ondblclick = () => {
      const targetSlot = mixer.idle;
      void loadTrackIntoDeck(targetSlot, item);
      toast(`Loaded "${item.name}" into Deck ${targetSlot === 0 ? "A" : "B"}`);
    };

    tr.append(tdNum, tdLoad, tdTitle, tdBpm, tdKey, tdMatch, tdEnergy, tdGenre, tdTime, tdAct);
    tbody.append(tr);
  });
}

// Alias for backwards compatibility
const renderCrateCards = renderCrateList;

/** Keep the idle deck (or both decks before Start) loaded from the queue. */
async function fill() {
  if (loading) return;
  loading = true;
  try {
    const targets: (0 | 1)[] = mixer.playing ? (mixer.busy ? [] : [mixer.idle]) : [0, 1];
    for (const slot of targets) {
      if (slots[slot] || !queue.length) continue;
      const nextItem = queue.shift()!;
      renderQueue();
      await loadTrackIntoDeck(slot, nextItem);
    }
  } finally {
    loading = false;
    renderQueue();
  }
}

function autoSequenceQueueSilently() {
  if (queue.length < 2) return;
  const activeMeta = slots[mixer.active] ?? slots[0];
  const anchor = {
    bpm: activeMeta?.analysis.bpm ?? 124,
    key: activeMeta?.analysis.key ?? "8A",
  };
  const tpl = getActiveTemplate();
  const reordered = sequenceCrateForParty(anchor, queue, tpl.energyCurve, getSessionProgress01());
  queue.splice(0, queue.length, ...reordered);
}

// Recursive directory file scanner for Folder Upload and Directory Drag & Drop
async function scanFolderFiles(items: DataTransferItemList | null, fallbackFiles: FileList | File[] | null): Promise<File[]> {
  const fileList: File[] = [];
  if (items && items.length > 0) {
    const queueEntries: any[] = [];
    for (let i = 0; i < items.length; i++) {
      const entry = (items[i] as any).webkitGetAsEntry?.();
      if (entry) queueEntries.push(entry);
    }
    if (queueEntries.length > 0) {
      while (queueEntries.length > 0) {
        const entry = queueEntries.shift()!;
        if (entry.isFile) {
          const file = await new Promise<File>((resolve, reject) => {
            entry.file((f: File) => {
              (f as any)._relativePath = entry.fullPath?.replace(/^\//, "") || f.name;
              resolve(f);
            }, reject);
          }).catch(() => null);
          if (file) fileList.push(file);
        } else if (entry.isDirectory) {
          const reader = entry.createReader();
          const subEntries = await new Promise<any[]>((resolve) => {
            reader.readEntries(resolve, () => resolve([]));
          });
          queueEntries.push(...subEntries);
        }
      }
      return fileList;
    }
  }
  return Array.from(fallbackFiles ?? []);
}

async function addFiles(fileSource: FileList | File[] | null, isFolderUpload = false) {
  const rawList = Array.from(fileSource ?? []);
  const files = rawList.filter(
    f => f.type.startsWith("audio/") || /\.(mp3|wav|m4a|aac|flac|ogg)$/i.test(f.name)
  );
  if (!files.length) return toast("Unsupported file type. Try MP3, WAV, FLAC, or M4A.");

  toast(`Indexing & analyzing ${files.length} audio ${files.length === 1 ? "track" : "tracks"}...`);
  let addedCount = 0;

  for (let idx = 0; idx < files.length; idx++) {
    const f = files[idx];
    const startTime = performance.now();
    try {
      // 1. Raw byte tag parsing (ID3v2, ID3v1, MP4, filename regex)
      const parsedMeta = await parseAudioFileMetadata(f);

      // 2. AudioBuffer decode
      const ab = await f.arrayBuffer();
      const buf = await mixer.ctx.decodeAudioData(ab);

      // 3. DSP analysis
      const tempDeckSlot = (!slots[0] ? 0 : !slots[1] ? 1 : mixer.idle) as 0 | 1;
      const analysis =
        !slots[tempDeckSlot]
          ? mixer.loadBuffer(tempDeckSlot, buf)
          : (await import("./engine/analysis")).analyze(buf);

      // Prefer parsed ID3 key if available and valid
      if (parsedMeta.key && /^[1-9]|1[0-2][AB]$/i.test(parsedMeta.key)) {
        analysis.key = parsedMeta.key.toUpperCase();
      }

      // 4. Acoustic classification & metadata categorizing
      const acoustic = categorizeTrackAcoustics(analysis, parsedMeta);
      analysis.categorization = acoustic;

      const trackId = `user-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const title = parsedMeta.title || clean(f.name);
      const artist = parsedMeta.artist || "Imported Artist";
      const genre = acoustic.genre;
      const relPath = (f as any).webkitRelativePath || (f as any)._relativePath || f.name;

      const item: CrateTrack = {
        id: trackId,
        name: title,
        artist,
        genre,
        tags: acoustic.tags,
        energyTier: acoustic.energyTier,
        buffer: buf,
        file: f,
        analysis,
        dateAddedMs: Date.now(),
        persistedToIdb: true,
      };

      crate.unshift(item);
      queue.push(item);
      addedCount++;

      // Log metadata entry
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
      const logRecord: MetadataLogEntry = {
        id: trackId,
        timeStr,
        name: title,
        relativePath: relPath,
        sizeFormatted: formatFileSize(f.size),
        specs: `${buf.sampleRate}Hz / ${buf.numberOfChannels}ch / ${fmt(buf.duration)}`,
        bpm: analysis.bpm,
        key: analysis.key || "8A",
        keyName: analysis.keyName || "A Minor",
        energyPct: Math.round((analysis.energy ?? 0.7) * 100),
        energyTier: acoustic.energyTier,
        tags: acoustic.tags,
        genre,
        autoGainDb: analysis.autoGainDb ?? 0,
        rmsDb: analysis.rmsDb ?? -14,
        status: "OK",
        durationSec: buf.duration,
      };
      metadataLogs.unshift(logRecord);

      // 5. Persist to IndexedDB cache
      const wf = analysis.waveform;
      const record: CrateIndexRecord = {
        id: trackId,
        name: title,
        artist,
        genre,
        tags: acoustic.tags,
        energyTier: acoustic.energyTier,
        mood: acoustic.mood,
        harmonicMood: acoustic.harmonicMood,
        bpm: analysis.bpm,
        key: analysis.key || "8A",
        keyName: analysis.keyName || "A Minor",
        energy: analysis.energy ?? 0.7,
        rmsDb: analysis.rmsDb ?? -14,
        autoGainDb: analysis.autoGainDb ?? 0,
        durationSec: buf.duration,
        cuePoints: analysis.cuePoints,
        waveformLow: wf ? Array.from(wf.low) : [],
        waveformMid: wf ? Array.from(wf.mid) : [],
        waveformHigh: wf ? Array.from(wf.high) : [],
        waveformPeaks: wf ? Array.from(wf.peaks) : [],
        waveformEnergy: wf ? Array.from(wf.energyCurve) : [],
        fileBlob: f,
        fileName: f.name,
        playCount: 0,
        dateAddedMs: item.dateAddedMs!,
      };
      void persistTrackToIndexedDb(record);

      if (!slots[tempDeckSlot]) {
        slots[tempDeckSlot] = {
          id: item.id,
          name: item.name,
          artist: item.artist,
          genre: item.genre,
          analysis,
        };
        updateDeckStaticLabels(tempDeckSlot);
      }
    } catch {
      const now = new Date();
      const timeStr = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}:${String(now.getSeconds()).padStart(2, "0")}`;
      metadataLogs.unshift({
        id: `err-${Date.now()}`,
        timeStr,
        name: f.name,
        relativePath: (f as any).webkitRelativePath || f.name,
        sizeFormatted: formatFileSize(f.size),
        specs: "Unsupported or Corrupted PCM",
        bpm: 0,
        key: "--",
        keyName: "--",
        energyPct: 0,
        energyTier: "Groove",
        tags: ["corrupt"],
        genre: "Unknown",
        autoGainDb: 0,
        rmsDb: 0,
        status: "FAILED",
        durationSec: 0,
      });
      toast(`Couldn't decode ${f.name}. Try an MP3, WAV or M4A file.`);
    }
  }

  autoSequenceQueueSilently();
  renderCrateList();
  renderQueue();
  renderMetadataLog();
  updateCrateStatsReadout();
  await fill();
  evictIdleCrateBuffers();
  toast(`Indexed & logged metadata for ${addedCount} track(s) — stored in IndexedDB crate cache`);
}

// 3 Distinct Upload Triggers: Folder, Bulk, Single File + Sidebar Drop
$<HTMLInputElement>("folderInput")?.addEventListener("change", e => {
  const t = e.target as HTMLInputElement;
  void addFiles(t.files, true);
  t.value = "";
});

$<HTMLInputElement>("bulkFilesInput")?.addEventListener("change", e => {
  const t = e.target as HTMLInputElement;
  void addFiles(t.files, false);
  t.value = "";
});

$<HTMLInputElement>("singleFileInput")?.addEventListener("change", e => {
  const t = e.target as HTMLInputElement;
  void addFiles(t.files, false);
  t.value = "";
});

$<HTMLInputElement>("files")?.addEventListener("change", e => {
  const t = e.target as HTMLInputElement;
  void addFiles(t.files, false);
  t.value = "";
});

const drop = $("drop");
window.addEventListener("dragover", e => {
  e.preventDefault();
  drop?.classList.add("over");
});
window.addEventListener("dragleave", e => {
  if (!e.relatedTarget) drop?.classList.remove("over");
});
window.addEventListener("drop", async e => {
  e.preventDefault();
  drop?.classList.remove("over");
  if (e.dataTransfer?.items && e.dataTransfer.items.length > 0) {
    const files = await scanFolderFiles(e.dataTransfer.items, e.dataTransfer.files);
    void addFiles(files);
  } else if (e.dataTransfer?.files?.length) {
    void addFiles(e.dataTransfer.files);
  }
});

// 8. Primary Hero Smart Mix Pad & Transport Controls
const pad = $<HTMLButtonElement>("pad");
async function triggerPrimaryAction() {
  await mixer.ctx.resume();
  if (!mixer.playing) {
    if (mixer.play()) {
      if (!sessionStartedAtMs) sessionStartedAtMs = Date.now();
      logTrackToSetlist(slots[mixer.active], "Set Opener", "Master Lock");
      void syncWakeLock();
      toast("Party Started - Auto-DJ, Beat Grid, Auto-Gain & Club Limiter Active");
      void fill();
    } else {
      toast("Add a song first");
    }
    return;
  }
  const { preset, autoReason } = resolveActiveTransitionPreset();
  const incomingMeta = slots[mixer.idle];
  const r = mixer.next(preset);
  if (!r.ok) return toast(r.reason);
  freePending = true;
  logTrackToSetlist(incomingMeta, preset.name, r.harmonicLabel);
  onTrackTransitionTriggered(incomingMeta);
  const shiftPct = ((r.rate - 1) * 100).toFixed(1);
  const modeTag = autoReason ? `Auto: ${preset.name}` : preset.name;
  toast(
    r.clamped
      ? `Smart Mix (${modeTag}) - Wide tempo range clamped`
      : `Smart Mix (${modeTag}) - ${r.harmonicLabel} (Tempo ${shiftPct}%)`
  );
}
pad.onclick = () => void triggerPrimaryAction();

// Mode Switch Buttons & Simple Transition Trigger
$("simpleModeBtn")?.addEventListener("click", () => setUiMode("simple"));
$("advancedModeBtn")?.addEventListener("click", () => setUiMode("advanced"));
$("switchToAdvBtn")?.addEventListener("click", () => setUiMode("advanced"));
$("simpleTransitionBtn")?.addEventListener("click", () => void triggerPrimaryAction());

$("playPauseToggle").addEventListener("click", async () => {
  await mixer.ctx.resume();
  if (mixer.playing) {
    mixer.pause();
    void syncWakeLock();
    toast("Playback Paused");
  } else if (mixer.play()) {
    if (!sessionStartedAtMs) sessionStartedAtMs = Date.now();
    void syncWakeLock();
    toast("Playback Resumed");
  }
});

// Keyboard Shortcuts (Space = Start/Mix, G/R/1-8 = Advanced Scratch Controls)
window.addEventListener("keydown", e => {
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  if (e.code === "Space") {
    e.preventDefault();
    void triggerPrimaryAction();
  } else if (uiMode === "advanced" && (e.key === "g" || e.key === "G")) {
    e.preventDefault();
    void trigger90sScratchAgent(false);
  } else if (uiMode === "advanced" && (e.key === "r" || e.key === "R")) {
    e.preventDefault();
    void trigger90sScratchAgent(true);
  } else if (uiMode === "advanced" && e.key >= "1" && e.key <= "8") {
    const idx = parseInt(e.key, 10) - 1;
    const pat = SCRATCH_PATTERNS[idx];
    if (pat) {
      void mixer.ctx.resume().then(() => {
        const res = mixer.triggerAutoscratch(pat.id);
        if (res.ok) toast(`Autoscratch: ${res.message}`);
      });
    }
  }
});

// 9. Waveform Click-to-Seek
const waveCanvas = $<HTMLCanvasElement>("waveCanvas");
waveCanvas.addEventListener("click", async e => {
  await mixer.ctx.resume();
  const rect = waveCanvas.getBoundingClientRect();
  const yRatio = (e.clientY - rect.top) / rect.height;
  const xRatio = (e.clientX - rect.left) / rect.width;
  const targetDeck: 0 | 1 = yRatio < 0.5 ? 0 : 1;
  const d = mixer.decks[targetDeck];
  if (!d.buffer) return;
  const targetSec = xRatio * d.buffer.duration;
  mixer.seekDeck(targetDeck, targetSec);
  toast(`Deck ${targetDeck === 0 ? "A" : "B"} seeked to ${fmt(targetSec)}`);
});

// 10. Canvas Renderers: Parallel 3-Band Waveforms, Scratch Scope & Marathon Energy Curve
const waveCtx = waveCanvas.getContext("2d")!;
const scopeCanvas = $<HTMLCanvasElement>("scratchScope");
const scopeCtx = scopeCanvas.getContext("2d")!;
const energyCurveCanvas = $<HTMLCanvasElement>("energyCurveCanvas");
const energyCurveCtx = energyCurveCanvas.getContext("2d")!;

const deckSpectrumCanvasA = $<HTMLCanvasElement>("deckSpectrumCanvasA");
const deckSpectrumCtxA = deckSpectrumCanvasA.getContext("2d")!;
const deckSpectrumCanvasB = $<HTMLCanvasElement>("deckSpectrumCanvasB");
const deckSpectrumCtxB = deckSpectrumCanvasB.getContext("2d")!;

function drawDeckSpectrum(deckIndex: number, canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, isDeckPlaying: boolean) {
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);

  const deck = mixer.decks[deckIndex];
  if (!deck) return;

  const binCount = deck.analyser.frequencyBinCount;
  const dataArray = new Uint8Array(binCount);

  const scratch = mixer.scratchTelemetry();
  const isScratchingThisDeck = scratch.active && scratch.deck === deckIndex;

  if (isDeckPlaying || isScratchingThisDeck) {
    deck.analyser.getByteFrequencyData(dataArray);
  } else {
    dataArray.fill(0);
  }

  // Number of visual columns (bars)
  const barCount = 40;
  const barWidth = W / barCount;

  for (let i = 0; i < barCount; i++) {
    const percent = i / barCount;
    // Logarithmic distribution to focus on bass/mids
    const binIndex = Math.min(
      binCount - 1,
      Math.floor(Math.pow(percent, 1.4) * (binCount - 4)) + 1
    );

    let val = dataArray[binIndex];
    if (binIndex > 0 && binIndex < binCount - 1) {
      val = (dataArray[binIndex - 1] + dataArray[binIndex] + dataArray[binIndex + 1]) / 3;
    }

    const normVal = val / 255;
    // Add a small threshold floor to prevent minor noise flickering when silent
    const targetHeight = normVal > 0.02 ? normVal * H : 0;

    if (targetHeight > 0) {
      const x = i * barWidth;
      const y = H - targetHeight;
      const width = barWidth - 1.5;
      const height = targetHeight;

      const grad = ctx.createLinearGradient(x, H, x, y);
      if (deckIndex === 0) {
        // Deck A: Warm Glowing Amber
        grad.addColorStop(0, "rgba(245, 158, 11, 0.08)");
        grad.addColorStop(0.5, "rgba(245, 158, 11, 0.32)");
        grad.addColorStop(1, "rgba(251, 191, 36, 0.72)");
      } else {
        // Deck B: Radiant Cyan/Teal to Match Badges
        grad.addColorStop(0, "rgba(14, 165, 233, 0.08)");
        grad.addColorStop(0.5, "rgba(14, 165, 233, 0.32)");
        grad.addColorStop(1, "rgba(56, 189, 248, 0.72)");
      }

      ctx.fillStyle = grad;
      ctx.fillRect(x, y, width, height);
    }
  }
}

function drawEnergyCurve() {
  const W = energyCurveCanvas.width;
  const H = energyCurveCanvas.height;
  energyCurveCtx.fillStyle = "#07090d";
  energyCurveCtx.fillRect(0, 0, W, H);

  const tpl = getActiveTemplate();
  const curve = tpl.energyCurve;
  const prog = getSessionProgress01();
  const targetE = interpolateEnergyCurve(curve, prog);

  // Grid line
  energyCurveCtx.strokeStyle = "rgba(255,255,255,0.07)";
  energyCurveCtx.lineWidth = 1;
  energyCurveCtx.beginPath();
  energyCurveCtx.moveTo(0, H * 0.5);
  energyCurveCtx.lineTo(W, H * 0.5);
  energyCurveCtx.stroke();

  // Fill under target energy curve
  energyCurveCtx.beginPath();
  for (let i = 0; i < curve.length; i++) {
    const x = (i / Math.max(1, curve.length - 1)) * W;
    const y = H - 4 - curve[i] * (H - 10);
    if (i === 0) energyCurveCtx.moveTo(x, y);
    else energyCurveCtx.lineTo(x, y);
  }
  energyCurveCtx.strokeStyle = "#f59e0b";
  energyCurveCtx.lineWidth = 2;
  energyCurveCtx.stroke();

  energyCurveCtx.lineTo(W, H);
  energyCurveCtx.lineTo(0, H);
  energyCurveCtx.closePath();
  energyCurveCtx.fillStyle = "rgba(245, 158, 11, 0.14)";
  energyCurveCtx.fill();

  // Plot queued track energy dots along upcoming horizon
  for (let i = 0; i < Math.min(6, queue.length); i++) {
    const qProg = Math.min(1, prog + (i + 1) * 0.1);
    const qx = qProg * W;
    const qe = queue[i].analysis.energy ?? 0.75;
    const qy = H - 4 - qe * (H - 10);
    energyCurveCtx.fillStyle = "#38bdf8";
    energyCurveCtx.beginPath();
    energyCurveCtx.arc(qx, qy, 3, 0, Math.PI * 2);
    energyCurveCtx.fill();
  }

  // Current set progress playhead & target dot
  const cx = prog * W;
  const cy = H - 4 - targetE * (H - 10);
  energyCurveCtx.strokeStyle = "#ffffff";
  energyCurveCtx.lineWidth = 1.5;
  energyCurveCtx.beginPath();
  energyCurveCtx.moveTo(cx, 0);
  energyCurveCtx.lineTo(cx, H);
  energyCurveCtx.stroke();

  energyCurveCtx.fillStyle = "#fbbf24";
  energyCurveCtx.beginPath();
  energyCurveCtx.arc(cx, cy, 4, 0, Math.PI * 2);
  energyCurveCtx.fill();
}

function drawParallelWaveforms() {
  const W = waveCanvas.width;
  const H = waveCanvas.height;
  const halfH = H * 0.5;

  waveCtx.fillStyle = "#05070a";
  waveCtx.fillRect(0, 0, W, H);

  // Center horizontal divider between Deck A and Deck B
  waveCtx.strokeStyle = "rgba(255,255,255,0.1)";
  waveCtx.lineWidth = 1;
  waveCtx.beginPath();
  waveCtx.moveTo(0, halfH);
  waveCtx.lineTo(W, halfH);
  waveCtx.stroke();

  for (let slot = 0 as 0 | 1; slot <= 1; slot = (slot + 1) as 0 | 1) {
    const d = mixer.decks[slot];
    const meta = slots[slot];
    const topY = slot === 0 ? 0 : halfH;
    const centerY = topY + halfH * 0.5;
    const maxAmp = halfH * 0.42;

    if (!d.buffer || !meta || !(d.analysis?.waveform ?? meta.analysis.waveform)) continue;

    const wf = (d.analysis?.waveform ?? meta.analysis.waveform)!;
    const dur = d.buffer.duration;
    const curSec = d.currentOffset();
    const curRatio = curSec / Math.max(0.1, dur);
    const n = wf.low.length;
    const barW = W / n;

    // Cohesive Warm Amber / Titanium 3-Band Spectrum
    for (let i = 0; i < n; i++) {
      const x = i * barW;
      const played = i / n <= curRatio;
      const alpha = played ? 0.35 : 0.9;

      const lAmp = wf.low[i] * maxAmp;
      const mAmp = wf.mid[i] * maxAmp * 0.78;
      const hAmp = wf.high[i] * maxAmp * 0.55;

      // Low Band (Warm Amber on Deck A, Cool Silver-Slate on Deck B)
      waveCtx.fillStyle =
        slot === 0 ? `rgba(245, 158, 11, ${alpha})` : `rgba(148, 163, 184, ${alpha})`;
      waveCtx.fillRect(x, centerY - lAmp, Math.max(1.5, barW - 0.5), lAmp * 2);

      // Mid Band
      waveCtx.fillStyle =
        slot === 0 ? `rgba(251, 191, 36, ${alpha * 0.75})` : `rgba(203, 213, 225, ${alpha * 0.75})`;
      waveCtx.fillRect(x, centerY - mAmp, Math.max(1.5, barW - 0.5), mAmp * 2);

      // High Band
      waveCtx.fillStyle = `rgba(241, 245, 249, ${alpha * 0.65})`;
      waveCtx.fillRect(x, centerY - hAmp, Math.max(1.5, barW - 0.5), hAmp * 2);
    }

    // Highlight permanently spliced scratch regions in the music file
    if (d.modRegions.length > 0) {
      waveCtx.font = "600 8px 'JetBrains Mono', monospace";
      for (const reg of d.modRegions) {
        const rx = (reg.startSec / dur) * W;
        const rw = Math.max(3, ((reg.endSec - reg.startSec) / dur) * W);
        waveCtx.fillStyle = "rgba(56, 189, 248, 0.22)";
        waveCtx.fillRect(rx, topY + 1, rw, halfH - 2);
        waveCtx.strokeStyle = "rgba(56, 189, 248, 0.85)";
        waveCtx.lineWidth = 1;
        waveCtx.strokeRect(rx, topY + 1, rw, halfH - 2);
        if (rw > 18) {
          waveCtx.fillStyle = "#38bdf8";
          waveCtx.fillText("MOD", rx + 2, topY + halfH - 3);
        }
      }
    }

    // Draw Bar Grid ticks
    const secPerBar = (60 / meta.analysis.bpm) * 4;
    waveCtx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    waveCtx.lineWidth = 1;
    for (let t = meta.analysis.firstBeat; t < dur; t += secPerBar) {
      const x = (t / dur) * W;
      waveCtx.beginPath();
      waveCtx.moveTo(x, topY + 2);
      waveCtx.lineTo(x, topY + halfH - 2);
      waveCtx.stroke();
    }

    // Draw Cue Flags (IN, DROP, BRK, OUT)
    if (meta.analysis.cuePoints) {
      const cues: Array<[string, number]> = [
        ["IN", meta.analysis.cuePoints.intro],
        ["DROP", meta.analysis.cuePoints.drop],
        ["BRK", meta.analysis.cuePoints.breakdown],
        ["OUT", meta.analysis.cuePoints.outro],
      ];
      waveCtx.font = "600 9px 'JetBrains Mono', monospace";
      for (const [label, sec] of cues) {
        const cx = (sec / dur) * W;
        waveCtx.strokeStyle = "rgba(251, 191, 36, 0.75)";
        waveCtx.beginPath();
        waveCtx.moveTo(cx, topY);
        waveCtx.lineTo(cx, topY + halfH);
        waveCtx.stroke();
        waveCtx.fillStyle = "#fbbf24";
        waveCtx.fillText(label, cx + 3, topY + 10);
      }
    }

    // Draw Deck Playhead Needle
    const px = curRatio * W;
    waveCtx.strokeStyle = "#ffffff";
    waveCtx.lineWidth = 2;
    waveCtx.beginPath();
    waveCtx.moveTo(px, topY);
    waveCtx.lineTo(px, topY + halfH);
    waveCtx.stroke();
  }
}

const PRIMITIVE_COLORS: Record<string, string> = {
  baby: "#f59e0b",
  stab: "#fbbf24",
  cut_forward: "#38bdf8",
  transform: "#c084fc",
  flare: "#22d3ee",
  chirp: "#fb923c",
  tear: "#a3e635",
  crab: "#f472b6",
  rest: "#64748b",
};

scopeCanvas.style.cursor = "pointer";
scopeCanvas.title = "Click any placed scratch event block to cycle its primitive · Shift+Click to drop live";
scopeCanvas.addEventListener("click", async e => {
  if (!lastAgentOutput?.result) return;
  const res = lastAgentOutput.result;
  const rect = scopeCanvas.getBoundingClientRect();
  const clickRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / Math.max(1, rect.width)));
  const bpm = mixer.info()?.effBpm ?? slots[mixer.active]?.analysis.bpm ?? 124;
  const totalSec = res.plan.bars * 4 * (60 / bpm);
  const clickSec = clickRatio * totalSec;

  let hitIdx = -1;
  for (let i = 0; i < res.events.length; i++) {
    const ev = res.events[i];
    const dur = ev.n_strokes * ev.stroke_T;
    if (clickSec >= ev.t0 - 0.04 && clickSec <= ev.t0 + dur + 0.04) {
      hitIdx = i;
      break;
    }
  }
  if (hitIdx >= 0) {
    if (e.shiftKey) await mixer.ctx.resume();
    const updated = mixer.cycleScratchAgentEventPrimitive(lastAgentOutput, hitIdx, e.shiftKey);
    if (updated) {
      lastAgentOutput = updated;
      renderAgentInspector(updated);
      toast(updated.message);
    }
  }
});

function drawScratchScope(telemetry: ReturnType<typeof mixer.scratchTelemetry>) {
  const W = scopeCanvas.width;
  const H = scopeCanvas.height;
  scopeCtx.fillStyle = "#07090d";
  scopeCtx.fillRect(0, 0, W, H);

  const showAgentTimeline =
    lastAgentOutput?.result &&
    (telemetry.patternId === "agent" || !telemetry.active);

  if (showAgentTimeline && lastAgentOutput?.result) {
    const res = lastAgentOutput.result;
    const bpm = mixer.info()?.effBpm ?? slots[mixer.active]?.analysis.bpm ?? 124;
    const totalSec = res.plan.bars * 4 * (60 / bpm);

    // Center line
    scopeCtx.strokeStyle = "rgba(255,255,255,0.08)";
    scopeCtx.lineWidth = 1;
    scopeCtx.beginPath();
    scopeCtx.moveTo(0, H * 0.5);
    scopeCtx.lineTo(W, H * 0.5);
    scopeCtx.stroke();

    // Beat grid lines across the phrase
    const totalBeats = res.plan.bars * 4;
    for (let b = 0; b <= totalBeats; b++) {
      const x = (b / totalBeats) * W;
      const isBar = b % 4 === 0;
      scopeCtx.strokeStyle = isBar ? "rgba(251, 191, 36, 0.32)" : "rgba(255, 255, 255, 0.09)";
      scopeCtx.lineWidth = isBar ? 1.5 : 1;
      scopeCtx.beginPath();
      scopeCtx.moveTo(x, 0);
      scopeCtx.lineTo(x, H);
      scopeCtx.stroke();
    }

    // Placed 90s ScratchEvent blocks (baby, stab, cut_forward, transform)
    scopeCtx.font = "600 8px 'JetBrains Mono', monospace";
    for (const ev of res.events) {
      const x0 = (ev.t0 / totalSec) * W;
      const dur = ev.n_strokes * ev.stroke_T;
      const w = Math.max(4, (dur / totalSec) * W);
      const col = PRIMITIVE_COLORS[ev.primitive] ?? "#f59e0b";
      scopeCtx.fillStyle = `${col}2e`;
      scopeCtx.strokeStyle = col;
      scopeCtx.lineWidth = 1;
      scopeCtx.fillRect(x0, 3, w, H - 6);
      scopeCtx.strokeRect(x0, 3, w, H - 6);
      if (w > 24) {
        scopeCtx.fillStyle = "#f8fafc";
        scopeCtx.fillText(ev.primitive.slice(0, 5).toUpperCase(), x0 + 3, 12);
      }
    }

    // Rendered Kaiser-windowed sinc scratch audio waveform overlay
    const audio = res.audio;
    const step = Math.max(1, Math.floor(audio.length / W));
    scopeCtx.strokeStyle = telemetry.active ? "#fbbf24" : "#f59e0b";
    scopeCtx.lineWidth = 1.3;
    scopeCtx.beginPath();
    for (let px = 0; px < W; px++) {
      let pk = 0;
      const base = px * step;
      for (let j = 0; j < step && base + j < audio.length; j++) {
        const v = audio[base + j];
        if (Math.abs(v) > Math.abs(pk)) pk = v;
      }
      const y = H * 0.55 - Math.max(-1, Math.min(1, pk)) * (H * 0.36);
      if (px === 0) scopeCtx.moveTo(px, y);
      else scopeCtx.lineTo(px, y);
    }
    scopeCtx.stroke();

    // Live playhead needle when active
    if (telemetry.active) {
      const cx = telemetry.progress * W;
      scopeCtx.strokeStyle = "#ffffff";
      scopeCtx.lineWidth = 1.8;
      scopeCtx.beginPath();
      scopeCtx.moveTo(cx, 0);
      scopeCtx.lineTo(cx, H);
      scopeCtx.stroke();
    }
    return;
  }

  // 16th-note precision grid lines on Pad / Manual Scratch Scope
  for (let gIdx = 1; gIdx < 8; gIdx++) {
    const gx = (gIdx / 8) * W;
    scopeCtx.strokeStyle = gIdx % 2 === 0 ? "rgba(251, 191, 36, 0.2)" : "rgba(255, 255, 255, 0.06)";
    scopeCtx.lineWidth = 1;
    scopeCtx.beginPath();
    scopeCtx.moveTo(gx, 0);
    scopeCtx.lineTo(gx, H);
    scopeCtx.stroke();
  }

  scopeCtx.strokeStyle = "rgba(255,255,255,0.1)";
  scopeCtx.lineWidth = 1;
  scopeCtx.beginPath();
  scopeCtx.moveTo(0, H * 0.5);
  scopeCtx.lineTo(W, H * 0.5);
  scopeCtx.stroke();

  const curve = telemetry.curveSamples;
  const gate = telemetry.gateSamples;
  const len = curve.length;

  // VCA Gate Bar along bottom
  for (let i = 0; i < len; i++) {
    const x = (i / len) * W;
    const g = gate[i];
    scopeCtx.fillStyle = g > 0.25 ? "rgba(245, 158, 11, 0.22)" : "rgba(100, 116, 139, 0.12)";
    scopeCtx.fillRect(x, H - 7, W / len + 0.5, 7);
  }

  // Vinyl Platter Displacement Trajectory
  scopeCtx.strokeStyle = telemetry.active ? "#fbbf24" : "#94a3b8";
  scopeCtx.lineWidth = 1.8;
  scopeCtx.beginPath();
  for (let i = 0; i < len; i++) {
    const x = (i / (len - 1)) * W;
    const normY = H * 0.5 - Math.max(-1, Math.min(1, curve[i])) * (H * 0.36);
    if (i === 0) scopeCtx.moveTo(x, normY);
    else scopeCtx.lineTo(x, normY);
  }
  scopeCtx.stroke();

  if (telemetry.active) {
    const cx = telemetry.progress * W;
    scopeCtx.strokeStyle = "#ffffff";
    scopeCtx.lineWidth = 1.5;
    scopeCtx.beginPath();
    scopeCtx.moveTo(cx, 0);
    scopeCtx.lineTo(cx, H);
    scopeCtx.stroke();
  }
}

// 12. Online Radio Station Autonomous Broadcast & Webhook Hub
function toggleRadioBroadcast(forceState?: boolean) {
  const isLive = radio.toggleOnAir(forceState);
  const badge = $("radioOnAirBadge");
  const onAirBtn = $("radioMasterOnAirBtn");
  const topbarBtn = $("radioBroadcastBtn");
  const topbarLabel = $("radioBroadcastLabel");

  if (badge) badge.classList.toggle("live", isLive);
  if ($("radioOnAirText")) $("radioOnAirText").textContent = isLive ? "RADIO: ON AIR (LIVE)" : "RADIO: STANDBY";
  if (onAirBtn) {
    onAirBtn.classList.toggle("live", isLive);
    onAirBtn.innerHTML = isLive ? "<span>🔴 TRANSMITTING (ON AIR)</span>" : "<span>📻 GO ON AIR (TRANSMIT)</span>";
  }
  if (topbarBtn) {
    topbarBtn.classList.toggle("active", isLive);
    topbarBtn.setAttribute("aria-pressed", String(isLive));
  }
  if (topbarLabel) {
    topbarLabel.textContent = isLive ? "ON AIR: LIVE" : "ON AIR: STANDBY";
  }

  toast(isLive ? "📻 Radio Broadcast LIVE — Master Feed Streaming On Air" : "Radio Broadcast in Standby");
  void syncRadioStateToServer();
}

function renderSweeperButtons() {
  const container = $("sweepersGrid");
  if (!container) return;
  container.innerHTML = "";
  radio.sweepers.forEach(s => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sweeper-btn";
    btn.innerHTML = `<span>${s.name}</span><small class="mono">${s.durationSec.toFixed(1)}s</small>`;
    btn.title = `Inject ${s.name} with -7.5dB music sidechain ducking`;
    btn.onclick = async () => {
      await mixer.ctx.resume();
      btn.classList.add("playing");
      const ok = radio.triggerJingle(s.id);
      if (ok) {
        toast(`🎙️ Radio Sweeper Injected: ${s.name} (-7.5dB music ducking active)`);
        renderSweeperButtons();
      }
      setTimeout(() => btn.classList.remove("playing"), (s.durationSec + 0.3) * 1000);
    };
    container.appendChild(btn);
  });
  if ($("jinglesCountBadge")) {
    $("jinglesCountBadge").textContent = `${radio.totalJinglesPlayed} JINGLES FIRED`;
  }
}

function renderRadioRequests() {
  const tbody = $("radioRequestsTableBody");
  if (!tbody) return;
  if (!radio.songRequests.length) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align: center; color: #64748b; padding: 12px;">No incoming listener requests. Submit via <code>POST /api/radio/request</code> or click "+ Simulate Request" above.</td></tr>`;
    if ($("requestCountBadge")) $("requestCountBadge").textContent = "0";
    return;
  }
  if ($("requestCountBadge")) $("requestCountBadge").textContent = String(radio.songRequests.length);
  tbody.innerHTML = "";
  radio.songRequests.forEach(req => {
    const tr = document.createElement("tr");
    const statusColor = req.status === "queued" ? "#34d399" : req.status === "played" ? "#94a3b8" : "#fbbf24";
    tr.innerHTML = `
      <td>${req.timeFormatted}</td>
      <td><strong>${req.requester}</strong></td>
      <td>${req.query}${req.message ? ` <em style="color:#94a3b8;">("${req.message}")</em>` : ""}</td>
      <td style="color: ${statusColor}; font-weight: 700;">${req.status.toUpperCase()}</td>
      <td>
        ${req.status === "pending" ? `<button type="button" class="btn-micro" data-req-act="queue" data-req-id="${req.id}" title="Accept & queue track">+ Queue</button>` : ""}
        <button type="button" class="btn-micro" data-req-act="del" data-req-id="${req.id}" title="Remove request">✕</button>
      </td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll<HTMLButtonElement>("button[data-req-act]").forEach(btn => {
    btn.onclick = () => {
      const act = btn.dataset.reqAct;
      const id = btn.dataset.reqId;
      if (!id) return;
      if (act === "queue") {
        const reqItem = radio.songRequests.find(r => r.id === id);
        if (reqItem) {
          radio.updateRequestStatus(id, "queued");
          const qLower = reqItem.query.toLowerCase();
          const match = crate.find(t => t.name.toLowerCase().includes(qLower) || t.artist.toLowerCase().includes(qLower)) || crate[Math.floor(Math.random() * crate.length)];
          if (match) {
            queue.push(match);
            renderQueue();
            toast(`📥 Listener Request Queued: "${match.name}" for ${reqItem.requester}`);
          }
          renderRadioRequests();
        }
      } else if (act === "del") {
        radio.songRequests = radio.songRequests.filter(r => r.id !== id);
        renderRadioRequests();
      }
    };
  });
}

async function syncRadioStateToServer() {
  const activeTrack = slots[mixer.active] ?? slots[0];
  if (!activeTrack) return;
  const idleTrack = slots[mixer.idle] ?? queue[0];
  const curOff = mixer.decks[mixer.active]?.currentOffset() || 0;
  const activeDuration = mixer.decks[mixer.active]?.buffer?.duration || 180;
  const idleDuration = mixer.decks[mixer.idle]?.buffer?.duration || 180;

  const payload = radio.buildNowPlayingPayload(
    {
      id: activeTrack.id,
      name: activeTrack.name,
      artist: activeTrack.artist,
      genre: activeTrack.genre,
      analysis: activeTrack.analysis,
      duration: activeDuration,
    },
    curOff,
    idleTrack
      ? {
          id: idleTrack.id,
          name: idleTrack.name,
          artist: idleTrack.artist,
          analysis: idleTrack.analysis,
          duration: idleDuration,
        }
      : undefined
  );

  try {
    const res = await fetch("/api/radio/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.commands && Array.isArray(data.commands)) {
        for (const cmd of data.commands) {
          handleRemoteRadioCommand(cmd);
        }
      }
    }
  } catch {}
}

function handleRemoteRadioCommand(cmd: { command: string; param?: any }) {
  if (cmd.command === "skip") {
    void triggerPrimaryAction();
    toast(`📡 Remote Radio Command Executed: Skip Track`);
  } else if (cmd.command === "play") {
    void mixer.ctx.resume().then(() => {
      mixer.play();
      toast(`📡 Remote Radio Command Executed: Play`);
    });
  } else if (cmd.command === "pause") {
    mixer.pause();
    toast(`📡 Remote Radio Command Executed: Pause`);
  } else if (cmd.command === "jingle") {
    radio.triggerJingle();
    toast(`📡 Remote Radio Command Executed: Inject Station Jingle`);
  } else if (cmd.command === "vibe" && typeof cmd.param === "string") {
    const tpl = templates.find(t => t.id === cmd.param);
    if (tpl) {
      selectedTemplateId = tpl.id;
      $("marathonArcLabel").textContent = `ENERGY ARC: ${tpl.name.toUpperCase()}`;
      autoSequenceQueueSilently();
      renderQueue();
      renderPartyTemplates();
      saveBoothPrefs();
      toast(`📡 Remote Radio Command Executed: Set Vibe to ${tpl.name}`);
    }
  }
}

function onTrackTransitionTriggered(incomingTrack?: { id: string; name: string; artist: string; genre: string; analysis: TrackAnalysis }) {
  radio.checkAutomationRules(true);
  if ($("jinglesCountBadge")) {
    $("jinglesCountBadge").textContent = `${radio.totalJinglesPlayed} JINGLES FIRED`;
  }

  // Outbound Webhook dispatch
  if (radio.config.autoWebhookOnTrackChange && radio.config.webhookUrl && incomingTrack) {
    const nextItem = queue[0];
    const payload = radio.buildNowPlayingPayload(
      {
        id: incomingTrack.id,
        name: incomingTrack.name,
        artist: incomingTrack.artist,
        genre: incomingTrack.genre,
        analysis: incomingTrack.analysis,
        duration: 180,
      },
      0,
      nextItem
        ? {
            id: nextItem.id,
            name: nextItem.name,
            artist: nextItem.artist,
            analysis: nextItem.analysis,
            duration: nextItem.buffer?.duration || 180,
          }
        : undefined
    );
    void radio.dispatchWebhook(payload).then(res => {
      const badge = $("webhookStatusBadge");
      if (badge) {
        badge.textContent = res.success ? "DELIVERED" : "FAILED";
        badge.classList.toggle("active", res.success);
      }
    });
  }

  void syncRadioStateToServer();
}

function initRadioStation() {
  $("radioBroadcastBtn")?.addEventListener("click", () => toggleRadioBroadcast());
  $("radioMasterOnAirBtn")?.addEventListener("click", () => toggleRadioBroadcast());

  const dspBtn = $<HTMLButtonElement>("radioDspToggleBtn");
  dspBtn?.addEventListener("click", () => {
    radio.config.broadcastDspEnabled = !radio.config.broadcastDspEnabled;
    dspBtn.classList.toggle("active", radio.config.broadcastDspEnabled);
    dspBtn.setAttribute("aria-pressed", String(radio.config.broadcastDspEnabled));
    dspBtn.textContent = `FM BROADCAST DSP: ${radio.config.broadcastDspEnabled ? "ON" : "OFF"}`;
    toast(`FM Broadcast DSP ${radio.config.broadcastDspEnabled ? "Enabled (Multiband Limiter + Warmth)" : "Bypassed"}`);
  });

  $<HTMLInputElement>("radioStationNameInput")?.addEventListener("input", e => {
    radio.config.stationName = (e.target as HTMLInputElement).value;
    void syncRadioStateToServer();
  });

  $<HTMLInputElement>("radioSloganInput")?.addEventListener("input", e => {
    radio.config.slogan = (e.target as HTMLInputElement).value;
    void syncRadioStateToServer();
  });

  $<HTMLInputElement>("radioMountInput")?.addEventListener("input", e => {
    radio.config.mountPoint = (e.target as HTMLInputElement).value;
  });

  $<HTMLSelectElement>("radioBitrateSelect")?.addEventListener("change", e => {
    const br = parseInt((e.target as HTMLSelectElement).value, 10) || 192;
    radio.config.bitrateKbps = br;
    if ($("embedStreamMeta")) $("embedStreamMeta").textContent = `${br} KBPS HD`;
  });

  $<HTMLSelectElement>("autoJingleSelect")?.addEventListener("change", e => {
    const val = (e.target as HTMLSelectElement).value;
    radio.config.autoJingleInterval = val === "top-of-hour" ? "top-of-hour" : parseInt(val, 10);
    toast(`Auto-Jingle Rotation: ${val === "top-of-hour" ? "Top of Hour Clock" : val === "0" ? "Off (Manual Only)" : `Every ${val} Tracks`}`);
  });

  $<HTMLInputElement>("customJingleFileInput")?.addEventListener("change", async e => {
    const files = (e.target as HTMLInputElement).files;
    if (files && files[0]) {
      try {
        const added = await radio.addCustomJingle(files[0]);
        renderSweeperButtons();
        toast(`Custom Radio Jingle Imported: "${added.name}"`);
      } catch {
        toast("Failed to decode custom jingle file. Try MP3 or WAV.");
      }
    }
  });

  $("triggerRandomJingleBtn")?.addEventListener("click", async () => {
    await mixer.ctx.resume();
    const ok = radio.triggerJingle();
    if (ok) toast("⚡ Dropped Random Station Sweeper (-7.5dB ducking active)");
  });

  $<HTMLInputElement>("webhookUrlInput")?.addEventListener("input", e => {
    radio.config.webhookUrl = (e.target as HTMLInputElement).value.trim();
  });

  $<HTMLSelectElement>("webhookFormatSelect")?.addEventListener("change", e => {
    radio.config.webhookFormat = (e.target as HTMLSelectElement).value as any;
  });

  $<HTMLInputElement>("autoWebhookCheck")?.addEventListener("change", e => {
    radio.config.autoWebhookOnTrackChange = (e.target as HTMLInputElement).checked;
  });

  $("testWebhookBtn")?.addEventListener("click", async () => {
    if (!radio.config.webhookUrl) {
      return toast("Please enter an Outbound Webhook URL first");
    }
    toast("Sending test now-playing payload to radio webhook...");
    const activeTrack = slots[mixer.active] ?? slots[0];
    const payload = radio.buildNowPlayingPayload(
      {
        id: activeTrack?.id || "test-1",
        name: activeTrack?.name || "Midnight Warehouse",
        artist: activeTrack?.artist || "Studio Syndicate",
        genre: activeTrack?.genre || "Peak Time Techno",
        analysis: activeTrack?.analysis || { bpm: 124, key: "8A" },
        duration: 180,
      },
      30,
      queue[0]
        ? {
            id: queue[0].id,
            name: queue[0].name,
            artist: queue[0].artist,
            analysis: queue[0].analysis,
            duration: queue[0].buffer?.duration || 180,
          }
        : undefined
    );
    const res = await radio.dispatchWebhook(payload);
    const badge = $("webhookStatusBadge");
    if (badge) {
      badge.textContent = res.success ? "CONNECTED" : "ERROR";
      badge.classList.toggle("active", res.success);
    }
    toast(res.message);
  });

  $<HTMLInputElement>("autoApproveRequestsCheck")?.addEventListener("change", e => {
    radio.config.autoApproveRequests = (e.target as HTMLInputElement).checked;
    toast(`Inbound Requests: ${radio.config.autoApproveRequests ? "Auto-Approve & Queue ON" : "Manual Approval"}`);
  });

  $("clearRequestsBtn")?.addEventListener("click", () => {
    radio.songRequests = [];
    renderRadioRequests();
    toast("Listener requests cleared");
  });

  $("simulateRequestBtn")?.addEventListener("click", () => {
    const sampleRequesters = ["Lucas (Berlin)", "Elena (London)", "Carlos (Miami)", "Yuki (Tokyo)", "Sam (Montreal)"];
    const sampleMessages = ["Drop some heavy bass!", "Great set, keep it rolling!", "Can we hear some underground acid?", "Love from the rooftop party!"];
    const randomTrack = crate[Math.floor(Math.random() * crate.length)];
    const req = radio.submitSongRequest({
      query: randomTrack?.name || "Acid Warehouse 303",
      requester: sampleRequesters[Math.floor(Math.random() * sampleRequesters.length)],
      message: sampleMessages[Math.floor(Math.random() * sampleMessages.length)],
    });
    renderRadioRequests();
    toast(`New Listener Request Ingested from ${req.requester}`);
  });

  $("copyEmbedBtn")?.addEventListener("click", () => {
    const html = radio.generateEmbedWidgetHtml();
    void navigator.clipboard.writeText(html).then(() => {
      toast("📋 Live Radio Player Embed Snippet copied to clipboard!");
    }).catch(() => {
      toast("Snippet ready in console");
    });
  });

  $("copyNowPlayingApiBtn")?.addEventListener("click", () => {
    const apiUrl = `${window.location.origin}/api/radio/nowplaying`;
    void navigator.clipboard.writeText(apiUrl).then(() => {
      toast(`📋 Now-Playing JSON API URL copied: ${apiUrl}`);
    }).catch(() => {
      toast(`API: ${apiUrl}`);
    });
  });

  $("testFailoverBtn")?.addEventListener("click", () => {
    toast("🚨 Simulating Silence Dead-Air: Failover Audio Recovery Triggered!");
    const idleSlot = mixer.idle;
    const failoverTrack = crate[Math.floor(Math.random() * crate.length)];
    if (failoverTrack) {
      void loadTrackIntoDeck(idleSlot, failoverTrack).then(() => {
        void triggerPrimaryAction();
      });
    }
  });

  // OBS Studio Live DJ Broadcast Suite & 1kHz Calibration Tone
  let obsToneOsc: OscillatorNode | null = null;
  let obsToneGain: GainNode | null = null;

  $("openObsOverlayBtn")?.addEventListener("click", () => {
    const overlayUrl = `${window.location.origin}${window.location.pathname}#obs-overlay`;
    window.open(overlayUrl, "OBS_Ticker_Overlay", "width=800,height=160,resizable=yes,scrollbars=no");
    toast("📹 Opened OBS Live Ticker Overlay Window (Add as Browser Source in OBS)");
  });

  $("toggleObsToneBtn")?.addEventListener("click", async () => {
    await mixer.ctx.resume();
    const btn = $<HTMLButtonElement>("toggleObsToneBtn");
    if (obsToneOsc) {
      obsToneOsc.stop();
      obsToneOsc.disconnect();
      obsToneOsc = null;
      obsToneGain = null;
      btn.classList.remove("active");
      btn.textContent = "🔊 1KHZ CALIBRATION TONE: OFF";
      toast("OBS Reference Calibration Tone Stopped");
    } else {
      obsToneOsc = mixer.ctx.createOscillator();
      obsToneGain = mixer.ctx.createGain();
      obsToneOsc.frequency.value = 1000;
      obsToneGain.gain.value = 0.25; // -12dBFS
      obsToneOsc.connect(obsToneGain);
      obsToneGain.connect(mixer.getMasterOutputNode());
      obsToneOsc.start();
      btn.classList.add("active");
      btn.textContent = "🔊 1KHZ CALIBRATION TONE: ON (-12dBFS)";
      toast("🔊 Playing 1kHz -12dBFS Calibration Tone — Adjust OBS Audio Fader to exactly -12dB");
    }
  });

  renderSweeperButtons();
  renderRadioRequests();

  // Initial populate with 2 sample listener requests
  radio.submitSongRequest({
    query: "Midnight Warehouse",
    requester: "Alex (Berlin)",
    message: "Drop some heavy acid synth please!",
  });
  radio.submitSongRequest({
    query: "Neon Ignition",
    requester: "Maya (Tokyo)",
    message: "Great groove today, love the station!",
  });
  renderRadioRequests();

  // Periodic server state sync (every 3 seconds)
  setInterval(() => {
    void syncRadioStateToServer();
  }, 3000);
}

// 13. Initialize Built-In Studio Crate
async function loadPersistedUserCrateTracks() {
  try {
    const saved = await loadPersistedCrateTracks();
    if (!saved || !saved.length) {
      updateCrateStatsReadout();
      return;
    }
    let restored = 0;
    for (const rec of saved) {
      if (crate.some(t => t.id === rec.id)) continue;
      const analysis: TrackAnalysis = {
        bpm: rec.bpm,
        firstBeat: 0.08,
        key: rec.key,
        keyName: rec.keyName,
        energy: rec.energy,
        rmsDb: rec.rmsDb,
        autoGainDb: rec.autoGainDb,
        cuePoints: rec.cuePoints,
        waveform: {
          low: new Float32Array(rec.waveformLow || []),
          mid: new Float32Array(rec.waveformMid || []),
          high: new Float32Array(rec.waveformHigh || []),
          peaks: new Float32Array(rec.waveformPeaks || []),
          energyCurve: new Float32Array(rec.waveformEnergy || []),
        },
        categorization: {
          genre: rec.genre,
          energyTier: rec.energyTier,
          tags: rec.tags,
          mood: rec.mood,
          harmonicMood: rec.harmonicMood,
          parsedFromTag: true,
        },
      };

      const item: CrateTrack = {
        id: rec.id,
        name: rec.name,
        artist: rec.artist,
        genre: rec.genre,
        tags: rec.tags,
        energyTier: rec.energyTier,
        file: rec.fileBlob ? new File([rec.fileBlob], rec.fileName || `${rec.name}.mp3`, { type: rec.fileBlob.type }) : undefined,
        analysis,
        playCount: rec.playCount || 0,
        lastPlayedAtMs: rec.lastPlayedAtMs,
        dateAddedMs: rec.dateAddedMs || Date.now(),
        persistedToIdb: true,
      };
      crate.push(item);
      restored++;
    }
    if (restored > 0) {
      renderCrateCards();
      updateCrateStatsReadout();
    }
  } catch {
    // Non-fatal
  }
}

function bootstrapStudioCrate() {
  for (const spec of BUILTIN_TRACK_SPECS) {
    const buf = synthesizeStudioTrack(mixer.ctx, spec);
    const tempSlot = crate.length < 2 ? (crate.length as 0 | 1) : 1;
    const analysis = mixer.loadBuffer(tempSlot, buf);
    const acousticMeta = categorizeTrackAcoustics(analysis, {
      genre: spec.genre,
      bpm: spec.bpm,
      key: spec.camelot,
    });
    analysis.categorization = acousticMeta;

    const item: CrateTrack = {
      id: spec.id,
      name: spec.title,
      artist: spec.artist,
      genre: acousticMeta.genre,
      tags: acousticMeta.tags,
      energyTier: acousticMeta.energyTier,
      buffer: buf,
      analysis,
      dateAddedMs: Date.now(),
    };
    crate.push(item);
  }

  // Auto-sequence the entire built-in crate by the active Party Template energy curve on startup
  const tpl = getActiveTemplate();
  const sequenced = sequenceCrateForParty(
    { bpm: crate[0]?.analysis.bpm ?? 124, key: crate[0]?.analysis.key ?? "8A" },
    crate.slice(1),
    tpl.energyCurve,
    0
  );
  const deckATrack = crate[0];
  const deckBTrack = sequenced[0] ?? crate[1];
  const remainingQueue = sequenced.slice(1);

  if (deckATrack?.buffer) {
    const a0 = mixer.loadBuffer(0, deckATrack.buffer, deckATrack.analysis);
    slots[0] = {
      id: deckATrack.id,
      name: deckATrack.name,
      artist: deckATrack.artist,
      genre: deckATrack.genre,
      analysis: a0,
    };
    updateDeckStaticLabels(0);
  }
  if (deckBTrack?.buffer) {
    const a1 = mixer.loadBuffer(1, deckBTrack.buffer, deckBTrack.analysis);
    slots[1] = {
      id: deckBTrack.id,
      name: deckBTrack.name,
      artist: deckBTrack.artist,
      genre: deckBTrack.genre,
      analysis: a1,
    };
    mixer.syncDeck(1);
    syncPitchSlidersFromDecks();
    updateDeckStaticLabels(1);
  }
  queue.push(...remainingQueue);
  renderCrateCards();
  renderQueue();
  updateCrateStatsReadout();
  updateRamAndWakeBadge();
  void loadPersistedUserCrateTracks();

  // Sync persisted booth toggle UI states & pre-stage the 90s Scratch Agent scope
  autoPilotBtn.setAttribute("aria-pressed", String(autoPilotEnabled));
  autoPilotBtn.innerHTML = `<span class="switch-led"></span><span>Auto-DJ: ${autoPilotEnabled ? "On" : "Off"}</span>`;
  autoScratchToggle.classList.toggle("active", autoScratchDrops);
  autoScratchToggle.setAttribute("aria-pressed", String(autoScratchDrops));
  autoScratchToggle.textContent = `AUTO-SCRATCH DROPS: ${autoScratchDrops ? "ON" : "OFF"}`;
  autoGainToggle.classList.toggle("active", mixer.autoGainEnabled);
  autoGainToggle.setAttribute("aria-pressed", String(mixer.autoGainEnabled));
  autoGainToggle.textContent = `AUTO-GAIN: ${mixer.autoGainEnabled ? "ON" : "OFF"}`;
  document.querySelectorAll<HTMLButtonElement>("[data-cf-curve]").forEach(b => {
    b.classList.toggle("active", b.dataset.cfCurve === mixer.crossfaderCurve);
  });
  document.querySelectorAll<HTMLButtonElement>("[data-marathon-mins]").forEach(b => {
    b.classList.toggle("active", parseInt(b.dataset.marathonMins || "240", 10) === marathonDurationMins);
  });
  void autoStageScratchRoutine();
  initRadioStation();
}
bootstrapStudioCrate();

// 12. Main 60fps UI & Physics Loop
function tick(nowPerf = performance.now()) {
  const dt = Math.min(0.1, Math.max(0.001, (nowPerf - lastFrameTime) / 1000));
  lastFrameTime = nowPerf;

  const info = mixer.info();
  const playing = !!info;
  document.body.classList.toggle("playing", playing);

  const scratch = mixer.scratchTelemetry();

  const shown = info ? slots[info.deck] : slots[0];
  const nextSlot = slots[mixer.idle];
  setTxt("title", shown?.name ?? "Nothing playing yet");
  setTxt(
    "meta",
    info
      ? `${info.effBpm.toFixed(1)} BPM / Key ${shown?.analysis.key ?? "8A"} (${shown?.analysis.keyName ?? "Minor"})`
      : shown
        ? `${shown.analysis.bpm.toFixed(1)} BPM / Key ${shown.analysis.key ?? "8A"} Ready`
        : "Load audio below to start"
  );

  setStyleProp("fill", "width", info ? `${(info.elapsed / info.duration) * 100}%` : "0%");
  setTxt("elapsed", fmt(info?.elapsed ?? 0));
  setTxt("left", `-${fmt(info?.remaining ?? 0)}`);
  setStyleProp("ring", "strokeDashoffset", String(RING * (1 - (info?.fade ?? 0))));

  const masterBpm = info?.effBpm ?? shown?.analysis.bpm ?? 124;
  setTxt("masterBpmReadout", `${masterBpm.toFixed(1)} BPM`);
  midiEngine.syncMidiClockOutput(playing, masterBpm);
  const match = evaluateHarmonicMatch(shown?.analysis.key, nextSlot?.analysis.key);
  setTxt("harmonicReadout", match.label.replace("→", "to"));

  // Live Kick Drum Phase Pocket & Transient Offset
  const phaseInfo = mixer.getPhaseDifferenceInfo();
  const kickBadge = $("kickPhaseReadout");
  if (kickBadge) {
    if (phaseInfo && mixer.decks[0].playing && mixer.decks[1].playing) {
      kickBadge.classList.remove("in-pocket", "drag", "lead");
      if (phaseInfo.inPhase) {
        kickBadge.classList.add("in-pocket");
        kickBadge.textContent = `PHASE: LOCK (${phaseInfo.phaseDiffMs >= 0 ? "+" : ""}${phaseInfo.phaseDiffMs}ms)`;
      } else if (phaseInfo.phaseDiffMs < 0) {
        kickBadge.classList.add("drag");
        kickBadge.textContent = `PHASE: DRAG ${phaseInfo.phaseDiffMs}ms`;
      } else {
        kickBadge.classList.add("lead");
        kickBadge.textContent = `PHASE: LEAD +${phaseInfo.phaseDiffMs}ms`;
      }
    } else {
      kickBadge.className = "oled-phase-badge in-pocket";
      kickBadge.textContent = "PHASE: READY";
    }
  }

  // Halftime / Doubletime tempo match assistant
  const multCluster = $("tempoMultCluster");
  if (multCluster) {
    const activeMeta = slots[mixer.active];
    const idleSlot = mixer.idle as 0 | 1;
    const idleMeta = slots[idleSlot];
    if (activeMeta && idleMeta && Math.abs(activeMeta.analysis.bpm - idleMeta.analysis.bpm) > 8) {
      const cand = detectTempoMultiplierCandidate(activeMeta.analysis.bpm, idleMeta.analysis.bpm);
      if (cand.isHalfOrDouble) {
        multCluster.style.display = "inline-flex";
        multCluster.innerHTML = `
          <button type="button" class="mult-btn" data-mult="0.5" title="Match half-time tempo (${cand.halfBpm} BPM)">1/2x ${cand.halfBpm}</button>
          <button type="button" class="mult-btn" data-mult="1" title="Match straight tempo (${cand.straightBpm} BPM)">1x ${cand.straightBpm}</button>
          <button type="button" class="mult-btn" data-mult="2" title="Match double-time tempo (${cand.doubleBpm} BPM)">2x ${cand.doubleBpm}</button>
        `;
        multCluster.querySelectorAll<HTMLButtonElement>(".mult-btn").forEach(b => {
          b.onclick = async () => {
            await mixer.ctx.resume();
            const m = parseFloat(b.dataset.mult || "1") as 1 | 2 | 0.5;
            mixer.syncDeckTempo(idleSlot, m);
            syncPitchSlidersFromDecks();
            toast(`Deck ${idleSlot === 0 ? "A" : "B"} matched ${m}x tempo (${activeMeta.analysis.bpm * m} BPM)`);
          };
        });
      } else {
        multCluster.style.display = "none";
      }
    } else {
      multCluster.style.display = "none";
    }
  }

  updatePitchedKeyBadge(0);
  updatePitchedKeyBadge(1);

  if (info) {
    const barNum = Math.floor(info.elapsed / ((60 / info.effBpm) * 4)) + 1;
    setTxt("beatCountReadout", `Bar ${barNum} / Beat ${info.beatInBar + 1}`);
    setTxt(
      "phraseCountdown",
      mixer.busy
        ? `BLENDING ${Math.round(info.fade * 100)}%`
        : `NEXT BAR IN ${info.nextBarIn.toFixed(1)}S`
    );
  } else {
    setTxt("beatCountReadout", "Bar 1 / Beat 1");
    setTxt("phraseCountdown", "BAR SYNC READY");
  }

  for (let slot = 0 as 0 | 1; slot <= 1; slot = (slot + 1) as 0 | 1) {
    const d = mixer.decks[slot];
    const prefix = slot === 0 ? "A" : "B";
    const curOff = d.currentOffset();
    const dur = d.buffer?.duration ?? 0;
    setTxt(`deck${prefix}Elapsed`, fmt(curOff));
    setTxt(`deck${prefix}Remaining`, `-${fmt(Math.max(0, dur - curOff))}`);

    const isMaster = mixer.active === slot;
    const deckPlayBtn = $(`deckPlay${prefix}`);
    if (deckPlayBtn) {
      deckPlayBtn.classList.toggle("active", d.playing);
      deckPlayBtn.textContent = d.playing ? `PAUSE ${prefix}` : `PLAY ${prefix}`;
    }

    setTxt(
      `deck${prefix}StatusText`,
      mixer.busy
        ? "MIXING"
        : d.playing
          ? isMaster
            ? "ON AIR"
            : "BLENDING"
          : isMaster
            ? "MASTER"
            : "CUED"
    );

    let platterSpeed = 0;
    if (scratch.active && scratch.deck === slot) {
      platterSpeed = scratch.velocity;
    } else if (d.playing) {
      platterSpeed = d.rate;
    }
    platterAngles[slot] = (platterAngles[slot] + platterSpeed * 200 * dt) % 360;
    const rotor = document.getElementById(`vinylRotor${prefix}`);
    if (rotor) {
      rotor.setAttribute("transform", `rotate(${platterAngles[slot].toFixed(1)} 110 110)`);
    }
    setTxt(
      `platter${prefix}Readout`,
      scratch.active && scratch.deck === slot
        ? `SCRATCH ${scratch.velocity >= 0 ? "+" : ""}${scratch.velocity.toFixed(2)}x`
        : playing && isMaster
          ? `${(33.3 * platterSpeed).toFixed(1)} RPM`
          : "CUED"
    );

    const level = d.getLevel();
    setStyleProp(`vuFill${prefix}`, "height", `${Math.max(6, Math.round(level * 100))}%`);

    setTxt(
      `simpleDeckStatus${prefix}`,
      mixer.busy
        ? "MIXING"
        : d.playing
          ? isMaster
            ? "PLAYING (MASTER)"
            : "BLENDING"
          : isMaster
            ? "READY (MASTER)"
            : "CUED (NEXT)"
    );
    const simpleDisc = $(`simpleDisc${prefix}`);
    if (simpleDisc) {
      simpleDisc.style.animationPlayState = d.playing ? "running" : "paused";
    }
  }

  const crossfaderInput = $<HTMLInputElement>("crossfaderInput");
  if (mixer.busy && crossfaderInput) {
    crossfaderInput.value = mixer.crossfader.toFixed(2);
  }

  const simpleTransBtn = $<HTMLButtonElement>("simpleTransitionBtn");
  const padBtn = $<HTMLButtonElement>("pad");
  if (padBtn) {
    if (!mixer.playing) {
      padBtn.disabled = !slots[0];
      setTxt("padlabel", slots[0] ? "START PARTY" : "ADD SONGS");
      setTxt("upnext", slots[1] ? `Next: ${slots[1].name}` : "");
      if (simpleTransBtn) {
        simpleTransBtn.disabled = !slots[0];
        simpleTransBtn.innerHTML = "<span>START PARTY →</span>";
      }
    } else if (mixer.busy) {
      padBtn.disabled = true;
      setTxt("padlabel", "MIXING");
      setTxt("upnext", `Into ${slots[mixer.active]?.name ?? "Next Track"}`);
      if (simpleTransBtn) {
        simpleTransBtn.disabled = true;
        simpleTransBtn.innerHTML = "<span>BLENDING TRACKS...</span>";
      }
    } else {
      padBtn.disabled = !nextSlot;
      setTxt("padlabel", "SMART MIX");
      setTxt(
        "upnext",
        nextSlot
          ? `Next: ${nextSlot.name} (${nextSlot.analysis.bpm.toFixed(0)} BPM)`
          : queue.length || loading
            ? "Loading next..."
            : "Pick track below"
      );
      if (simpleTransBtn) {
        simpleTransBtn.disabled = !nextSlot;
        simpleTransBtn.innerHTML = nextSlot
          ? `<span>SMART TRANSITION TO ${nextSlot.name.toUpperCase()} →</span>`
          : "<span>QUEUE TRACK TO MIX →</span>";
      }
    }
  }

  if (autoPilotEnabled && info && !mixer.busy && nextSlot) {
    const activeCueOutro = shown?.analysis.cuePoints?.outro ?? info.duration - 12;
    const secPerBar = (60 / info.effBpm) * 4;
    // Optional Auto-Scratch Drop 6 bars before the outro transition (active only in Advanced Mode)
    if (
      uiMode === "advanced" &&
      autoScratchDrops &&
      shown?.id &&
      autoScratchFiredForTrackId !== shown.id &&
      !scratch.active &&
      info.elapsed >= Math.max(4, activeCueOutro - 6 * secPerBar) &&
      info.elapsed < activeCueOutro - secPerBar
    ) {
      autoScratchFiredForTrackId = shown.id;
      void trigger90sScratchAgent(true);
    }

    if (info.elapsed >= activeCueOutro || info.remaining <= 10) {
      const { preset, autoReason } = resolveActiveTransitionPreset();
      const r = mixer.next(preset);
      if (r.ok) {
        freePending = true;
        logTrackToSetlist(nextSlot, preset.name, r.harmonicLabel);
        onTrackTransitionTriggered(nextSlot);
        const modeTag = autoReason ? `Auto ${preset.name}` : preset.name;
        toast(`Auto-DJ triggered ${modeTag} into ${nextSlot.name} (${r.harmonicLabel})`);
      }
    }
  }

  if (freePending && !mixer.busy) {
    slots[mixer.idle] = undefined;
    freePending = false;
    if (queue.length === 0 && crate.length > 1) {
      const activeMeta = slots[mixer.active];
      const exclude = new Set<string>(activeMeta ? [activeMeta.id] : []);
      const picked = pickNextMarathonTrack(
        { bpm: activeMeta?.analysis.bpm ?? 124, key: activeMeta?.analysis.key ?? "8A" },
        crate,
        exclude,
        getCurrentTargetEnergy()
      );
      if (picked) {
        queue.push(picked.track);
      }
    }
    void fill().then(() => {
      evictIdleCrateBuffers();
      void autoStageScratchRoutine();
    });
  }

  // Master Bus & Marathon Telemetry Readouts
  const masterBus = mixer.getMasterTelemetry();
  if (masterBus.recordingActive) {
    setTxt("recSetLabel", `REC ${fmt(masterBus.recordingElapsedSec)}`);
  }
  const grText =
    masterBus.limiterReductionDb < -0.1
      ? `GR ${masterBus.limiterReductionDb.toFixed(1)}dB`
      : `PK ${masterBus.masterPeakDb > -55 ? masterBus.masterPeakDb.toFixed(1) : "-INF"}dB`;
  setTxt("masterBusReadout", `LIM ${grText} / AG ${masterBus.autoGainEnabled ? "ON" : "OFF"}`);

  // Radio Station Broadcast Telemetry & Silence Watchdog
  if (radio.isOnAir && radio.startedAtMs > 0) {
    const totalSec = Math.floor((Date.now() - radio.startedAtMs) / 1000);
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    const uptimeStr = `${String(hrs).padStart(2, "0")}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
    setTxt("radioUptimeBadge", `UPTIME: ${uptimeStr}`);
    setTxt("radioBroadcastLabel", `ON AIR: ${uptimeStr}`);
  }
  if (shown) {
    setTxt("embedTrackTitle", shown.name);
    setTxt("embedTrackArtist", `${shown.artist} (${shown.analysis.bpm.toFixed(0)} BPM)`);
    setTxt("obsBpmReadout", `${shown.analysis.bpm.toFixed(1)} BPM / ${shown.analysis.key ?? "8A"}`);
    setTxt("obsPreviewTitle", shown.name);
    setTxt("obsPreviewArtist", `${shown.artist} · Up Next: ${nextSlot?.name ?? "End of Queue"}`);
  }

  // 24/7 Radio Silence Watchdog & Dead Air Failover Protection
  const watchdogResult = radio.checkSilenceWatchdog(masterBus.masterPeakDb);
  const watchdogLed = $("watchdogLed");
  if (watchdogLed) {
    watchdogLed.className = watchdogResult.deadAirDetected ? "watchdog-led dead" : "watchdog-led green";
  }
  if (watchdogResult.deadAirDetected && !mixer.busy && crate.length > 0) {
    toast("🚨 24/7 Radio Watchdog: Silence Detected — Engaging Emergency Failover Track");
    const failoverTrack = crate[Math.floor(Math.random() * crate.length)];
    if (failoverTrack) {
      void loadTrackIntoDeck(mixer.idle, failoverTrack).then(() => {
        void triggerPrimaryAction();
      });
    }
  }

  const targetEnergyPct = Math.round(getCurrentTargetEnergy() * 100);
  setTxt("targetEnergyReadout", `TARGET ENERGY ${targetEnergyPct}%`);
  const elapsedMinTotal = sessionStartedAtMs && mixer.playing
    ? Math.floor((Date.now() - sessionStartedAtMs) / 60000)
    : 0;
  const elapsedHrs = Math.floor(elapsedMinTotal / 60);
  const elapsedMinsRem = elapsedMinTotal % 60;
  const clockStr = `${String(elapsedHrs).padStart(2, "0")}:${String(elapsedMinsRem).padStart(2, "0")}`;
  const durLabel = marathonDurationMins > 0 ? `${marathonDurationMins / 60}H` : "INF";
  setTxt("sessionClockReadout", `SET ${clockStr} / ${durLabel}`);

  document.querySelectorAll<HTMLButtonElement>(".scratch-pad-btn").forEach(btn => {
    btn.classList.toggle("active", scratch.active && btn.dataset.scratchId === scratch.patternId);
  });
  const activeDeckModCount = mixer.decks[mixer.active].modCount;
  setTxt(
    "trackModReadout",
    activeDeckModCount > 0
      ? `${activeDeckModCount} SPLICE${activeDeckModCount === 1 ? "" : "S"} IN DECK ${mixer.active === 0 ? "A" : "B"}`
      : "0 SPLICES IN TRACK"
  );
  const restoreBtn = $<HTMLButtonElement>("restoreTrackModBtn");
  if (restoreBtn) restoreBtn.disabled = activeDeckModCount === 0;

  toggleClass("gateDot", "cut", !scratch.faderOpen);
  setTxt("faderGateText", scratch.faderOpen ? "GATE OPEN" : "GATE CUT");
  setTxt(
    "scratchAnchorBadge",
    scratch.active && scratch.cutSampleLabel
      ? `${scratch.cutSampleLabel} · ${mixer.scratchCutMode === "mag-four" ? "MAG-4" : "VCA"}`
      : `M44-7 · 32-TAP SINC · ${mixer.scratchCutMode === "mag-four" ? "0.55MS MAG-4" : "1.6MS VCA"}`
  );
  setTxt(
    "activeScratchName",
    scratch.active
      ? `${scratch.patternName} (Gate ${Math.round(scratch.faderGain * 100)}%)`
      : lastAgentOutput?.result
        ? `90s Agent (${lastAgentOutput.result.plan.bars}B ${lastAgentOutput.result.plan.style.toUpperCase()} / ${lastAgentOutput.result.events.length} events)`
        : "90s Agent Ready (Press DROP 90S CUT, Key G, or Keys 1-8)"
  );
  setTxt("activeScratchVel", `${scratch.velocity >= 0 ? "+" : ""}${scratch.velocity.toFixed(2)}x`);

  drawParallelWaveforms();
  drawScratchScope(scratch);
  drawEnergyCurve();
  drawDeckSpectrum(0, deckSpectrumCanvasA, deckSpectrumCtxA, mixer.decks[0].playing);
  drawDeckSpectrum(1, deckSpectrumCanvasB, deckSpectrumCtxB, mixer.decks[1].playing);

  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
