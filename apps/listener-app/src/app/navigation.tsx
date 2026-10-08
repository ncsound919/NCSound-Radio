import React from 'react';
import { Text } from 'react-native';
import {
  DefaultTheme,
  NavigationContainer,
  type Theme,
} from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { HomeScreen } from './home';
import { PlayerScreen } from './player';
import { ScheduleScreen } from './schedule';
import { RequestsScreen } from './requests';
import { SettingsScreen } from './settings';
import { SignInScreen } from './sign-in';
import { VideoScreen } from '../video/VideoScreen';
import { colors, typography } from '../ui/tokens';

export type RootStackParamList = {
  Tabs: undefined;
  Player: undefined;
  Watch: undefined;
  SignIn: undefined;
};

export type RootTabParamList = {
  Home: undefined;
  Schedule: undefined;
  Requests: undefined;
  Settings: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<RootTabParamList>();

/** Text glyphs stand in for an icon set to avoid a dependency. */
const glyph =
  (label: string) =>
  ({ color }: { color: string }) => (
    <Text style={{ color, fontSize: typography.size.lg }} accessible={false}>
      {label}
    </Text>
  );

const navTheme: Theme = {
  ...DefaultTheme,
  dark: true,
  colors: {
    ...DefaultTheme.colors,
    primary: colors.accent,
    background: colors.bg,
    card: colors.bg,
    text: colors.text.primary,
    border: colors.border,
    notification: colors.accent,
  },
};

function Tabs() {
  return (
    <Tab.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: colors.bg },
        headerTintColor: colors.text.primary,
        tabBarStyle: { backgroundColor: colors.bg, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.text.muted,
        tabBarLabelStyle: {
          fontSize: typography.size.xs,
          fontWeight: typography.weight.semibold,
        },
      }}
    >
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{ tabBarAccessibilityLabel: 'Home', tabBarIcon: glyph('▶') }}
      />
      <Tab.Screen
        name="Schedule"
        component={ScheduleScreen}
        options={{ tabBarAccessibilityLabel: 'Schedule', tabBarIcon: glyph('▤') }}
      />
      <Tab.Screen
        name="Requests"
        component={RequestsScreen}
        options={{ tabBarAccessibilityLabel: 'Requests', tabBarIcon: glyph('♪') }}
      />
      <Tab.Screen
        name="Settings"
        component={SettingsScreen}
        options={{ tabBarAccessibilityLabel: 'Settings', tabBarIcon: glyph('⚙') }}
      />
    </Tab.Navigator>
  );
}

export function AppNavigation() {
  return (
    <NavigationContainer theme={navTheme}>
      <Stack.Navigator
        screenOptions={{
          headerStyle: { backgroundColor: colors.bg },
          headerTintColor: colors.text.primary,
          contentStyle: { backgroundColor: colors.bg },
        }}
      >
        <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
        <Stack.Screen name="Player" component={PlayerScreen} options={{ title: 'Now playing' }} />
        <Stack.Screen name="Watch" component={VideoScreen} options={{ title: 'Watch live' }} />
        <Stack.Screen
          name="SignIn"
          component={SignInScreen}
          options={{ title: 'Sign in', presentation: 'modal' }}
        />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
