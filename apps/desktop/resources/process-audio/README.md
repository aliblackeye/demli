# Process-audio helper (Windows process loopback)

`win32-x64/demli-audio-capture.exe` captures screen-share sound **by process**,
through the WASAPI process-loopback virtual device. Microsoft documents it from
build 20348; the activation type exists from Windows 10 2004 (19041), so Demli
tries it there too (as OBS and GStreamer do) and reports a refused activation
instead of sharing silence. Windows 10 is not yet checked on a real machine. It
powers both share-sound options in the picker:

| Picker option | Helper call | What is captured |
| --- | --- | --- |
| Yalnız bu uygulama | `<window PID> include` | the shared window's process tree only |
| Sistem sesi (Demli hariç) | `<Demli main PID> exclude` | everything except Demli's process tree |

Neither mode contains what Demli's own processes play. Electron plays all audio
from its audio-service utility process, a child of the main process, so
excluding the main PID's tree removes it — measured, see "Proof" below.

Known limit: a mixer that takes Demli's output and renders it again from its own
process (Voicemeeter on an MME/WDM-shared output, SteelSeries Sonar, Windows
"Listen to this device") is outside Demli's tree, so "system" can carry that
copy of the call. The picker says so; "only this app" is the way out.

## Interface

```
demli-audio-capture.exe <pid> <include|exclude>
    stdout  raw interleaved PCM, 48000 Hz, signed 16-bit LE, 2 channels
    stderr  "ready pid=… mode=…" once Windows accepted the capture
    stop    close stdin (EOF) or kill the process
    failure one "error: …" line on stderr, non-zero exit
demli-audio-capture.exe --window-pid <hwnd>   PID that renders a window (decimal)
demli-audio-capture.exe --ancestors <pid>     parent chain, nearest first
```

`--window-pid` returns the window's owner, except for a packaged (UWP / Store)
app: its top-level ApplicationFrameWindow belongs to ApplicationFrameHost.exe,
which plays nothing, so the helper returns the owner of the frame's
`Windows.UI.Core.CoreWindow` child instead. A minimized or suspended packaged
app has no CoreWindow; the helper then exits 8 and the share goes out without
sound, offering system sound.

`main/process-audio.ts` uses `--window-pid` to resolve a shared window and
`--ancestors` to refuse "app" mode on a window whose tree contains Demli (Demli
itself, or Explorer, which launches it). An "app" capture that cannot run is
never widened to "system" without the sharer's click. The helper emits PCM only
while the captured tree is actually rendering sound; zero bytes before play is
pressed is normal.

## Source, build, provenance

- Source: [`apps/desktop/native/process-audio/src/main.cpp`](../../native/process-audio/src/main.cpp),
  adapted from Microsoft's
  [Windows-classic-samples `ApplicationLoopback`](https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/ApplicationLoopback)
  (MIT).
- Build: `pnpm --filter @demli/desktop build:process-audio` (MinGW-w64 g++ from
  MSYS2 UCRT64; set `DEMLI_MINGW_BIN` if it is not at `C:/msys64/ucrt64/bin`).
  The binary is linked statically (no MinGW runtime DLLs) with deterministic
  flags; `node scripts/build-process-audio.mjs --check` rebuilds it to a temp
  file and fails unless it matches the committed one byte for byte.
- Licences: static linking embeds the MinGW-w64 runtime and winpthreads in the
  binary. [`./LICENSE`](./LICENSE) reproduces their notices verbatim next to
  Microsoft's, and ships with every installer next to the binary. The build and
  `--check` fail while the binary carries code whose notice is missing there.
- The binary is committed so the packaged app needs no native build step and has
  no ABI coupling to the Electron version. It ships via electron-builder
  `extraResources` (unpacked, outside the asar).

## Proof

`node scripts/verify-process-audio.mjs [--electron] [--packaged]` (Windows; plays
short −30 dBFS test tones) measures each capture with the Goertzel algorithm:

1. Two processes play 613 Hz and 1471 Hz at once. `include(A)` must carry 613 Hz
   and not 1471 Hz; `exclude(A)` the reverse.
2. `--electron`: a real Electron app plays 1471 Hz through an `<audio>` element
   (how LiveKit plays remote voices) while another process plays 613 Hz.
   `exclude(<Electron main PID>)` must carry 613 Hz and not 1471 Hz, and
   `include(<Electron main PID>)` must carry 1471 Hz.
3. `--packaged`: Filmler ve TV plays 887 Hz. `--window-pid` on its frame must
   return the app, `include(app)` must carry the tone and
   `include(ApplicationFrameHost)` must not.

Present means ≥ −40 dBFS and ≥ 15 dB above the neighbouring bins. Absent means
at least 40 dB below the same tone's level in the capture that carries it; when
other audio on the PC keeps the floor too high to show that, the check fails as
inconclusive instead of passing. Process loopback captures after the per-app
volume, so an `electron.exe` muted in the Windows volume mixer makes part 2 fail
instead of passing vacuously.
