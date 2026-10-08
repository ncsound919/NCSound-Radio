import React from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSchedule } from '../data/hooks';
import { colors, radius, spacing, typography } from '../ui/tokens';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const hhmm = (h: number, m: number) =>
  `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;

export function ScheduleScreen() {
  const { data, isLoading, isError } = useSchedule();
  const shows = data?.shows ?? [];

  return (
    <ScrollView style={styles.wrap} contentContainerStyle={styles.content}>
      <Text style={styles.heading}>
        This week{data?.now ? ` · ${data.now.label}` : ''}
      </Text>
      {isLoading ? <Text style={styles.muted}>Loading…</Text> : null}
      {isError ? <Text style={styles.muted}>Schedule unavailable.</Text> : null}
      {shows.map((s) => {
        const active = s.id === data?.currentShowId;
        return (
          <View key={s.id} style={[styles.row, active && styles.rowActive]}>
            <Text style={styles.rowTitle}>{s.name}</Text>
            <Text style={styles.rowMeta}>
              {DAYS[s.dayOfWeek]} {hhmm(s.startHour, s.startMinute)} · {s.host} · {s.kind}
            </Text>
          </View>
        );
      })}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.sm },
  heading: {
    color: colors.text.primary,
    fontSize: typography.size.lg,
    fontWeight: typography.weight.semibold,
    marginBottom: spacing.sm,
  },
  muted: { color: colors.text.muted, fontSize: typography.size.sm },
  row: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.card,
    padding: spacing.lg,
    gap: spacing.xs,
  },
  rowActive: { borderColor: colors.accent },
  rowTitle: { color: colors.text.primary, fontSize: typography.size.base, fontWeight: typography.weight.semibold },
  rowMeta: { color: colors.text.muted, fontSize: typography.size.sm },
});
