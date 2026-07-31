import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * The real app version, baked in at build time. `process.env.npm_package_version`
 * only exists when launched through pnpm — in a PACKAGED app it is undefined,
 * which made the login footer show the "0.0.1" fallback forever. package.json is
 * the single source of truth (electron-builder reads the same field).
 */
const APP_VERSION: string = (
  JSON.parse(
    readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
  ) as { version: string }
).version;

/**
 * Content-Security-Policy is built here and injected into the renderer
 * index.html at build time (security-review M4). The HTML ships a
 * `%DEMLI_CSP%` placeholder instead of a hardcoded policy so the packaged
 * production build cannot accidentally ship the dev (localhost + plaintext)
 * CSP.
 *
 *  - dev / `mode !== "production"`: allow the local api/realtime/livekit dev
 *    servers over plaintext ws/http (localhost only).
 *  - production build: pin `connect-src` to the exact TLS origins derived from
 *    DEMLI_DOMAIN — no wildcards, no plaintext. The build FAILS if
 *    DEMLI_DOMAIN is not set, so a locked CSP can never be forgotten.
 *
 * Inject the domain at build time, e.g.:
 *   DEMLI_DOMAIN=demli.example.com pnpm --filter @demli/desktop build
 * (see docs/architecture/deploy.md → "Desktop production build").
 */
// 'wasm-unsafe-eval' is required for the RNNoise noise-suppression worklet (the
// "Yüksek" NS tier): Chromium blocks WebAssembly compilation under a bare
// script-src 'self'. The directive ONLY permits WASM instantiation — it does NOT
// enable JS eval()/new Function() (that would be 'unsafe-eval', which stays
// banned). Director-approved security tradeoff, scoped to this single directive.
const CSP_BASE =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';" +
  // Watch Party (M20, ADR 0016): the ONE origin this app may frame. Without it
  // `default-src 'self'` blocks every iframe and the feature cannot exist.
  //
  // Exactly one directive, one host, no wildcard. `script-src` and `connect-src`
  // are deliberately UNTOUCHED: the embed is driven over `postMessage`
  // (`enablejsapi=1`), NOT by loading YouTube's `iframe_api` script, so this
  // change adds a rendering surface and no new code-execution or network origin.
  // The nocookie host is the privacy-preserving embed domain; `www.youtube.com`
  // is deliberately NOT allowed.
  " frame-src https://www.youtube-nocookie.com;";

/**
 * YouTube's thumbnail CDN — the ONLY extra img-src host (M20 Watch Party wave 3).
 *
 * The watch-party video picker shows search results, and a list of videos
 * without cover images is a list nobody can pick from. The covers are served
 * from this one host, built by OUR server from a validated 11-character id
 * (`youtubeThumbnailUrl`), never from a URL the API response supplied — so this
 * directive can only ever load `https://i.ytimg.com/vi/<id>/mqdefault.jpg`.
 *
 * `img-src` only. No script origin, no connect origin, no frame origin: an image
 * host can render pixels and nothing else. The privacy cost is the same one the
 * embed itself already carries — YouTube learns an IP is looking at YouTube
 * content — and it is paid only inside the picker, only after a user opens it.
 *
 * The alternative was a coverless list. It was rejected: picking a video from
 * titles alone is materially worse, and leaving the <img> in place against a
 * CSP that blocks it would ship a broken-image glyph to every user (§35).
 */
const YOUTUBE_THUMBNAIL_ORIGIN = "https://i.ytimg.com";

/**
 * img-src / media-src for attachment tiles (security-review M10-M1).
 *
 * `blob:` is required on both: the composer tray and optimistic sender tiles
 * render local object URLs before (and instead of) any network fetch.
 * `media-src` must be explicit — without it video/audio fall back to
 * `default-src 'self'` and remote attachment playback is silently blocked.
 *
 * Set DEMLI_STORAGE_ORIGIN (e.g. https://xyzref.supabase.co) at build time
 * to pin both directives to the storage host; without it they stay on the
 * https: wildcard (functional, but any TLS host — see the warning).
 *
 * `img-src` additionally carries {@link YOUTUBE_THUMBNAIL_ORIGIN} in BOTH the
 * pinned and the wildcard branch. In the pinned branch it is the whole point;
 * in the wildcard branch it is redundant but stated anyway, so that tightening
 * the wildcard later cannot silently break the picker.
 */
