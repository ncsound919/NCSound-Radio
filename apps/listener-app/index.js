/**
 * @format
 */

import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

// The audio player is a component now (`src/player/PlaybackEngine.tsx`, mounted
// at the app root), so there is no playback session to register here. The old
// `@rntp/player` `registerPlaybackSession` call is gone with the library.
AppRegistry.registerComponent(appName, () => App);
