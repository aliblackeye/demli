import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  nativeImage,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";
import { promises as fs } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  SYSTEM_CHANNELS,
  type DesktopSystemSettings,
  type TrayVoiceStatus,
} from "./system-types";
import { TASKBAR_UNREAD_BADGE_PNG_BASE64, TRAY_ICONS } from "./tray-icon";
import {
  IDLE_TRAY_STATE,
  selectTrayIcon,
  trayTooltip,
  type TrayIconState,
} from "./tray-icon-variant";

/**
 * Desktop system integration (main process): system tray + close-to-tray +
 * launch-at-startup, backed by a small persisted settings file.
 *
 * Milestone 6 (founder request): keep the app running in the background for
 * voice/notifications instead of quitting on the window's X, and let it start
 * with Windows.
 *
 * Behaviour:
 *   - A tray icon with "Aç / Göster" (show+focus) and "Çıkış" (real quit). Left-
 *     click toggles the window.
 *   - Close-to-tray (setting, default ON): the window's X hides to tray instead
 *     of quitting. A real quit only via tray "Çıkış" or the app menu — both go
 *     through `app.quit()`, and the `before-quit` guard below lets the window
 *     close past the hide-to-tray handler (no separate flag plumbing needed).
 *   - Launch-at-startup (setting, default OFF): `app.setLoginItemSettings`; when
 *     enabled the app also auto-starts hidden to tray.
 *
 * The tray icon is also the founder's at-a-glance readout of his own VOICE state
 * (normal / muted mic / deafened) with the unread dot layered on top. The rule
 * that picks the image is a pure function in `tray-icon-variant.ts` — it is the
 * founder-visible behaviour, and it must be unit-testable without an Electron
 * runtime. This module only holds the two transient inputs and paints the result.
 *
 * Security posture (CLAUDE.md §9, §28):
 *   - The renderer can only flip named flags through the validated bridge
 *     (`window.demli.system`): the two persisted settings below plus the
 *     transient `setUnreadBadge` / `setVoiceStatus` tray signals. Every payload is
 *     zod-validated (a bare boolean, or a strict three-boolean object); no
 *     filesystem, shell, login-item, or window internals are exposed — main
 *     derives the tray image + overlay icon from embedded assets itself.
 *   - The settings file holds non-secret UX flags only (never tokens), so it is
 *     stored as plain JSON (unlike the OS-encrypted session token). The unread
 *     badge and voice status are runtime-only and never persisted.
 */

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Settings file name under the app's userData directory. */
const SETTINGS_FILE = "desktop-settings.json";

const DEFAULT_SETTINGS: DesktopSystemSettings = {
  closeToTray: true,
  autoLaunch: false,
};

/** Validate the on-disk document defensively (a hand-edited/corrupt file must not crash us). */
const settingsSchema = z
  .object({
    closeToTray: z.boolean(),
    autoLaunch: z.boolean(),
  })
  .partial();

const boolSchema = z.boolean();

/**
 * Tray voice-status payload. `.strict()` so an unexpected key is a rejection
 * rather than a silently ignored field — this crosses the process boundary, and
 * main must never accept a shape it did not agree to (CLAUDE.md §28).
 */
const voiceStatusSchema = z
  .object({
    inVoiceSession: z.boolean(),
    micEnabled: z.boolean(),
    deafened: z.boolean(),
  })
  .strict();

