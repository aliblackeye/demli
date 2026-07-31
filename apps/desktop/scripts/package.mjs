#!/usr/bin/env node
/**
  * Demli desktop packaging — one script for every platform.
 *
 * Usage (from the repo root):
 *   DEMLI_DOMAIN=getdemli.com pnpm --filter @demli/desktop package:win
 *   DEMLI_DOMAIN=getdemli.com pnpm --filter @demli/desktop package:mac   # macOS host only
 *
 * This replaces the `node -e "…"` one-liner that used to live in package.json's
 * `package:win`. Same steps, same environment contract, same electron-builder
 * flags — just readable, testable, and shared with the new mac target. The
 * Windows path is the founder's live release path (docs/architecture/desktop-packaging.md
 * → "Release + publish runbook"); do not change its behaviour casually.
 *
 * Steps:
 *   1. Require DEMLI_DOMAIN (it pins the production CSP and the renderer's
 *      API/WS URLs — without it the packaged app cannot reach the backend).
 *   2. Derive VITE_API_URL / VITE_REALTIME_URL unless explicitly set.
 *   3. Derive the electron-updater feed URL.
 *   4. `electron-vite build` (production mode).
 *   5. `electron-builder --<platform>` with the pinned electron version + feed.
 */
/* global console */
import process from "node:process";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const PLATFORMS = new Set(["win", "mac"]);

function fail(message) {
  process.stderr.write(`\n  [package] ${message}\n\n`);
  process.exit(1);
}

/**
 * Pull release settings out of the repo-root `.env.deploy` (gitignored) when the
 * caller has not exported them.
 *
 * These values are properties of OUR deployment, not of the person running the
 * build, so requiring them on the command line means the release is one forgotten
 * word away from being wrong — and wrong SILENTLY: a build with no
 * DEMLI_STORAGE_ORIGIN still runs, it just widens the renderer CSP and the
 * image save/copy allow-list from "our storage host" to "any public https host".
 * Nothing fails, nothing warns at runtime, and the looser build is indistinguishable
 * from the tight one. Reading the file the deploy scripts already read removes the
 * chance to forget. An explicitly exported variable always wins.
 */
function loadDeployEnv() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
  let raw;
  try {
    raw = readFileSync(resolve(root, ".env.deploy"), "utf8");
  } catch {
    return; // Not every machine deploys; the contract below still applies.
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rest] = match;
    if (process.env[key]) continue;
    process.env[key] = rest.trim().replace(/^(['"])(.*)\1$/, "$2");
  }
}

loadDeployEnv();

// ---------------------------------------------------------------------------
// 0. Target platform
// ---------------------------------------------------------------------------

const platform = process.argv
  .slice(2)
  .map((arg) => arg.replace(/^--/, ""))
  .find((arg) => PLATFORMS.has(arg));

if (!platform) {
  fail("Usage: node scripts/package.mjs --win | --mac");
}

// macOS binaries can only be produced on macOS: the dmg target, the app bundle
// layout, and code signing all need Apple tooling. There is no cross-build.
if (platform === "mac" && process.platform !== "darwin") {
  fail(
    "package:mac must run on macOS (dmg + app bundle need Apple tooling).\n" +
      "  From a Windows/Linux machine, use the GitHub Actions workflow instead:\n" +
      "    .github/workflows/desktop-mac.yml  (Actions -> 'Desktop macOS build' -> Run workflow)\n" +
      "  It runs this exact script on a macos-latest runner and uploads the artifacts.",
  );
}

// ---------------------------------------------------------------------------
// 1. Environment contract
// ---------------------------------------------------------------------------

const domain = (process.env.DEMLI_DOMAIN || "").trim();
if (!domain) {
  fail(
    "DEMLI_DOMAIN is required. It pins the production CSP and the renderer\n" +
      "  API/WS URLs to https://api.<domain>, wss://ws.<domain>, wss://livekit.<domain>.\n" +
      "  Without it the packaged app is locked to 'self' only and cannot reach the backend.\n" +
      `  Run:  DEMLI_DOMAIN=yourdomain.com pnpm --filter @demli/desktop package:${platform}`,
  );
}
// The domain is interpolated into a shell command below; keep it to a hostname.
if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i.test(domain)) {
  fail(`DEMLI_DOMAIN is not a valid hostname: ${domain}`);
}

