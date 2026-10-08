import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { engine } from '../player/engine';
import { useSession } from '../auth/session';
import { useNowPlaying, usePrefs } from '../data/hooks';
import { STATION_REF, useIsFavorite, useToggleFavorite } from '../data/favorites';
import { setDataSaver } from '../data/prefs';
import { qualityFor } from '../data/streams';
import { playLive } from '../player/live';
import { cancelSleepTimer, startSleepTimer } from '../player/sleepTimer';
import { colors, radius, spacing, typography } from '../ui/tokens';

export function PlayerScreen() {
  const { data } = useNowPlaying();
  const prefs = usePrefs();
  const { user } = useSession();
  const isFavorite = useIsFavorite('station', STATION_REF);
  const toggleFavorite = useToggleFavorite();
  const [sleepMin, setSleepMin] = useState<number | null>(null);
  const [favMsg, setFavMsg] = useState<string | null>(null);

  const current = data?.current ?? null;
  const mode = data?.mode;

  function togglePlay(): void {
    if (engine.isPlaying()) {
      engine.pause();
      return;
    }
    if (engine.state() === 'idle') {
      // Nothing loaded yet — a first "play" starts the live stream.
      playLive(qualityFor(prefs.dataSaver));
      return;
    }
    engine.play();
  }

  function jumpToLive(): void {
    engine.jumpToLive();
  }

  function setSleep(min: number | null): void {
    setSleepMin(min);
    if (min === null) cancelSleepTimer();
    else startSleepTimer(min);
  }

  return (
    <ScrollView style={styles.wrap} contentContainerStyle={styles.content}>
      <Text style={styles.title} numberOfLines={2}>
        {current ? current.track.title : 'NCSound Radio'}
      </Text>
      <Text style={styles.sub} numberOfLines={1}>
        {current ? current.track.artist : 'Live from the station'}
      </Text>

      <View style={styles.controls}>
        <Pressable
          style={styles.round}
          onPress={togglePlay}
          accessibilityRole="button"
          accessibilityLabel="Play or pause"
        >
          <Text style={styles.roundGlyph} accessible={false}>
            ⏯
          </Text>
        </Pressable>
        <Pressable style={styles.pill} onPress={jumpToLive} accessibilityRole="button">
          <Text style={styles.pillText}>Jump to live</Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Sleep timer</Text>
        <View style={styles.chips}>
          {[15, 30, 60].map((m) => (
            <Pressable
              key={m}
              style={[styles.chip, sleepMin === m && styles.chipOn]}
              onPress={() => setSleep(sleepMin === m ? null : m)}
              accessibilityRole="button"
              accessibilityState={{ selected: sleepMin === m }}
            >
              <Text style={styles.chipText}>{m}m</Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={[styles.card, styles.rowBetween]}>
        <Text style={styles.cardLabel}>Data saver (64 kbps)</Text>
        <Switch
          value={prefs.dataSaver}
          onValueChange={(v) => {
            void setDataSaver(v);
          }}
          trackColor={{ true: colors.accent, false: colors.border }}
          accessibilityLabel="Data saver"
        />
      </View>

      <Pressable
        style={[styles.card, styles.rowBetween]}
        onPress={() => {
          if (!user) {
            setFavMsg('Sign in to save favorites.');
            return;
          }
          setFavMsg(null);
          toggleFavorite.mutate(
            { kind: 'station', ref: STATION_REF, on: !isFavorite },
            {
              onError: (e: unknown) =>
                setFavMsg(e instanceof Error ? e.message : 'Could not update favorites.'),
            },
          );
        }}
        accessibilityRole="button"
        accessibilityState={{ selected: isFavorite }}
      >
        <Text style={styles.cardLabel}>
          {isFavorite ? '★ Favorited' : '☆ Favorite this station'}
        </Text>
      </Pressable>
      {favMsg ? <Text style={styles.meta}>{favMsg}</Text> : null}

      <Text style={styles.meta}>
        {mode === 'offline' ? 'Station offline' : 'Playing the live stream'}
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.lg },
  title: { color: colors.text.primary, fontSize: typography.size.xxl, fontWeight: typography.weight.bold },
  sub: { color: colors.text.secondary, fontSize: typography.size.base },
  controls: { alignItems: 'center', gap: spacing.lg, paddingVertical: spacing.xl },
  round: {
    width: 88,
    height: 88,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundGlyph: { fontSize: typography.size.xxl, color: '#1a1200' },
  pill: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.xl,
    paddingVertical: spacing.md,
    minHeight: 44,
    justifyContent: 'center',
  },
  pillText: { color: colors.text.primary, fontWeight: typography.weight.medium },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.card,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardLabel: { color: colors.text.muted, fontSize: typography.size.xs, textTransform: 'uppercase', letterSpacing: 0.6 },
  chips: { flexDirection: 'row', gap: spacing.sm },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    minHeight: 44,
    justifyContent: 'center',
  },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.surfaceStrong },
  chipText: { color: colors.text.primary },
  meta: { color: colors.text.muted, fontSize: typography.size.sm },
});
