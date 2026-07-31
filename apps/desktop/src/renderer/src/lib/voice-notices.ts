/**
 * User-facing copy for the NON-error ways a voice session ends, and for the
 * "you're the only one here" countdown that precedes one of them (§26).
 *
 * `@demli/media` stays i18n-free — it hands us a typed reason, we map it to a
 * `desktop:voice.*` key here, exactly like `localizeVoiceError` does for failures.
 */

import {
  aloneCountdownAt,
  formatAloneCountdown,
  type AloneCountdown,
  type VoiceEndedReason,
} from "@demli/media";
import type { AppTFunction } from "./i18n";

/**
 * Why the voice session ended, in words.
 *
 * The `default` branch is deliberate FORWARD COMPATIBILITY, not laziness: a
 * server that learns a new reason before this client does must not blank the
 * notice or leak a raw enum value into the UI. Anything unrecognized keeps the
 * message this surface already showed, which is a true statement in every case
 * we know of (the session ended and you did not end it).
 */
export function localizeVoiceEnded(
  reason: VoiceEndedReason | null,
  t: AppTFunction,
): string | null {
  if (reason === null) return null;
  switch (reason) {
    case "alone":
      return t("desktop:voice.endedAlone");
    case "session_replaced":
      return t("desktop:voice.sessionReplaced");
    default:
      return t("desktop:voice.sessionReplaced");
  }
}

/**
 * The countdown line for a room you are alone in, or null when there is nothing
 * to say. Two phases, because a counter that hits 0:00 and sits there reads like
 * a hang: `counting` shows the remaining time, `expiring` says the close is
 * happening. It never shows a negative number and never claims to be the actor —
 * the server is (the real cut lands within a minute of zero, on its sweep tick).
 */
export function aloneCountdownLabel(
  countdown: AloneCountdown,
  t: AppTFunction,
): string | null {
  switch (countdown.phase) {
    case "counting":
      return t("desktop:voice.aloneCountdown", {
        time: formatAloneCountdown(countdown.remainingSeconds),
      });
    case "expiring":
      return t("desktop:voice.aloneExpiring");
    case "hidden":
      return null;
  }
}

export { aloneCountdownAt };
