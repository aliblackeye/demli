/**
 * Localized error copy for the mobile UI (ADR 0009).
 *
 * `@demli/client-core` is deliberately React-free and i18n-free (ADR 0002),
 * so its `friendlyErrorMessage` only ever returns baked English. Instead of
 * importing i18n into client-core, the app maps the transport-level
 * `ApiClientError.code` to a localized `common.errors.*` key HERE, at the render
 * boundary, where a translate function is available.
 *
 * Call sites pass the `t` from `useAppTranslation()` and render the result:
 *   catch (err) { setError(localizeError(err, t)); }
 */
import type { FieldError } from "@demli/client-core";
import type { AppTFunction } from "./i18n";
import { ApiClientError, type ApiClientErrorCode } from "./clients";
import { formatSlowmodeInterval } from "./slowmode";

/**
 * The `common.errors.*` keys an error can resolve to (default namespace).
 * Exported so a React-less lib can hold an error KEY (localized at render)
 * instead of a frozen English string.
 */
export type CommonErrorKey =
  | "errors.generic"
  | "errors.server"
  | "errors.network"
  | "errors.sessionExpired"
  | "errors.forbidden"
  | "errors.notFound"
  | "errors.userNotFound"
  | "errors.rateLimited"
  | "errors.slowmode"
  | "errors.inviteExpired"
  | "errors.inviteExhausted"
  // M18 blocking (ADR 0017): one neutral message for both directions — the copy
  // must never disclose which side blocked whom.
  | "errors.blocked"
  // Set-once date of birth (M15 age gate) rejected a second write.
  | "errors.birthdateLocked"
  // The server retired this build.
  | "errors.clientUpdateRequired";

/**
 * Attachment-pipeline error keys (mobile namespace). The composer's upload
 * pipeline (lib/attachments/**) is React-free, so it carries these KEYS on the
 * draft — the tray localizes them at render (the desktop DraftError pattern),
 * so a live locale switch re-translates a stale failure line.
 */
export type AttachmentErrorKey =
  | "mobile:attachments.typeNotAllowed"
  | "mobile:attachments.tooLargeImage"
  | "mobile:attachments.tooLargeAudio"
  | "mobile:attachments.tooLargeVideo"
  | "mobile:attachments.tooLargeMax"
  | "mobile:attachments.fileUnreadable"
  | "mobile:attachments.imageUnreadable"
  | "mobile:attachments.imageTooLarge"
  | "mobile:attachments.uploadCancelled"
  | "mobile:attachments.uploadRejected"
  | "mobile:attachments.uploadFailed"
  | "mobile:attachments.nsfwBlocked"
  | "mobile:attachments.maxPerMessage";

/** Every catalog key a draft failure can hold (shared errors + attachment-local). */
export type DraftErrorKey = CommonErrorKey | AttachmentErrorKey;

/**
 * A localizable draft failure: a catalog KEY (+ optional interpolation params),
 * resolved by the tray at render — never a frozen English string.
 */
export interface DraftError {
  key: DraftErrorKey;
  params?: Record<string, string | number>;
}

/**
 * Transport/API error code → shared error key. Codes without a dedicated
 * message (validation/conflict/attachment specifics the server phrases itself)
 * fall back to `errors.generic` — we never surface a raw English server string.
 */
