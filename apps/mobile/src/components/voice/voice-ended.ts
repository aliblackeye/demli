import {
  formatAloneCountdown,
  type AloneCountdown,
  type VoiceEndedReason,
} from "@demli/media";
import type { AppTFunction } from "@/lib/i18n";

/**
 * Why the voice session ended, in words (§26) — the mobile twin of the desktop
 * `localizeVoiceEnded`. `@demli/media` stays i18n-free and hands us a typed
 * reason; we map it to `mobile:voice.*` here.
 *
 * The `default` branch is deliberate FORWARD COMPATIBILITY: a server that learns
 * a new reason before this build does must not blank the notice or leak a raw
 * enum value into an Alert. Anything unrecognized keeps the message this surface
 * already showed.
 */
export function localizeVoiceEnded(
  reason: VoiceEndedReason | null,
  t: AppTFunction,
): string | null {
  if (reason === null) return null;
  switch (reason) {
    case "alone":
      return t("mobile:voice.endedAlone");
    case "session_replaced":
      return t("mobile:voice.sessionReplaced");
    case "moderator":
      return t("mobile:voice.endedModerator");
    default:
      return t("mobile:voice.sessionReplaced");
  }
}

/**
 * The "you're the only one here" countdown line, or null when there is nothing to
 * say. Two phases so a counter that reaches zero reads as "closing", not as a
 * frozen 0:00 — and it never claims to be the actor: the server closes the room,
 * within a minute of zero, on its own sweep tick.
 */
export function aloneCountdownLabel(
  countdown: AloneCountdown,
  t: AppTFunction,
): string | null {
  switch (countdown.phase) {
    case "counting":
      return t("mobile:voice.aloneCountdown", {
        time: formatAloneCountdown(countdown.remainingSeconds),
      });
    case "expiring":
      return t("mobile:voice.aloneExpiring");
    case "hidden":
      return null;
  }
}
