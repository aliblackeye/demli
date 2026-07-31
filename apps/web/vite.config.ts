import { readFileSync } from "node:fs";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * The desktop installer feed names files `Demli-Setup-<version>.exe` with no
 * stable "latest" alias, so the web "download the desktop app" button needs the
 * exact current version. Read it from the desktop package at build time — every
 * web deploy then tracks the desktop release automatically. A caller may still
 * pin VITE_DESKTOP_VERSION explicitly (below).
 */
function readDesktopVersion(): string {
  try {
    const pkg = readFileSync(new URL("../desktop/package.json", import.meta.url), "utf8");
    return (JSON.parse(pkg) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * Demli web build — the DESKTOP renderer, running unchanged in a browser.
 *
 * The web entry (src/main.tsx) installs a `window.demli` shim, then mounts
 * apps/desktop/src/renderer/src/App. So this config's only job is to make the
 * renderer source build in a browser context:
 *
 *  - @tailwindcss/vite (Tailwind v4): the renderer + shared UI use v4
 *    @theme/@utility rules and v4 class names, painted by the desktop renderer's
 *    own globals.css (imported via src/styles/desktop-shell.css). The old v3
 *    postcss/autoprefixer/tailwind.config pipeline is gone.
 *
 *  - MODERN target (esnext): founder-approved — iPhone 6 / Safari 12 perfection
 *    is no longer required (best-effort only). No @vitejs/plugin-legacy, no
 *    core-js modern polyfills, no legacy/nomodule chunks.
 *
 *  - VITE_API_URL / VITE_REALTIME_URL default to the PRODUCTION hosts. The
 *    desktop renderer's api-client/connection fall back to localhost when these
 *    are unset (correct for `pnpm dev:desktop`); for the web build we want an
 *    unconfigured build to target the live backend, matching the promise in
 *    apps/web/.env.example. A real .env / process env still overrides.
 *    (LiveKit's URL is delivered by the server's join grant, so no build-time
 *    LiveKit var is needed here.)
 */
export default defineConfig(({ mode }) => {
  // "" prefix → read every var (incl. non-VITE) from .env files + process.env.
  const env = loadEnv(mode, process.cwd(), "");
  // karagozali.com was the pre-rebrand domain and its DNS records were DELETED
  // on 2026-07-27 (CLAUDE.md §32), so these defaults pointed an unconfigured
  // build at nothing. `publish-web.sh` always sets both, which is why the live
  // site was never affected — the trap only fires for someone who builds without
  // the script, and it fires silently: the bundle looks fine and connects
  // nowhere. Kept as a fallback rather than made fatal because `pnpm dev:web`
  // against the live backend is a real workflow.
  const apiUrl = env.VITE_API_URL ?? "https://api.getdemli.com";
  const realtimeUrl = env.VITE_REALTIME_URL ?? "wss://ws.getdemli.com";
  const appVersion = env.VITE_APP_VERSION ?? "0.0.1";
  const desktopVersion = env.VITE_DESKTOP_VERSION ?? readDesktopVersion();

  return {
    plugins: [react(), tailwindcss()],
    // Bake the resolved endpoints so an unconfigured production build still
    // reaches the live backend. Leaf-key defines statically replace the exact
    // `import.meta.env.VITE_*` reads the renderer performs.
    define: {
      "import.meta.env.VITE_API_URL": JSON.stringify(apiUrl),
      "import.meta.env.VITE_REALTIME_URL": JSON.stringify(realtimeUrl),
      "import.meta.env.VITE_APP_VERSION": JSON.stringify(appVersion),
      // Exact desktop installer version for the web download button (see
      // readDesktopVersion + DownloadPrompt.tsx).
      "import.meta.env.VITE_DESKTOP_VERSION": JSON.stringify(desktopVersion),
    },
    build: {
      target: "esnext",
      sourcemap: false,
    },
    server: { port: 5175, host: true },
    preview: { port: 5175, host: true },
  };
});
