# Process-audio helper binaries (Windows process loopback)

These small prebuilt Win32 x64 executables capture a single process's rendered
audio via the WASAPI process-loopback API (`AUDCLNT` activation on a process
tree, Windows 10 build 20348+). They power the per-process film-audio path
in `apps/desktop/src/main/process-audio.ts`, which spawns them for a shared
window's PID and streams the PCM to the renderer. This bypasses the render
endpoint entirely, so film sound is captured even when the default output is a
virtual mixer (Voicemeeter Input / VB-CABLE) whose endpoint loopback is silent.

## Files

- `win32-x64/ApplicationLoopback.exe` — captures the target PID's process-tree
  audio and writes raw interleaved PCM (48 kHz, 16-bit signed LE, stereo) to
  stdout. Args: `ApplicationLoopback.exe <pid>`. It blocks on `getchar()` as its
  stop signal, so its stdin must be kept as an open pipe; kill the process to
  stop capture.
- `win32-x64/ProcessList.exe` — prints one visible window per line as
  `pid;hwnd;title` (HWND in decimal). Used to resolve a `desktopCapturer`
  window source (`window:<HWND>:0`) to its owning PID.

## Provenance & license

Vendored from the MIT-licensed npm package
[`application-loopback`](https://github.com/WerdoxDev/application-loopback)
(pinned `1.2.7`). The executables are a stripped build of Microsoft's
[Windows-classic-samples `ApplicationLoopback`](https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/ApplicationLoopback)
(also MIT). See `./LICENSE`.

They are committed to the repo (rather than pulled as a runtime dependency) so
the packaged app is fully self-contained: no native compile step, no
`node-gyp`/electron-rebuild, no ABI coupling to the Electron version. They ship
via electron-builder `extraResources` (unpacked, outside the asar) — see
`apps/desktop/electron-builder.yml`.

## Updating

Run `pnpm --filter @demli/desktop sync:process-audio-bins` (downloads the
pinned `application-loopback` tarball and refreshes the two exes here), then
review the diff and commit. Bump the pinned version inside
`apps/desktop/scripts/sync-process-audio-bins.mjs` to take a newer upstream.