function settingsFilePath(): string {
  return join(app.getPath("userData"), SETTINGS_FILE);
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

let settings: DesktopSystemSettings = { ...DEFAULT_SETTINGS };
let tray: Tray | null = null;
/** Flipped true once a real quit is underway, so the close handler stops hiding. */
let quitting = false;
let ipcRegistered = false;
let loaded = false;
/**
 * The two transient signals the renderer pushes (unread + own voice state), held
 * together because they share ONE tray image. Never persisted; reset to the
 * neutral state on sign-out by the renderer's tray sync.
 */
let trayState: TrayIconState = { ...IDLE_TRAY_STATE };

// ---------------------------------------------------------------------------
// Settings load / save
// ---------------------------------------------------------------------------

/** Load settings synchronously at startup (best effort; falls back to defaults). */
function loadSettings(): void {
  if (loaded) {
    return;
  }
  loaded = true;
  try {
    const raw = readFileSync(settingsFilePath(), "utf8");
    const parsed = settingsSchema.safeParse(JSON.parse(raw));
    if (parsed.success) {
      settings = { ...DEFAULT_SETTINGS, ...parsed.data };
    }
  } catch {
    // Missing / unreadable / corrupt — keep defaults.
    settings = { ...DEFAULT_SETTINGS };
  }
}

async function saveSettings(): Promise<void> {
  const path = settingsFilePath();
  const tmp = `${path}.tmp`;
  const body = JSON.stringify(settings, null, 2);
  try {
    await fs.writeFile(tmp, body, { encoding: "utf8" });
    await fs.rename(tmp, path);
  } catch (err) {
    await fs.unlink(tmp).catch(() => undefined);
    console.warn("[system] failed to persist settings:", err);
  }
}

// ---------------------------------------------------------------------------
// Launch-at-startup
// ---------------------------------------------------------------------------

/**
 * Apply the login-item registration. `openAsHidden` (macOS) + `--hidden` arg
 * (Windows) make an auto-launched app start hidden to tray. Wrapped in try/catch
 * because `setLoginItemSettings` can throw on locked-down machines / unsupported
 * platforms — a failure must not crash the app or block the settings toggle.
 */
function applyAutoLaunch(enabled: boolean): void {
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      openAsHidden: enabled,
      args: enabled ? ["--hidden"] : [],
    });
  } catch (err) {
    console.warn("[system] setLoginItemSettings failed:", err);
  }
}

/**
 * Whether this launch should start hidden to tray: either an explicit `--hidden`
 * arg (Windows auto-launch) or the OS reporting a hidden login-item launch (mac).
 */
