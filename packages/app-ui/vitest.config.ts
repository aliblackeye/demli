import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * app-ui unit tests.
 *
 * The DEFAULT environment stays `node`: most tests here cover framework-free
 * model code (server-folder reconciliation, channel ordering, long-press timing)
 * and a DOM would only slow them down.
 *
 * `.test.tsx` files may opt into jsdom with a `// @vitest-environment jsdom`
 * docblock. That escape hatch exists for ONE class of bug the pure tests are
 * structurally unable to catch: menu/popover/composer interactions that only go
 * wrong once Radix's real focus and dismiss machinery runs (the "Profile menu
 * entry opens a card that instantly closes again" regression). Those are exactly
 * the defects that reach the founder by hand, so they get a real harness.
 */
export default defineConfig({
  resolve: {
    /**
     * pnpm gives Radix its own physical copy of react@18.3.1, and two copies
     * means two hook dispatchers ("Cannot read properties of null (reading
     * 'useRef')") the moment a Radix component renders. The app bundlers already
     * dedupe react; the test runner has to be told the same, explicitly, because
     * `dedupe` alone does not reach a nested `node_modules/react`.
     */
    alias: [
      { find: /^react$/, replacement: resolvePkg("react") },
      { find: /^react\/jsx-runtime$/, replacement: resolvePkg("react/jsx-runtime") },
      { find: /^react\/jsx-dev-runtime$/, replacement: resolvePkg("react/jsx-dev-runtime") },
      { find: /^react-dom$/, replacement: resolvePkg("react-dom") },
      { find: /^react-dom\/client$/, replacement: resolvePkg("react-dom/client") },
      { find: /^react-dom\/test-utils$/, replacement: resolvePkg("react-dom/test-utils") },
      // CJS, so its `require("react")` escapes the aliases above — stubbed
      // instead. See src/test/react-remove-scroll-stub.tsx for why that is safe.
      {
        find: /^react-remove-scroll$/,
        replacement: fileURLToPath(new URL("./src/test/react-remove-scroll-stub.tsx", import.meta.url)).replace(
          /\\/g,
          "/",
        ),
      },
    ],
    dedupe: ["react", "react-dom"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    server: {
      // Radix + its floating/scroll helpers must go through Vite (not Node's
      // resolver) or the aliases above never reach their `import "react"`.
      deps: { inline: true },
    },
  },
});

/**
 * Absolute path to a module as resolved from THIS package's node_modules, with
 * POSIX separators — Vite's alias replacement does not accept Windows `\`.
 */
function resolvePkg(specifier: string): string {
  return fileURLToPath(import.meta.resolve(specifier)).replace(/\\/g, "/");
}
