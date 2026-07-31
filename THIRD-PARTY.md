# Third-party components

Demli itself is [AGPL-3.0-only](LICENSE). It also ships code and assets written by
other people, and their licences require their notices to travel with every copy —
including the copies inside `Demli-Setup.exe`, the Android APK, and the web build.
This file is where those notices live.

Everything below is MIT or SIL OFL 1.1. Both are compatible with the AGPL, so
nothing here restricts what you may do with a fork.

---

## Windows process-loopback audio capture

**Where:** `apps/desktop/resources/process-audio/` (prebuilt `.exe` files, shipped
via electron-builder `extraResources`).

Two MIT notices apply, and both are reproduced in full in
[`apps/desktop/resources/process-audio/LICENSE`](apps/desktop/resources/process-audio/LICENSE):

- **Microsoft Corporation** — the executables are a stripped build of the
  `ApplicationLoopback` and `ProcessList` samples from
  [Windows-classic-samples](https://github.com/microsoft/Windows-classic-samples).
- **Matin Tat** — the `application-loopback` npm package that packaged that build.

Microsoft's notice was missing until 2026-07-31, which meant every installer
released before then distributed their code without it. Fixed, and recorded here
rather than quietly.

## Fonts

**Where:** `apps/desktop/src/renderer/src/assets/fonts/` (the desktop renderer, the
web app and the landing page all load these same files) and
`apps/mobile/assets/fonts/`.

- **Instrument Sans** — SIL Open Font License 1.1. Full text:
  [`OFL-InstrumentSans.txt`](apps/desktop/src/renderer/src/assets/fonts/OFL-InstrumentSans.txt)
- **Space Grotesk** — SIL Open Font License 1.1. Full text:
  [`OFL-SpaceGrotesk.txt`](apps/desktop/src/renderer/src/assets/fonts/OFL-SpaceGrotesk.txt)

The OFL permits bundling and redistribution; it forbids selling the fonts on their
own and requires the licence to accompany them, which is what these files are for.

## Patched npm packages

**Where:** `patches/` — applied by pnpm at install time.

- `@livekit/react-native-webrtc` — MIT
- `@supersami/rn-foreground-service` — MIT

Both licences permit modification and redistribution of modified versions. Every
patch hunk carries a `NOTE (Demli patch)` comment explaining why it exists.

## Design influences — no code, no licence obligation

Recorded for honesty, not because anything is owed:

- The colour ramp was originally adapted from **Catppuccin Macchiato** (MIT) before
  being replaced by Demli's own warm palette. No Catppuccin code was copied.
- Layout and motion values were informed by the Buzz/Arc design language
  (Apache-2.0). Again, no code — numeric values and patterns are not copyrightable.

## The Demli name and logo are NOT covered by the AGPL

`assets/brand/` is in this repository because the applications need those files to
build. It is not a grant to use the name or mark. See [`TRADEMARK.md`](TRADEMARK.md)
and [`assets/brand/LICENSE`](assets/brand/LICENSE). Fork freely — under your own name.
