/**
 * Sleep timer: countdown, then a short volume fade, then pause.
 *
 * The fade is part of the state machine, not a fire-and-forget animation, so a
 * listener who reopens the app mid-fade sees the true remaining time. Pure and
 * clock-injected: `advance(deltaMs)` is driven by the app's own interval.
 */

export type SleepPhase = "idle" | "counting" | "fading" | "done";

export type SleepState = {
  phase: SleepPhase;
  /** Total requested duration, ms. */
  durationMs: number;
  /** Time left before the fade begins, ms (>= 0). */
  remainingMs: number;
  /** 0..1 multiplier the player should apply while fading. */
  volume: number;
};

export type SleepTimer = {
  getState(): SleepState;
  /** Each callback advances the clock; returns the new state. */
  advance(deltaMs: number): SleepState;
  cancel(): SleepState;
};

export function createSleepTimer(durationMs: number, fadeMs = 3000): SleepTimer {
  let state: SleepState = {
    phase: durationMs > 0 ? "counting" : "idle",
    durationMs,
    remainingMs: Math.max(0, durationMs),
    volume: 1,
  };

  function advance(deltaMs: number): SleepState {
    if (state.phase === "idle" || state.phase === "done") return state;

    if (state.phase === "counting") {
      const remainingMs = state.remainingMs - Math.max(0, deltaMs);
      if (remainingMs > 0) {
        state = { ...state, remainingMs };
        return state;
      }
      const overshoot = -remainingMs;
      state = { phase: "fading", durationMs, remainingMs: 0, volume: 1 };
      return advance(overshoot);
    }

    // fading
    const fadeProgress = fadeMs > 0 ? Math.min(1, Math.max(0, deltaMs) / fadeMs) : 1;
    const volume = Math.max(0, state.volume - fadeProgress);
    if (volume <= 0) {
      state = { ...state, phase: "done", volume: 0 };
      return state;
    }
    state = { ...state, volume };
    return state;
  }

  function cancel(): SleepState {
    state = { phase: "idle", durationMs, remainingMs: 0, volume: 1 };
    return state;
  }

  return {
    getState: () => state,
    advance,
    cancel,
  };
}
