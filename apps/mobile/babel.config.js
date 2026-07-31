/**
 * Babel config for the Expo app. `babel-preset-expo` handles JSX, TypeScript,
 * the automatic React runtime, and the expo-router entry — no extra plugins are
 * needed at the E1 foundation stage (Reanimated / its plugin are deferred to
 * whenever an animation library is actually pulled in).
 */
module.exports = function babelConfig(api) {
  api.cache(true);
  return {
    presets: ["babel-preset-expo"],
  };
};
