/**
 * Localize transport errors at the RENDER site (ADR 0009).
 *
 * `@demli/client-core` is deliberately React-free and i18n-free (ADR 0002),
 * so it throws `ApiClientError` with a machine `code` and an English fallback
 * `message`. The desktop maps that code to a shared `common.errors.*` key here,
 * where a `t` function is available — never inside client-core.
 */

import type { VoiceError } from "@demli/media";
import { ApiClientError, type ApiClientErrorCode } from "./api-client";
import type { AppTFunction } from "./i18n";

/**
 * Every value is a key in the shared `common.errors` catalog. Exported so
 * dialogs can hold an error KEY in state (localized at render — live locale
 * switches re-render the message) instead of a frozen resolved string.
 */
export type CommonErrorKey =
  | "errors.generic"
  | "errors.server"
  | "errors.network"
  | "errors.sessionExpired"
  | "errors.inviteExpired"
  | "errors.inviteExhausted"
  | "errors.forbidden"
  | "errors.notFound"
  | "errors.userNotFound"
  | "errors.rateLimited"
  | "errors.slowmode"
  | "errors.invalidAttachment"
  | "errors.attachmentsDisabled"
  | "errors.avatarUploadsDisabled"
  | "errors.avatarTooLarge"
  | "errors.invalidAvatar"
  | "errors.avatarRejected"
  | "errors.blocked"
  | "errors.blockedMessage"
  | "errors.blockedFriendRequest"
  | "errors.blockedCall"
  | "errors.blockedAddMember"
  | "errors.clientUpdateRequired"
  | "errors.birthdateLocked";

const ERROR_KEY: Record<ApiClientErrorCode, CommonErrorKey> = {
  VALIDATION_ERROR: "errors.generic",
  UNAUTHORIZED: "errors.sessionExpired",
  FORBIDDEN: "errors.forbidden",
  NOT_FOUND: "errors.notFound",
  // Add-by-username (#111) found no such account. Bespoke copy on purpose: the
  // generic "we couldn't find what you were looking for" reads as an app fault,
  // when the user's actual mistake is a typo they can fix in the field.
  USER_NOT_FOUND: "errors.userNotFound",
  CONFLICT: "errors.generic",
  INVALID_CHANNEL: "errors.generic",
  INVITE_EXPIRED: "errors.inviteExpired",
  INVITE_EXHAUSTED: "errors.inviteExhausted",
  // Server moderation (migration 0017): banned from a server on invite redeem.
  // Reuses the generic "forbidden" copy; a moderation-UI wave can add bespoke text.
  GROUP_BANNED: "errors.forbidden",
  RATE_LIMITED: "errors.rateLimited",
  SLOWMODE: "errors.slowmode",
  // Message enrichment (ADR 0011). Both are generic to the user — the reaction
  // toggle rolls back silently and a rejected reply is a rare edge (deleted /
  // cross-channel target); neither needs a bespoke message.
  INVALID_REACTION: "errors.generic",
  INVALID_PAYLOAD: "errors.generic",
  INVALID_ATTACHMENT: "errors.invalidAttachment",
  ATTACHMENTS_DISABLED: "errors.attachmentsDisabled",
  // Avatar uploads (profile photo) — each gets a bespoke inline message.
  INVALID_AVATAR: "errors.invalidAvatar",
  AVATAR_TOO_LARGE: "errors.avatarTooLarge",
  AVATAR_UPLOADS_DISABLED: "errors.avatarUploadsDisabled",
  AVATAR_REJECTED: "errors.avatarRejected",
  // User blocking (M18 / ADR 0017). The generic line is the safe default; a call
  // site with a known action uses `localizeBlockedError` for sharper copy. Every
  // one of those strings is DIRECTION-FREE on purpose — the server sends one code
  // for "I blocked them" and "they blocked me", and the UI must not let the two
  // be told apart, not even by wording (§28).
  BLOCKED: "errors.blocked",
  // Set-once date of birth (M15): the account already has one, so the write was
  // refused. Bespoke copy on purpose — "something went wrong" would read as a
  // transient failure and invite the user to keep retrying a write that can
  // never succeed.
  BIRTHDATE_LOCKED: "errors.birthdateLocked",
  // Watch Party video search (M20). Generic HERE on purpose, and only here: the
  // three codes each need their own sentence, and they get it inside the picker
  // (`watchSearchFailure` → `watchParty.search*`), which is the one surface that
  // calls the route. This map is the fallback for a code reaching some OTHER
  // dialog, where "search is not configured on this server" would be a non
  // sequitur. Adding three more `common.errors.*` keys nobody renders would be
  // worse than one honest generic.
  WATCH_SEARCH_DISABLED: "errors.generic",
  WATCH_SEARCH_QUOTA: "errors.generic",
  WATCH_SEARCH_UNAVAILABLE: "errors.generic",
  // The server retired this BUILD. The real surface
  // is the full-screen migration notice, which the same refusal raises — this
  // key is the fallback for a call already showing an inline error when it
  // lands, and it says the true thing ("install the new one") rather than
  // "check your connection", which would send the user chasing a fault that is
  // not theirs.
  CLIENT_UPDATE_REQUIRED: "errors.clientUpdateRequired",
  INTERNAL: "errors.server",
  NETWORK: "errors.network",
};

