import React, { useCallback, useEffect, useRef, useState } from 'react';
import { StyleSheet } from 'react-native';
import Video, { type VideoRef } from 'react-native-video';
import type {
  OnBufferData,
  OnLoadData,
  OnPlaybackStateChangedData,
  OnProgressData,
  OnTimedMetadataData,
  OnVideoErrorData,
} from 'react-native-video';
import {
  emitEngine,
  registerEngine,
  type EngineState,
  type MediaDescriptor,
} from './engine';

/**
 * The single audio player for the app.
 *
 * Rendered once at the root. It is audio-only — the `<Video>` has zero size and
 * no controls — but it uses react-native-video as the transport (the same MIT
 * library the Watch screen uses for video). This component owns the audio
 * session, so playback survives navigation and the device lock.
 *
 * `react-native-video` is a component, so the transport cannot be a module
 * singleton the way the old player was. The `engine` facade in `./engine` gives
 * UI-free callers an imperative handle; this component registers it on mount.
 *
 * Live-edge note: an Icecast mp3 cannot seek, so "jump to live" remounts the
 * player (a fresh HTTP request) rather than seeking. That also makes it the
 * correct recovery for a stall or a dropped connection.
 */
export function PlaybackEngine() {
  const ref = useRef<VideoRef>(null);
  const [media, setMedia] = useState<MediaDescriptor | null>(null);
  const [paused, setPaused] = useState(true);
  const [volume, setVolume] = useState(1);
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<EngineState>('idle');

  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const stateRef = useRef(state);
  stateRef.current = state;

  const updateState = useCallback((next: EngineState) => {
    if (stateRef.current === next) return;
    stateRef.current = next;
    setState(next);
    emitEngine({ type: 'state', state: next });
  }, []);

  useEffect(() => {
    registerEngine({
      play: () => setPaused(false),
      pause: () => setPaused(true),
      toggle: () => setPaused((p) => !p),
      isPlaying: () =>
        !pausedRef.current &&
        stateRef.current !== 'idle' &&
        stateRef.current !== 'error',
      setVolume: (v) => setVolume(Math.max(0, Math.min(1, v))),
      jumpToLive: () => {
        setMedia((current) => {
          if (current) setReloadKey((k) => k + 1);
          return current;
        });
        updateState('loading');
      },
      load: (next) => {
        setMedia(next);
        setPaused(false);
        updateState('loading');
      },
      state: () => stateRef.current,
    });
    return () => registerEngine(null);
  }, [updateState]);

  const onError = useCallback(
    (e: OnVideoErrorData) => {
      const code = e.error?.errorCode ?? (e.error?.code != null ? String(e.error.code) : undefined);
      const message =
        e.error?.localizedDescription ??
        e.error?.errorString ??
        e.error?.localizedFailureReason;
      updateState('error');
      emitEngine({ type: 'error', error: { code, message } });
    },
    [updateState],
  );

  const onBuffer = useCallback(
    (e: OnBufferData) => {
      if (e.isBuffering) {
        updateState('buffering');
      } else if (stateRef.current !== 'error') {
        updateState(pausedRef.current ? 'paused' : 'playing');
      }
    },
    [updateState],
  );

  const onPlaybackState = useCallback(
    (e: OnPlaybackStateChangedData) => {
      if (e.isPlaying) updateState('playing');
      else if (pausedRef.current) updateState('paused');
      // Not playing and not intended-paused means a stall: leave the last state
      // so the watchdog can see it and recover.
    },
    [updateState],
  );

  const onProgress = useCallback((e: OnProgressData) => {
    emitEngine({ type: 'progress', positionSec: e.currentTime });
  }, []);

  const onLoad = useCallback(
    (_e: OnLoadData) => {
      if (stateRef.current !== 'error') {
        updateState(pausedRef.current ? 'paused' : 'playing');
      }
    },
    [updateState],
  );

  const onTimedMetadata = useCallback((e: OnTimedMetadataData) => {
    // ICY stream titles, when the encoder sends them. The now-playing UI still
    // reads `GET /api/nowplaying`; this only sharpens the lock-screen title.
    const title = e.metadata?.find(
      (m) => m.identifier === 'title' || m.identifier === 'StreamTitle',
    )?.value;
    if (title) emitEngine({ type: 'metadata', title });
  }, []);

  if (!media) return null;

  return (
    <Video
      key={reloadKey}
      ref={ref}
      source={{
        uri: media.url,
        metadata: {
          title: media.title,
          artist: media.artist,
          imageUri: media.artwork,
        },
      }}
      style={styles.hidden}
      paused={paused}
      volume={volume}
      playInBackground
      showNotificationControls
      ignoreSilentSwitch="ignore"
      progressUpdateInterval={1000}
      repeat={false}
      onError={onError}
      onBuffer={onBuffer}
      onProgress={onProgress}
      onLoad={onLoad}
      onPlaybackStateChanged={onPlaybackState}
      onTimedMetadata={onTimedMetadata}
    />
  );
}

const styles = StyleSheet.create({
  hidden: { width: 0, height: 0 },
});