function mediaSrc(isProduction: boolean): string {
  const storageOrigin = process.env["DEMLI_STORAGE_ORIGIN"]?.trim();
  if (isProduction && storageOrigin) {
    return (
      `img-src 'self' data: blob: ${storageOrigin} ${YOUTUBE_THUMBNAIL_ORIGIN}; ` +
      `media-src 'self' blob: ${storageOrigin};`
    );
  }
  if (isProduction) {
    console.warn(
      "\n[demli-csp] WARNING: DEMLI_STORAGE_ORIGIN not set — img-src/media-src " +
        "allow any https: host. Set it to your Supabase origin to pin attachment media.\n",
    );
  }
  return (
    `img-src 'self' data: blob: https: ${YOUTUBE_THUMBNAIL_ORIGIN}; ` +
    "media-src 'self' blob: https:;"
  );
}

function connectSrc(isProduction: boolean): string {
  if (!isProduction) {
    // Dev additionally admits the real TLS origins when DEMLI_DOMAIN is set,
    // so `pnpm dev:desktop` can preview against production (UI reviews) — the
    // packaged-build CSP path below stays untouched and TLS-only.
    const devDomain = process.env["DEMLI_DOMAIN"]?.trim();
    const devTls = devDomain
      ? ` https://api.${devDomain} wss://ws.${devDomain} wss://livekit.${devDomain}`
      : "";
    return `connect-src 'self' ws://localhost:* http://localhost:* ws://127.0.0.1:* http://127.0.0.1:*${devTls}`;
  }
  const domain = process.env["DEMLI_DOMAIN"]?.trim();
  if (!domain) {
    // Production build without a domain: lock connect-src to 'self' only (never
    // the dev localhost/plaintext origins) and warn loudly. A deployable build
    // MUST set DEMLI_DOMAIN (see docs/architecture/deploy.md → "Desktop
    // production build"). This safe-but-inert fallback keeps the generic
    // `pnpm build` gate usable without ever shipping the dev CSP; a forgotten
    // domain produces an app that cannot reach the backend (caught in QA), not
    // a security hole.
    console.warn(
      "\n[demli-csp] WARNING: production build with no DEMLI_DOMAIN — " +
        "connect-src is locked to 'self' only, so the packaged app cannot reach " +
        "the backend. Set DEMLI_DOMAIN=yourdomain.com before deploying.\n",
    );
    return "connect-src 'self'";
  }
  return `connect-src 'self' https://api.${domain} wss://ws.${domain} wss://livekit.${domain}`;
}

/**
 * Origins the MAIN process may download a chat image from when the user picks
 * "save image" / "copy image" (main/image-actions.ts). Same inputs as the CSP
 * above, so the download allow-list can never be looser than what the renderer
 * is allowed to display:
 *
 *   - DEMLI_STORAGE_ORIGIN → the Supabase host that serves signed attachment
 *     URLs (the only origin that actually matters).
 *   - DEMLI_DOMAIN         → our own API origin, for anything served from it.
 *
 * EMPTY (neither set) DISABLES the feature: main refuses every URL and the
 * preload reports `saveSupported: false` / `copySupported: false`, so the menu
 * entries are not rendered. That is deliberate — main downloading a
 * renderer-chosen URL from anywhere on the internet would be more power than the
 * renderer itself has (see main/image-actions-policy.ts → isAllowedImageUrl).
 * Attachments are served from Supabase, so a build that wants working image
 * actions MUST set DEMLI_STORAGE_ORIGIN.
 *
 * The same string is injected into the PRELOAD bundle, which needs it purely to
 * answer the capability question synchronously at render time.
 */
function imageOrigins(): string {
  const storageOrigin = imageOriginSetting("DEMLI_STORAGE_ORIGIN");
  const domain = imageOriginSetting("DEMLI_DOMAIN");
  return [storageOrigin, domain ? `https://api.${domain}` : ""].filter(Boolean).join(" ");
}

