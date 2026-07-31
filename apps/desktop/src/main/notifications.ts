import {
  app,
  BrowserWindow,
  ipcMain,
  Notification,
  type IpcMainInvokeEvent,
} from "electron";
import { z } from "zod";
import {
  NOTIFICATION_CHANNELS,
  type NotificationNavigate,
  type NotificationRequest,
} from "./notifications-types";

/**
 * Desktop notifications (main process): show a native OS toast on the renderer's
 * request, and — when the user clicks it — bring the window forward and tell the
 * renderer where to navigate.
 *
 * Why main owns this (CLAUDE.md §9): showing a toast can be done from the
 * renderer's `new Notification()`, but focusing/restoring the window on click is
 * a privileged, main-process job. So the renderer (which sees the messages)
 * decides WHAT to show and asks main through the validated bridge; main shows the
 * toast, and on click restores + focuses the window and echoes the navigate
 * target back to the renderer.
 *
 * Security posture (CLAUDE.md §9, §28):
 *   - The single inbound IPC (`notify`) zod-validates its whole payload before a
 *     Notification is constructed. Title/body are length-bounded plain text
 *     (native toasts render no HTML — no injection surface).
 *   - The `navigate` target is opaque routing data: main never acts on it beyond
 *     echoing the exact validated object back to the renderer on click. It can
 *     carry no filesystem/shell/privileged capability.
 *   - No new window prefs, navigation, or shell access are introduced.
 */

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

/**
 * Windows requires an explicit AppUserModelID for toast notifications to be
 * delivered and attributed to Demli (not "electron.exe"). Must match the
 * `appId` in electron-builder.yml. No-op on macOS/Linux (we guard on platform).
 */
const WINDOWS_APP_USER_MODEL_ID = "app.demli.desktop";

/** Generous but bounded — a title/body longer than this is abusive, not useful. */
const TITLE_MAX = 200;
const BODY_MAX = 300;
/** Opaque routing ids (branded ids on the renderer side); bound to a sane length. */
const ID_MAX = 128;

const idSchema = z.string().min(1).max(ID_MAX);

const navigateSchema: z.ZodType<NotificationNavigate> = z.discriminatedUnion(
  "target",
  [
    z.object({
      target: z.literal("channel"),
      groupId: idSchema,
      channelId: idSchema,
    }),
    z.object({
      target: z.literal("groupChat"),
      groupChatId: idSchema,
      streamId: idSchema,
    }),
    z.object({
      target: z.literal("dm"),
      dmId: idSchema,
      streamId: idSchema,
    }),
    z.object({ target: z.literal("friends") }),
    // App-update-ready: no ids to carry — main only focuses the window on click.
    z.object({ target: z.literal("update") }),
    // Incoming DM call: no ids — the global overlay is already visible, so a click
    // only needs to focus the window (ADR 0012 Wave 6).
    z.object({ target: z.literal("call") }),
  ],
);

const requestSchema: z.ZodType<NotificationRequest> = z.object({
  // Title may be empty in theory; trim + cap. Body likewise (attachment-only
  // messages still carry a localized body from the renderer).
  title: z.string().max(TITLE_MAX),
  body: z.string().max(BODY_MAX),
  navigate: navigateSchema,
});

// ---------------------------------------------------------------------------
// Window focus
// ---------------------------------------------------------------------------

function targetWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null;
}

/**
 * Bring the app forward when a notification is clicked: restore from minimized,
 * show if hidden to tray, and focus. Mirrors the tray "show" behaviour in
 * `system.ts` (kept local to avoid coupling the two main modules).
 */
function focusMainWindow(): void {
  const win = targetWindow();
  if (!win || win.isDestroyed()) {
    return;
  }
  if (win.isMinimized()) {
    win.restore();
  }
  if (!win.isVisible()) {
    win.show();
  }
  win.focus();
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

let ipcRegistered = false;

function showNotification(request: NotificationRequest): void {
  // OS/user may have notifications disabled — never assume support.
  if (!Notification.isSupported()) {
    return;
  }

  const notification = new Notification({
    title: request.title,
    body: request.body,
    // SILENT: the app owns the sound, not the OS.
    //
    // The stale claim above this line was that our cue "only plays in-app" and so
    // could not collide. It always could — both fire for the same message — but
    // the toast used to appear only while the app was UNFOCUSED, so the overlap
    // was rare enough to pass for the OS being a bit loud. The notify policy now
    // toasts whenever the user is not looking at THAT conversation, which is most
    // of the time, so every message would arrive as two different sounds a
    // moment apart. That is a large part of what "dandik" describes.
    //
    // Ours wins because it is the one that carries meaning: distinct cues per
    // event, levels balanced against each other, and mutable from our own
    // settings. The OS ding is one sound for everything and ignores those.
    silent: true,
  });

  notification.on("click", () => {
    focusMainWindow();
    // Echo the exact validated navigate target to the (now-focused) window so the
    // renderer can route. Send to every live window's webContents — single-window
    // app, but this stays correct if a second window is ever added.
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(NOTIFICATION_CHANNELS.activated, request.navigate);
      }
    }
  });

  notification.show();
}

/**
 * Register the notifications IPC. Idempotent — safe to call once after
 * `app.whenReady()`.
 */
export function registerNotifications(): void {
  if (ipcRegistered) {
    return;
  }
  ipcRegistered = true;

  // Set the Windows AppUserModelID so native toasts actually appear (esp. in dev).
  if (process.platform === "win32") {
    app.setAppUserModelId(WINDOWS_APP_USER_MODEL_ID);
  }

  ipcMain.handle(
    NOTIFICATION_CHANNELS.notify,
    async (_event: IpcMainInvokeEvent, raw: unknown): Promise<void> => {
      const parsed = requestSchema.safeParse(raw);
      if (!parsed.success) {
        // A malformed request is dropped silently — a notification is best-effort
        // UX, never worth throwing back into the renderer.
        console.warn("[notifications] invalid notify payload; ignored");
        return;
      }
      showNotification(parsed.data);
    },
  );

  // Argument-free raise+focus for the incoming-call ring. No payload is trusted;
  // main only runs its own focus routine (restore + show + focus). This introduces
  // no new window prefs, navigation, or shell access (CLAUDE.md §9, §28).
  ipcMain.handle(
    NOTIFICATION_CHANNELS.requestFocus,
    async (): Promise<void> => {
      focusMainWindow();
    },
  );
}
