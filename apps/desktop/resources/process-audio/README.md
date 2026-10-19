# Process-audio helper (Windows process loopback)

`win32-x64/demli-audio-capture.exe` captures screen-share sound **by process**,
through the WASAPI process-loopback virtual device (Windows build 20348+, i.e.
Windows 11 / Server 2022). It powers both share-sound options in the picker:

| Picker option | Helper call | What is captured |
| --- | --- | --- |
| Yalnız bu uygulama | `<window PID> include` | the shared window's process tree only |
| Sistem sesi (Demli hariç) | `<Demli main PID> exclude` | everything except Demli's process tree |

Neither mode can contain Demli's own playback of the call, so nobody in the call
hears their own voice back (M16 H1). Electron plays all audio from its
audio-service utility process, a child of the main process, so excluding the
main PID's tree removes it — measured, see "Proof" below. Capturing by process
also bypasses the output device, so it works when the default output is a
virtual mixer (Voicemeeter / VB-CABLE).

## Interface

```
demli-audio-capture.exe <pid> <include|exclude>
    stdout  raw interleaved PCM, 48000 Hz, signed 16-bit LE, 2 channels
    stderr  "ready pid=… mode=…" once Windows accepted the capture
    stop    close stdin (EOF) or kill the process
    failure one "error: …" line on stderr, non-zero exit
demli-audio-capture.exe --window-pid <hwnd>   owning PID of a window (decimal)
demli-audio-capture.exe --ancestors <pid>     parent chain, nearest first
```

`main/process-audio.ts` uses `--window-pid` to resolve a shared window and
`--ancestors` to refuse "app" mode on a window whose tree contains Demli (Demli
itself, or Explorer, which launches it). The helper emits PCM only while the
captured tree is actually rendering sound; zero bytes before play is pressed is
normal.

## Source, build, provenance

- Source: [`apps/desktop/native/process-audio/src/main.cpp`](../../native/process-audio/src/main.cpp),
  adapted from Microsoft's
  [Windows-classic-samples `ApplicationLoopback`](https://github.com/microsoft/Windows-classic-samples/tree/main/Samples/ApplicationLoopback)
  (MIT). Microsoft's notice is in [`./LICENSE`](./LICENSE) and ships with every
  installer next to the binary.
- Build: `pnpm --filter @demli/desktop build:process-audio` (MinGW-w64 g++ from
  MSYS2 UCRT64; set `DEMLI_MINGW_BIN` if it is not at `C:/msys64/ucrt64/bin`).
  The binary is linked statically (no MinGW runtime DLLs) with deterministic
  flags; `node scripts/build-process-audio.mjs --check` rebuilds it to a temp
  file and fails unless it matches the committed one byte for byte.
- The binary is committed so the packaged app needs no native build step and has
  no ABI coupling to the Electron version. It ships via electron-builder
  `extraResources` (unpacked, outside the asar).

## Proof

`pnpm --filter @demli/desktop verify:process-audio` (Windows; plays two short
test tones) measures each capture with the Goertzel algorithm:

1. Two processes play 440 Hz and 1000 Hz at once. `include(A)` must carry 440 Hz
   and not 1000 Hz; `exclude(A)` the reverse.
2. A real Electron app plays 1000 Hz through an `<audio>` element (how LiveKit
   plays remote voices) while another process plays 440 Hz. `exclude(<Electron
   main PID>)` must carry 440 Hz and not 1000 Hz.

Present means ≥ −40 dBFS, absent ≤ −60 dBFS (tones are generated at −12 dBFS).
