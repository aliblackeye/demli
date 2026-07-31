/**
 * Custom-emoji request bodies (M17).
 *
 * The name grammar, MIME whitelist and byte cap already live in
 * `@demli/config` as one source of truth — this file only wires them into a
 * schema shape. Byte-level validation (base64 decode, magic-byte sniff) stays on
 * the API: it needs the real bytes, and a client's declared MIME is a hint (§28).
 */

import { z } from "zod";
import {
  CUSTOM_EMOJI_MAX_PER_GROUP,
  CUSTOM_EMOJI_NAME_MAX_LENGTH,
  CUSTOM_EMOJI_NAME_MIN_LENGTH,
  isCustomEmojiName,
  MIME_MAX_LENGTH,
} from "@demli/config";
import { customIssue } from "./codes.js";
import { uuidField } from "./common.js";
import { type TextField } from "./text.js";

/**
 * An emoji name: trimmed and lowercased BEFORE the grammar check, so `:Cat:` and
 * `:cat:` are the same emoji rather than two colliding rows. The normalization
 * is part of the schema precisely so no handler can forget it.
 */
export const emojiNameField: TextField = z
  .string()
  .min(CUSTOM_EMOJI_NAME_MIN_LENGTH)
  .max(CUSTOM_EMOJI_NAME_MAX_LENGTH)
  .transform((value) => value.trim().toLowerCase())
  .superRefine((value, ctx) => {
    if (!isCustomEmojiName(value)) ctx.addIssue(customIssue("emojiNamePattern"));
  });

/** `/groups/:groupId/emojis/:emojiId`. */
export const emojiParamsSchema = z.object({ groupId: uuidField, emojiId: uuidField });

/** `POST /groups/:groupId/emojis`. */
export const createEmojiBodySchema = z.object({
  name: emojiNameField,
  mime: z.string().min(1).max(MIME_MAX_LENGTH),
  /** The raw image, base64-encoded. Length- and byte-capped again during decode. */
  dataBase64: z.string().min(1),
});

/** `POST /groups/:groupId/emojis/urls` — batch signed-read-URL resolution. */
export const emojiUrlsBodySchema = z.object({
  emojiIds: z.array(uuidField).min(1).max(CUSTOM_EMOJI_MAX_PER_GROUP),
});

export type CreateEmojiBody = z.infer<typeof createEmojiBodySchema>;
export type EmojiUrlsBody = z.infer<typeof emojiUrlsBodySchema>;
