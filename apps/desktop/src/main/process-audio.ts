import { app, ipcMain, webContents, type IpcMainInvokeEvent } from "electron";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { isEnumeratedSourceId } from "./capture";
import {
  PROCESS_AUDIO_CHANNELS,
  PROCESS_AUDIO_FORMAT,
  type ProcessAudioStartResult,
  type ProcessAudioUnavailableReason,
} from "./process-audio-types";

/**
 * Per-process audio capture (main process) — the Windows WASAPI process-loopback
 * path. See `process-audio-types.ts` for WHY this exists (film sound taken from
 * the shared window's process, bypassing the render endpoint / Voicemeeter).
 *
 * HOW: a bundled helper binary (`ApplicationLoopback.exe`, Microsoft's
 * classic-samples ApplicationLoopback compiled to stream raw PCM to stdout) is
 * spawned with a target PID; it captures that process TREE's rendered audio and
 * writes interleaved 48 kHz / 16-bit / stereo PCM to stdout. A companion
 * `ProcessList.exe` enumerates visible windows as `pid;hwnd;title`, which we use
 * to resolve the shared window's PID from its HWND.
 *
 * Security posture (CLAUDE.md §9, §28):
 *   - The renderer never supplies a PID. It passes a `sourceId` that MUST be in
 *     the capture module's own enumeration allow-list (isEnumeratedSourceId);
 *     main resolves the PID itself. A spoofed / arbitrary source id is rejected.
 *   - The helper binary path is fixed and app-owned (bundled resource), never
 *     renderer-controlled. It is spawned with an args ARRAY (no shell), and the
 *     only argument is a validated integer PID.
 *   - Every IPC payload is validated (zod) before use.
 *   - A capture's PCM is sent ONLY to the webContents that started it, and only
 *     that webContents may stop it. All of a webContents' captures are killed
 *     when it is destroyed (reload / close / crash), so no exe is orphaned.
 */

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

/** Relative sub-path of the vendored helper binaries (Windows x64 only today). */
const BIN_SUBDIR = join("process-audio", "win32-x64");
const LOOPBACK_EXE = "ApplicationLoopback.exe";
const PROCESS_LIST_EXE = "ProcessList.exe";

/**
 * Absolute directory holding the helper binaries.
 *   - Packaged: shipped as an electron-builder `extraResource`, unpacked next to
 *     the app under `process.resourcesPath` (outside the asar so it is directly
 *     executable).
 *   - Dev / unpackaged: read straight from the repo's `apps/desktop/resources`.
 *     `__dirname` at runtime is `apps/desktop/out/main`, so two levels up is
 *     `apps/desktop`.
 */
function binaryDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, BIN_SUBDIR);
  }
  return join(__dirname, "..", "..", "resources", BIN_SUBDIR);
}

function loopbackExePath(): string {
  return join(binaryDir(), LOOPBACK_EXE);
}

function processListExePath(): string {
  return join(binaryDir(), PROCESS_LIST_EXE);
}

function binariesPresent(): boolean {
  return existsSync(loopbackExePath()) && existsSync(processListExePath());
}

// ---------------------------------------------------------------------------
// PID resolution
// ---------------------------------------------------------------------------

interface WindowRow {
  pid: string;
  hwnd: string;
  title: string;
}

/** Run ProcessList.exe and parse its `pid;hwnd;title` lines. Best-effort:
 *  returns [] on any failure (caller then reports the capture unavailable). */
function listWindowRows(): Promise<WindowRow[]> {
  return new Promise((resolve) => {
    execFile(
      processListExePath(),
      { timeout: 4000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err || !stdout) {
          resolve([]);
          return;
        }
        const rows: WindowRow[] = [];
        for (const line of stdout.split("\n")) {
          const parts = line.replace("\r", "").split(";");
          if (parts.length >= 3 && parts[0] && parts[1]) {
            rows.push({ pid: parts[0], hwnd: parts[1], title: parts.slice(2).join(";") });
          }
        }
        resolve(rows);
      },
    );
  });
}

/**
 * Resolve the owning PID of a `window:<HWND>:0` source. Electron encodes the
 * native window handle (decimal) as the middle segment of the source id — this
 * matched ProcessList's HWND exactly for every visible window in testing
 * (9/9). We match on that HWND; a truthy integer PID is returned or null.
 */