const CODE_TO_KEY: Record<ApiClientErrorCode, CommonErrorKey> = {
  VALIDATION_ERROR: "errors.generic",
  UNAUTHORIZED: "errors.sessionExpired",
  FORBIDDEN: "errors.forbidden",
  NOT_FOUND: "errors.notFound",
  // Add-by-username (#111) found no such account. Mapped here so the shared
  // `ApiClientErrorCode` union stays exhaustive AND so mobile already shows the
  // right sentence the moment it hits this code; the mobile add-friend FORM
  // still needs its own client-side username validation (parity task).
  USER_NOT_FOUND: "errors.userNotFound",
  CONFLICT: "errors.generic",
  // M18 blocking (ADR 0017). ONE code covers both directions and the copy must
  // never reveal which side blocked whom — `errors.blocked` is the neutral
  // catch-all; surfaces that know their action (message/call/friend request)
  // pick a more specific `errors.blocked*` key at the call site.
  BLOCKED: "errors.blocked",
  INVALID_CHANNEL: "errors.generic",
  INVITE_EXPIRED: "errors.inviteExpired",
  INVITE_EXHAUSTED: "errors.inviteExhausted",
  // Server moderation (migration 0017): banned from a server on invite redeem.
  // Reuses the generic "forbidden" copy; a moderation-UI wave can add bespoke text.
  GROUP_BANNED: "errors.forbidden",
  RATE_LIMITED: "errors.rateLimited",
  SLOWMODE: "errors.slowmode",
  INVALID_ATTACHMENT: "errors.generic",
  ATTACHMENTS_DISABLED: "errors.generic",
  INVALID_PAYLOAD: "errors.generic",
  INVALID_REACTION: "errors.generic",
  // Avatar-upload codes (desktop-only surface today). Mapped generically so the
  // shared `ApiClientErrorCode` union stays exhaustive here; mobile gains its own
  // copy when it adds an avatar picker (feature-parity task tracked separately).
  INVALID_AVATAR: "errors.generic",
  AVATAR_TOO_LARGE: "errors.generic",
  AVATAR_UPLOADS_DISABLED: "errors.generic",
  AVATAR_REJECTED: "errors.generic",
  // Set-once date of birth (M15): the account already has one, so the write was
  // refused. Bespoke copy on purpose — "something went wrong" would read as a
  // transient failure and invite the user to keep retrying a write that can
  // never succeed.
  BIRTHDATE_LOCKED: "errors.birthdateLocked",
  // Watch Party video search (M20) — a DESKTOP-only surface today. Mapped
  // generically so the shared `ApiClientErrorCode` union stays exhaustive here;
  // mobile gets the three distinct sentences ("never on this server" / "back
  // tomorrow" / "try again shortly") when it gains a watch-party picker, which
  // is a tracked feature-parity task. Mobile cannot reach these codes until then
  // — it never calls `searchWatchVideos` — so the generic line is not a
  // degradation of anything a user can currently see.
  WATCH_SEARCH_DISABLED: "errors.generic",
  WATCH_SEARCH_QUOTA: "errors.generic",
  WATCH_SEARCH_UNAVAILABLE: "errors.generic",
  // The server retired this BUILD (HTTP 426 /
  // gateway close 4426, @demli/client-core client-gate). Mapped here so the
  // shared `ApiClientErrorCode` union stays exhaustive AND so an inline error
  // that is already on screen when the refusal lands says the true thing
  // ("install the new one") instead of "check your connection". The full
  // migration screen is the mobile Faz-0 agent's work.
  CLIENT_UPDATE_REQUIRED: "errors.clientUpdateRequired",
  INTERNAL: "errors.server",
  NETWORK: "errors.network",
};

/**
 * The shared `common.errors.*` key for any thrown value (React-less). Lets a
 * non-React pipeline map an `ApiClientError` to a key without a translator;
 * non-API values fall back to the generic line.
 */
export function commonErrorKey(err: unknown): CommonErrorKey {
  return err instanceof ApiClientError ? CODE_TO_KEY[err.code] : "errors.generic";
}

/** Localized, user-safe message for any thrown value. */
export function localizeError(err: unknown, t: AppTFunction): string {
  if (err instanceof ApiClientError) {
    // SLOWMODE carries the exact wait; show a live countdown-style message.
    if (err.code === "SLOWMODE" && err.retryAfterSeconds != null) {
      return t("mobile:errors.slowmodeWait", {
        duration: formatSlowmodeInterval(err.retryAfterSeconds),
      });
    }
  }
  return t(commonErrorKey(err));
}

/** Resolve a {@link DraftError} (catalog key + params) to a localized string. */
export function localizeDraftError(error: DraftError, t: AppTFunction): string {
  return t(error.key, error.params);
}

/**
 * Resolve a form-V1 {@link FieldError} (client-core `validateForm`) to a
 * localized string.
 *
 * The cast mirrors `toTranslateFn`'s reasoning: `AppTFunction`'s key type is a
 * literal union, while a `FieldError.key` is an ordinary string chosen at
 * runtime. Every key it can carry is covered — client-core's `VALIDATION_KEYS`
 * are asserted present in BOTH catalogs by the i18n package's
 * validation-keys test, and the app-namespaced keys passed here are typed
 * literals at their call sites.
 */
export function localizeFieldError(t: AppTFunction, error: FieldError): string {
  const translate = t as unknown as (key: string, params?: Record<string, unknown>) => string;
  return translate(error.key, error.params);
}
