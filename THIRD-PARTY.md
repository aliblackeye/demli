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

**Where:** `apps/desktop/src/renderer/src/assets/fonts/` (the desktop renderer and
the web app load these same files) and `apps/mobile/assets/fonts/`.

- **Inter** — © The Inter Project Authors (https://github.com/rsms/inter), SIL Open
  Font License 1.1. Full text:
  [`OFL-Inter.txt`](apps/desktop/src/renderer/src/assets/fonts/OFL-Inter.txt)
  (copy beside the mobile files too).
- **Onest** — © The Onest Project Authors (https://github.com/simpals/onest), SIL
  Open Font License 1.1. Full text:
  [`OFL-Onest.txt`](apps/desktop/src/renderer/src/assets/fonts/OFL-Onest.txt).

Provenance: the desktop/web `.woff2` files are the latin and latin-ext variable-font
subsets served by Google Fonts (`fonts.gstatic.com`, Inter v20 = Inter 4.001, Onest
v11 = 2.001), committed unmodified. The mobile `.ttf` files are Google Fonts' static
instances of the same versions (Inter 400/500/600, Onest 500/600/700), unwrapped from
WOFF to TTF and subset to latin + latin-ext with fontTools. Neither family declares a
Reserved Font Name, so the subset files keep their names. The licence texts are
`ofl/inter/OFL.txt` and `ofl/onest/OFL.txt` from github.com/google/fonts.

The OFL permits bundling and redistribution; it forbids selling the fonts on their
own and requires the licence to accompany them, which is what these files are for.

Instrument Sans and Space Grotesk (the previous product faces) were removed with the
M16 "Koyu Masa" design system.

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
