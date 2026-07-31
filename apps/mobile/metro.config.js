/**
 * Metro config for the Demli mobile app inside the pnpm monorepo.
 *
 * The hard requirements this file satisfies (ADR 0004):
 *
 * 1. Watch the repo root so Metro sees the source of the workspace packages.
 * 2. Resolve modules from BOTH the app's and the repo root's node_modules
 *    (pnpm keeps hierarchical lookup, so we DON'T disable it — that is how the
 *    symlinked `.pnpm` store and per-package deps like `zod` are found).
 * 3. Transpile the source-only `@demli/*` packages: they ship raw TS via
 *    `main: ./src/index.ts`, so Metro resolves straight into their `src/` and
 *    babel-preset-expo transforms them like app code (Metro transforms every
 *    module it resolves, node_modules included — no allowlist needed).
 * 4. Make the ESM-style `./foo.js` import specifiers that those TS packages use
 *    internally (e.g. protocol's `export * from "./events.js"`) resolve to the
 *    real `./foo.ts` source, which Metro does not do out of the box.
 * 5. Keep `@demli/media`'s WEB entry out of the RN bundle. E2 wires in the
 *    voice FSM, so mobile now imports `@demli/media` (the platform-agnostic
 *    engine) and injects its own `@livekit/react-native` room adapter. The block
 *    below bars the web-only files `packages/media/src/{web,livekit}.ts` (the
 *    desktop `livekit-client` browser factory) so a stray `@demli/media/web`
 *    import can never reach the phone.
 *
 *    IMPORTANT — why `livekit-client` itself is NO LONGER blocked: `@livekit/
 *    react-native` IS livekit-client running on native WebRTC. Its own source
 *    imports `livekit-client` (Room, RemoteVideoTrack, Track, RoomEvent, …) and
 *    re-homes them onto `@livekit/react-native-webrtc` via `registerGlobals()`.
 *    So `livekit-client` is a REQUIRED dependency of the RN SDK; blocking
 *    `node_modules/livekit-client` (as E1 did defensively) would break the RN
 *    voice build. What we still forbid is the *web adapter path* — the two files
 *    above — which is the thing that was actually browser-only. See the E2 report
 *    (`.claude/reports/e2-mobile-media.md`) for the full rationale.
 */
const path = require("path");
const { getDefaultConfig } = require("expo/metro-config");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

/** Escape a filesystem path so it can be embedded in a RegExp literal. */
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// (1) Watch the whole monorepo so package sources are part of the graph.
config.watchFolders = [workspaceRoot];

// (2) App node_modules first, then the workspace root's — hierarchical lookup
//     stays ON so pnpm's per-package symlinks resolve.
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// (6) Bundle `.ogg` audio as an asset. Metro's default assetExts ships the other
//     audio containers (mp3/m4a/wav/aac/caf) but NOT ogg, so the UI sound cues
//     (assets/sounds/*.ogg) would silently fail to bundle without this. Pure
//     bundler config — no native module — so it stays OTA-safe (runtimeVersion
//     is pinned; see the mobile-sounds report).
if (!config.resolver.assetExts.includes("ogg")) {
  config.resolver.assetExts = [...config.resolver.assetExts, "ogg"];
}

// (5) Never let the WEB media adapter (@demli/media/web -> livekit.ts, the
//     desktop livekit-client browser factory) into the RN bundle. Mobile uses
//     its own @livekit/react-native adapter instead. NOTE: livekit-client itself
//     is intentionally NOT blocked — it is a required dependency of
//     @livekit/react-native (which runs livekit-client on native WebRTC).
config.resolver.blockList = [
  ...(Array.isArray(config.resolver.blockList)
    ? config.resolver.blockList
    : config.resolver.blockList
      ? [config.resolver.blockList]
      : []),
  /[\\/]packages[\\/]media[\\/]src[\\/](web|livekit)\.ts$/,
  // (6) Never crawl the agent worktrees. They are full repo checkouts WITH their
  //     own node_modules, so Metro's file watcher tries to index tens of
  //     thousands of extra files (and chokes on the broken pnpm symlinks a
  //     removed worktree leaves behind). Past a few worktrees the crawl blows
  //     Metro's HARDCODED 240s watch timeout and `expo start` dies with
  //     "Failed to start watch mode" — which is exactly what blocked the mobile
  //     emulator QA run. Cleaning worktrees fixes it too, but this makes the dev
  //     server immune to ever having them around.
  //
  //     ANCHORED to THIS workspace's worktrees directory on purpose. The rule
  //     used to be a floating `/[\\/]\.claude[\\/]worktrees[\\/]/`, which also
  //     matched the project's OWN path whenever Metro was run from inside a
  //     worktree — so every source file was blocked and `expo export` failed
  //     with "Unable to resolve module ./app/_layout". Agents work in worktrees,
  //     so that made the mobile build unverifiable exactly where it is verified.
  //     Anchoring keeps the intent (skip SIBLING checkouts) without self-blocking.
  new RegExp(`^${escapeRegExp(path.resolve(workspaceRoot, ".claude", "worktrees"))}[\\\\/]`),
];

// (4) Resolve ESM `./foo.js` specifiers (used by the source-only @demli/* TS
//     packages) to their real `.ts`/`.tsx` source. Try the request as written
//     first; only fall back to the TS sibling when the `.js` file is absent.
const upstreamResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolve = upstreamResolveRequest ?? context.resolveRequest;
  const isRelative = moduleName.startsWith("./") || moduleName.startsWith("../");
  if (isRelative && moduleName.endsWith(".js")) {
    try {
      return resolve(context, moduleName, platform);
    } catch (err) {
      const base = moduleName.slice(0, -".js".length);
      for (const ext of [".ts", ".tsx"]) {
        try {
          return resolve(context, base + ext, platform);
        } catch {
          // try the next extension
        }
      }
      throw err;
    }
  }
  return resolve(context, moduleName, platform);
};

module.exports = config;
