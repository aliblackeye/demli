import { app, ipcMain, webContents, type IpcMainInvokeEvent } from "electron";
import { spawn, execFile, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFile, existsSync } from "node:fs";
import { release } from "node:os";
import { join } from "node:path";
import { isEnumeratedSourceId, onRendererReset, shareGrantFor } from "./capture";
import {
  appTargetIncludesDemli,
  helperCaptureArgs,
  hwndOfWindowSource,
  parsePidLines,
  platformSupport,
  processAudioStartAllowed,
  processAudioStartSchema,
  processAudioStopSchema,
} from "./process-audio-policy";
import {
  PROCESS_AUDIO_CHANNELS,
  PROCESS_AUDIO_FORMAT,
  type ProcessAudioMode,
  type ProcessAudioStartRequest,
  type ProcessAudioStartResult,
  type ProcessAudioSupport,
  type ProcessAudioUnavailableReason,
} from "./process-audio-types";

/**
 * Per-process audio capture (main process) — the Windows WASAPI process-loopback
 * path. See `process-audio-types.ts` for WHY this exists and what the two modes
 * capture.
 *
 * HOW: Demli's own helper (`native/process-audio`, committed as
 * `resources/process-audio/win32-x64/demli-audio-capture.exe`) is spawned as
 * `<pid> include|exclude`; it writes interleaved 48 kHz / 16-bit / stereo PCM to
 * stdout until its stdin closes. The same binary resolves a window's owning PID
 * (`--window-pid`) and Demli's parent chain (`--ancestors`).
 *
 * Security posture (CLAUDE.md §9, §28):
 *   - The renderer never supplies a PID. "app" passes a `sourceId` that MUST be
 *     in the capture module's own enumeration allow-list; main resolves the PID.
 *     "system" takes no target at all — main always excludes `process.pid`.
 *   - The helper path is fixed and app-owned (bundled resource), spawned with an
 *     args ARRAY (no shell); the only arguments are a validated integer and a
 *     fixed mode word.
 *   - Every IPC payload is validated (zod) before use.
 *   - A capture starts ONLY for a share the user started in the same
 *     webContents: a source it picked in the share picker moments ago, or a
 *     share main served and that was not released since (`shareGrantFor` +
 *     `processAudioStartAllowed`). A bare `start({ mode: "system" })` from a
 *     renderer that is not sharing is refused (`no_active_share`).
 *   - At most ONE capture per webContents: a new start ends the previous one.
 *   - A capture's PCM is sent ONLY to the webContents that started it, and only
 *     that webContents may stop it. All of a webContents' captures are killed
 *     when its page goes away (main-frame navigation / reload, renderer crash,
 *     or destroy), so no helper outlives the page that asked for it.
 */

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

const BIN_SUBDIR = join("process-audio", "win32-x64");
const HELPER_EXE = "demli-audio-capture.exe";

/**
 * Absolute directory holding the helper binary.
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

function helperPath(): string {
  return join(binaryDir(), HELPER_EXE);
}

function support(): ProcessAudioSupport {
  const platform = platformSupport(process.platform, release());
  if (!platform.supported) return platform;
  if (!existsSync(helperPath())) return { supported: false, reason: "binary_missing" };
  return { supported: true };
}

// ---------------------------------------------------------------------------
// Diagnostic file log — <userData>/process-audio.log, i.e.
// %APPDATA%\Demli\process-audio.log (the userData directory is pinned — see
// main/user-data-path.ts). Append-only, best-effort, small: the founder tests,
// the Director reads the file.
// ---------------------------------------------------------------------------

function plog(line: string): void {
  try {
    const file = join(app.getPath("userData"), "process-audio.log");
    appendFile(file, `${new Date().toISOString()} ${line}\n`, () => undefined);
  } catch {
    // logging must never break capture
  }
}

// ---------------------------------------------------------------------------
// PID resolution
// ---------------------------------------------------------------------------

/** Run a helper lookup subcommand; [] on any failure. */
function helperLookup(args: string[]): Promise<number[]> {
  return new Promise((resolve) => {
    execFile(
      helperPath(),
      args,
      { timeout: 4000, windowsHide: true, maxBuffer: 64 * 1024 },
      (err, stdout, stderr) => {
        if (err || !stdout) {
          plog(`lookup ${args[0]} failed: ${String(stderr || err).trim().slice(0, 200)}`);
          resolve([]);
          return;
        }
        resolve(parsePidLines(stdout));
      },
    );
  });
}

