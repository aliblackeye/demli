import {
  BrowserWindow,
  ipcMain,
  powerMonitor,
  type IpcMainInvokeEvent,
} from "electron";
import { z } from "zod";
import {
  ACTIVE_STATE,
  pollDelayMs,
  resolveSystemIdleState,
  sameSystemIdleState,
} from "./system-idle-state";
import {
  SYSTEM_IDLE_CHANNELS,
  SYSTEM_IDLE_THRESHOLD_MAX_MS,
  SYSTEM_IDLE_THRESHOLD_MIN_MS,
  type SystemIdleState,
} from "./system-idle-types";

/**
 * System-idle watcher (main process) — the OS-wide "is the user at their
 * computer?" signal behind automatic "boşta" presence.
 *
 * WHY MAIN, NOT THE RENDERER
 * --------------------------
 * The renderer's old detector listened on `window` events, so it only saw input
 * that reached the Demli window. A user busy in a browser/game/editor produced
 * ZERO events and was marked away after five minutes — and, coming back, stayed
 * away until they happened to click Demli itself. Both are wrong: the founder's
 * rule is "bilgisayarda bir yere dokunmayınca". `powerMonitor.getSystemIdleTime()`
 * reports seconds since the last input ANYWHERE on the machine, which is exactly
 * the question, so the measurement moved here and the renderer is handed the
 * answer.
 *
 * Behaviour:
 *   - A two-speed poll of the OS inactivity clock (see `system-idle-state.ts`):
 *     lazy while present, snappy while away so the comeback feels instant.
 *   - `lock-screen` / `suspend` mean away IMMEDIATELY (no waiting out the
 *     threshold); `unlock-screen` / `resume` re-read the clock rather than
 *     assuming presence — a machine woken by a timer with nobody in front of it
 *     must stay away.
 *   - Only TRANSITIONS are broadcast; the steady state costs one cheap syscall
 *     per poll and no IPC traffic (§27).
 *
 * Security posture (CLAUDE.md §9, §28):
 *   - The renderer gets no `powerMonitor` access. The only inbound payload is
 *     `{ thresholdMs }`, zod-validated AND bounded (30 s … 24 h) before use, so a
 *     compromised renderer cannot turn this into a busy-loop or a never-firing
 *     watcher.
 *   - The only outbound data is `{ idle, reason }` — a boolean plus a coarse
 *     enum. The raw idle duration never leaves main.
 *   - `stop` is argument-free; nothing here touches the filesystem, shell,
 *     window internals, or navigation.
 */

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let ipcRegistered = false;
let powerEventsWired = false;

/** Armed by the renderer's `start`; false means "do nothing at all". */
let watching = false;
/** Validated inactivity budget from the renderer. Meaningless while idle. */
let thresholdMs = SYSTEM_IDLE_THRESHOLD_MIN_MS;
/** The last state we told the renderer about. */
let current: SystemIdleState = ACTIVE_STATE;
/** Pending poll timer, if any. */
let pollTimer: NodeJS.Timeout | null = null;

/**
 * Sleep / lock are tracked as INDEPENDENT flags rather than one "reason", so a
 * machine that locked and then slept reports "suspended" while asleep and falls
 * back to "locked" on resume — instead of a resume event wrongly clearing a lock
 * that is still in place.
 */
let systemSuspended = false;
let screenLocked = false;

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/**
 * Seconds since the last OS-wide input, or null when the platform cannot say.
 * `getSystemIdleTime` is documented as unavailable on some Linux setups and can
 * throw before the app is ready; a null answer fails safe to "active" upstream.
 */
function readIdleSeconds(): number | null {
  try {
    return powerMonitor.getSystemIdleTime();
  } catch (err) {
    console.warn("[system-idle] getSystemIdleTime unavailable:", err);
    return null;
  }
}

function computeState(): SystemIdleState {
  return resolveSystemIdleState({
    suspended: systemSuspended,
    locked: screenLocked,
    idleSeconds: readIdleSeconds(),
    thresholdMs,
  });
}

// ---------------------------------------------------------------------------
// Broadcast + scheduling
// ---------------------------------------------------------------------------

function broadcast(state: SystemIdleState): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(SYSTEM_IDLE_CHANNELS.changed, state);
    }
  }
}

function clearPoll(): void {
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function schedulePoll(): void {
  clearPoll();
  if (!watching) {
    return;
  }
  pollTimer = setTimeout(refresh, pollDelayMs(current));
}

/** Re-read the world, broadcast a transition if there is one, re-arm the poll. */
function refresh(): void {
  if (!watching) {
    clearPoll();
    return;
  }
  const next = computeState();
  if (!sameSystemIdleState(next, current)) {
    current = next;
    broadcast(current);
  }
  schedulePoll();
}

// ---------------------------------------------------------------------------
// powerMonitor events
// ---------------------------------------------------------------------------

/**
 * Wire the lock/sleep events once, for the lifetime of the process. They are
 * cheap, they only flip two booleans, and `refresh()` is a no-op while the
 * watcher is disarmed — so there is nothing to unregister on logout.
 */
function wirePowerEvents(): void {
  if (powerEventsWired) {
    return;
  }
  powerEventsWired = true;

  powerMonitor.on("suspend", () => {
    systemSuspended = true;
    refresh();
  });
  powerMonitor.on("resume", () => {
    systemSuspended = false;
    // NOT "the user is back": re-read the inactivity clock. A machine woken by a
    // scheduled task with nobody in front of it stays away until real input.
    refresh();
  });
  powerMonitor.on("lock-screen", () => {
    screenLocked = true;
    refresh();
  });
  powerMonitor.on("unlock-screen", () => {
    screenLocked = false;
    // Unlocking took real input, so the clock is ~0 and this resolves to active.
    refresh();
  });
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

/**
 * The renderer owns the threshold (one constant in `stores/idle-auto.ts`), but
 * main never trusts it: it must be a finite integer inside sane bounds.
 */
const watchOptionsSchema = z.object({
  thresholdMs: z
    .number()
    .int()
    .min(SYSTEM_IDLE_THRESHOLD_MIN_MS)
    .max(SYSTEM_IDLE_THRESHOLD_MAX_MS),
});

function registerIpc(): void {
  if (ipcRegistered) {
    return;
  }
  ipcRegistered = true;

  ipcMain.handle(
    SYSTEM_IDLE_CHANNELS.start,
    async (
      _event: IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<SystemIdleState> => {
      const parsed = watchOptionsSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error("system-idle: invalid watch options");
      }
      thresholdMs = parsed.data.thresholdMs;
      watching = true;
      // The caller applies the RETURNED state, so compute it without
      // broadcasting — otherwise a fresh start would double-apply.
      current = computeState();
      schedulePoll();
      return current;
    },
  );

  ipcMain.handle(SYSTEM_IDLE_CHANNELS.stop, async (): Promise<void> => {
    watching = false;
    clearPoll();
    current = ACTIVE_STATE;
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Wire up the system-idle watcher. Call once, after `app.whenReady()` (the
 * `powerMonitor` module requires a ready app) and before the window loads, so
 * the IPC exists by the time the renderer signs in and arms it.
 *
 * Nothing is measured until the renderer calls `start` — a signed-out app polls
 * nothing.
 */
export function registerSystemIdle(): void {
  wirePowerEvents();
  registerIpc();
}
