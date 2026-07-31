/**
 * The add-a-friend form's two decisions, kept out of the component so they can
 * be unit-tested (apps/mobile/vitest.config.ts runs plain Node — no RN harness).
 *
 * Both return a form-V1 {@link FieldError} — an i18n KEY plus params, never a
 * resolved string — so the message re-translates on a live language switch and a
 * locally-broken rule and a server-rejected one render through one code path.
 * The previous mobile version stored resolved strings in component state, which
 * froze whatever language was active when the error appeared.
 *
 * This mirrors the desktop helper's SHAPE, but nothing is copied: both bind the
 * same shared `sendFriendRequestByUsernameBodySchema` and the same `validateForm`
 * from client-core. Only the two app-namespaced copy keys differ.
 */

import { ApiClientError, validateForm, type FieldError } from "@demli/client-core";
import { sendFriendRequestByUsernameBodySchema } from "@demli/protocol";

/** Accepted input, carrying the NORMALIZED username the schema produced. */
export interface AddFriendInputAccepted {
  ok: true;
  /** `@` stripped, trimmed, lowercased — send this, not the raw field value. */
  username: string;
}

export interface AddFriendInputRejected {
  ok: false;
  error: FieldError;
}

export type AddFriendInputResult = AddFriendInputAccepted | AddFriendInputRejected;

/**
 * Validate what the user typed against THE username rule.
 *
 * The rule is imported (`sendFriendRequestByUsernameBodySchema`, built on
 * `@demli/config`'s bounds and grammar) and is the exact schema the API runs
 * on the same body, so this form cannot show a rule the server does not enforce
 * and the server cannot enforce one the user was never shown. Mobile previously
 * checked only for emptiness, which meant every real rule (length, allowed
 * characters) was learned from a round-trip failure instead of from the field.
 *
 * The empty field is the one case handled here rather than by the schema: to a
 * user, a blank box is not a length problem, and "use at least 3 characters" —
 * which is what the schema's `min` would say — reads as though the form is
 * broken rather than as "you haven't typed anything yet".
 */
export function validateAddFriendInput(raw: string): AddFriendInputResult {
  if (raw.trim().replace(/^@+/, "").trim().length === 0) {
    return { ok: false, error: { key: "mobile:friends.addValidation" } };
  }

  const result = validateForm(sendFriendRequestByUsernameBodySchema, { username: raw });
  if (!result.ok) {
    return {
      ok: false,
      error: result.errors["username"] ?? { key: "validation.invalid" },
    };
  }
  return { ok: true, username: result.value.username };
}

/**
 * Map a send failure to a localized field error.
 *
 * The server now DOES disclose that a username has no account
 * (`USER_NOT_FOUND`, founder directive 2026-07-28): a mistyped handle used to be
 * answered "sent — if that user exists", so the sender waited for a request that
 * was never coming. What it still refuses to disclose is the state of a
 * RELATIONSHIP — already friends / already pending answer the same success as a
 * fresh send — so there is deliberately no branch for those, only: no such user,
 * adding yourself, and the generic rate-limit / network / unknown cases.
 */
export function addFriendError(err: unknown): FieldError {
  if (err instanceof ApiClientError) {
    if (err.code === "USER_NOT_FOUND") return { key: "errors.userNotFound" };
    if (err.code === "VALIDATION_ERROR") return { key: "mobile:friends.addSelf" };
    if (err.code === "RATE_LIMITED") return { key: "errors.rateLimited" };
    if (err.code === "NETWORK") return { key: "errors.network" };
  }
  return { key: "errors.generic" };
}
