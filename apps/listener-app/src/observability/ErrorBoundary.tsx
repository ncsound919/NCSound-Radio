import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { captureError } from './sentry';
import { colors, spacing, typography } from '../ui/tokens';

type Props = { children: React.ReactNode };
type State = { hasError: boolean };

/**
 * Catches render-time errors so a crash does not white-screen the app, and
 * reports them. The recovery is honest: there is no fake "resume"; the listener
 * reopens the app.
 */
export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    captureError(error, { scope: 'ui', componentStack: info.componentStack });
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <View style={styles.wrap}>
          <Text style={styles.title} accessibilityRole="header">
            Something went wrong
          </Text>
          <Text style={styles.hint}>Reopen the app to keep listening.</Text>
        </View>
      );
    }
    return this.props.children;
  }
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.bg,
    padding: spacing.xl,
  },
  title: {
    color: colors.text.primary,
    fontSize: typography.size.xxl,
    fontWeight: typography.weight.bold,
  },
  hint: {
    color: colors.text.muted,
    fontSize: typography.size.sm,
    marginTop: spacing.sm,
  },
});
