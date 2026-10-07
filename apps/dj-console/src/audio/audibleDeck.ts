/**
 * Which deck the OBS overlay should announce (plan 6.4).
 *
 * The audible deck is the one with the most gain after its channel fader and
 * the crossfader, but it must hold that position for `holdMs` before the
 * overlay switches — otherwise a quick scratch or a one-beat cut flips the
 * title mid-stream. Pure and time-injectable so it can be unit-tested.
 */
export type DeckLevel = { playing: boolean; gain: number };

export class AudibleDeckTracker {
  private current: 0 | 1 | null = null;
  private candidate: 0 | 1 | null = null;
  private candidateSince = 0;

  constructor(private readonly holdMs = 4000) {}

  get slot(): 0 | 1 | null {
    return this.current;
  }

  update(nowMs: number, levels: [DeckLevel, DeckLevel]): 0 | 1 | null {
    const rank = (i: 0 | 1) => (levels[i].playing ? levels[i].gain : -1);
    const a = rank(0);
    const b = rank(1);

    let best: 0 | 1 | null = null;
    if (a > 0 || b > 0) best = a >= b ? 0 : 1;

    // Nothing audible: keep the current choice (the track may resume) rather
    // than blanking the overlay on a momentary fade.
    if (best === null) {
      this.candidate = null;
      return this.current;
    }

    if (best === this.current) {
      this.candidate = null;
      return this.current;
    }

    // First audible deck shows immediately; later switches must hold.
    if (this.current === null) {
      this.current = best;
      this.candidate = null;
      return this.current;
    }

    if (this.candidate !== best) {
      this.candidate = best;
      this.candidateSince = nowMs;
      return this.current;
    }

    if (nowMs - this.candidateSince >= this.holdMs) {
      this.current = best;
      this.candidate = null;
    }
    return this.current;
  }
}