/**
 * The action a `BLOCKED` refusal interrupted, so the message can say what failed
 * without ever saying WHO blocked whom.
 */
export type BlockedAction = "message" | "friendRequest" | "call" | "addMember";

const BLOCKED_KEY: Record<BlockedAction, CommonErrorKey> = {
  message: "errors.blockedMessage",
  friendRequest: "errors.blockedFriendRequest",
  call: "errors.blockedCall",
  addMember: "errors.blockedAddMember",
};

/** The shared error key for any thrown value (generic fallback for non-API errors). */
export function errorKey(err: unknown): CommonErrorKey {
  return err instanceof ApiClientError ? ERROR_KEY[err.code] : "errors.generic";
}

/** Localize any thrown value to a user-safe string. Pass the `t` from useAppTranslation(). */
export function localizeError(err: unknown, t: AppTFunction): string {
  return t(errorKey(err));
}

/**
 * The action-specific catalog KEY for a `BLOCKED` refusal, or `null` when the
 * error is something else. For components that hold an error KEY in state (so the
 * message re-localizes on a live language switch) rather than a resolved string.
 */
export function blockedErrorKey(err: unknown, action: BlockedAction): CommonErrorKey | null {
  return err instanceof ApiClientError && err.code === "BLOCKED" ? BLOCKED_KEY[action] : null;
}

/**
 * Same as {@link localizeError}, but a `BLOCKED` refusal gets copy specific to the
 * action the user was attempting ("You can't message this user.") instead of the
 * generic line. Anything else falls through unchanged.
 *
 * The wording stays symmetric and blameless by design: a block must not be
 * distinguishable from the other side having blocked you, so no message here may
 * name a party or a direction (§28, ADR 0017).
 */
export function localizeBlockedError(
  err: unknown,
  t: AppTFunction,
  action: BlockedAction,
): string {
  if (err instanceof ApiClientError && err.code === "BLOCKED") return t(BLOCKED_KEY[action]);
  return localizeError(err, t);
}

/**
 * Localize a media-layer failure at the render site — same pattern as the API
 * codes above. `@demli/media` stays i18n-free (its `voiceErrorMessage` is an
 * English fallback); the renderer maps the typed `VoiceError` union to a
 * `desktop:voiceErrors.*` key instead.
 */
export function localizeVoiceError(error: VoiceError, t: AppTFunction): string {
  switch (error.kind) {
    case "permission_denied":
      if (error.device === "microphone") return t("desktop:voiceErrors.micPermissionDenied");
      if (error.device === "camera") return t("desktop:voiceErrors.cameraPermissionDenied");
      return t("desktop:voiceErrors.screenPermissionDenied");
    case "device_not_found":
      return error.device === "camera"
        ? t("desktop:voiceErrors.cameraNotFound")
        : t("desktop:voiceErrors.deviceNotFound");
    // `device` is what keeps a CAMERA failure from being reported with the
    // microphone's wording (the founder's mobile-web P0: "Aç" answered "Seçili
    // ses aygıtı kullanılamıyor"). It is optional only for legacy constructions,
    // which still mean the microphone.
    case "device_unavailable":
      if (error.device === "camera") return t("desktop:voiceErrors.cameraUnavailable");
      if (error.device === "screen") return t("desktop:voiceErrors.screenUnavailable");
      return t("desktop:voiceErrors.deviceUnavailable");
    case "device_in_use":
      return error.device === "camera"
        ? t("desktop:voiceErrors.cameraInUse")
        : t("desktop:voiceErrors.micInUse");
    case "device_constraints":
      return error.device === "camera"
        ? t("desktop:voiceErrors.cameraConstraints")
        : t("desktop:voiceErrors.micConstraints");
    case "monitor_unavailable":
      return t("desktop:voiceErrors.monitorUnavailable");
    case "track_ended_unexpectedly":
      if (error.track === "mic") return t("desktop:voiceErrors.micTrackEnded");
      if (error.track === "camera") return t("desktop:voiceErrors.cameraTrackEnded");
      return t("desktop:voiceErrors.screenTrackEnded");
    case "reconnect_failed":
      return t("desktop:voiceErrors.reconnectFailed");
    case "server_unavailable":
      return t("desktop:voiceErrors.serverUnavailable");
  }
}
