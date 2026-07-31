/**
 * Shared attachment logic (ADR 0008) used by the attachments and messages
 * modules: authoritative mime/size validation, magic-byte sniffing, the
 * AttachmentRecord → AttachmentDTO projection (which STRIPS the server-only
 * `storagePath`/`status`), and message DTO enrichment.
 *
 * The client validates locally for a fast reject, but the server re-validates
 * from the SAME `@demli/config` constants and additionally sniffs the bytes,
 * because a direct client→storage upload cannot be trusted on declared MIME
 * alone (§28).
 */

import { randomUUID } from "node:crypto";
import {
  ATTACHMENT_LIMITS,
  attachmentKindForMime,
  type AttachmentLimitKind,
} from "@demli/config";
import type { AttachmentDTO, MessageDTO } from "@demli/protocol";
import { AttachmentLinkError, type AttachmentRecord, type Repositories } from "@demli/db";
import type { ChannelId, Message } from "@demli/types";
import { ApiError } from "../errors.js";

/** How many leading bytes to fetch for the magic-byte sniff on `complete`. */
export const ATTACHMENT_SNIFF_BYTES = 16;

/** Sanity ceilings for client-reported media dimensions (clamped, not rejected). */
const MAX_PIXEL_DIMENSION = 100_000;
const MAX_DURATION_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve an upload's kind from its MIME against the whitelist, or reject. This
 * is the one canonical MIME→kind classification (`attachmentKindForMime`); the
 * API never hand-rolls a second one (security-relevant).
 */
export function resolveKindOrReject(mime: string): AttachmentLimitKind {
  const kind = attachmentKindForMime(mime);
  if (!kind) {
    throw new ApiError(400, "INVALID_ATTACHMENT", "This file type is not allowed.");
  }
  return kind;
}

/** Reject an upload whose declared size exceeds the per-kind cap. */
export function assertWithinSizeCap(kind: AttachmentLimitKind, sizeBytes: number): void {
  const cap = ATTACHMENT_LIMITS[kind].maxBytes;
  if (sizeBytes > cap) {
    const mb = Math.round(cap / (1024 * 1024));
    throw new ApiError(
      400,
      "INVALID_ATTACHMENT",
      `File is too large. The maximum for ${kind} is ${mb} MB.`,
    );
  }
}

/** Bucket-relative object key: random UUID (path is not sensitive), per-channel. */
export function buildStoragePath(channelId: ChannelId, mime: string): string {
  return `${channelId}/${randomUUID()}.${extensionForMime(mime)}`;
}

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "video/mp4": "mp4",
  "video/webm": "webm",
};

function extensionForMime(mime: string): string {
  return MIME_EXTENSIONS[mime] ?? "bin";
}

/**
 * Classify the leading bytes of an uploaded object into an attachment kind by
 * magic number, or `null` when they match no whitelisted media signature. The
 * `complete` step requires the sniffed kind to equal the row's declared kind:
 * an `.exe` renamed `.png` sniffs to `null` (rejected) and a video declared as
 * an image sniffs to `video` ≠ `image` (rejected). Covers exactly the ADR 0008
 * §4 whitelist (png/jpeg/webp/gif, mp3/ogg/wav, mp4/webm).
 */
export function sniffAttachmentKind(bytes: Uint8Array): AttachmentLimitKind | null {
  const startsWith = (sig: number[], offset = 0): boolean =>
    bytes.length >= offset + sig.length && sig.every((v, i) => bytes[offset + i] === v);
  const ascii = (text: string, offset = 0): boolean =>
    startsWith([...text].map((c) => c.charCodeAt(0)), offset);

  // Images
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image"; // PNG
  if (startsWith([0xff, 0xd8, 0xff])) return "image"; // JPEG
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return "image"; // GIF87a / GIF89a
  if (ascii("RIFF") && ascii("WEBP", 8)) return "image"; // WEBP (RIFF container)

  // Audio
  if (ascii("RIFF") && ascii("WAVE", 8)) return "audio"; // WAV (RIFF container)
  if (ascii("OggS")) return "audio"; // OGG (Vorbis/Opus)
  if (ascii("ID3")) return "audio"; // MP3 with an ID3v2 tag
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return "audio"; // MP3 frame sync

  // Video
  if (ascii("ftyp", 4)) return "video"; // MP4 / ISO-BMFF ("....ftyp")
  if (startsWith([0x1a, 0x45, 0xdf, 0xa3])) return "video"; // WEBM / Matroska (EBML)

  return null;
}

/**
 * Clamp a client-reported pixel dimension into a sane range. `undefined` means
 * "not provided" and is passed through so the repo leaves the column untouched.
 */
export function clampDimension(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.max(0, Math.min(MAX_PIXEL_DIMENSION, Math.floor(value)));
}

/** Clamp a client-reported duration (ms) into a sane range; `undefined` passes through. */
export function clampDuration(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return Math.max(0, Math.min(MAX_DURATION_MS, Math.floor(value)));
}

/**
 * Project the server-only record onto the client-facing DTO. The two absent
 * fields — `storagePath` and `status` — are the whole point of this function:
 * it is the boundary that guarantees the object key never leaves the API
 * (ADR 0008 §2). Metadata only; signed read URLs are minted separately.
 */
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
    createdAt: record.createdAt,
  };
}

/**
 * Enrich a page of messages with their attachment metadata in ONE query
 * (`listForMessages`, no N+1). Messages with no attachments are returned
 * unchanged (no empty `attachments` array). Metadata only — no signed URLs.
 */
export async function enrichMessagesWithAttachments(
  repos: Repositories,
  messages: Message[],
): Promise<MessageDTO[]> {
  if (messages.length === 0) return [];
  const byMessage = await repos.attachments.listForMessages(messages.map((m) => m.id));
  return messages.map((message) => {
    const records = byMessage.get(message.id);
    if (!records || records.length === 0) return message;
    return { ...message, attachments: records.map(toAttachmentDTO) };
  });
}

/** Single-message convenience over {@link enrichMessagesWithAttachments}. */
export async function enrichMessageWithAttachments(
  repos: Repositories,
  message: Message,
): Promise<MessageDTO> {
  const [enriched] = await enrichMessagesWithAttachments(repos, [message]);
  return enriched ?? message;
}

/**
 * Translate a repo {@link AttachmentLinkError} into a user-friendly HTTP error
 * when linking `attachmentIds` to a new message. All the "you can't attach that"
 * cases collapse to a 400 (a client that sent good ids never hits them); a
 * foreign/unknown id is a 400 rather than 404 so we neither confirm nor deny the
 * id's existence to a caller probing someone else's uploads.
 */
export function linkErrorToApiError(error: AttachmentLinkError): ApiError {
  switch (error.reason) {
    case "not_ready":
      return new ApiError(400, "INVALID_ATTACHMENT", "An attachment is not ready to send yet.");
    case "already_linked":
      return new ApiError(400, "INVALID_ATTACHMENT", "An attachment is already attached to a message.");
    case "not_found":
    case "foreign_uploader":
      return new ApiError(400, "INVALID_ATTACHMENT", "One or more attachments are invalid.");
  }
}

export { AttachmentLinkError };
