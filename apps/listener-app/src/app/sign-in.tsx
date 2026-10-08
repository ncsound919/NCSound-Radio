import React, { useState } from 'react';
import {
  ActivityIndicator,
  Linking,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { supabase, isAuthConfigured } from '../auth/supabase';
import { colors, radius, spacing, typography } from '../ui/tokens';

/**
 * Sign in. Email uses a 6-digit OTP (no deep link needed); Apple/Google use
 * Supabase OAuth, which opens the system browser and returns via the
 * `com.ncsound.radio` scheme. The native providers also need platform config
 * (Apple capability, Google OAuth client) before they work on a device.
 */
export function SignInScreen() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'email' | 'code'>('email');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!isAuthConfigured) {
    return (
      <View style={styles.wrap}>
        <Text style={styles.title} accessibilityRole="header">
          Sign-in unavailable
        </Text>
        <Text style={styles.hint}>
          Supabase is not configured for this build (set SUPABASE_URL / SUPABASE_ANON_KEY).
        </Text>
      </View>
    );
  }

  async function sendCode() {
    if (!supabase) return;
    setBusy(true);
    setMessage(null);
    const { error } = await supabase.auth.signInWithOtp({ email: email.trim() });
    setBusy(false);
    if (error) setMessage(error.message);
    else {
      setStage('code');
      setMessage('Check your email for a 6-digit code.');
    }
  }

  async function verify() {
    if (!supabase) return;
    setBusy(true);
    setMessage(null);
    const { error } = await supabase.auth.verifyOtp({
      email: email.trim(),
      token: code.trim(),
      type: 'email',
    });
    setBusy(false);
    if (error) setMessage(error.message);
  }

  async function oauth(provider: 'apple' | 'google') {
    if (!supabase) return;
    setBusy(true);
    setMessage(null);
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: { redirectTo: 'com.ncsound.radio://auth', skipBrowserRedirect: true },
    });
    setBusy(false);
    if (error) setMessage(error.message);
    else if (data?.url) await Linking.openURL(data.url);
  }

  return (
    <View style={styles.wrap}>
      <Text style={styles.title} accessibilityRole="header">
        Sign in
      </Text>
      <Text style={styles.hint}>
        Sign in to sync your favorites and have your requests credited to you.
      </Text>

      <TextInput
        style={styles.input}
        placeholder="you@example.com"
        placeholderTextColor={colors.text.muted}
        autoCapitalize="none"
        keyboardType="email-address"
        value={email}
        onChangeText={setEmail}
        accessibilityLabel="Email address"
      />

      {stage === 'email' ? (
        <Pressable
          style={[styles.button, busy && styles.buttonDisabled]}
          onPress={sendCode}
          disabled={busy || email.trim().length === 0}
          accessibilityRole="button"
        >
          <Text style={styles.buttonText}>Email me a code</Text>
        </Pressable>
      ) : (
        <>
          <TextInput
            style={styles.input}
            placeholder="6-digit code"
            placeholderTextColor={colors.text.muted}
            keyboardType="number-pad"
            value={code}
            onChangeText={setCode}
            accessibilityLabel="Login code"
          />
          <Pressable
            style={[styles.button, busy && styles.buttonDisabled]}
            onPress={verify}
            disabled={busy || code.trim().length === 0}
            accessibilityRole="button"
          >
            <Text style={styles.buttonText}>Verify</Text>
          </Pressable>
        </>
      )}

      <View style={styles.divider} />

      <Pressable
        style={[styles.buttonSecondary, busy && styles.buttonDisabled]}
        onPress={() => oauth('apple')}
        disabled={busy}
        accessibilityRole="button"
      >
        <Text style={styles.buttonSecondaryText}>Continue with Apple</Text>
      </Pressable>
      <Pressable
        style={[styles.buttonSecondary, busy && styles.buttonDisabled]}
        onPress={() => oauth('google')}
        disabled={busy}
        accessibilityRole="button"
      >
        <Text style={styles.buttonSecondaryText}>Continue with Google</Text>
      </Pressable>

      {busy ? <ActivityIndicator color={colors.accent} style={styles.spinner} /> : null}
      {message ? <Text style={styles.message}>{message}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flex: 1, backgroundColor: colors.bg, padding: spacing.xl, justifyContent: 'center' },
  title: {
    color: colors.text.primary,
    fontSize: typography.size.xxl,
    fontWeight: typography.weight.bold,
  },
  hint: { color: colors.text.muted, fontSize: typography.size.sm, marginTop: spacing.sm },
  input: {
    marginTop: spacing.lg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.card,
    padding: spacing.lg,
    color: colors.text.primary,
    backgroundColor: colors.surface,
    minHeight: 44,
  },
  button: {
    marginTop: spacing.md,
    backgroundColor: colors.accent,
    borderRadius: radius.card,
    paddingVertical: spacing.md,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  buttonDisabled: { opacity: 0.6 },
  buttonText: { color: '#1a1200', fontWeight: typography.weight.semibold },
  buttonSecondary: {
    marginTop: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.card,
    paddingVertical: spacing.md,
    alignItems: 'center',
    minHeight: 44,
    justifyContent: 'center',
  },
  buttonSecondaryText: { color: colors.text.primary, fontWeight: typography.weight.medium },
  divider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.xl },
  spinner: { marginTop: spacing.md },
  message: { color: colors.text.secondary, fontSize: typography.size.sm, marginTop: spacing.md },
});
