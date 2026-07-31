import {
  app,
  crashReporter,
  ipcMain,
  type Details as ChildProcessGoneDetails,
  type IpcMainInvokeEvent,
  type RenderProcessGoneDetails,
  type WebContents,
} from "electron";
import {
  mkdirSync,
  renameSync,
  statSync,
  appendFileSync,
} from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  CRASH_CHANNELS,
  CRASH_PAYLOAD_LIMITS,
  type RendererErrorReport,
} from "./crash-reporter-types";
import { captureSentryError } from "./sentry";

/**
 * Crash reporting (main process).
 *
 * Closes the last missing Milestone 5 hardening item: the desktop app had zero
 * crash capture. Four layers now record failures locally so a crash is
 * diagnosable after the fact:
 *
 *   1. Native minidumps — `crashReporter.start()` makes Electron/Chromium write a
 *      minidump to `app.getPath('crashDumps')` on a native (C++) crash of the
 *      main / renderer / GPU / utility processes.
 *   2. Process-gone events — `render-process-gone` / `child-process-gone` are
 *      logged (reason + exitCode) to a rotating text log. These fire while the
 *      main process is still alive, so we get a readable record even when a
 *      minidump isn't produced (e.g. a clean `killed`).
 *   3. Main-process exceptions — `uncaughtExceptionMonitor` observes an uncaught
 *      throw (and, since Node 18 throws on them, an unhandled rejection) without
 *      changing Node's default behaviour: the app still crashes as before, we
 *      just get the message + stack on disk first.
 *   4. Renderer JS errors — a validated IPC handler appends structured
 *      renderer-side errors (React error boundary + global handlers) to the same
 *      log.
 *
 * Privacy posture (CLAUDE.md §26, §28):
 *   - The four layers above are LOCAL ONLY. `uploadToServer: false` — no
 *     minidump ever leaves the device.
 *   - No raw stack traces are shown to the user; they only ever land in the
 *     local log file (the renderer shows a friendly fallback instead — §26).
 *   - Every IPC payload is zod-validated and length-bounded before use,
 *     mirroring `secure-token.ts` / `capture.ts`.
 *   - We log error diagnostics only — never tokens or other sensitive values.
 *
 * SENTRY (optional, OFF unless a DSN was baked in at build time): every crash
 * path below ALSO calls `captureSentryError`, which is a hard no-op while the
 * client is disabled. Sentry is additive — the local log stays the primary
 * record and its behaviour is unchanged whether or not a DSN exists. Native
 * minidumps are still never uploaded (`uploadToServer: false`); only the
 * scrubbed, structured JS-level events go out. See main/sentry.ts and
 * docs/architecture/crash-reporting.md for the role split.
 */

// ---------------------------------------------------------------------------
// Log location & rotation
// ---------------------------------------------------------------------------

/** Subdirectory (under userData) that holds the text crash log. */
const LOG_DIR_NAME = "logs";
/** The active crash log file name. */
const LOG_FILE_NAME = "crash.log";
/** One rolled-over backup is kept alongside the active log. */
const ROTATED_FILE_NAME = "crash.log.1";
/** Rotate once the active log grows past this size (bytes). */
const MAX_LOG_BYTES = 512 * 1024;

/** Guards so we register the OS-level pieces exactly once. */
let started = false;
let handlersRegistered = false;
/** Set true once we've ensured the log directory exists this run. */
let logDirReady = false;

function logDir(): string {
  return join(app.getPath("userData"), LOG_DIR_NAME);
}

function logFilePath(): string {
  return join(logDir(), LOG_FILE_NAME);
}

function ensureLogDir(): void {
  if (logDirReady) {
    return;
  }
  mkdirSync(logDir(), { recursive: true });
  logDirReady = true;
}

/**
 * Roll the active log to `crash.log.1` once it exceeds {@link MAX_LOG_BYTES},
 * keeping a single backup so the file can never grow without bound. Best effort:
 * any rotation error is swallowed so it can't stop us from recording the crash.
 */
function rotateIfNeeded(path: string): void {
  try {
    const size = statSync(path).size;
    if (size < MAX_LOG_BYTES) {
      return;
    }
    renameSync(path, join(logDir(), ROTATED_FILE_NAME));
  } catch {
    // No file yet, or rename raced — nothing to rotate.
  }
}

/**
 * Append one line to the crash log. Synchronous on purpose: process-gone events
 * fire at unstable moments, and a small synchronous append is the most reliable
 * way to get the entry on disk without interleaving. Never throws — a failure to
 * log must not crash the main process.
 */
function writeCrashLine(kind: string, fields: Record<string, unknown>): void {
  try {
    ensureLogDir();
    const path = logFilePath();
    rotateIfNeeded(path);
    const parts = Object.entries(fields)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => `${key}=${formatValue(value)}`);
    const line = `${new Date().toISOString()} ${kind} ${parts.join(" ")}\n`;
    appendFileSync(path, line, { encoding: "utf8" });
  } catch {
    // Swallow — logging must be side-effect-free on failure.
  }
}

/** Render a value as a single-line, quoted token so multi-line stacks stay on one line. */
function formatValue(value: unknown): string {
  const str = typeof value === "string" ? value : String(value);
  const oneLine = str.replace(/\r?\n/g, "\\n");
  return /\s/.test(oneLine) ? `"${oneLine.replace(/"/g, "'")}"` : oneLine;
}

/** Clamp a possibly-oversized string to a max length (defensive, main-side). */
function clamp(value: string | undefined, max: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.length > max ? value.slice(0, max) : value;
}

// ---------------------------------------------------------------------------
// IPC payload schema
// ---------------------------------------------------------------------------