async function resolvePidForWindowSource(sourceId: string): Promise<number | null> {
  const hwnd = sourceId.split(":")[1];
  if (!hwnd) return null;
  const rows = await listWindowRows();
  const row = rows.find((r) => r.hwnd === hwnd);
  if (!row) return null;
  const pid = Number.parseInt(row.pid, 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

// ---------------------------------------------------------------------------
// Active captures
// ---------------------------------------------------------------------------

interface ActiveCapture {
  captureId: number;
  child: ChildProcessWithoutNullStreams;
  webContentsId: number;
}

let captureCounterSeed = 0;
const activeCaptures = new Map<number, ActiveCapture>();

function endCapture(capture: ActiveCapture, reason: string): void {
  if (!activeCaptures.has(capture.captureId)) return;
  activeCaptures.delete(capture.captureId);
  try {
    capture.child.kill();
  } catch {
    // already gone
  }
  const target = webContents.fromId(capture.webContentsId);
  if (target && !target.isDestroyed()) {
    target.send(PROCESS_AUDIO_CHANNELS.ended, {
      captureId: capture.captureId,
      reason,
    });
  }
}

/** Kill every capture owned by a webContents (its window reloaded / closed). */
function cleanupForWebContents(webContentsId: number): void {
  for (const capture of [...activeCaptures.values()]) {
    if (capture.webContentsId === webContentsId) {
      endCapture(capture, "webcontents-destroyed");
    }
  }
}

/** webContents ids that already have a destroy-cleanup listener wired, so
 *  repeated start() calls don't stack redundant listeners on the same sender. */
const wiredForCleanup = new Set<number>();

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// Diagnostic file log — <userData>/process-audio.log, i.e.
// %APPDATA%\Demli\process-audio.log (the userData directory is pinned — see
// main/user-data-path.ts).
// (uzaktan teşhis:
// founder test eder, Director dosyayı okur). Append-only, best-effort, küçük.
// ---------------------------------------------------------------------------
import { appendFile } from "node:fs";

function plog(line: string): void {
  try {
    const file = join(app.getPath("userData"), "process-audio.log");
    appendFile(file, `${new Date().toISOString()} ${line}
`, () => undefined);
  } catch {
    // logging must never break capture
  }
}

function fail(reason: ProcessAudioUnavailableReason): ProcessAudioStartResult {
  plog(`start FAILED reason=${reason}`);
  return { ok: false, reason };
}

async function startCapture(
  sourceId: string,
  senderId: number,
): Promise<ProcessAudioStartResult> {
  if (process.platform !== "win32") return fail("unsupported_platform");
  if (!sourceId.startsWith("window:")) return fail("not_a_window");
  // Only a source WE enumerated is acceptable — blocks spoofed ids and, with
  // them, any attempt to steer the PID resolution toward an arbitrary window.
  if (!isEnumeratedSourceId(sourceId)) return fail("unknown_source");
  if (!binariesPresent()) return fail("binary_missing");

  const pid = await resolvePidForWindowSource(sourceId);
  plog(`start sourceId=${sourceId} pid=${pid ?? "UNRESOLVED"}`);
  if (pid === null) return fail("pid_unresolved");

  let child: ChildProcessWithoutNullStreams;
  try {
    // Args ARRAY (no shell). stdin is kept as an open pipe on purpose: the exe
    // blocks on getchar() as its stop signal, so a closed/ignored stdin would
    // make it exit immediately with zero output.
    child = spawn(loopbackExePath(), [String(pid)], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    return fail("spawn_failed");
  }

  const captureId = ++captureCounterSeed;
  const capture: ActiveCapture = { captureId, child, webContentsId: senderId };
  activeCaptures.set(captureId, capture);

  // Real byte accounting. The previous log line printed the literal string
  // "bytes=streamed", which told us NOTHING — during the 3rd "film sesi
  // gitmiyor" investigation it was impossible to tell from the log whether the
  // helper had produced PCM or not. Count it for real.
  let bytesStreamed = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    const target = webContents.fromId(senderId);
    if (!target || target.isDestroyed()) {
      endCapture(capture, "target-gone");
      return;
    }
    if (bytesStreamed === 0) {
      // The moment PCM first flows is the moment the shared app actually began
      // rendering audio — the single most useful datapoint for diagnosing a
      // silent share remotely.
      plog(`first PCM pid=${pid} captureId=${captureId}`);
    }
    bytesStreamed += chunk.byteLength;
    target.send(PROCESS_AUDIO_CHANNELS.data, { captureId, chunk });
  });
  // Surface helper diagnostics only in dev; never fail the capture on stderr.
  child.stderr.on("data", (buf: Buffer) => {
    if (!app.isPackaged) {
      console.warn(`[process-audio] ${LOOPBACK_EXE} stderr: ${buf.toString().trim()}`);
    }
  });
  child.on("error", (err) => {
    plog(`child ERROR pid=${pid}: ${String(err)}`);
    endCapture(capture, "error");
  });
  child.on("close", (code) => {
    plog(`child CLOSE pid=${pid} code=${code} bytes=${bytesStreamed}`);
    endCapture(capture, "exit");
  });

  return { ok: true, captureId, format: PROCESS_AUDIO_FORMAT };
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

const startSchema = z
  .object({ sourceId: z.string().min(1).max(256) })
  .strict();

const stopSchema = z.number().int().nonnegative();

let ipcRegistered = false;

/**
 * Wire up the process-audio IPC. Call once, after `app.whenReady()`, from the
 * main process. No-op registration is idempotent across re-activations.
 */
export function registerProcessAudio(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle(
    PROCESS_AUDIO_CHANNELS.start,
    async (event: IpcMainInvokeEvent, rawRequest: unknown): Promise<ProcessAudioStartResult> => {
      const parsed = startSchema.safeParse(rawRequest);
      if (!parsed.success) {
        throw new Error("process-audio: invalid start request");
      }
      // Ensure this webContents' captures are cleaned up if it goes away while a
      // capture is live — wired exactly once per sender (repeated start() calls
      // must not stack redundant destroy listeners).
      const senderId = event.sender.id;
      if (!wiredForCleanup.has(senderId)) {
        wiredForCleanup.add(senderId);
        event.sender.once("destroyed", () => {
          wiredForCleanup.delete(senderId);
          cleanupForWebContents(senderId);
        });
      }
      return startCapture(parsed.data.sourceId, senderId);
    },
  );

  ipcMain.handle(
    PROCESS_AUDIO_CHANNELS.stop,
    async (event: IpcMainInvokeEvent, rawId: unknown): Promise<void> => {
      const parsed = stopSchema.safeParse(rawId);
      if (!parsed.success) {
        throw new Error("process-audio: invalid stop request");
      }
      const capture = activeCaptures.get(parsed.data);
      // Ownership check: only the webContents that started a capture may stop it.
      if (capture && capture.webContentsId === event.sender.id) {
        endCapture(capture, "stopped");
      }
    },
  );
}
