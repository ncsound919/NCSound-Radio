const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Monorepo Metro config.
 *
 * The app lives in a bun workspace beside `packages/station-client` and
 * `packages/station-core`, so Metro must watch the whole repo and resolve both
 * the app's own and the hoisted root `node_modules`. Without this, imports of
 * `@ncsound/station-client` fail to resolve.
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

/** @type {import('@react-native/metro-config').MetroConfig} */
const config = {
  watchFolders: [workspaceRoot],
  resolver: {
    nodeModulesPaths: [
      path.resolve(projectRoot, 'node_modules'),
      path.resolve(workspaceRoot, 'node_modules'),
    ],
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);