/**
 * Read one image-origin setting: the exported environment first, then the
 * gitignored repo-root `.env.deploy`.
 *
 * The file fallback exists so a plain `pnpm dev:desktop` is not silently
 * missing the feature. `scripts/package.mjs` already loads the same file for
 * PACKAGED builds; without this, dev alone would end up with an empty
 * allow-list, image save/copy would vanish locally, and the next person to hit
 * that would be tempted to "fix" the fail-closed rule instead of setting the
 * variable.
 *
 * Deliberately narrow: only these two keys are ever read, and nothing is written
 * back into `process.env`, so the CSP/connect-src behaviour of a dev run is
 * untouched.
 */
function imageOriginSetting(key: "DEMLI_STORAGE_ORIGIN" | "DEMLI_DOMAIN"): string {
  const exported = process.env[key]?.trim();
  if (exported) return exported;
  try {
    const raw = readFileSync(
      fileURLToPath(new URL("../../.env.deploy", import.meta.url)),
      "utf8",
    );
    for (const line of raw.split(/\r?\n/)) {
      const match = new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=\\s*(.*)$`).exec(line);
      if (!match) continue;
      return (match[1] ?? "").trim().replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch {
    // No .env.deploy on this machine — normal for a fresh clone.
  }
  return "";
}

function cspPlugin(isProduction: boolean): Plugin {
  const csp = `${CSP_BASE} ${mediaSrc(isProduction)} ${connectSrc(isProduction)}`;
  return {
    name: "demli-csp",
    transformIndexHtml(html) {
      return html.replace("%DEMLI_CSP%", csp);
    },
  };
}

/**
 * Sentry DSN, baked into the MAIN bundle at build time (main/index.ts reads it
 * as `__SENTRY_DSN__`). A packaged Electron app has no environment of its own,
 * so an env var read at runtime would always be empty on a user's machine.
 *
 * DEFAULT IS EMPTY = SENTRY FULLY DISABLED: no init, no state, no network. Set
 * `SENTRY_DSN` (or `VITE_SENTRY_DSN`) in the build environment to turn it on —
 * see docs/architecture/crash-reporting.md. Only the MAIN bundle gets it: the
 * renderer reports through the existing crash IPC bridge, so the DSN never
 * lands in renderer JS and the renderer CSP needs no ingest origin.
 */
const SENTRY_DSN: string = (
  process.env["SENTRY_DSN"] ??
  process.env["VITE_SENTRY_DSN"] ??
  ""
).trim();

export default defineConfig(({ mode }) => {
  const isProduction = mode === "production";
  return {
    // main/preload deliberately do NOT use externalizeDepsPlugin: every npm
    // dependency (electron-updater, zod) is bundled into out/main so the
    // packaged app needs NO node_modules at all — electron-builder ships only
    // `out/` (see electron-builder.yml `files`). electron-vite still keeps
    // `electron` and Node built-ins external by default, which is all the
    // runtime provides. If a future main-process dep cannot be bundled (e.g. a
    // native module), externalize it here AND re-include node_modules in
    // electron-builder.yml — never one without the other.
    main: {
      define: {
        // See SENTRY_DSN above — empty string means "disabled", which is default.
        __SENTRY_DSN__: JSON.stringify(SENTRY_DSN),
        // See imageOrigins() above — the save/copy-image download allow-list.
        __DEMLI_IMAGE_ORIGINS__: JSON.stringify(imageOrigins()),
      },
    },
    preload: {
      define: {
        // See APP_VERSION above — surfaces the true version in packaged builds.
        __APP_VERSION__: JSON.stringify(APP_VERSION),
        // Same allow-list the main bundle gets; the preload only asks whether it
        // is empty, to decide if the image-action menu entries exist at all.
        __DEMLI_IMAGE_ORIGINS__: JSON.stringify(imageOrigins()),
      },
    },
    renderer: {
      plugins: [react(), tailwindcss(), cspPlugin(isProduction)],
    },
  };
});
