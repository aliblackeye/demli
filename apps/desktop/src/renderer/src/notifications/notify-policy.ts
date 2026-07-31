/**
 * WHEN may an alert interrupt the user — RE-EXPORT ONLY.
 *
 * The rule itself lives in `@demli/client-core` (`notify-policy.ts`) so the
 * desktop/web renderer and the React Native app decide from ONE implementation.
 * This file held the original copy; mobile had grown the same rule as three
 * ad-hoc checks, the shared module was written to unify them, and leaving a
 * second copy here would have re-created the drift the move was for.
 *
 * "Suppress this alert" is exactly the kind of decision that goes wrong quietly:
 * the alert simply does not arrive, and nobody files a bug about a notification
 * they never saw. Both of this month's reports in this area — desktop notifying
 * nothing while focused, mobile treating a mounted-but-covered thread as "being
 * read" — were that shape.
 *
 * This stays as the renderer's import path so call sites read locally and a
 * future desktop-only helper has a home. It must not re-implement anything: add
 * shared behaviour to the client-core module, where its tests already live.
 */

export {
  isAppInForeground,
  isTargetVisible,
  shouldNotify,
  shouldPlayMessageCue,
  shouldShowForegroundPush,
  type AlertTarget,
  type NotifyGateInput,
  type VisibleContext,
  type VisibleSurface,
} from "@demli/client-core";