const rendererErrorSchema = z
  .object({
    message: z.string().min(1).max(CRASH_PAYLOAD_LIMITS.message),
    stack: z.string().max(CRASH_PAYLOAD_LIMITS.stack).optional(),
    componentStack: z
      .string()
      .max(CRASH_PAYLOAD_LIMITS.componentStack)
      .optional(),
  })
  .strict();

// ---------------------------------------------------------------------------
// Native crash reporter
// ---------------------------------------------------------------------------

/**
 * Start Electron's native crash reporter. Must run as EARLY as possible — before
 * `app.whenReady()` and before any window — so minidumps are captured even for
 * an early crash. Idempotent.
 *
 * `uploadToServer: false` keeps everything on-device (see the privacy posture
 * above). Minidumps land in `app.getPath('crashDumps')`.
 */
export function startCrashReporter(): void {
  if (started) {
    return;
  }
  started = true;
  crashReporter.start({
    productName: "Demli",
    // LOCAL ONLY — native minidumps never leave the machine, even when Sentry
    // is enabled. A minidump is a raw memory snapshot: it can contain message
    // text, tokens and other user data, so uploading one would break the
    // privacy posture that main/sentry.ts is careful to hold (CLAUDE.md §28).
    // Sentry receives structured, scrubbed JS events only.
    uploadToServer: false,
    // Still let the OS crash handler run so native tooling keeps working.
    ignoreSystemCrashHandler: false,
    compress: true,
  });
}

// ---------------------------------------------------------------------------
// Process-gone + IPC handlers
// ---------------------------------------------------------------------------

function onRenderProcessGone(
  _event: Electron.Event,
  webContents: WebContents,
  details: RenderProcessGoneDetails,
): void {
  writeCrashLine("render-process-gone", {
    reason: details.reason,
    exitCode: details.exitCode,
    webContentsId: webContents.isDestroyed() ? undefined : webContents.id,
  });
  // No-op unless Sentry is enabled. Only the reason/exit code travel — a
  // process-gone event carries no user content to begin with.
  captureSentryError({
    message: `render process gone: ${details.reason}`,
    type: "RenderProcessGone",
    process: "renderer",
    level: "fatal",
    handled: false,
    extra: { reason: details.reason, exitCode: String(details.exitCode) },
  });
}

function onChildProcessGone(
  _event: Electron.Event,
  details: ChildProcessGoneDetails,
): void {
  writeCrashLine("child-process-gone", {
    type: details.type,
    reason: details.reason,
    exitCode: details.exitCode,
    name: details.name,
    serviceName: details.serviceName,
  });
  captureSentryError({
    message: `child process gone: ${details.type} ${details.reason}`,
    type: "ChildProcessGone",
    process: "main",
    level: "fatal",
    handled: false,
    extra: {
      childType: details.type,
      reason: details.reason,
      exitCode: String(details.exitCode),
    },
  });
}

/**
 * Observe main-process exceptions WITHOUT changing what Node does with them.
 *
 * `uncaughtExceptionMonitor` is deliberate: a plain `uncaughtException` listener
 * would SUPPRESS the default crash, silently keeping a half-dead main process
 * alive. The monitor variant only observes, so the app still crashes exactly as
 * it does today — we just get a log line (and, if enabled, a Sentry event)
 * first. Node routes unhandled promise rejections here too (they throw by
 * default in Node 18+), so no separate rejection hook is needed.
 */
function onMainUncaught(error: Error): void {
  writeCrashLine("main-uncaught", {
    message: error.message,
    stack: error.stack,
  });
  captureSentryError({
    message: error.message || "Uncaught main-process error",
    ...(error.stack ? { stack: error.stack } : {}),
    type: error.name || "Error",
    process: "main",
    level: "fatal",
    handled: false,
  });
}

function registerHandlers(): void {
  if (handlersRegistered) {
    return;
  }
  handlersRegistered = true;

  app.on("render-process-gone", onRenderProcessGone);
  app.on("child-process-gone", onChildProcessGone);
  process.on("uncaughtExceptionMonitor", onMainUncaught);

  ipcMain.handle(
    CRASH_CHANNELS.reportRenderer,
    async (_event: IpcMainInvokeEvent, rawReport: unknown): Promise<void> => {
      const parsed = rendererErrorSchema.safeParse(rawReport);
      if (!parsed.success) {
        throw new Error("crash: invalid renderer error payload");
      }
      const report: RendererErrorReport = parsed.data;
      const message = clamp(report.message, CRASH_PAYLOAD_LIMITS.message);
      const stack = clamp(report.stack, CRASH_PAYLOAD_LIMITS.stack);
      const componentStack = clamp(
        report.componentStack,
        CRASH_PAYLOAD_LIMITS.componentStack,
      );
      writeCrashLine("renderer-error", { message, stack, componentStack });
      // The renderer never talks to Sentry directly: it reports here over the
      // existing validated IPC bridge and MAIN forwards. That keeps the
      // renderer's CSP untouched (no ingest origin in `connect-src`), keeps the
      // renderer bundle free of any reporting code, and leaves exactly one
      // place where scrubbing happens. No-op unless Sentry is enabled.
      captureSentryError({
        message: message ?? "Unknown renderer error",
        ...(stack ? { stack } : {}),
        ...(componentStack ? { componentStack } : {}),
        process: "renderer",
      });
    },
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Wire up the process-gone handlers and the validated renderer-error IPC handler.
 * Call once, after `app.whenReady()`, from the main process. The native reporter
 * itself is started separately and earlier via {@link startCrashReporter}.
 */
export function registerCrashReporting(): void {
  registerHandlers();
}
