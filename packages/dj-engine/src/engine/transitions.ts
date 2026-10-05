import type { TransitionPreset } from "./types";
import type { Deck } from "./deck";

/**
 * Bar length assumed when the caller's tempo is unusable. At 120bpm this is
 * exactly two seconds, so a degraded transition still behaves like a transition
 * rather than a jump cut or an unbounded fade.
 */
const FALLBACK_SEC_PER_BAR = 2;

/**
 * Schedules dynamic, fast-acting real DJ transitions with rich variety:
 * - Drop Slam (1 bar / instant drop)
 * - Club Bass Swap (2-4 bars, clean low-end handoff)
 * - Filter Riser Sweep (2-4 bars high-pass tension build)
 * - Vinyl Motor Brake (turntable spindown into drop)
 * - Backspin Whip (fast spinback whip on deck A into deck B)
 * - Echo Out Wash (high-pass dub decay)
 * - Smooth Phrase Blend (4-8 bars equal power)
 */
export function runTransition(
  from: Deck,
  to: Deck,
  p: TransitionPreset,
  startAt: number,
  secPerBar: number
): number {
  const bars = Math.max(0.5, p.bars || 2);
  /**
   * Every duration below feeds setValueCurveAtTime / setTargetAtTime / ramps,
   * and those reject non-finite times. secPerBar comes from the active deck's
   * effective tempo, so one bad bpm anywhere upstream turns every fade length
   * into NaN and the first scheduling call throws - after the caller has already
   * muted the incoming deck and unmuted the outgoing one, which is the worst
   * possible moment to discover it.
   *
   * 0.5s is a defensible floor for any transition at any tempo: it is shorter
   * than a 16th note at 190bpm, so it still reads as a cut rather than a pause.
   */
  const safeStartAt = Number.isFinite(startAt) ? startAt : 0;
  const safeSecPerBar =
    Number.isFinite(secPerBar) && secPerBar > 0 ? secPerBar : FALLBACK_SEC_PER_BAR;
  const dur = bars * safeSecPerBar;

  const fromVol = from.channelVolume;
  const toVol = to.channelVolume;
  const style = p.style || (p.id === "quick" || p.id === "drop-cut" ? "drop-cut" : p.id === "bass-swap" ? "bass-swap" : p.id === "filter" ? "filter-riser" : p.id === "vinyl-brake" ? "vinyl-brake" : p.id === "backspin" ? "backspin" : p.id === "echo-out" ? "echo-out" : "blend");

  // 1. Drop Slam / Quick Cut (Instant or 1-bar phrase slam)
  if (style === "drop-cut" || p.curve === "cut" || dur <= safeSecPerBar * 0.5) {
    const cutDur = Math.min(0.04, safeSecPerBar * 0.25);
    from.out.gain.cancelScheduledValues(safeStartAt);
    from.out.gain.setValueAtTime(fromVol, safeStartAt);
    from.out.gain.linearRampToValueAtTime(0, safeStartAt + cutDur);

    to.out.gain.cancelScheduledValues(safeStartAt);
    to.out.gain.setValueAtTime(0, safeStartAt);
    to.out.gain.linearRampToValueAtTime(toVol, safeStartAt + cutDur);
    return safeStartAt + Math.max(cutDur, safeSecPerBar * 0.5);
  }

  // 2. Vinyl Motor Brake Drop (Authentic turntable power-down into drop)
  if (style === "vinyl-brake") {
    const brakeDur = Math.min(dur * 0.85, safeSecPerBar * 1.5);
    from.vinylBrake(safeStartAt, brakeDur, 0.04);
    from.out.gain.cancelScheduledValues(safeStartAt);
    from.out.gain.setValueAtTime(fromVol, safeStartAt);
    from.out.gain.exponentialRampToValueAtTime(0.001, safeStartAt + brakeDur);

    // Incoming deck launches full power right at the start or halfway through the spindown
    to.out.gain.cancelScheduledValues(safeStartAt);
    to.out.gain.setValueAtTime(0, safeStartAt);
    to.out.gain.linearRampToValueAtTime(toVol, safeStartAt + brakeDur * 0.4);
    return safeStartAt + brakeDur + 0.05;
  }

  // 3. Backspin Whip Drop (Turntablist spinback into incoming drop)
  if (style === "backspin") {
    const spinDur = Math.min(dur * 0.75, safeSecPerBar * 1.2);
    from.filter.frequency.cancelScheduledValues(safeStartAt);
    from.filter.frequency.setValueAtTime(10, safeStartAt);
    from.filter.frequency.exponentialRampToValueAtTime(3200, safeStartAt + spinDur);
    from.filter.frequency.setValueAtTime(10, safeStartAt + spinDur + 0.1);

    from.out.gain.cancelScheduledValues(safeStartAt);
    from.out.gain.setValueAtTime(fromVol, safeStartAt);
    from.out.gain.exponentialRampToValueAtTime(0.001, safeStartAt + spinDur);

    to.out.gain.cancelScheduledValues(safeStartAt);
    to.out.gain.setValueAtTime(0, safeStartAt);
    to.out.gain.linearRampToValueAtTime(toVol, safeStartAt + spinDur * 0.5);
    return safeStartAt + spinDur + 0.08;
  }

  // 4. Echo Out Wash
  if (style === "echo-out") {
    const washDur = Math.min(dur, safeSecPerBar * 2);
    from.filter.frequency.cancelScheduledValues(safeStartAt);
    from.filter.frequency.setValueAtTime(10, safeStartAt);
    from.filter.frequency.exponentialRampToValueAtTime(4500, safeStartAt + washDur);
    from.filter.frequency.setValueAtTime(10, safeStartAt + washDur + 0.1);

    from.out.gain.cancelScheduledValues(safeStartAt);
    from.out.gain.setValueAtTime(fromVol, safeStartAt);
    from.out.gain.exponentialRampToValueAtTime(0.001, safeStartAt + washDur);

    to.out.gain.cancelScheduledValues(safeStartAt);
    to.out.gain.setValueAtTime(0, safeStartAt);
    to.out.gain.linearRampToValueAtTime(toVol, safeStartAt + safeSecPerBar * 0.5);
    return safeStartAt + washDur;
  }

  // 5. Filter Riser Sweep (High-pass buildup on outgoing deck)
  if (style === "filter-riser" || p.filterSweep) {
    const end = safeStartAt + dur;
    from.filter.frequency.cancelScheduledValues(safeStartAt);
    from.filter.frequency.setValueAtTime(10, safeStartAt);
    from.filter.frequency.exponentialRampToValueAtTime(5800, end);
    from.filter.frequency.setValueAtTime(10, end + 0.12);

    // Fade curves
    const N = 32;
    const fadeOut = new Float32Array(N);
    const fadeIn = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      fadeOut[i] = Math.cos((t * Math.PI) / 2) * fromVol;
      fadeIn[i] = Math.sin((t * Math.PI) / 2) * toVol;
    }
    from.out.gain.cancelScheduledValues(safeStartAt);
    to.out.gain.cancelScheduledValues(safeStartAt);
    from.out.gain.setValueCurveAtTime(fadeOut, safeStartAt, dur);
    to.out.gain.setValueCurveAtTime(fadeIn, safeStartAt, dur);

    // Cut outgoing bass during the last half of the riser
    const midTime = safeStartAt + dur * 0.4;
    from.lowEq.gain.cancelScheduledValues(safeStartAt);
    from.lowEq.gain.setValueAtTime(from.lowDb, safeStartAt);
    from.lowEq.gain.linearRampToValueAtTime(-48, midTime);
    from.lowEq.gain.setValueAtTime(from.lowDb, end + 0.15);
    return end;
  }

  // 6. Club Bass Swap (Tight 2-4 bar low-end handoff)
  if (style === "bass-swap" || p.bassSwap) {
    const end = safeStartAt + dur;
    const midTime = safeStartAt + dur * 0.5;
    const toTargetLow = to.lowKill ? -48 : to.lowDb;
    const fromStartLow = from.lowKill ? -48 : from.lowDb;

    // Outgoing deck keeps bass until midpoint, then swaps out cleanly
    from.lowEq.gain.cancelScheduledValues(safeStartAt);
    from.lowEq.gain.setValueAtTime(fromStartLow, safeStartAt);
    from.lowEq.gain.setValueAtTime(fromStartLow, midTime - 0.05);
    from.lowEq.gain.linearRampToValueAtTime(-48, midTime + 0.05);
    from.lowEq.gain.setValueAtTime(fromStartLow, end + 0.15);

    // Incoming deck holds bass kill until midpoint, then drops full club punch
    to.lowEq.gain.cancelScheduledValues(safeStartAt);
    to.lowEq.gain.setValueAtTime(-48, safeStartAt);
    to.lowEq.gain.setValueAtTime(-48, midTime - 0.05);
    to.lowEq.gain.linearRampToValueAtTime(toTargetLow, midTime + 0.05);

    // High/mid volume curve
    const N = 32;
    const fadeOut = new Float32Array(N);
    const fadeIn = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      fadeOut[i] = Math.cos((t * Math.PI) / 2) * fromVol;
      fadeIn[i] = Math.sin((t * Math.PI) / 2) * toVol;
    }
    from.out.gain.cancelScheduledValues(safeStartAt);
    to.out.gain.cancelScheduledValues(safeStartAt);
    from.out.gain.setValueCurveAtTime(fadeOut, safeStartAt, dur);
    to.out.gain.setValueCurveAtTime(fadeIn, safeStartAt, dur);
    return end;
  }

  // 7. Standard Fast Smooth Blend
  const end = safeStartAt + dur;
  const N = 32;
  const fadeOut = new Float32Array(N);
  const fadeIn = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    fadeOut[i] = (p.curve === "equal-power" ? Math.cos((t * Math.PI) / 2) : 1 - t) * fromVol;
    fadeIn[i] = (p.curve === "equal-power" ? Math.sin((t * Math.PI) / 2) : t) * toVol;
  }
  from.out.gain.cancelScheduledValues(safeStartAt);
  to.out.gain.cancelScheduledValues(safeStartAt);
  from.out.gain.setValueCurveAtTime(fadeOut, safeStartAt, dur);
  to.out.gain.setValueCurveAtTime(fadeIn, safeStartAt, dur);

  return end;
}
