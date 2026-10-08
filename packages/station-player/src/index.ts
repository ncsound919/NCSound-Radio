/**
 * @ncsound/listener-app — platform-agnostic playback logic.
 *
 * The React Native shell (screens, RNTP wiring, native projects) is added by the
 * scaffold step in docs/MOBILE-LISTENER-APP-IMPLEMENTATION.md §5. This module is
 * what that shell calls; keeping it pure means it is unit-tested without a device.
 */

export { qualityFor, selectMount, playbackUrl } from "./player/mounts";
export {
  classifyPlaybackError,
  createStallWatchdog,
  DEFAULT_RETRY,
  nextRetry,
  shouldReloadOnConnectivity,
} from "./player/reconnect";
export type { PlaybackErrorKind, RetryConfig, RetryDecision } from "./player/reconnect";
export { createSleepTimer } from "./player/sleep";
export type { SleepPhase, SleepState, SleepTimer } from "./player/sleep";
