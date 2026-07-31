/**
 * @demli/app-ui — the SINGLE-SOURCE foundation the desktop renderer and the
 * web app will share for the product UI (tek-kaynak UI).
 *
 * Phase 0 (this) ships infrastructure ONLY:
 *   - tokens.css   — the one place the design tokens live (imported as
 *                    "@demli/app-ui/tokens.css"; NOT re-exported from JS —
 *                    CSS is loaded by the bundler, not the module graph).
 *   - platform/    — the typed PlatformBridge contract + desktop/web adapters +
 *                    <PlatformProvider> / usePlatform().
 *
 * Phase 1 moves the actual product components (AppShell, ChatView, VoicePanel …)
 * in here and points both surfaces at them. The shared four-column layout shell
 * lands first (see ./components); the chat vertical follows.
 */
export * from "./platform";
export * from "./data";
export * from "./components";
export * from "./motion";
