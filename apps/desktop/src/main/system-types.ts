/**
 * Shared desktop-system contract (tray + launch-at-startup).
 *
 * Pure TypeScript types plus the IPC channel-name constants, importing NOTHING
 * from `electron` or `node` — mirroring the other `*-types.ts` modules. Safe to
 * import from:
 *   - the main process (`system.ts`)           — values + types
 *   - the preload bridge (`preload/index.ts`)  — values + types
 *   - the renderer (via a type-only import)     — types only
 *
 * Do not add electron/node imports here, or the renderer bundle will break.
 */

/**
 * IPC channel names for the desktop-system settings. Single source of truth —
 * never hard-code these strings anywhere else (CLAUDE.md §23: no magic strings).
 */
export const SYSTEM_CHANNELS = {
  /** renderer -> main (invoke): read the current {@link DesktopSystemSettings}. */
  getSettings: "demli:system:get-settings",
  /** renderer -> main (invoke): set "close hides to tray"; resolves to the new settings. */
  setCloseToTray: "demli:system:set-close-to-tray",
  /** renderer -> main (invoke): set "launch at startup"; resolves to the new settings. */
  setAutoLaunch: "demli:system:set-auto-launch",
  /**
   * renderer -> main (invoke): reflect whether there are unread notifications on
   * the system tray icon (red dot overlay) and the Windows taskbar overlay icon.
   * Transient runtime signal (NOT persisted). Payload is a single boolean.
   */
  setUnreadBadge: "demli:system:set-unread-badge",
  /**
   * renderer -> main (invoke): reflect the user's own voice state on the tray
   * icon (normal / muted mic / deafened). Transient runtime signal (NOT
   * persisted). Payload is {@link TrayVoiceStatus}, re-validated in main.
   *
   * A SEPARATE channel from `setUnreadBadge` on purpose: the two signals have
   * different sources (chat store vs voice store) and different rates, so each
   * pushes only when its own source changes. Main holds both halves and
   * recomputes the single tray image (see main/tray-icon-variant.ts).
   */
  setVoiceStatus: "demli:system:set-voice-status",
} as const;

export type SystemChannel =
  (typeof SYSTEM_CHANNELS)[keyof typeof SYSTEM_CHANNELS];

/**
 * User-controllable desktop-system preferences, persisted (unencrypted — these
 * are non-secret UX flags) under the app's userData directory and mirrored to the
 * renderer through the validated bridge below.
 */
export interface DesktopSystemSettings {
  /**
   * When true (default), clicking the window's X hides the app to the system
   * tray instead of quitting, so voice/notifications keep running. A real quit
   * is only via the tray "Çıkış" item. When false, X closes the window normally.
   */
  closeToTray: boolean;
  /**
   * When true, the app registers as a Windows login item (`setLoginItemSettings`)
   * and starts on sign-in (hidden to tray). Default false.
   */
  autoLaunch: boolean;
}

/**
 * The user's OWN voice state, as the tray needs to show it. Mirrored from the
 * voice engine's state (packages/media — the single source of truth, CLAUDE.md
 * §11); this is a read-only projection of it, never a second state model.
 */
export interface TrayVoiceStatus {
  /**
   * In a voice surface at all — a voice channel OR a DM call (both drive the same
   * engine). False makes the two flags below meaningless: they persist across
   * sessions as preferences, so out of a call they describe the NEXT join.
   */
  inVoiceSession: boolean;
  /** Mic on. Only meaningful while `inVoiceSession`. */
  micEnabled: boolean;
  /** Deafened. Only meaningful while `inVoiceSession`. Implies `!micEnabled`. */
  deafened: boolean;
}

/**
 * The minimal desktop-system surface exposed on `window.demli.system`.
 *
 * Each settings setter takes a single boolean (re-validated in main) and resolves
 * to the updated settings so the renderer reflects the new state without a
 * round-trip race. No filesystem, shell, or login-item internals are exposed —
 * the renderer can only flip these named flags and push the two transient tray
 * signals below.
 */
export interface SystemBridge {
  /** Read the current persisted settings. */
  getSettings(): Promise<DesktopSystemSettings>;
  /** Toggle close-to-tray; resolves to the updated settings. */
  setCloseToTray(enabled: boolean): Promise<DesktopSystemSettings>;
  /** Toggle launch-at-startup; resolves to the updated settings. */
  setAutoLaunch(enabled: boolean): Promise<DesktopSystemSettings>;
  /**
   * Reflect an unread-notification state on the tray icon (red dot) + the Windows
   * taskbar overlay. Transient — call it whenever the renderer's unread count
   * crosses 0 (true = there are unread notifications/messages, false = none).
   * Fire-and-forget; resolves once main has applied the badge.
   */
  setUnreadBadge(hasUnread: boolean): Promise<void>;
  /**
   * Reflect the user's own voice state on the tray icon (normal / muted mic /
   * deafened). Transient — call it only when the state actually CHANGES, never on
   * every voice tick: a live call fires speaking/quality updates continuously and
   * each call here crosses the process boundary and repaints the tray (§27).
   */
  setVoiceStatus(status: TrayVoiceStatus): Promise<void>;
}
