import { app, BrowserWindow, nativeImage } from "electron";
import { join } from "node:path";
import { resolveUserDataPath } from "./user-data-path";
import { WINDOW_ICON_PNG_BASE64 } from "./tray-icon";
import { registerScreenCapture } from "./capture";
import { isAllowedFrameUrl } from "./frame-navigation-policy";
import { registerProcessAudio } from "./process-audio";
import { registerSecureTokenStore } from "./secure-token";
import { registerSecureVaultStore } from "./secure-vault";
import {
  registerCrashReporting,
  startCrashReporter,
} from "./crash-reporter";
import { initSentry } from "./sentry";
import { registerAutoUpdater } from "./auto-update";
import { registerNotifications } from "./notifications";
import { registerImageActions } from "./image-actions";
import { registerExternalLinks } from "./external-link";
import { denyWindowOpen } from "./external-link-policy";
import {
  attachWindowToTray,
  registerDesktopSystem,
  shouldStartHidden,
} from "./system";
import { registerSystemIdle } from "./system-idle";

/**
 * Main process — app lifecycle, windows, and (later) tray, shortcuts,
 * desktop capture, auto-update. Privileged logic stays here; the renderer
 * only talks to it through the validated preload bridge.
 */

// userData is PINNED, for both packaged and dev runs — see ./user-data-path.ts
// for the full reasoning. Short version: Electron derives this directory from
// app.getName(), so a rebrand (productName / package name / extraMetadata) would
// silently move it and orphan every user's account vault, session and settings.
// Dev runs get their own profile so a `pnpm dev:desktop` preview does not fight
// the installed app over the single-instance lock (which keys on this path) or
// pollute its state. Must run before ANY userData consumer (crash reporter,
// lock, stores).
app.setPath(
  "userData",
  resolveUserDataPath(app.getPath("appData"), app.isPackaged),
);

// Start the native crash reporter BEFORE anything else (before app is ready and
// before any window) so early Electron/Chromium crashes still produce a local
// minidump. Local only — see main/crash-reporter.ts and docs/architecture/crash-reporting.md.
startCrashReporter();

/**
 * Sentry DSN, baked in at build time from the `SENTRY_DSN` (or `VITE_SENTRY_DSN`)
 * environment variable — see the `define` block in electron.vite.config.ts.
 * A packaged app has no process env of its own, so this MUST be a build-time
 * constant; `process.env` is only a convenience for `pnpm dev:desktop`.
 *
 * EMPTY IS THE DEFAULT AND MEANS OFF: `initSentry` refuses to start without a
 * valid https DSN, so a normal build performs no error-reporting network calls
 * whatsoever. Nothing else in the app changes either way.
 */
declare const __SENTRY_DSN__: string;
initSentry({
  dsn:
    (typeof __SENTRY_DSN__ === "string" ? __SENTRY_DSN__ : "") ||
    process.env["SENTRY_DSN"] ||
    "",
  release: app.getVersion(),
  environment: app.isPackaged ? "production" : "development",
  osName: process.platform,
  electronVersion: process.versions.electron,
});

// The single main window, tracked so a second launch can focus it.
let mainWindow: BrowserWindow | null = null;

// Single-instance lock — fixes duplicate windows/tray icons when Demli is
// launched a second time. If another copy already holds the lock, THIS launch
// quits and the primary instance focuses its existing window via the
// "second-instance" event. Must run before any window is created.
const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (!mainWindow) {
      return;
    }
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    if (!mainWindow.isVisible()) {
      mainWindow.show();
    }
    mainWindow.focus();
  });
}

function createMainWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    show: false,
    // Painted by Chromium before the renderer's first frame — so it must be the
    // Demli base, not the pre-rebrand Catppuccin value it was left on. Matches
    // the darkest stop of the startup gradient in renderer/index.html, so the
    // window never flashes a colour the app does not use.
    backgroundColor: "#0c0304",
    // Brand window icon (Alt-Tab / taskbar in dev + non-packaged runs). Packaged
    // builds also embed it in the exe via build/icon.ico. Generated from the
    // single-source logo — see scripts/gen-icons.mjs and ./tray-icon.
    icon: nativeImage.createFromDataURL(
      `data:image/png;base64,${WINDOW_ICON_PNG_BASE64}`,
    ),
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Show on ready, unless this launch should start hidden to tray (Windows
  // auto-launch with --hidden, or a hidden login-item launch on macOS).
  window.once("ready-to-show", () => {
    if (!shouldStartHidden()) {
      window.show();
    }
  });

  // Close-to-tray: the window's X hides to the tray (when enabled) instead of
  // quitting, so voice/notifications keep running. See main/system.ts.
  attachWindowToTray(window);

  // Window opens are DENIED UNCONDITIONALLY — no new window, and no handoff to
  // the OS either.
  //
  // This handler used to forward any `https://` url to `shell.openExternal`,
  // which was safe only while our own renderer was the sole thing that could
  // reach it. Watch Party (M20, ADR 0016) put content we do not control inside
  // the window, and every link in an embedded player — its title, its channel,
  // "Watch on YouTube", an end-screen card, an ad — opens with `target="_blank"`
  // and arrives right here. Forwarding those would turn a hostile embed into a
  // launcher for arbitrary urls on the user's machine: exactly the outcome the
  // `will-frame-navigate` guard below refuses on purpose. The two now agree.
  //
  // Our OWN external links do not depend on this path at all: they call the
  // validated `external-link:open` IPC through the preload bridge (see
  // main/external-link.ts), which the embed cannot reach — it is a subframe, and
  // that handler only accepts the top frame of one of our windows.
  // `denyWindowOpen` takes no arguments, so it structurally cannot branch on the
  // requested url — see main/external-link-policy.ts.
  window.webContents.setWindowOpenHandler(denyWindowOpen);

  // Block in-app navigation away from our own UI (TOP frame).
  window.webContents.on("will-navigate", (event, url) => {
    const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
    if (!devServerUrl || !url.startsWith(devServerUrl)) {
      event.preventDefault();
    }
  });

  // Block navigation away from our UI in ANY frame — including the Watch Party
  // iframe (M20, ADR 0016).
  //
  // This is a SEPARATE guard on purpose: `will-navigate` fires for the main
  // frame only, so before this app had an iframe it was the whole story, and
  // adding one silently opened a hole it does not cover. The CSP `frame-src`
  // decides what may be LOADED into a frame; this decides where a frame may
  // NAVIGATE to afterwards. Both are needed — a frame that starts on an allowed
  // host can still try to navigate itself elsewhere.
  //
  // The rule: a subframe may move around inside the embed origin (the player
  // does this normally — related videos, its own consent/ad frames) and nowhere
  // else. A refused navigation is simply cancelled; it is NOT re-opened
  // externally, because a frame navigating itself is not a user asking to visit
  // a page, and treating it as one would turn a hostile embed into a launcher
  // for arbitrary URLs on the user's machine.
  window.webContents.on("will-frame-navigate", (event) => {
    if (event.isMainFrame) {
      const devServerUrl = process.env["ELECTRON_RENDERER_URL"];
      if (!devServerUrl || !event.url.startsWith(devServerUrl)) {
        event.preventDefault();
      }
      return;
    }
    if (!isAllowedFrameUrl(event.url)) {
      event.preventDefault();
    }
  });

  if (process.env["ELECTRON_RENDERER_URL"]) {
    void window.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  } else {
    void window.loadFile(join(__dirname, "../renderer/index.html"));
  }

  mainWindow = window;
  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
  });

  return window;
}

app.whenReady().then(() => {
  // If another instance already holds the single-instance lock, this launch is
  // quitting — do not set up a window or the tray.
  if (!hasSingleInstanceLock) {
    return;
  }

  // Register crash reporting: process-gone handlers (render/child) that log to
  // a rotating file under userData, plus the validated renderer-error IPC
  // handler. The native reporter itself was already started at module load.
  registerCrashReporting();

  // Register the secure screen-capture path (desktopCapturer enumeration +
  // setDisplayMediaRequestHandler + validated IPC) before the window loads.
  registerScreenCapture();

  // Register the per-process audio-capture path (Windows WASAPI process
  // loopback): spawns the bundled helper binary for a shared window's PID and
  // streams its film audio to the renderer, bypassing the render endpoint /
  // Voicemeeter. Windows-only at runtime; the IPC registers on every platform
  // (start() returns `unsupported_platform` elsewhere). See main/process-audio.ts.
  registerProcessAudio();

  // Register the OS-encrypted session-token store (safeStorage + validated IPC)
  // so the renderer can persist the token without ever touching localStorage
  // (security-review M1).
  registerSecureTokenStore();

  // Register the OS-encrypted account-vault store (M15 / ADR 0013) — a second
  // safeStorage slot holding every signed-in account's token + profile for the
  // multi-account switcher. Same encrypted-at-rest posture as the token store.
  registerSecureVaultStore();

  // Register the desktop-system integration (tray, close-to-tray, launch-at-
  // startup + validated IPC) BEFORE the window so the close handler and tray are
  // ready when the first window appears.
  registerDesktopSystem();

  // Register the OS-WIDE idle watcher (powerMonitor inactivity clock + lock /
  // sleep events) behind automatic "boşta" presence. Needs a ready app, and
  // measures nothing until the renderer arms it after sign-in. See
  // main/system-idle.ts for why this cannot live in the renderer.
  registerSystemIdle();

  // Register the native-notification path (validated `notify` IPC + click →
  // focus window + `activated` navigate event). No window prefs or navigation
  // are touched; see main/notifications.ts for the security posture.
  registerNotifications();

  // Register "save image as…" / "copy image" for chat pictures. Both are
  // privileged (native save dialog + filesystem write, clipboard bitmap), so the
  // renderer only names the image it is already showing. Every payload is
  // zod-validated, the URL must be on the build-pinned storage allow-list, and
  // the bytes never travel back into the renderer — see main/image-actions.ts.
  registerImageActions();

  // Register the external-link path: the ONLY way a browser tab gets opened now
  // that `setWindowOpenHandler` is an unconditional deny. The url is zod-bounded
  // and re-validated (http(s) only, no credentials), the sender must be the top
  // frame of one of our windows, and opens are rate limited — see
  // main/external-link.ts. The renderer never receives `shell` itself.
  registerExternalLinks();

  createMainWindow();

  // Register auto-update (electron-updater). IPC registers in every build; the
  // actual check only runs in a packaged build (guarded off under dev).
  registerAutoUpdater();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
