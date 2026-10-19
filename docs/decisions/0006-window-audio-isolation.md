# 0006 — Window Audio Isolation for Screen Share

- **Status:** Accepted — Option A (include + exclude) IMPLEMENTED in M16 (2026-10-19);
  see "Update 2026-10-19" at the end. Endpoint loopback is no longer used anywhere.
- **Date:** 2026-07-07 (updated 2026-10-19)
- **Owner:** media-webrtc
- **Related:** CLAUDE.md §6/§11/§26

## Context

When a user shares a window (or screen) with system audio on Windows, our
capture path is Electron's `setDisplayMediaRequestHandler` with
`audio: "loopback"`. Loopback taps the **entire default render device**, so the
published audio track contains everything the sharer's PC plays:

1. The film/app audio we want (good).
2. **Remote participants' own voices**, played back by Demli — they hear
   themselves echoed ~RTT later (bad; the classic loopback feedback problem,
   [electron#25120](https://github.com/electron/electron/issues/25120), closed
   not-planned).
3. Unrelated system sounds (notifications, other apps) (noise).

Goal of this spike: options for capturing **only the shared window's audio**
(true isolation), or at minimum keeping remote voices out of the capture
(echo mitigation), for the "watch a film together" scenario.

Constraints: media flows over LiveKit only (§35); Electron security stays
intact (§28); we ship Electron 33 today (Chromium 130).

## Options considered

### A. WASAPI process loopback via a native Node addon (true isolation)

Windows 10 2004+ exposes `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`
(`AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS` with a `TargetProcessId` and
include/exclude-process-tree mode) via `ActivateAudioInterfaceAsync`
([MS sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/),
[API docs](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_process_loopback_params)).

- **Include mode:** capture ONLY the shared window's process tree → true
  window-audio isolation.
- **Exclude mode:** capture everything EXCEPT our own PID → kills the remote
  voice echo while keeping "system audio" semantics (film + player app both
  covered even if they are different processes).

Plumbing: N-API addon in the **main process** captures PCM → frames to the
renderer (IPC/SharedArrayBuffer, ~384 KB/s for 48 kHz stereo float — fine) →
`AudioWorklet` + `MediaStreamAudioDestinationNode` → publish the resulting
track to LiveKit as `screen_share_audio` instead of the getDisplayMedia one.
The engine API needs no change (it already accepts a caller-supplied audio
track via `ScreenShareAssets.audio`).

- Pros: only complete solution today; exclude-mode alone fixes the echo for
  every share type; Windows-only matches our Windows-first posture.
- Cons: native build chain (prebuilds, signing, CI), PID→window mapping for
  include mode, drift/underrun handling, device-change handling. **Effort:
  ~1.5–2 weeks** including packaging; clock-drift bugs are the main risk.

### B. Chromium `restrictOwnAudio` constraint (echo fix, no native code)

The Screen Capture spec's `restrictOwnAudio` constraint filters audio
**originating from the capturing document** (i.e. Demli's own playback of
remote voices) out of captured system audio
([MDN](https://developer.mozilla.org/en-US/docs/Web/API/MediaTrackConstraints/restrictOwnAudio)).
Chromium implements it for Windows + macOS (not Linux/ChromeOS); it shipped in
the Chrome 141 era — **not available in our Electron 33 / Chromium 130**.
livekit-client 2.20 already types it in `AudioCaptureOptions` ("Chromium-based
browsers only, mid-2026").

- Pros: one constraint in `getDisplayMedia`; exactly targets the echo; no
  native code; verifiable via `track.getSettings().restrictOwnAudio`.
- Cons: needs an Electron upgrade to a Chromium ≥141 baseline; must verify it
  applies to Electron's custom-handler loopback path (it is implemented for
  desktop capture on Windows/macOS, but Electron's `audio: "loopback"` path
  needs an explicit test); does NOT isolate a single window's audio.
  **Effort: days once we're on a new-enough Electron** (upgrade itself is a
  separate, larger task).

### C. Chromium `windowAudio: "window"` (true isolation, upstream direction)

Chrome 141 added a `windowAudio` option to `getDisplayMedia`
(`"exclude" | "system" | "window"`) — `"window"` offers **window-specific
audio capture** (process loopback under the hood on Windows)
([Chrome 141 beta notes](https://developer.chrome.com/blog/chrome-141-beta)).
This is the long-term answer, but it is wired to Chromium's own picker/handler
flow; Electron would need to expose it through
`setDisplayMediaRequestHandler` (no Electron API for per-window audio exists
as of Electron 39). Watch item, not actionable now.

### D. Output-device routing (mitigation, works today)

Windows loopback taps the **default render device**. If Demli plays remote
voices on a **different output device** than the one the film plays on, they
never enter the capture. The engine already supports this
(`setOutputDevice` → `switchActiveDevice("audiooutput")`) — this is a UX/docs
mitigation, not code: "During shares, set your voice output to your headset
and let the film play on the default device."

- Pros: zero code (or a one-line settings hint); available immediately.
- Cons: needs two audio endpoints and user action; most users won't do it.

### E. AEC on the loopback track (rejected)

Chromium's echo cancellation is tuned for mic-vs-speaker echo, not for
cancelling N remote Opus streams inside a digital loopback mix; applying
`echoCancellation: true` to the loopback track degrades the film audio and
does not reliably remove remote voices. Rejected.

## Decision (proposed)

1. **Now (M8):** ship the system-audio **toggle** (done in this wave) and keep
   whole-system loopback as-is. Document the echo caveat in the share UI copy
   and QA checklist; recommend mitigation D in user-facing help.
2. **Next (M9 candidate):** build **Option A in exclude-mode** ("everything
   except Demli") as a native addon — it is the highest-value/lowest-risk
   half of A: no PID→window mapping, fixes the echo for ALL shares, and the
   addon is reusable later for include-mode window isolation.
3. **Later:** when the Electron baseline reaches Chromium ≥141, re-evaluate
   B (`restrictOwnAudio`, may replace the addon's exclude mode) and C
   (`windowAudio: "window"`, may replace include mode). Track in the Electron
   upgrade task.

## Consequences

- No user-visible isolation change ships in M8; the toggle + presets do.
- M9 gains a native-module build step for the desktop app if 2. is approved
  (prebuild + CI + signing implications for devops-release).
- The engine contract already fits every option (caller-acquired audio track),
  so no `@demli/media` API changes are anticipated.

## Estimated effort summary

| Option | Isolation | Echo fix | Availability | Effort |
| --- | --- | --- | --- | --- |
| A native WASAPI addon (exclude) | system minus us | yes | now (Win 10 2004+) | ~1–1.5 wk |
| A native WASAPI addon (include) | single window | yes | now (Win 10 2004+) | +0.5–1 wk on top |
| B `restrictOwnAudio` | no | yes | Electron ≥ Chromium 141 | days (after upgrade) |
| C `windowAudio: "window"` | single window | yes | needs Electron API support | blocked upstream |
| D output-device routing | no | yes (manual) | now | hours (docs/hint) |

## Update 2026-10-19 — M16: Option A shipped, loopback removed

The "next step" above was never built: 0.0.47 vendored an include-only
`ApplicationLoopback.exe` (mode hard-wired to `INCLUDE_TARGET_PROCESS_TREE`,
confirmed by disassembly), and whole-screen shares kept using Electron
`audio: "loopback"` or a regex-matched "system mix" recording input. Both carry
Demli's playback of the call, which is exactly the founder's field report
(M16 H1: the other side heard her own voice). The mix-input tier could also
pick the user's microphone bus on a Voicemeeter setup, and an 8-second
supervisor hot-swapped silent-but-correct sources onto those inputs.

Decision now in code:

1. **Own helper, both modes.** `apps/desktop/native/process-audio` (adapted from
   the MS sample, MIT) is built statically with MinGW-w64 and committed as
   `resources/process-audio/win32-x64/demli-audio-capture.exe`
   (`<pid> include|exclude`, plus `--window-pid` / `--ancestors` lookups).
   Not an N-API addon: a child process has no ABI coupling to Electron and no
   native build at install time.
2. **Two user-facing modes**, chosen explicitly in the picker:
   "Yalnız bu uygulama" = include the window's tree; "Sistem sesi (Demli
   hariç)" = exclude `process.pid`'s tree. Electron's audio service is a child
   of the main process; measured with a real Electron `<audio>` element:
   exclude(main PID) leaves the Electron tone at −118.8 dBFS while another
   process's tone stays at −12.0 dBFS (`scripts/verify-process-audio.mjs`).
3. **"App" mode refuses trees that contain Demli** (Demli itself, or an
   ancestor such as Explorer, which launches it) and falls back to the exclude
   mode with a notice.
4. **No endpoint loopback, no mix inputs, no hot-swap.** The display-media
   handler serves video only; the supervisor only reports waiting / live /
   failed.
5. **Unsupported Windows (build < 20348, i.e. Windows 10)**: the share goes out
   without sound and says why. Endpoint loopback was rejected even as an opt-in
   fallback: it echoes the call on every utterance, headphones do not prevent it
   (loopback taps the render endpoint, not the speakers), and Option D needs a
   second output device most users do not have.
6. **Web** (Chromium ≥141 available there, unlike Electron 33): the request sets
   `restrictOwnAudio: true` (Option B) and `selfBrowserSurface: "exclude"`;
   window audio (Option C, `windowAudio: "window"`) is sent as a hint only.

Still open: Option B/C on desktop once Electron reaches Chromium ≥141; a
browser launched BY Demli (e.g. `shell.openExternal` starting Chrome) becomes a
descendant of Demli and is therefore excluded from "system" sound — "app" mode
on its window still works.
