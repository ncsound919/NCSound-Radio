import type { TransitionPreset } from "./types";
import type { Deck } from "./deck";

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
  const dur = bars * secPerBar;
  const fromVol = from.channelVolume;
  const toVol = to.channelVolume;
  const style = p.style || (p.id === "quick" || p.id === "drop-cut" ? "drop-cut" : p.id === "bass-swap" ? "bass-swap" : p.id === "filter" ? "filter-riser" : p.id === "vinyl-brake" ? "vinyl-brake" : p.id === "backspin" ? "backspin" : p.id === "echo-out" ? "echo-out" : "blend");

  // 1. Drop Slam / Quick Cut (Instant or 1-bar phrase slam)
  if (style === "drop-cut" || p.curve === "cut" || dur <= secPerBar * 0.5) {
    const cutDur = Math.min(0.04, secPerBar * 0.25);
    from.out.gain.cancelScheduledValues(startAt);
    from.out.gain.setValueAtTime(fromVol, startAt);
    from.out.gain.linearRampToValueAtTime(0, startAt + cutDur);

    to.out.gain.cancelScheduledValues(startAt);
    to.out.gain.setValueAtTime(0, startAt);
    to.out.gain.linearRampToValueAtTime(toVol, startAt + cutDur);
    return startAt + Math.max(cutDur, secPerBar * 0.5);
  }

  // 2. Vinyl Motor Brake Drop (Authentic turntable power-down into drop)
  if (style === "vinyl-brake") {
    const brakeDur = Math.min(dur * 0.85, secPerBar * 1.5);
    from.vinylBrake(startAt, brakeDur, 0.04);
    from.out.gain.cancelScheduledValues(startAt);
    from.out.gain.setValueAtTime(fromVol, startAt);
    from.out.gain.exponentialRampToValueAtTime(0.001, startAt + brakeDur);

    // Incoming deck launches full power right at the start or halfway through the spindown
    to.out.gain.cancelScheduledValues(startAt);
    to.out.gain.setValueAtTime(0, startAt);
    to.out.gain.linearRampToValueAtTime(toVol, startAt + brakeDur * 0.4);
    return startAt + brakeDur + 0.05;
  }

  // 3. Backspin Whip Drop (Turntablist spinback into incoming drop)
  if (style === "backspin") {
    const spinDur = Math.min(dur * 0.75, secPerBar * 1.2);
    from.filter.frequency.cancelScheduledValues(startAt);
    from.filter.frequency.setValueAtTime(10, startAt);
    from.filter.frequency.exponentialRampToValueAtTime(3200, startAt + spinDur);
    from.filter.frequency.setValueAtTime(10, startAt + spinDur + 0.1);

    from.out.gain.cancelScheduledValues(startAt);
    from.out.gain.setValueAtTime(fromVol, startAt);
    from.out.gain.exponentialRampToValueAtTime(0.001, startAt + spinDur);

    to.out.gain.cancelScheduledValues(startAt);
    to.out.gain.setValueAtTime(0, startAt);
    to.out.gain.linearRampToValueAtTime(toVol, startAt + spinDur * 0.5);
    return startAt + spinDur + 0.08;
  }

  // 4. Echo Out Wash
  if (style === "echo-out") {
    const washDur = Math.min(dur, secPerBar * 2);
    from.filter.frequency.cancelScheduledValues(startAt);
    from.filter.frequency.setValueAtTime(10, startAt);
    from.filter.frequency.exponentialRampToValueAtTime(4500, startAt + washDur);
    from.filter.frequency.setValueAtTime(10, startAt + washDur + 0.1);

    from.out.gain.cancelScheduledValues(startAt);
    from.out.gain.setValueAtTime(fromVol, startAt);
    from.out.gain.exponentialRampToValueAtTime(0.001, startAt + washDur);

    to.out.gain.cancelScheduledValues(startAt);
    to.out.gain.setValueAtTime(0, startAt);
    to.out.gain.linearRampToValueAtTime(toVol, startAt + secPerBar * 0.5);
    return startAt + washDur;
  }

  // 5. Filter Riser Sweep (High-pass buildup on outgoing deck)
  if (style === "filter-riser" || p.filterSweep) {
    const end = startAt + dur;
    from.filter.frequency.cancelScheduledValues(startAt);
    from.filter.frequency.setValueAtTime(10, startAt);
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
    from.out.gain.cancelScheduledValues(startAt);
    to.out.gain.cancelScheduledValues(startAt);
    from.out.gain.setValueCurveAtTime(fadeOut, startAt, dur);
    to.out.gain.setValueCurveAtTime(fadeIn, startAt, dur);

    // Cut outgoing bass during the last half of the riser
    const midTime = startAt + dur * 0.4;
    from.lowEq.gain.cancelScheduledValues(startAt);
    from.lowEq.gain.setValueAtTime(from.lowDb, startAt);
    from.lowEq.gain.linearRampToValueAtTime(-48, midTime);
    from.lowEq.gain.setValueAtTime(from.lowDb, end + 0.15);
    return end;
  }

  // 6. Club Bass Swap (Tight 2-4 bar low-end handoff)
  if (style === "bass-swap" || p.bassSwap) {
    const end = startAt + dur;
    const midTime = startAt + dur * 0.5;
    const toTargetLow = to.lowKill ? -48 : to.lowDb;
    const fromStartLow = from.lowKill ? -48 : from.lowDb;

    // Outgoing deck keeps bass until midpoint, then swaps out cleanly
    from.lowEq.gain.cancelScheduledValues(startAt);
    from.lowEq.gain.setValueAtTime(fromStartLow, startAt);
    from.lowEq.gain.setValueAtTime(fromStartLow, midTime - 0.05);
    from.lowEq.gain.linearRampToValueAtTime(-48, midTime + 0.05);
    from.lowEq.gain.setValueAtTime(fromStartLow, end + 0.15);

    // Incoming deck holds bass kill until midpoint, then drops full club punch
    to.lowEq.gain.cancelScheduledValues(startAt);
    to.lowEq.gain.setValueAtTime(-48, startAt);
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
    from.out.gain.cancelScheduledValues(startAt);
    to.out.gain.cancelScheduledValues(startAt);
    from.out.gain.setValueCurveAtTime(fadeOut, startAt, dur);
    to.out.gain.setValueCurveAtTime(fadeIn, startAt, dur);
    return end;
  }

  // 7. Standard Fast Smooth Blend
  const end = startAt + dur;
  const N = 32;
  const fadeOut = new Float32Array(N);
  const fadeIn = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    fadeOut[i] = (p.curve === "equal-power" ? Math.cos((t * Math.PI) / 2) : 1 - t) * fromVol;
    fadeIn[i] = (p.curve === "equal-power" ? Math.sin((t * Math.PI) / 2) : t) * toVol;
  }
  from.out.gain.cancelScheduledValues(startAt);
  to.out.gain.cancelScheduledValues(startAt);
  from.out.gain.setValueCurveAtTime(fadeOut, startAt, dur);
  to.out.gain.setValueCurveAtTime(fadeIn, startAt, dur);

  return end;
}
