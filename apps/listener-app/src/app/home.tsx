import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from './navigation';
import { useNowPlaying, usePrefs, useVideo } from '../data/hooks';
import { qualityFor } from '../data/streams';
import { useStationAnnouncements } from '../notifications/realtime';
import { playLive } from '../player/live';
import { colors, radius, spacing, typography } from '../ui/tokens';

type Nav = NativeStackNavigationProp<RootStackParamList>;

export function HomeScreen() {
  const nav = useNavigation<Nav>();
  const { data, isLoading, isError } = useNowPlaying();
  const prefs = usePrefs();
  const video = useVideo();

  // Supabase Realtime in-app announcements (Firebase-free).
  const [announcement, setAnnouncement] = useState<string | null>(null);
  const onAnnouncement = useCallback((a: { title: string }) => setAnnouncement(a.title), []);
  useStationAnnouncements(onAnnouncement);

  const mode = data?.mode ?? (isError ? 'offline' : undefined);
  const current = data?.current ?? null;
  const modeLabel =
    mode === 'live' ? 'LIVE' : mode === 'standby' ? 'STANDBY' : mode === 'offline' ? 'OFFLINE' : '';

  return (
    <ScrollView style={styles.wrap} contentContainerStyle={styles.content}>
      <Pressable
        style={styles.play}
        onPress={() => playLive(qualityFor(prefs.dataSaver))}
        accessibilityRole="button"
        accessibilityLabel="Play NCSound Radio live"
      >
        <Text style={styles.playGlyph} accessible={false}>
          ▶
        </Text>
        <Text style={styles.playLabel}>Play live</Text>
      </Pressable>

      {announcement ? (
        <View style={styles.promo}>
          <Text style={styles.promoText}>◉ {announcement}</Text>
        </View>
      ) : null}

      {video.data?.promote && prefs.watchVideo ? (
        <Pressable
          style={styles.promo}
          onPress={() => nav.navigate('Watch')}
          accessibilityRole="button"
        >
          <Text style={styles.promoText}>
            ◉ Watch {video.data.show?.name ?? 'the show'} — live now
          </Text>
        </Pressable>
      ) : null}

      <View style={styles.card}>
        <View style={styles.rowBetween}>
          <Text style={styles.cardTitle} numberOfLines={1}>
            {current ? current.track.title : isLoading ? 'Loading…' : 'Offline'}
          </Text>
          {modeLabel ? (
            <View style={[styles.badge, mode === 'live' ? styles.badgeLive : styles.badgeIdle]}>
              <Text style={styles.badgeText}>{modeLabel}</Text>
            </View>
          ) : null}
        </View>
        <Text style={styles.cardSub} numberOfLines={1}>
          {current ? current.track.artist : isError ? 'The station is unreachable.' : ''}
        </Text>
        {data?.listeners?.current != null ? (
          <Text style={styles.cardMeta}>{data.listeners.current} listening</Text>
        ) : null}
      </View>

      {data?.next?.length ? (
        <View style={styles.card}>
          <Text style={styles.cardLabel}>Up next</Text>
          {data.next.slice(0, 5).map((t) => (
            <Text key={t.id} style={styles.nextRow} numberOfLines={1}>
              {t.artist} — {t.title}
            </Text>
          ))}
        </View>
      ) : null}

      <Pressable
        style={styles.secondary}
        onPress={() => nav.navigate('Player')}
        accessibilityRole="button"
      >
        <Text style={styles.secondaryText}>Open player</Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.lg },
  play: {
    backgroundColor: colors.accent,
    borderRadius: radius.card,
    paddingVertical: spacing.xl,
    alignItems: 'center',
    minHeight: 96,
    justifyContent: 'center',
  },
  playGlyph: { color: '#1a1200', fontSize: typography.size.xxxl },
  playLabel: { color: '#1a1200', fontWeight: typography.weight.bold, marginTop: spacing.xs },
  promo: {
    borderWidth: 1,
    borderColor: colors.accent,
    borderRadius: radius.card,
    padding: spacing.lg,
    backgroundColor: colors.surface,
  },
  promoText: { color: colors.accent, fontWeight: typography.weight.semibold },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.card,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardTitle: { color: colors.text.primary, fontSize: typography.size.lg, fontWeight: typography.weight.semibold, flex: 1 },
  cardSub: { color: colors.text.secondary, fontSize: typography.size.base },
  cardMeta: { color: colors.text.muted, fontSize: typography.size.sm },
  cardLabel: { color: colors.text.muted, fontSize: typography.size.xs, textTransform: 'uppercase', letterSpacing: 0.6 },
  nextRow: { color: colors.text.secondary, fontSize: typography.size.base },
  badge: { paddingHorizontal: spacing.sm, paddingVertical: 2, borderRadius: radius.pill, borderWidth: 1 },
  badgeLive: { borderColor: colors.accent },
  badgeIdle: { borderColor: colors.text.muted },
  badgeText: { color: colors.text.primary, fontSize: typography.size.xs, fontWeight: typography.weight.semibold },
  secondary: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.card,
    paddingVertical: spacing.md,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  secondaryText: { color: colors.text.primary, fontWeight: typography.weight.medium },
});
