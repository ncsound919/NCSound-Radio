import React, { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from './navigation';
import { useSession } from '../auth/session';
import { supabase } from '../auth/supabase';
import { usePrefs } from '../data/hooks';
import { setDataSaver, setWatchVideo } from '../data/prefs';
import { usePushPrefs, useSetPushPref, type PushPrefKey } from '../notifications/prefs';
import { colors, radius, spacing, typography } from '../ui/tokens';

type Nav = NativeStackNavigationProp<RootStackParamList>;

const PUSH_ROWS: Array<{ key: PushPrefKey; label: string }> = [
  { key: 'artist_on_air', label: 'Artist you follow is on air' },
  { key: 'request_played', label: 'Your request is playing' },
  { key: 'show_start', label: 'A show you follow starts' },
];

export function SettingsScreen() {
  const nav = useNavigation<Nav>();
  const { user, configured, signOut } = useSession();
  const prefs = usePrefs();
  const pushPrefs = usePushPrefs();
  const setPref = useSetPushPref();
  const [deleteMsg, setDeleteMsg] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function deleteAccount(): Promise<void> {
    if (!supabase) return;
    setDeleting(true);
    setDeleteMsg(null);
    const { error } = await supabase.functions.invoke('delete-account', { method: 'POST' });
    setDeleting(false);
    if (error) setDeleteMsg(error.message);
    else await supabase.auth.signOut();
  }

  return (
    <ScrollView style={styles.wrap} contentContainerStyle={styles.content}>
      <View style={styles.card}>
        <Text style={styles.cardLabel}>Account</Text>
        {!configured ? (
          <Text style={styles.muted}>Sign-in is not configured for this build.</Text>
        ) : user ? (
          <>
            <Text style={styles.value} numberOfLines={1}>
              {user.email ?? user.id}
            </Text>
            <Pressable
              style={styles.secondary}
              onPress={() => void signOut()}
              accessibilityRole="button"
            >
              <Text style={styles.secondaryText}>Sign out</Text>
            </Pressable>
          </>
        ) : (
          <Pressable
            style={styles.secondary}
            onPress={() => nav.navigate('SignIn')}
            accessibilityRole="button"
          >
            <Text style={styles.secondaryText}>Sign in</Text>
          </Pressable>
        )}
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

      <View style={[styles.card, styles.rowBetween]}>
        <Text style={styles.cardLabel}>Watch live video</Text>
        <Switch
          value={prefs.watchVideo}
          onValueChange={(v) => {
            void setWatchVideo(v);
          }}
          trackColor={{ true: colors.accent, false: colors.border }}
          accessibilityLabel="Watch live video"
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Notifications</Text>
        {!configured ? (
          <Text style={styles.muted}>Sign-in is not configured.</Text>
        ) : !user ? (
          <Text style={styles.muted}>Sign in to choose notifications.</Text>
        ) : (
          PUSH_ROWS.map((row) => (
            <View key={row.key} style={styles.rowBetween}>
              <Text style={styles.value}>{row.label}</Text>
              <Switch
                value={pushPrefs.data?.[row.key] ?? true}
                onValueChange={(v) => setPref.mutate({ key: row.key, value: v })}
                trackColor={{ true: colors.accent, false: colors.border }}
                accessibilityLabel={row.label}
              />
            </View>
          ))
        )}
      </View>

      <View style={styles.card}>
        <Text style={styles.cardLabel}>Delete account</Text>
        {user ? (
          <>
            <Text style={styles.muted}>
              Permanently removes your account, favorites and devices.
            </Text>
            <Pressable
              style={styles.secondary}
              onPress={() =>
                Alert.alert('Delete account?', 'This cannot be undone.', [
                  { text: 'Cancel', style: 'cancel' },
                  { text: 'Delete', style: 'destructive', onPress: () => void deleteAccount() },
                ])
              }
              disabled={deleting}
              accessibilityRole="button"
            >
              <Text style={styles.secondaryText}>
                {deleting ? 'Deleting…' : 'Delete my account'}
              </Text>
            </Pressable>
            {deleteMsg ? <Text style={styles.muted}>{deleteMsg}</Text> : null}
          </>
        ) : (
          <Text style={styles.muted}>Sign in first.</Text>
        )}
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
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  cardLabel: { color: colors.text.muted, fontSize: typography.size.xs, textTransform: 'uppercase', letterSpacing: 0.6 },
  value: { color: colors.text.primary, fontSize: typography.size.base },
  muted: { color: colors.text.muted, fontSize: typography.size.sm },
  secondary: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.card,
    paddingVertical: spacing.md,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
    marginTop: spacing.sm,
  },
  secondaryText: { color: colors.text.primary, fontWeight: typography.weight.medium },
});
