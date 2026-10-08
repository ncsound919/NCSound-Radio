import React, { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Video from 'react-native-video';
import { useVideo } from '../data/hooks';
import { enterWatch, exitWatch } from './coexistence';
import { colors, spacing, typography } from '../ui/tokens';

/**
 * Watch the live show. The HLS manifest comes from `GET /api/video`; when
 * nothing is streaming the screen says so honestly rather than showing a dead
 * player. Entering Watch pauses the audio player (coexistence); leaving resumes.
 */
export function VideoScreen() {
  const { data } = useVideo();
  const live = Boolean(data?.live && data.hls);

  useEffect(() => {
    if (live) enterWatch();
    return () => exitWatch();
  }, [live]);

  if (!live) {
    return (
      <View style={styles.wrap}>
        <Text style={styles.title} accessibilityRole="header">
          Not live right now
        </Text>
        <Text style={styles.hint}>
          Watch returns when the morning show or a guest DJ slot is on air.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.wrap}>
      <Video
        source={{ uri: data!.hls! }}
        style={styles.video}
        resizeMode="contain"
        paused={false}
        controls
        enterPictureInPictureOnLeave
        playInBackground
      />
      <Text style={styles.hint}>
        Live · {data?.show?.name ?? 'NCSound Radio'}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: colors.bg,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.lg,
    gap: spacing.md,
  },
  video: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000' },
  title: { color: colors.text.primary, fontSize: typography.size.xxl, fontWeight: typography.weight.bold },
  hint: { color: colors.text.muted, fontSize: typography.size.sm },
});
