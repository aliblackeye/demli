/**
 * Desktop-surface stand-ins for the settings harness (dev only).
 *
 * `?surface=desktop` makes the page present itself as the Electron app
 * (`appInfo.platform = "win32"`) and swaps in in-memory `system` and `updates`
 * bridges, so the desktop-only settings (tray, launch at startup, the updater
 * panel, the critical overlay, the optional-update banner) render with real,
 * clickable state. The web surface keeps the honest web shim untouched.
 */
import type { UpdateStatus } from "@demli/app-ui";

type Listener = (status: UpdateStatus) => void;

let status: UpdateStatus = { kind: "up-to-date", version: "0.0.80" };
const listeners = new Set<Listener>();

/** Push a status from the harness toolbar, exactly as main would over IPC. */
export function pushUpdateStatus(next: UpdateStatus): void {
  status = next;
  for (const listener of listeners) listener(next);
}

export function installDesktopBridge(failSystemWrites: boolean): void {
  const bridge = window.demli;
  const settings = { closeToTray: true, autoLaunch: false };
  Object.assign(bridge.appInfo, { platform: "win32", version: "0.0.80" });
  bridge.system = {
    ...bridge.system,
    getSettings: async () => ({ ...settings }),
    setCloseToTray: async (enabled: boolean) => {
      await new Promise((r) => window.setTimeout(r, 220));
      if (failSystemWrites) throw new Error("harness: system write refused");
      settings.closeToTray = enabled;
      return { ...settings };
    },
    setAutoLaunch: async (enabled: boolean) => {
      await new Promise((r) => window.setTimeout(r, 220));
      if (failSystemWrites) throw new Error("harness: system write refused");
      settings.autoLaunch = enabled;
      return { ...settings };
    },
  };
  bridge.updates = {
    check: async () => {
      pushUpdateStatus({ kind: "checking" });
      await new Promise((r) => window.setTimeout(r, 900));
      pushUpdateStatus({ kind: "available", version: "0.0.81", critical: false });
      return status;
    },
    getStatus: async () => status,
    onStatus: (listener: Listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    downloadAndInstall: async () => {
      if (status.kind !== "available") return;
      const version = status.version;
      const critical = status.critical;
      for (let percent = 0; percent <= 100; percent += 10) {
        pushUpdateStatus({ kind: "downloading", version, percent, critical });
        await new Promise((r) => window.setTimeout(r, 160));
      }
      pushUpdateStatus({ kind: "ready", version, critical });
    },
  };
}
