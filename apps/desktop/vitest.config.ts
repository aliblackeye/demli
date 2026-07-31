import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

/**
 * Desktop unit tests.
 *
 * The DEFAULT environment is `node`: almost everything here is framework-free
 * logic (layout-class decisions, update reducers, permission rules) and a DOM
 * would only slow it down.
 *
 * `.test.tsx` files may opt into jsdom with a `// @vitest-environment jsdom`
 * docblock — the same escape hatch packages/app-ui uses, for the same reason: a
 * few guarantees are about what is actually ON SCREEN, and a test of the model
 * behind a component cannot prove the component honoured it. The identity-
 * migration screen is one of those ("Daha sonra" must be GONE once the server
 * has retired this build), so it renders for real.
 *
 * `src/main` is included too, for main-process modules that import no `electron`
 * API and are therefore testable in plain Node (e.g. `sentry.ts` — its "disabled
 * without a DSN sends nothing" guarantee is enforced here). Kept separate from
 * electron.vite.config.ts, which is the electron-vite BUILD config.
 */
export default defineConfig({
  resolve: {
    /**
     * pnpm can give a dependent its own physical copy of React, and two copies
     * means two hook dispatchers ("Cannot read properties of null (reading
     * 'useState')") the moment a component renders. The app bundler already
     * dedupes react; the test runner has to be told the same, explicitly.
     */
    alias: [
      { find: /^react$/, replacement: resolvePkg("react") },
      { find: /^react\/jsx-runtime$/, replacement: resolvePkg("react/jsx-runtime") },
      { find: /^react\/jsx-dev-runtime$/, replacement: resolvePkg("react/jsx-dev-runtime") },
      { find: /^react-dom$/, replacement: resolvePkg("react-dom") },
      { find: /^react-dom\/client$/, replacement: resolvePkg("react-dom/client") },
    ],
    dedupe: ["react", "react-dom"],
  },
  /**
   * The renderer's own tsconfig uses the automatic JSX runtime; vitest's esbuild
   * pass does not read it, so a `.test.tsx` would otherwise compile to
   * `React.createElement` and fail with "React is not defined".
   */
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: [
      "src/renderer/src/**/*.test.ts",
      "src/renderer/src/**/*.test.tsx",
      "src/main/**/*.test.ts",
    ],
    server: {
      /**
       * pnpm gives react-i18next and zustand their OWN nested copies of react,
       * and their `require("react")` escapes Node's resolver — so a render sees
       * a second, hook-less React ("Cannot read properties of null (reading
       * 'useMemo')"). Routing dependencies through Vite is what makes the
       * aliases above actually apply. Same setting, same reason, as
       * packages/app-ui's config.
       */
      deps: { inline: true },
    },
  },
});

/**
 * Absolute path to a module as resolved from THIS package's node_modules, with
 * POSIX separators — Vite's alias replacement does not accept Windows `\`.
 *
 * `createRequire` rather than `import.meta.resolve`: this package is CommonJS
 * (no `"type": "module"`), so vite loads the config through esbuild's cjs output
 * where `import.meta` is empty.
 */
function resolvePkg(specifier: string): string {
  return createRequire(__filename).resolve(specifier).replace(/\\/g, "/");
}
