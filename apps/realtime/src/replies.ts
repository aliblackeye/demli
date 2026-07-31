/**
 * Reply-preview projection for the realtime gateway (ADR 0011 §2).
 *
 * The gateway threads `replyToMessageId` through `message.send` and enriches the
 * broadcast `message.created` with a lightweight quote of the target message.
 * This is the WS mirror of the API's list/create reply enrichment (W3): both
 * build the SAME preview from `messages.getReplyPreviews`, which lives in
 * `@demli/db` precisely because it is the one package both processes import
 * (`apps/realtime` must not depend on `apps/api`). See attachments.ts for the
 * sibling attachment projection.
 */

import type { Repositories } from "@demli/db";
import type { MessageDTO } from "@demli/protocol";

/**
 * Graft the reply-target preview onto a `message.created` DTO. A non-reply
 * (`replyToMessageId` null/absent) is returned unchanged — no `replyTo` key,
 * matching the REST list shape for non-replies, so text-only messages and
 * pre-M14 fixtures are untouched.
 *
 * The preview is read from the PERSISTED `message.replyToMessageId` (not the
 * send payload), so a deduped retry re-broadcasts the canonical original's
 * reply, and a since-deleted target renders its stub. `getReplyPreviews`
 * resolves a soft-deleted target as `{ deleted: true, content: "" }` (the
 * "Original message was deleted." stub) and a hard-deleted one as absent — but
 * a hard delete SET NULLs the self-FK, so `replyToMessageId` would already be
 * null and we never reach the lookup. The defensive `?? null` covers the
 * theoretical gap (target vanished between insert and lookup) by sending an
 * explicit null the client reads as "no preview".
 *
 * One batched `WHERE id IN (…)` query for the single target — the same no-N+1
 * builder the API page path uses, called here with a one-element set.
 */
export async function enrichMessageWithReplyPreview(
  repos: Repositories,
  message: MessageDTO,
): Promise<MessageDTO> {
  const targetId = message.replyToMessageId;
  if (!targetId) return message;
  const previews = await repos.messages.getReplyPreviews([targetId]);
  return { ...message, replyTo: previews.get(targetId) ?? null };
}
