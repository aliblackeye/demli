/**
 * Browser notification permission — the web build's half of "bildirim gelmeli".
 *
 * The renderer is one product on two surfaces (lib/surface.ts). On Electron the
 * OS toast needs no permission: the preload bridge shows it. In a browser the
 * page must be GRANTED permission first, and until this module existed nothing
 * ever asked — `Notification.permission` sat at "default" forever, so
 * `web-bridge.notify()` returned silently on every single event and the web app
 * never produced one notification.
 *
 * ---------------------------------------------------------------------------
 * WHY WE DO NOT PROMPT ON LOAD
 * ---------------------------------------------------------------------------
 * A permission prompt fired on page load is the pattern browsers actively
 * punish: Chrome's "quiet UI" hides it behind a bell icon for users who habitually
 * dismiss, Firefox blocks any request not tied to a user gesture outright, and —
 * worst of all — a dismissal from a prompt the user did not ask for is
 * PERMANENT. `Notification.requestPermission()` can never be shown again for
 * that origin; the user must dig through site settings. One badly-timed prompt
 * costs the feature forever.
 *
 * So the request is only ever made from a real click (the Settings button), and
 * the resulting state is reported honestly in Settings — including "denied",
 * with instructions, rather than a switch that pretends to be on while nothing
 * happens.
 */

import { create } from "zustand";
import { isWebSurface } from "../lib/surface";

/**
 * - `unsupported` — not a browser build, or an engine with no Notification API
 *   (older Safari on iOS). The in-app fallback carries the load.
 * - `default`     — supported, never asked. A click can still ask.
 * - `granted`     — real OS toasts available.
 * - `denied`      — the user said no (or dismissed a prompt once). We cannot ask
 *   again from script; only site settings can undo it.
 */
export type WebNotificationPermission = "unsupported" | "default" | "granted" | "denied";

/** True when this build is a browser AND the engine has the Notification API. */
export function webNotificationsSupported(): boolean {
  return isWebSurface() && typeof window !== "undefined" && "Notification" in window;
}

/** Read the live browser permission (never cached — the user can change it). */
export function readWebNotificationPermission(): WebNotificationPermission {
  if (!webNotificationsSupported()) return "unsupported";
  const permission = Notification.permission;
  if (permission === "granted" || permission === "denied") return permission;
  return "default";
}

interface WebNotificationPermissionState {
  /** Last read permission. Seeded synchronously at store creation. */
  status: WebNotificationPermission;
  /** True while a request prompt is open (the button shows a pending state). */
  requesting: boolean;
  /** Re-read the browser's current answer (cheap; call on mount / on focus). */
  refresh: () => void;
  /**
   * Ask the browser. MUST be called from a user gesture — see the file header.
   * Resolves with the resulting state; never throws.
   */
  request: () => Promise<WebNotificationPermission>;
}

export const useWebNotificationPermission = create<WebNotificationPermissionState>()(
  (set, get) => ({
    status: readWebNotificationPermission(),
    requesting: false,

    refresh: () => {
      const next = readWebNotificationPermission();
      if (next !== get().status) set({ status: next });
    },

    request: async () => {
      if (!webNotificationsSupported()) {
        set({ status: "unsupported" });
        return "unsupported";
      }
      // Already decided: asking again is a no-op in every engine, and for
      // "denied" it silently resolves without a prompt. Report the truth.
      const current = readWebNotificationPermission();
      if (current !== "default") {
        set({ status: current });
        return current;
      }

      set({ requesting: true });
      try {
        // Older engines only support the callback form; the promise form is
        // undefined there, so fall back rather than awaiting undefined.
        const result = await new Promise<NotificationPermission>((resolve) => {
          let settled = false;
          const done = (value: NotificationPermission): void => {
            if (settled) return;
            settled = true;
            resolve(value);
          };
          try {
            const maybePromise = Notification.requestPermission(done);
            if (maybePromise && typeof maybePromise.then === "function") {
              void maybePromise.then(done, () => done(Notification.permission));
            }
          } catch {
            done(Notification.permission);
          }
        });
        const next: WebNotificationPermission =
          result === "granted" || result === "denied" ? result : "default";
        set({ status: next, requesting: false });
        return next;
      } catch {
        const next = readWebNotificationPermission();
        set({ status: next, requesting: false });
        return next;
      }
    },
  }),
);
