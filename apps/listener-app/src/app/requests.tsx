import React, { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useRequests, useSubmitRequest, useTracks } from '../data/hooks';
import { colors, radius, spacing, typography } from '../ui/tokens';

export function RequestsScreen() {
  const { data, isLoading } = useRequests();
  const tracks = useTracks();
  const submit = useSubmitRequest();
  const [name, setName] = useState('');
  const [trackId, setTrackId] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

  function send(): void {
    if (!trackId || !name.trim()) {
      setMsg('Pick a track and enter your on-air name.');
      return;
    }
    setMsg(null);
    submit.mutate(
      { trackId, listenerName: name.trim(), note: note.trim() || null },
      {
        onSuccess: (r) => setMsg(r.message),
        onError: (e: unknown) => setMsg(e instanceof Error ? e.message : 'Request failed'),
      },
    );
  }

  const list = tracks.data?.tracks ?? [];

  return (
    <ScrollView style={styles.wrap} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Make a request</Text>
        <TextInput
          style={styles.input}
          placeholder="Your on-air name"
          placeholderTextColor={colors.text.muted}
          value={name}
          onChangeText={setName}
          maxLength={32}
          accessibilityLabel="Your on-air name"
        />
        <TextInput
          style={styles.input}
          placeholder="Note (optional)"
          placeholderTextColor={colors.text.muted}
          value={note}
          onChangeText={setNote}
          maxLength={140}
          accessibilityLabel="Note"
        />
        <Text style={styles.cardLabel}>Pick a track</Text>
        <View style={styles.chips}>
          {list.slice(0, 40).map((t) => (
            <Pressable
              key={t.id}
              style={[styles.chip, trackId === t.id && styles.chipOn]}
              onPress={() => setTrackId(t.id)}
              accessibilityRole="button"
              accessibilityState={{ selected: trackId === t.id }}
            >
              <Text style={styles.chipText} numberOfLines={1}>
                {t.title}
              </Text>
            </Pressable>
          ))}
        </View>
        <Pressable
          style={[styles.button, submit.isPending && styles.disabled]}
          onPress={send}
          disabled={submit.isPending}
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>Send request</Text>
        </Pressable>
        {msg ? <Text style={styles.msg}>{msg}</Text> : null}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Most requested</Text>
        {isLoading ? <Text style={styles.muted}>Loading…</Text> : null}
        {(data?.top ?? []).map((t) => (
          <Text key={t.trackId} style={styles.row}>
            {t.title} — {t.artist} · {t.count}
          </Text>
        ))}
        <Text style={styles.cardLabel}>Recent shouts</Text>
        {(data?.recent ?? []).map((r) => (
          <Text key={r.id} style={styles.row}>
            {r.listenerName}: {r.trackTitle}
            {r.note ? ` — “${r.note}”` : ''}
          </Text>
        ))}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.lg },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.card,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  cardLabel: {
    color: colors.text.muted,
    fontSize: typography.size.xs,
    textTransform: 'uppercase',
    letterSpacing: 0.6,
    marginTop: spacing.sm,
  },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.card,
    padding: spacing.md,
    color: colors.text.primary,
    backgroundColor: colors.bg,
    minHeight: 44,
  },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    maxWidth: 220,
    minHeight: 44,
    justifyContent: 'center',
  },
  chipOn: { borderColor: colors.accent, backgroundColor: colors.surfaceStrong },
  chipText: { color: colors.text.primary, fontSize: typography.size.sm },
  button: {
    marginTop: spacing.sm,
    backgroundColor: colors.accent,
    borderRadius: radius.card,
    paddingVertical: spacing.md,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  disabled: { opacity: 0.6 },
  buttonText: { color: '#1a1200', fontWeight: typography.weight.semibold },
  msg: { color: colors.text.secondary, fontSize: typography.size.sm },
  muted: { color: colors.text.muted, fontSize: typography.size.sm },
  row: { color: colors.text.secondary, fontSize: typography.size.base },
});
