/**
 * Shared desktop-notifications contract (native toast + click-to-navigate).
 *
 * Pure TypeScript types plus the IPC channel-name constants, importing NOTHING
 * from `electron` or `node` — mirroring the other `*-types.ts` modules. Safe to
 * import from:
 *   - the main process (`notifications.ts`)      — values + types
 *   - the preload bridge (`preload/index.ts`)    — values + types
 *   - the renderer (via a type-only import)       — types only
 *
 * Do not add electron/node imports here, or the renderer bundle will break.
 *
 * Security posture (CLAUDE.md §9, §28): the renderer requests a notification and
 * the payload is zod-validated in main before a `Notification` is shown. The
 * `navigate` target is opaque routing data (plain strings) that main echoes back
 * to the renderer on click — it is never used by main for anything but the echo,
 * so it can carry no privileged capability.
 */

/**
 * IPC channel names for desktop notifications. Single source of truth — never
 * hard-code these strings anywhere else (CLAUDE.md §23: no magic strings).
 */
export const NOTIFICATION_CHANNELS = {
  /** renderer -> main (invoke): show a native notification for a validated request. */
  notify: "demli:notifications:notify",
  /** main -> renderer (send): a shown notification was clicked; carries its navigate target. */
  activated: "demli:notifications:activated",
  /**
   * renderer -> main (invoke): proactively raise + focus the window. Argument-free
   * (no untrusted payload). Used by the incoming-call ring to bring the app forward
   * when a call arrives while it is unfocused/minimized/hidden — the
   * "answer the call" foreground behaviour (ADR 0012 Wave 6).
   */
  requestFocus: "demli:notifications:request-focus",
} as const;

export type NotificationChannel =
  (typeof NOTIFICATION_CHANNELS)[keyof typeof NOTIFICATION_CHANNELS];

/**
 * Where a click on a notification should take the user. A discriminated union of
 * plain, serializable routing data — the IDs are opaque strings to the main
 * process (they are branded ids on the renderer side, structurally strings). The
 * renderer resolves each variant to a chat-store navigation action.
 */
export type NotificationNavigate =
  /** A server text channel: switch to the server surface and select the channel. */
  | { target: "channel"; groupId: string; channelId: string }
  /** A flat group chat (ADR 0005): open the group conversation on the home surface. */
  | { target: "groupChat"; groupChatId: string; streamId: string }
  /** A 1:1 DM (ADR 0010): open the DM conversation on the home surface. */
  | { target: "dm"; dmId: string; streamId: string }
  /** The friends surface (used by friend-request notifications). */
  | { target: "friends" }
  /**
   * An app update finished downloading and is ready to install. Carries no ids:
   * clicking just needs main to focus the window — the app-wide update banner
   * (mounted at the App root) is already visible whenever an update is ready, so
   * the user acts from there. Fired by the update-ready toast (auto-update).
   */
  | { target: "update" }
  /**
   * An incoming DM call (ADR 0012 Wave 6). Carries no ids: the global incoming-call
   * overlay renders on every screen already, so clicking the toast only needs main
   * to focus the window — the renderer takes no navigation action.
   */
  | { target: "call" };

/**
 * A single notification request from the renderer. `title`/`body` are plain text
 * (native notifications never render HTML — no injection surface) and length-
 * bounded in main. `navigate` is the click target described above.
 */
export interface NotificationRequest {
  title: string;
  body: string;
  navigate: NotificationNavigate;
}

/**
 * The minimal notifications surface exposed on `window.demli.notifications`.
 *
 * `notify` fire-and-forgets a validated request (main decides whether the OS can
 * show it). `onActivated` subscribes to click events and returns an unsubscribe
 * function — only the sanitized {@link NotificationNavigate} reaches the callback,
 * never the raw IPC event (mirrors capture's `onDisplaySourceServed`).
 */
export interface NotificationsBridge {
  notify(request: NotificationRequest): Promise<void>;
  onActivated(listener: (navigate: NotificationNavigate) => void): () => void;
  /**
   * Proactively raise + focus the app window (argument-free). Used by the
   * incoming-call ring so the call is not missed when the app is in the
   * background. Best-effort — resolves once main has run its focus routine.
   */
  requestFocus(): Promise<void>;
}
