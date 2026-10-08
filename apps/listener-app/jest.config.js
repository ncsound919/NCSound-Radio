/**
 * The app imports @ncsound/station-client, which is workspace ESM. Jest ignores
 * node_modules by default and then chokes on the untransformed `export`, so let
 * @ncsound through the transform alongside the React Native packages.
 */
module.exports = {
  preset: '@react-native/jest-preset',
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native.*|@react-native(-community)?|@react-navigation|@ncsound)/)',
  ],
  // Component tests live in __tests__/; the pure-logic test/*.test.ts files use
  // node:test and run under `node --test` (see package.json), not Jest.
  testMatch: ['**/__tests__/**/*.[jt]s?(x)'],
};
