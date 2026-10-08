module.exports = {
  presets: ['module:@react-native/babel-preset'],
  plugins: [
    // Kept as a safety net: it was added because zod (pulled in by
    // station-client's old optional response-validation import) emits
    // `export * as ns from ...` which RN's preset does not transform. That
    // import is gone — validation is now injected — but a dependency can emit
    // the same syntax, and the transform is harmless when unused.
    '@babel/plugin-transform-export-namespace-from',
  ],
};
