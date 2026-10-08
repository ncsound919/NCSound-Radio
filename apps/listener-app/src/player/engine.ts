/**
 * The imperative playback facade.
 *
 * The player is a React component (`PlaybackEngine`), because react-native-video
 * is a component, not a singleton module. But UI-free callers (the sleep timer,
 * the video/audio hand-off, and non-hook screens) still need to drive one shared
 * player without holding React state. So the mounted engine registers itself
 * here and everyone else calls through this facade.
 *
 * Every method is a no-op before the engine mounts, so callers never guard for
 * "player not ready". This is deliberate: the old library exposed a module
 * singleton, and code that assumed it could not throw must keep working.
 */

export type EngineState =
  | 'idle'
  | 'loading'
  | 'buffering'
  | 'playing'
  | 'paused'
  | 'error';

export type EngineError = {
  /** react-native-video `errorCode` (Android) or a domain code (iOS). */
  code?: string;
  /** Human-readable reason, for the health policy and the logs. */
  message?: string;
};

export type MediaDescriptor = {
  url: string;
  title?: string;
  artist?: string;
  artwork?: string;
};

export type EngineHandle = {
  play(): void;
  pause(): void;
  toggle(): void;
  isPlaying(): boolean;
  setVolume(volume: number): void;
  /** Reconnect at the live edge. A live Icecast mp3 has no seek, so this
   *  reopens the stream rather than seeking to a position. */
  jumpToLive(): void;
  load(media: MediaDescriptor): void;
  state(): EngineState;
};

let handle: EngineHandle | null = null;

export function registerEngine(next: EngineHandle | null): void {
  handle = next;
}

export const engine: EngineHandle = {
  play: () => handle?.play(),
  pause: () => handle?.pause(),
  toggle: () => handle?.toggle(),
  isPlaying: () => handle?.isPlaying() ?? false,
  setVolume: (volume) => handle?.setVolume(volume),
  jumpToLive: () => handle?.jumpToLive(),
  load: (media) => handle?.load(media),
  state: () => handle?.state() ?? 'idle',
};

// --- event bus --------------------------------------------------------------
// The mounted engine pushes these; the reconnect/watchdog policy subscribes.
// Kept separate from the handle so the policy can be attached before the engine
// mounts (initPlayback runs at app launch).

export type EngineEvent =
  | { type: 'state'; state: EngineState }
  | { type: 'error'; error: EngineError }
  | { type: 'progress'; positionSec: number }
  | { type: 'metadata'; title?: string; artist?: string };

type EngineListener = (event: EngineEvent) => void;

const listeners = new Set<EngineListener>();

export function subscribeEngine(listener: EngineListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitEngine(event: EngineEvent): void {
  for (const listener of listeners) listener(event);
}
