/**
 * Attachment projection for the realtime gateway (ADR 0008).
 *
 * The gateway links `attachmentIds` to a message on `message.send` and enriches
 * the broadcast `message.created` with attachment METADATA. This mirrors the
 * REST path's `toAttachmentDTO` (apps/api/src/lib/attachments.ts): the two
 * absent fields — `storagePath` and `status` — are the whole point. The bucket
 * object key is server-internal and MUST NOT reach a client (ADR 0008 §2), and
 * no signed read URL is ever baked into a message; those are minted per request
 * by the batch attachments-URL endpoint.
 *
 * This is a deliberate, tiny duplication of the API's projection rather than a
 * cross-app import: `apps/realtime` must not depend on `apps/api`, and the
 * natural shared home (the `AttachmentRecord → AttachmentDTO` boundary) sits in
 * `@demli/db`, owned by the database agent. See media-gateway.md.
 */

import type { AttachmentLinkError, AttachmentRecord, Repositories } from "@demli/db";
import type { AttachmentDTO, ErrorRaisedPayload, MessageDTO } from "@demli/protocol";
import type { Message } from "@demli/types";

/** Project the server-only record onto the client-facing DTO (metadata only). */
export function toAttachmentDTO(record: AttachmentRecord): AttachmentDTO {
  return {
    id: record.id,
    messageId: record.messageId,
    channelId: record.channelId,
    uploaderId: record.uploaderId,
    kind: record.kind,
    mime: record.mime,
    sizeBytes: record.sizeBytes,
    width: record.width,
    height: record.height,
    durationMs: record.durationMs,
    isVoiceMessage: record.isVoiceMessage,
    createdAt: record.createdAt,
  };
}

/**
 * Enrich one message with its attachment METADATA for a `message.created`
 * broadcast — the WS mirror of the API's `enrichMessageWithAttachments`. One
 * `listForMessages` query; a message with no attachments is returned unchanged
 * (no empty `attachments` array), matching the REST list shape. Reading back
 * from the DB (rather than trusting the payload's ids) makes a deduped retry
 * re-broadcast the SAME full attachment set the original send linked.
 */
export async function enrichMessageWithAttachments(
  repos: Repositories,
  message: Message,
): Promise<MessageDTO> {
  const byMessage = await repos.attachments.listForMessages([message.id]);
  const records = byMessage.get(message.id);
  if (!records || records.length === 0) return message;
  return { ...message, attachments: records.map(toAttachmentDTO) };
}

/**
 * Translate a repo {@link AttachmentLinkError} into a typed `error.raised`
 * payload — the WS mirror of the API's `linkErrorToApiError`, where every link
 * refusal is a 400 `INVALID_ATTACHMENT`. Here they all map to the existing
 * `INVALID_PAYLOAD` code (the WS 4xx equivalent; no new protocol error code)
 * with the SAME user-facing messages. `not_found` and `foreign_uploader`
 * deliberately share one message so a client probing someone else's upload ids
 * learns nothing about their existence (no oracle), exactly like the REST path.
 */
export function linkErrorToErrorRaised(
  error: AttachmentLinkError,
  nonce: string,
): ErrorRaisedPayload {
  switch (error.reason) {
    case "not_ready":
      return {
        code: "INVALID_PAYLOAD",
        message: "An attachment is not ready to send yet.",
        nonce,
      };
    case "already_linked":
      return {
        code: "INVALID_PAYLOAD",
        message: "An attachment is already attached to a message.",
        nonce,
      };
    case "not_found":
    case "foreign_uploader":
      return {
        code: "INVALID_PAYLOAD",
        message: "One or more attachments are invalid.",
        nonce,
      };
  }
}
