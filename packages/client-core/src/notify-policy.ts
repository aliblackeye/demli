/**
 * WHEN may an alert interrupt the user? — the one place that decides, on EVERY
 * platform.
 *
 * Pure functions, no imports, no DOM, no React Native, no stores: every input is
 * passed in. That is what lets desktop and mobile share the rule instead of each
 * re-deriving it and drifting — which is exactly what had happened (desktop kept
 * this file privately; mobile had three ad-hoc checks spread across the push
 * handler, the banner and the sound cue).
 *
 * ---------------------------------------------------------------------------
 * THE RULE
 * ---------------------------------------------------------------------------
 * Suppress an alert ONLY when the user is demonstrably already looking at the
 * thing it is about. Everything else alerts.
 *
 * The rule this replaced was "app in foreground = never notify". That is wrong,
 * and it is what the founder reported on desktop: with Demli open on #general, a
 * DM arriving produced NOTHING. Foreground says the app has the user's
 * attention; it says nothing about WHICH conversation has it.
 *
 * So:
 *   - foreground AND the message's channel/DM is the one on screen → silent
 *   - foreground but a DIFFERENT conversation is on screen         → alert
 *   - foreground but on Friends / Settings / a call / the stage    → alert
 *   - not in the foreground (other window, tray, backgrounded)     → alert
 *   - surface hidden (minimized window, background tab)            → alert
 *
 * `hidden` is checked independently of `focused` because they are different
 * facts: a browser tab can be `hasFocus() === true` in a window that is not the
 * visible tab, and a minimized Electron window reports `hidden`. Either one
 * means the user is not reading that conversation.
 *
 * PLATFORM MAPPING — the host supplies {@link VisibleContext}; only that binding
 * is platform-specific:
 *   - desktop: `focused` = `document.hasFocus()`, `hidden` = `document.hidden`
 *   - mobile:  `focused` = `AppState.currentState === "active"`, `hidden` =
 *     false (RN has no separate hidden state), and `streamId` is claimed only
 *     while the chat screen is actually FOCUSED — a route pushed on top of it
 *     (voice room, settings, profile) means the user is no longer looking at
 *     that conversation, the phone analog of desktop's covering overlay.
 *
 * Everything else that used to gate an alert is UNCHANGED and still applies
 * upstream of this module: Do Not Disturb, the master notification switch,
 * channel/server mutes (migration 0013), blocks (ADR 0017), our own messages,
 * system notices, and the per-channel throttle.
 */

/** What an alert is ABOUT — i.e. what the user would have to be looking at. */
export type AlertTarget =
  /** A conversation (server text channel, DM, or flat group-chat stream). */
  | { kind: "stream"; streamId: string }
  /** A non-conversation destination that is its own screen. */
  | { kind: "surface"; surface: VisibleSurface }
  /**
   * Something the app already puts front-and-centre whenever it is in the
   * foreground — the incoming-call overlay, the update banner. A toast on top of
   * an overlay the user is already staring at is pure noise.
   */
  | { kind: "app" };

/** Non-conversation screens the shell can be showing. */
export type VisibleSurface = "friends" | "recentCalls";

/** What the shell is actually rendering right now. */
export interface VisibleContext {
  /** Desktop `document.hasFocus()`; mobile `AppState.currentState === "active"`. */
  focused: boolean;
  /** Desktop `document.hidden` (minimized / background tab); false on mobile. */
  hidden: boolean;
  /** The conversation stream currently painted, or null. */
  streamId: string | null;
  /** The non-conversation screen currently painted, or null. */
  surface: VisibleSurface | null;
}

/**
 * Is the app itself in front of the user? The weakest possible claim — it says
 * nothing about which conversation is open.
 */
export function isAppInForeground(ctx: VisibleContext): boolean {
  return ctx.focused && !ctx.hidden;
}

/**
 * Is the user demonstrably looking at `target` right now?
 *
 * The ONLY reason to stay silent. Returns false whenever we cannot prove it —
 * an alert the user did not need is a far smaller failure than a message they
 * never learned about (the bug this module exists to fix).
 */
export function isTargetVisible(target: AlertTarget, ctx: VisibleContext): boolean {
  if (!isAppInForeground(ctx)) return false;
  switch (target.kind) {
    case "stream":
      return ctx.streamId !== null && ctx.streamId === target.streamId;
    case "surface":
      return ctx.surface === target.surface;
    case "app":
      return true;
    default: {
      const _exhaustive: never = target;
      void _exhaustive;
      return false;
    }
  }
}

/** Everything the notification gate needs, all explicit. */
export interface NotifyGateInput {
  /** The persisted master switch (notification-settings). */
  enabled: boolean;
  /** Do Not Disturb — silences every interruptive surface. */
  doNotDisturb: boolean;
  /** A notification sink exists (native bridge, or the in-app fallback). */
  hasSink: boolean;
  /** The localizer is bound (we never emit untranslated copy). */
  hasTranslator: boolean;
  /** What the alert is about. */
  target: AlertTarget;
  /** What the shell is showing. */
  visible: VisibleContext;
}

/**
 * The notification gate. True → show a notification for this alert.
 *
 * Order matters only for readability; every clause is independent.
 */
export function shouldNotify(input: NotifyGateInput): boolean {
  if (input.doNotDisturb) return false;
  if (!input.enabled) return false;
  if (!input.hasSink) return false;
  if (!input.hasTranslator) return false;
  return !isTargetVisible(input.target, input.visible);
}

/**
 * The SOUND gate for an inbound message, kept here so the cue and the toast can
 * never drift apart again.
 *
 * Same "is the user looking at it" question, minus the notification-specific
 * concerns (a sound needs no sink, no translator, and is not governed by the
 * desktop-notification master switch — it has its own in sound-settings).
 * Mute/own-message/system filtering happens upstream in the dispatcher.
 */
export function shouldPlayMessageCue(input: {
  doNotDisturb: boolean;
  streamId: string;
  visible: VisibleContext;
}): boolean {
  if (input.doNotDisturb) return false;
  return !isTargetVisible({ kind: "stream", streamId: input.streamId }, input.visible);
}

/**
 * The FOREGROUND-PUSH gate: may the OS banner be shown for a push that arrived
 * while the app is open?
 *
 * Mobile-shaped but platform-agnostic. `streamId` is the conversation the push
 * is about (null when it is not about one — a friend request, a call), which can
 * never be "already on screen", so it always alerts.
 */
export function shouldShowForegroundPush(input: {
  streamId: string | null;
  visible: VisibleContext;
}): boolean {
  if (input.streamId === null) return true;
  return !isTargetVisible({ kind: "stream", streamId: input.streamId }, input.visible);
}
