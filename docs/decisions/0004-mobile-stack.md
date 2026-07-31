# ADR 0004 — Mobile App Stack (React Native / Expo)

**Status:** accepted
**Date:** 2026-07-04

## Context

The film-night use case is asymmetric: the host shares a film from the desktop, and the
other person needs to **watch on a phone**, installed as a real app (not a web page). The
founder asked for a mobile app installable **as an APK**, as reliable as a native chat
app, targeting both Android and iOS (Android first).

The existing monorepo was designed for this: `@demli/types`, `@demli/config`, and
`@demli/protocol` (the typed event contract + zod) are framework-agnostic, and the
voice engine in `@demli/media` is written against an **injectable** `VoiceRoomAdapter`
(never the browser SDK directly), so the FSM is reusable off the web.

## Decision

- **React Native via Expo** (`apps/mobile`), using **prebuild + a custom dev client** —
  not Expo Go, because LiveKit needs native modules (`@livekit/react-native` +
  `react-native-webrtc`).
- **Reuse, don't rewrite:** import `@demli/types`, `@demli/config`,
  `@demli/protocol`, the voice **FSM** from `@demli/media`, and a new
  `@demli/client-core` (ADR 0002) for the HTTP + realtime clients. Mobile supplies its
  own LiveKit `VoiceRoomAdapter` over `@livekit/react-native`, and a SecureStore-backed
  token-storage adapter.
- **Native UI is built fresh** — `@demli/ui` (Radix + Tailwind + web React) is not
  portable to RN.
- **First mobile flow = "watcher/participant":** auth, groups/channels, chat
  (send/receive, presence, typing), join a voice channel, **watch the shared screen
  (remote video + audio)**, and talk (mic). Sending a screen from mobile is a later
  concern.
- **APK build via EAS Build** (free Expo account) for Android; **iOS via EAS later**
  (needs an Apple Developer account). Local Gradle is a documented fallback (requires the
  Android SDK/JDK locally).
- **Metro monorepo config:** `watchFolders` at repo root, pnpm-symlink resolution,
  transpile the source-only `@demli/*` packages, `jsx: react-native` tsconfig, and a
  `crypto.randomUUID` polyfill (`expo-crypto`). Keep `@demli/media`'s web-only
  `livekit.ts` out of the RN bundle.

## Consequences

- Mobile and server share the exact same wire protocol and voice FSM → one contract, one
  source of truth, far less drift.
- A `@demli/client-core` extraction (ADR 0002) becomes a prerequisite so desktop and
  mobile share the HTTP/WS client logic.
- Two build/distribution pipelines to maintain (EAS Android now, EAS iOS later); iOS
  distribution is a separate, heavier work item (Apple account, provisioning).
- RN permission handling and device/volume semantics differ from the web; the mobile
  adapter and `mapAcquisitionError` need RN-specific review.

## Alternatives considered

- **Flutter / native (Kotlin+Swift)** — no code sharing with the existing TS monorepo;
  would duplicate the protocol and voice logic. Rejected.
- **PWA / mobile web** — no APK, weaker background/media/permission behavior, and a web
  app is exactly what the founder wants to avoid ("apk olarak indirerek"). Rejected.
- **Bare React Native (no Expo)** — more manual native plumbing; Expo prebuild gives the
  same native capability with a far smoother build/OTA story. Rejected in favor of Expo.
