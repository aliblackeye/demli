import type { CallEndedReason, CallRole } from "@demli/client-core";
import type { AppTFunction } from "@/lib/i18n";

/**
 * Localized outcome line for an ended DM call (ADR 0012 §26) — the mobile i18n
 * counterpart of client-core's English `callEndedMessage`. Role-aware where it
 * matters: the caller who was never answered sees "No answer", the callee whose
 * caller hung up sees "Missed call".
 */
export function callOutcomeLabel(
  reason: CallEndedReason | null,
  role: CallRole | null,
  t: AppTFunction,
): string {
  switch (reason) {
    case "declined":
      return t("mobile:call.outcome.declined");
    case "canceled":
      return role === "callee"
        ? t("mobile:call.outcome.missed")
        : t("mobile:call.outcome.canceled");
    case "timeout":
      return role === "caller"
        ? t("mobile:call.outcome.noAnswer")
        : t("mobile:call.outcome.missed");
    case "hung_up":
      return t("mobile:call.outcome.ended");
    case "busy":
      return t("mobile:call.outcome.busy");
    case "failed":
      return t("mobile:call.outcome.failed");
    case "upgraded":
      return t("mobile:call.outcome.movedToGroup");
    case "session_replaced":
      return t("mobile:call.outcome.sessionReplaced");
    default:
      return t("mobile:call.outcome.ended");
  }
}