export function shouldStartHidden(): boolean {
  if (process.argv.includes("--hidden")) {
    return true;
  }
  try {
    return app.getLoginItemSettings().wasOpenedAsHidden;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Window helpers
// ---------------------------------------------------------------------------

function targetWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows()[0] ?? null;
}

function showWindow(): void {
  const win = targetWindow();
  if (!win) {
    return;
  }
  if (win.isMinimized()) {
    win.restore();
  }
  win.show();
  win.focus();
}

function toggleWindow(): void {
  const win = targetWindow();
  if (!win) {
    return;
  }
  if (win.isVisible() && !win.isMinimized()) {
    win.hide();
  } else {
    showWindow();
  }
}

// ---------------------------------------------------------------------------
// Tray
// ---------------------------------------------------------------------------

/**
 * The tray image for the current state: a voice-state base (box-less Demli
 * tea-glass / muted mic / deafened headphones) with the unread dot layered on.
 * All variants are embedded base64 (see main/tray-icon.ts, itself generated by
 * scripts/gen-icons.mjs) so they ship inside the app bundle.
 *
 * Built with BOTH scale representations rather than one 32px bitmap: Windows
 * draws the tray at 16px on a 100% DPI display, and letting it downscale a 32px
 * image there smears exactly the detail that has to survive — the slash across
 * the mic/headphones. The 16px art is drawn on its own optical grid upstream, so
 * handing it over as the 1x representation is what makes the muted state legible
 * on a standard-DPI monitor.
 */
function trayImage(state: TrayIconState): Electron.NativeImage {
  const selection = selectTrayIcon(state);
  const asset = TRAY_ICONS[selection.base][selection.unread ? "unread" : "normal"];
  const image = nativeImage.createEmpty();
  image.addRepresentation({
    scaleFactor: 1,
    buffer: Buffer.from(asset.png16, "base64"),
  });
  image.addRepresentation({
    scaleFactor: 2,
    buffer: Buffer.from(asset.png32, "base64"),
  });
  return image;
}

function buildTray(): void {
  if (tray) {
    return;
  }
  tray = new Tray(trayImage(trayState));
  tray.setToolTip(trayTooltip(selectTrayIcon(trayState)));
  const menu = Menu.buildFromTemplate([
    { label: "Aç / Göster", click: () => showWindow() },
    { type: "separator" },
    {
      label: "Çıkış",
      click: () => {
        quitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  // Left-click toggles the window (Windows-first UX; harmless elsewhere).
  tray.on("click", () => toggleWindow());
}

/**
 * Repaint the tray icon + tooltip from {@link trayState}. Cheap and idempotent,
 * so both signal handlers can just call it.
 */
function refreshTray(): void {
  if (!tray || tray.isDestroyed()) {
    return;
  }
  tray.setImage(trayImage(trayState));
  tray.setToolTip(trayTooltip(selectTrayIcon(trayState)));
}

/**
 * Reflect an unread-notification state on the tray icon (red dot layered over
 * whatever voice base is current) and the Windows taskbar button (overlay icon).
 * No-op-safe on every platform: `setOverlayIcon` only exists on Windows, and
 * `setBadgeCount` covers macOS/Linux (dock / Unity launcher) as a cheap parity
 * nicety.
 */
function applyUnreadBadge(next: boolean): void {
  trayState = { ...trayState, hasUnread: next };
  refreshTray();

  // Windows taskbar overlay icon (bottom-right of the taskbar button).
  if (process.platform === "win32") {
    const win = targetWindow();
    if (win && !win.isDestroyed()) {
      if (next) {
        win.setOverlayIcon(
          nativeImage.createFromDataURL(
            `data:image/png;base64,${TASKBAR_UNREAD_BADGE_PNG_BASE64}`,
          ),
          "Okunmamış bildirimler",
        );
      } else {
        win.setOverlayIcon(null, "");
      }
    }
  } else {
    // macOS dock / Linux Unity launcher badge (boolean -> 0/1). Harmless no-op
    // where unsupported.
    try {
      app.setBadgeCount(next ? 1 : 0);
    } catch {
      // ignore — badge is best-effort
    }
  }
}

/**
 * Reflect the user's own voice state on the tray icon. Only the tray changes —
 * the taskbar overlay stays reserved for unread, which is what it means on
 * Windows.
 */
function applyVoiceStatus(next: TrayVoiceStatus): void {
  trayState = { ...trayState, ...next };
  refreshTray();
}

// ---------------------------------------------------------------------------
// Window close -> hide-to-tray
// ---------------------------------------------------------------------------

/**
 * Attach the close-to-tray handler to a window. Call from `createMainWindow`.
 * When close-to-tray is on and no real quit is underway, the X hides the window
 * instead of destroying it.
 */
export function attachWindowToTray(window: BrowserWindow): void {
  window.on("close", (event) => {
    if (quitting || !settings.closeToTray) {
      return; // real quit, or setting off -> allow the normal close
    }
    event.preventDefault();
    window.hide();
  });
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

function registerIpc(): void {
  if (ipcRegistered) {
    return;
  }
  ipcRegistered = true;

  ipcMain.handle(
    SYSTEM_CHANNELS.getSettings,
    async (): Promise<DesktopSystemSettings> => settings,
  );

  ipcMain.handle(
    SYSTEM_CHANNELS.setCloseToTray,
    async (
      _event: IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<DesktopSystemSettings> => {
      const parsed = boolSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error("system: invalid closeToTray value");
      }
      settings = { ...settings, closeToTray: parsed.data };
      await saveSettings();
      return settings;
    },
  );

  ipcMain.handle(
    SYSTEM_CHANNELS.setAutoLaunch,
    async (
      _event: IpcMainInvokeEvent,
      raw: unknown,
    ): Promise<DesktopSystemSettings> => {
      const parsed = boolSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error("system: invalid autoLaunch value");
      }
      settings = { ...settings, autoLaunch: parsed.data };
      applyAutoLaunch(parsed.data);
      await saveSettings();
      return settings;
    },
  );

  ipcMain.handle(
    SYSTEM_CHANNELS.setUnreadBadge,
    async (_event: IpcMainInvokeEvent, raw: unknown): Promise<void> => {
      const parsed = boolSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error("system: invalid unread badge value");
      }
      applyUnreadBadge(parsed.data);
    },
  );

  ipcMain.handle(
    SYSTEM_CHANNELS.setVoiceStatus,
    async (_event: IpcMainInvokeEvent, raw: unknown): Promise<void> => {
      const parsed = voiceStatusSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error("system: invalid voice status payload");
      }
      applyVoiceStatus(parsed.data);
    },
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Wire up the desktop-system integration. Call once, after `app.whenReady()`,
 * from the main process (before creating the window, so the close handler and
 * tray are ready). Loads settings, reconciles the login item with the persisted
 * flag, builds the tray, installs the quit guard, and registers the validated IPC.
 */
export function registerDesktopSystem(): void {
  loadSettings();
  // Keep the OS login item in sync with the persisted preference every launch.
  applyAutoLaunch(settings.autoLaunch);
  buildTray();

  // A real quit (tray "Çıkış", app menu, or autoUpdater.quitAndInstall) goes
  // through app.quit() -> 'before-quit'. Setting the flag here lets the window's
  // close handler fall through instead of hiding to tray.
  app.on("before-quit", () => {
    quitting = true;
  });

  registerIpc();
}
