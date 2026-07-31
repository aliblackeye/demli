/**
 * Profile / account request bodies (`/users/me`, `/users/:id`).
 */

import { z } from "zod";
import {
  BIO_MAX_LENGTH,
  CUSTOM_STATUS_MAX_LENGTH,
  CUSTOM_STATUS_MAX_MINUTES,
  MEDIA_URL_MAX_LENGTH,
  MIME_MAX_LENGTH,
  USER_NICKNAME_MAX_LENGTH,
  USER_NOTE_MAX_LENGTH,
} from "@demli/config";
import { requireAtLeastOneField, uuidField } from "./common.js";
import { birthdateField, displayNameField } from "./auth.js";
import { httpUrl, sanitizedText, type TextField } from "./text.js";

/**
 * Profile bio: 0..280, multiline.
 *
 * Sanitized (invisible characters out, line breaks kept) but NOT otherwise
 * touched: the bio is stored raw and escaped at RENDER time like message
 * content (§28), so markdown, punctuation and emoji survive the round trip.
 */
export const bioField: TextField = sanitizedText({
  max: BIO_MAX_LENGTH,
  multiline: true,
});

/** Custom status (M18): 0..128, single line. Empty clears it. */
export const customStatusField: TextField = sanitizedText({
  max: CUSTOM_STATUS_MAX_LENGTH,
});

/** An avatar / banner / icon URL: absolute http(s), <= 512 chars. */
export const mediaUrlField: TextField = httpUrl(MEDIA_URL_MAX_LENGTH);

/** `PATCH /users/me`. Every field optional; at least one required. */
export const updateProfileBodySchema = z
  .object({
    displayName: displayNameField.optional(),
    avatarUrl: mediaUrlField.nullable().optional(),
    bio: bioField.nullable().optional(),
    /** Public banner URL; `null` clears it (the upload path sets a real URL). */
    bannerUrl: mediaUrlField.nullable().optional(),
    /**
     * Date of birth as `YYYY-MM-DD`. SET-ONCE: the API accepts it only while the
     * account has none (pre-M15 users + the NSFW age-gate prompt). This schema
     * only validates the shape — the immutability guard is authorization, and
     * authorization belongs on the server.
     */
    birthdate: birthdateField.optional(),
  })
  .superRefine(requireAtLeastOneField);

/**
 * `PUT /users/me/custom-status`.
 *
 * `text: null` OR a blank string CLEARS the status and its expiry — "empty means
 * clear" is the founder-stated rule, so the common case needs no second call.
 */
export const setCustomStatusBodySchema = z.object({
  text: customStatusField.nullable(),
  /** Auto-clear after N minutes ("30 min", "today"); omit for indefinite. */
  expiresInMinutes: z.number().int().min(1).max(CUSTOM_STATUS_MAX_MINUTES).optional(),
});

/**
 * Inline image upload body, shared by `POST /users/me/avatar` and
 * `POST /users/me/banner` (the API declares this shape twice, identically).
 *
 * The declared MIME is a HINT only — the API magic-byte-sniffs the real bytes
 * and re-checks the decoded size, because a client-declared content type is
 * client-controlled (§28). Nothing here can be trusted as a security boundary;
 * it exists so a malformed body fails fast and legibly.
 */
export const uploadImageBodySchema = z.object({
  mime: z.string().min(1).max(MIME_MAX_LENGTH),
  dataBase64: z.string().min(1),
});

/** `GET /users/:id`, `GET /users/:id/profile`. */
export const userParamsSchema = z.object({ id: uuidField });

/** Optional shared-server context for the profile card's role list. */
export const profileQuerySchema = z.object({ groupId: uuidField.optional() });

// ---------------------------------------------------------------------------
// Private per-viewer annotations + ignore (migration 0020, ADR 0019)
// ---------------------------------------------------------------------------

/**
 * `PUT /users/:id/note` — the private note only its author can ever read.
 *
 * `null` or a value that sanitizes to empty DELETES the note. One endpoint, no
 * separate DELETE: "clear the box and save" is how the UI works, so making the
 * empty case a different HTTP verb would only invent a way for a client to get
 * it wrong.
 *
 * Multiline and NOT `requireVisible`: an empty result is a legitimate outcome
 * here (it means "delete"), unlike a name field where empty is a mistake.
 */
export const setUserNoteBodySchema = z.object({
  body: sanitizedText({ max: USER_NOTE_MAX_LENGTH, multiline: true }).nullable(),
});

/**
 * `PUT /users/:id/nickname` — the PRIVATE, per-viewer nickname (ADR 0019 §2).
 *
 * Not to be confused with `setMemberNicknameBodySchema`, which is the per-SERVER
 * nickname everyone sees. Same "null or empty clears it" rule; same visible-
 * character requirement, because this value replaces a display name in the
 * viewer's own UI and an invisible one would blank the person out of their list.
 */
export const setUserNicknameBodySchema = z.object({
  nickname: sanitizedText({
    min: 1,
    max: USER_NICKNAME_MAX_LENGTH,
    requireVisible: true,
  }).nullable(),
});

/** `PUT|DELETE /users/me/ignores/:userId`, `PUT /users/:id/note|nickname`. */
export const targetUserParamsSchema = z.object({ userId: uuidField });

export type UpdateProfileBody = z.infer<typeof updateProfileBodySchema>;
export type SetCustomStatusBody = z.infer<typeof setCustomStatusBodySchema>;
export type UploadImageBody = z.infer<typeof uploadImageBodySchema>;
export type SetUserNoteBody = z.infer<typeof setUserNoteBodySchema>;
export type SetUserNicknameBody = z.infer<typeof setUserNicknameBodySchema>;