const env = { ...process.env };
if (!env.VITE_API_URL) env.VITE_API_URL = `https://api.${domain}`;
if (!env.VITE_REALTIME_URL) env.VITE_REALTIME_URL = `wss://ws.${domain}`;

const updateUrl = (
  env.DEMLI_UPDATE_URL || `https://api.${domain}/dl/desktop/`
).trim();
if (!/^https:\/\/[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/.test(updateUrl)) {
  fail(`DEMLI_UPDATE_URL must be a plain https URL: ${updateUrl}`);
}

// Sentry is opt-in and off by default (see main/sentry.ts). Report the state so
// a release build never silently ships without the DSN the founder expected —
// and never print the DSN itself into CI logs.
const sentryDsn = (env.SENTRY_DSN || env.VITE_SENTRY_DSN || "").trim();

// The storage origin drives two things: the renderer's img-src/media-src CSP
// (which falls back to "any https host" without it) and main's image save/copy
// allow-list (which is FAIL-CLOSED without it — the feature disappears). Say
// which, loudly, because neither shows up as a build error.
const storageOrigin = (env.DEMLI_STORAGE_ORIGIN || "").trim();
if (storageOrigin) {
  console.log(`[package] storage origin pinned: ${storageOrigin}`);
} else {
  console.log(
    "[package] storage origin: NOT PINNED\n" +
      "          - CSP img-src/media-src fall back to any public https host.\n" +
      "          - Image save/copy is DISABLED in this build: main's download\n" +
      "            allow-list is empty and refuses every URL, so the context-menu\n" +
      "            entries are not rendered (fail-closed by design).\n" +
      "          Set DEMLI_STORAGE_ORIGIN (repo-root .env.deploy) to fix both.",
  );
}

const electronVersion = require("electron/package.json").version;

// ---------------------------------------------------------------------------
// 2. Platform-specific electron-builder flags
// ---------------------------------------------------------------------------

/** Extra `-c.` overrides appended to the electron-builder command. */
const overrides = [];

if (platform === "mac") {
  // Signing is a single switch: set DEMLI_MAC_IDENTITY (or provide CSC_LINK)
  // and the build signs; leave it unset and the build is explicitly unsigned.
  // Signing requires a paid Apple Developer account — a FOUNDER decision, so
  // the default stays free and unsigned. See docs/architecture/desktop-packaging.md
  // -> "macOS".
  const identity = (env.DEMLI_MAC_IDENTITY || "").trim();
  if (identity) {
    if (!/^[A-Za-z0-9 .()@:_-]+$/.test(identity)) {
      fail(`DEMLI_MAC_IDENTITY contains unexpected characters: ${identity}`);
    }
    overrides.push(`-c.mac.identity=${JSON.stringify(identity)}`);
    // Notarization needs Apple credentials on top of a signing identity, and
    // notarization in turn requires the hardened runtime. Both stay off in
    // electron-builder.yml and are only switched on here, together.
    if (env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID) {
      overrides.push("-c.mac.notarize=true", "-c.mac.hardenedRuntime=true");
      console.log("[package] macOS signing: ON, notarization: ON");
    } else {
      console.log(
        "[package] macOS signing: ON, notarization: OFF (set APPLE_ID,\n" +
          "          APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID to notarize)",
      );
    }
  } else {
    // Unsigned is the default. `mac.identity: null` already lives in
    // electron-builder.yml, so nothing is overridden here — we only force
    // auto-discovery off so a stray keychain identity on a dev Mac cannot
    // produce an unreproducible "sometimes signed" build.
    env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    console.log(
      "[package] macOS signing: OFF (unsigned build — Gatekeeper warns on first open;\n" +
        "          users must right-click -> Open. Set DEMLI_MAC_IDENTITY to sign.)",
    );
  }
}

// ---------------------------------------------------------------------------
// 3. Build
// ---------------------------------------------------------------------------

console.log(`[package] target=${platform} domain=${domain}`);
console.log(`[package] update feed=${updateUrl}`);
console.log(
  `[package] Sentry: ${sentryDsn ? "ENABLED (DSN present)" : "disabled (no SENTRY_DSN)"}`,
);

const run = (command) => execSync(command, { stdio: "inherit", env });

run("electron-vite build");
run(
  [
    "electron-builder",
    `--${platform}`,
    "--config electron-builder.yml",
    `-c.electronVersion=${electronVersion}`,
    `-c.publish.url=${updateUrl}`,
    ...overrides,
  ].join(" "),
);