async function resolvePidForWindowSource(sourceId: string): Promise<number | null> {
  const hwnd = hwndOfWindowSource(sourceId);
  if (!hwnd) return null;
  const [pid] = await helperLookup(["--window-pid", hwnd]);
  return pid ?? null;
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
    // Closing stdin is the helper's clean stop signal; kill() backs it up.
    capture.child.stdin.end();
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

/** Kill every capture owned by a webContents (its page reloaded / crashed / closed). */
function cleanupForWebContents(webContentsId: number, reason = "webcontents-destroyed"): void {
  for (const capture of [...activeCaptures.values()]) {
    if (capture.webContentsId === webContentsId) {
      endCapture(capture, reason);
    }
  }
}

/**
 * Bumped per webContents on every start and every page reset, so a start whose
 * helper is still warming up when a newer start (or a reload) lands never
 * registers a capture behind it.
 */
const startGeneration = new Map<number, number>();

function bumpGeneration(webContentsId: number): number {
  const next = (startGeneration.get(webContentsId) ?? 0) + 1;
  startGeneration.set(webContentsId, next);
  return next;
}

/** webContents ids that already have a destroy-cleanup listener wired, so
 *  repeated start() calls don't stack redundant listeners on the same sender. */
const wiredForCleanup = new Set<number>();

// ---------------------------------------------------------------------------
// Start / stop
// ---------------------------------------------------------------------------

/** How long the helper may take to report `ready` (activation + Start). */
const READY_TIMEOUT_MS = 3000;

function fail(mode: ProcessAudioMode, reason: ProcessAudioUnavailableReason): ProcessAudioStartResult {
  plog(`start FAILED mode=${mode} reason=${reason}`);
  return { ok: false, reason };
}

/** Resolve and vet the process tree a request targets. */
async function resolveTarget(
  request: ProcessAudioStartRequest,
): Promise<{ ok: true; pid: number } | { ok: false; reason: ProcessAudioUnavailableReason }> {
  if (request.mode === "system") return { ok: true, pid: process.pid };

  if (!request.sourceId.startsWith("window:")) return { ok: false, reason: "not_a_window" };
  // Only a source WE enumerated is acceptable — blocks spoofed ids and, with
  // them, any attempt to steer the PID resolution toward an arbitrary window.
  if (!isEnumeratedSourceId(request.sourceId)) return { ok: false, reason: "unknown_source" };
  const pid = await resolvePidForWindowSource(request.sourceId);
  if (pid === null) return { ok: false, reason: "pid_unresolved" };
  const ancestors = await helperLookup(["--ancestors", String(process.pid)]);
  if (appTargetIncludesDemli(pid, process.pid, ancestors)) {
    return { ok: false, reason: "includes_demli" };
  }
  return { ok: true, pid };
}

async function startCapture(
  request: ProcessAudioStartRequest,
  senderId: number,
): Promise<ProcessAudioStartResult> {
  const mode = request.mode;
  if (!processAudioStartAllowed(request, shareGrantFor(senderId), Date.now())) {
    return fail(mode, "no_active_share");
  }
  const supported = support();
  if (!supported.supported) return fail(mode, supported.reason);

  // One capture per webContents: this start supersedes any live or warming one.
  const generation = bumpGeneration(senderId);
  cleanupForWebContents(senderId, "superseded");

  const target = await resolveTarget(request);
  if (!target.ok) return fail(mode, target.reason);
  const { pid } = target;
  const args = helperCaptureArgs(mode, pid);
  plog(
    `start mode=${mode} helper=${args[1]} pid=${pid}` +
      (request.mode === "app" ? ` sourceId=${request.sourceId}` : ""),
  );

  let child: ChildProcessWithoutNullStreams;
  try {
    // Args ARRAY (no shell). stdin stays an open pipe: its EOF is the stop signal.
    child = spawn(helperPath(), args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    return fail(mode, "spawn_failed");
  }

  // Wait for the helper's "ready" line (activation + Start succeeded) or its
  // early exit, so a refused activation is reported to the renderer instead of
  // looking like a silent, healthy capture.
  const ready = await new Promise<boolean>((resolve) => {
    let stderr = "";
    let settled = false;
    const settle = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      child.off("error", onError);
      resolve(ok);
    };
    const onStderr = (buf: Buffer): void => {
      stderr += buf.toString();
      if (/^ready /m.test(stderr)) {
        plog(`helper ${stderr.trim().split(/\r?\n/)[0]}`);
        settle(true);
      }
    };
    const onExit = (code: number | null): void => {
      plog(`helper exited before ready code=${code} ${stderr.trim().slice(0, 300)}`);
      settle(false);
    };
    const onError = (err: Error): void => {
      plog(`helper spawn error ${String(err)}`);
      settle(false);
    };
    const timer = setTimeout(() => {
      plog("helper ready timeout");
      settle(false);
    }, READY_TIMEOUT_MS);
    child.stderr.on("data", onStderr);
    child.once("exit", onExit);
    child.once("error", onError);
  });
  if (!ready) {
    try {
      child.kill();
    } catch {
      // already gone
    }
    return fail(mode, "activation_failed");
  }
  // A newer start or a page reset landed while the helper warmed up: this
  // capture must not run next to (or after) it.
  if (startGeneration.get(senderId) !== generation) {
    try {
      child.stdin.end();
      child.kill();
    } catch {
      // already gone
    }
    return fail(mode, "activation_failed");
  }

  const captureId = ++captureCounterSeed;
  const capture: ActiveCapture = { captureId, child, webContentsId: senderId };
  activeCaptures.set(captureId, capture);

  let bytesStreamed = 0;
  child.stdout.on("data", (chunk: Buffer) => {
    const target = webContents.fromId(senderId);
    if (!target || target.isDestroyed()) {
      endCapture(capture, "target-gone");
      return;
    }
    if (bytesStreamed === 0) {
      // The moment PCM first flows is the moment the captured tree actually
      // began rendering audio — the most useful datapoint for diagnosing a
      // silent share remotely.
      plog(`first PCM mode=${mode} pid=${pid} captureId=${captureId}`);
    }
    bytesStreamed += chunk.byteLength;
    target.send(PROCESS_AUDIO_CHANNELS.data, { captureId, chunk });
  });
  let stderrLines = 0;
  child.stderr.on("data", (buf: Buffer) => {
    if (stderrLines >= 5) return;
    stderrLines++;
    plog(`helper stderr ${buf.toString().trim().slice(0, 300)}`);
  });
  child.on("error", (err) => {
    plog(`child ERROR mode=${mode} pid=${pid}: ${String(err)}`);
    endCapture(capture, "error");
  });
  child.on("close", (code) => {
    plog(`child CLOSE mode=${mode} pid=${pid} code=${code} bytes=${bytesStreamed}`);
    endCapture(capture, "exit");
  });

  return { ok: true, captureId, mode, format: PROCESS_AUDIO_FORMAT };
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

let ipcRegistered = false;

/**
 * Wire up the process-audio IPC. Call once, after `app.whenReady()`, from the
 * main process. Idempotent across re-activations.
 */
export function registerProcessAudio(): void {
  if (ipcRegistered) return;
  ipcRegistered = true;

  ipcMain.handle(PROCESS_AUDIO_CHANNELS.support, async (): Promise<ProcessAudioSupport> => support());

  ipcMain.handle(
    PROCESS_AUDIO_CHANNELS.start,
    async (event: IpcMainInvokeEvent, rawRequest: unknown): Promise<ProcessAudioStartResult> => {
      const parsed = processAudioStartSchema.safeParse(rawRequest);
      if (!parsed.success) {
        throw new Error("process-audio: invalid start request");
      }
      // Ensure this webContents' captures are cleaned up if it goes away while a
      // capture is live — wired exactly once per sender.
      const senderId = event.sender.id;
      if (!wiredForCleanup.has(senderId)) {
        wiredForCleanup.add(senderId);
        // Not only "destroyed": a reload or a renderer crash keeps the same
        // webContents, and its helpers must not keep recording for a page that
        // no longer exists.
        onRendererReset(event.sender, () => {
          bumpGeneration(senderId);
          cleanupForWebContents(senderId, "page-reset");
        });
        event.sender.once("destroyed", () => {
          wiredForCleanup.delete(senderId);
          startGeneration.delete(senderId);
        });
      }
      return startCapture(parsed.data, senderId);
    },
  );

  ipcMain.handle(
    PROCESS_AUDIO_CHANNELS.stop,
    async (event: IpcMainInvokeEvent, rawId: unknown): Promise<void> => {
      const parsed = processAudioStopSchema.safeParse(rawId);
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
