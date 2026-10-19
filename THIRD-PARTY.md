# Third-party components

Demli itself is [AGPL-3.0-only](LICENSE). It also ships code and assets written by
other people, and their licences require their notices to travel with every copy —
including the copies inside `Demli-Setup.exe`, the Android APK, and the web build.
This file is where those notices live.

Everything below is MIT or SIL OFL 1.1. Both are compatible with the AGPL, so
nothing here restricts what you may do with a fork.

---

## Windows process-loopback audio capture

**Where:** `apps/desktop/resources/process-audio/win32-x64/demli-audio-capture.exe`
(built from `apps/desktop/native/process-audio/src/main.cpp`, shipped via
electron-builder `extraResources`).

The helper is Demli's own code, adapted from Microsoft's `ApplicationLoopback`
sample in [Windows-classic-samples](https://github.com/microsoft/Windows-classic-samples)
(MIT, Copyright (c) Microsoft Corporation). It is compiled with MinGW-w64 GCC and
linked statically, so the binary also contains:

- the **MinGW-w64 runtime** (mingw-w64-crt) — ZPL 2.1 plus the BSD/MIT-style notices
  in `COPYING.MinGW-w64-runtime.txt`, which require the notices in binary copies;
- **mingw-w64 winpthreads** — MIT (Copyright (c) 2011 mingw-w64 project), with
  parts BSD-3-Clause (Copyright (C) 2010 Lockless Inc.);
- the **GCC runtime libraries** libstdc++ and libgcc — GPL-3.0-or-later with the
  GCC Runtime Library Exception 3.1, which lets the compiled program ship under
  any terms and requires no notice.

All of these notices are reproduced verbatim in
[`apps/desktop/resources/process-audio/LICENSE`](apps/desktop/resources/process-audio/LICENSE),
which ships next to the binary. `apps/desktop/scripts/build-process-audio.mjs`
fails while the binary embeds code whose notice is missing from that file.

Builds before M16 (2026-10) shipped prebuilt `ApplicationLoopback.exe` /
`ProcessList.exe` from the `application-loopback` npm package by **Matin Tat**
(MIT); those binaries and their notice were removed together. Microsoft's
notice was missing from installers until 2026-07-31, which meant every installer
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
