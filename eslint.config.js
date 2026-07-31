import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/build/**",
      "**/release/**",
      ".claude/worktrees/**",
      "tmp/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  // React Native / Expo config files are CommonJS Node scripts (they must use
  // module.exports + require). Scope those rules to the mobile app only so the
  // rest of the ESM workspace is untouched (ADR 0004 tooling).
  {
    files: [
      "apps/mobile/babel.config.js",
      "apps/mobile/metro.config.js",
      "apps/mobile/**/*.config.js",
      // Expo config plugins are Node CommonJS too (they run in the prebuild
      // pipeline, not the RN bundle) — e.g. plugins/with-livekit-setup.js.
      "apps/mobile/plugins/**/*.js",
    ],
    languageOptions: { sourceType: "commonjs" },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
      "no-undef": "off",
    },
  },
);
