/**
 * Message REST request bodies and query strings.
 *
 * NOTE the one field that is deliberately NOT run through `sanitizeText`:
 * message `content`. Message text is stored RAW and escaped at render time
 * (§28), and stripping formatting characters from it would corrupt real
 * content — a ZWJ emoji family, a right-to-left Arabic paragraph, a code block
 * whose tabs are meaningful. Emptiness is checked on the TRIMMED value, which is
 * what the "no blank message" rule actually means, without rewriting what gets
 * stored.
 */

import { z } from "zod";
import {
  ATTACHMENT_MAX_PER_MESSAGE,
  MESSAGE_MAX_LENGTH,
  REACTION_KEY_MAX_LENGTH,
  SEARCH_QUERY_MAX_LENGTH,
  SEARCH_QUERY_MIN_LENGTH,
} from "@demli/config";
import { customIssue } from "./codes.js";
import { cursorField, pageLimit, uuidField } from "./common.js";

/** `/channels/:channelId/...` message routes. */
export const messageChannelParamsSchema = z.object({ channelId: uuidField });

/** `/messages/:messageId` routes. */
export const messageParamsSchema = z.object({ messageId: uuidField });

/**
 * `/messages/:messageId/reactions/:emoji`.
 *
 * Only the segment's LENGTH is bounded here. Whether the key is a single unicode
 * emoji or a `:name:` shortcode that resolves in this message's group is decided
 * on the API — the unicode test needs the `v`-flag `\p{RGI_Emoji}` property,
 * which is a PARSE error on Safari 12 (the web target), so it can never live in
 * a package the browser bundles.
 */
export const reactionParamsSchema = z.object({
  messageId: uuidField,
  emoji: z.string().min(1).max(REACTION_KEY_MAX_LENGTH),
});

/** Message body text: 1..4000, non-blank. Stored raw (see the file header). */
export const messageContentField = z
  .string()
  .min(1)
  .max(MESSAGE_MAX_LENGTH)
  .superRefine((value, ctx) => {
    if (value.trim().length === 0) ctx.addIssue(customIssue("emptyMessage"));
  });

/**
 * `POST /channels/:channelId/messages` (ADR 0008).
 *
 * A message needs EITHER non-blank text OR at least one attachment, so a
 * caption-less image can be sent while a text-only send keeps the old "no empty
 * message" rule. The issue is attached to `content`, since that is the field the
 * composer can actually focus.
 */
export const createMessageBodySchema = z
  .object({
    content: z.string().max(MESSAGE_MAX_LENGTH).optional(),
    attachmentIds: z.array(uuidField).max(ATTACHMENT_MAX_PER_MESSAGE).optional(),
    /**
     * The message this send replies to (ADR 0011 §2). The handler validates the
     * target exists in the SAME channel and builds the preview.
     */
    replyToMessageId: uuidField.optional(),
  })
  .superRefine((body, ctx) => {
    const hasText = (body.content?.trim().length ?? 0) > 0;
    const hasAttachment = (body.attachmentIds?.length ?? 0) > 0;
    if (!hasText && !hasAttachment) {
      ctx.addIssue({ ...customIssue("emptyMessage"), path: ["content"] });
    }
  });

/** `PATCH /messages/:messageId`. An edit cannot blank a message — it deletes it. */
export const editMessageBodySchema = z.object({ content: messageContentField });

/** `GET /channels/:channelId/messages`. */
export const messageListQuerySchema = z.object({
  limit: pageLimit(100),
  cursor: cursorField.optional(),
});

/**
 * `GET /channels/:channelId/messages/search` (ADR 0011 §5).
 *
 * `q` is trimmed FIRST, then length-gated: under 3 characters is neither a
 * useful full-text match nor a cheap one to run, so it is a clean 400 rather
 * than a table scan.
 */
export const messageSearchQuerySchema = z.object({
  q: z.string().trim().min(SEARCH_QUERY_MIN_LENGTH).max(SEARCH_QUERY_MAX_LENGTH),
  limit: pageLimit(50),
  before: cursorField.optional(),
});

export type CreateMessageBody = z.infer<typeof createMessageBodySchema>;
export type EditMessageBody = z.infer<typeof editMessageBodySchema>;
export type MessageListQuery = z.infer<typeof messageListQuerySchema>;
export type MessageSearchQuery = z.infer<typeof messageSearchQuerySchema>;
