import { and, asc, eq, inArray, isNull, lt } from "drizzle-orm";
import type {
  AttachmentId,
  AttachmentKind,
  ChannelId,
  MessageId,
  UserId,
} from "@demli/types";
import type { Db } from "../client.js";
import { attachments } from "../schema.js";

/* ---------------------------------------------------------------------------
 * `AttachmentRecord` is the FULL persisted row (camelCased, ISO timestamps) —
 * intentionally a SERVER-ONLY superset of the shared client-facing
 * `Attachment` type. It carries `storagePath` and `status` because every
 * consumer of this repo is server-side (api + realtime): the API needs
 * `storagePath` to sign URLs and to purge storage objects on delete/sweep.
 * `storagePath` MUST NOT be forwarded to clients — the API strips it when
 * building the public `AttachmentDTO` (ADR 0008 §2/§5). This layer only
 * persists.
 * ------------------------------------------------------------------------- */

export type { AttachmentId, AttachmentKind };
/** Upload lifecycle only; linkage is `messageId !== null`, not a status. */
export type AttachmentStatus = "pending" | "ready";

export interface AttachmentRecord {
  id: AttachmentId;
  /** null until linked to a message (the upload window). */
  messageId: MessageId | null;
  channelId: ChannelId;
  uploaderId: UserId;
  kind: AttachmentKind;
  mime: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  /** Server-internal object key — never expose to clients. */
  storagePath: string;
  status: AttachmentStatus;
  createdAt: string;
}

type AttachmentRow = typeof attachments.$inferSelect;

/** Row → domain record. Co-located (not in mappers.ts) to keep this an
 * append-only, conflict-free addition to the package. */
export function toAttachmentRecord(row: AttachmentRow): AttachmentRecord {
  return {
    id: row.id,
    messageId: row.messageId,
    channelId: row.channelId,
    uploaderId: row.uploaderId,
    kind: row.kind,
    mime: row.mime,
    sizeBytes: row.sizeBytes,
    width: row.width,
    height: row.height,
    durationMs: row.durationMs,
    storagePath: row.storagePath,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Why an {@link attachToMessage} link was refused (API maps this to a 4xx). */
export type AttachmentLinkRejection =
  | "not_found"
  | "foreign_uploader"
  | "not_ready"
  | "already_linked";

/**
 * Thrown when {@link attachToMessage} is asked to link an id it must not: an
 * unknown id, one owned by another user, one not yet uploaded/verified, or one
 * already attached to a DIFFERENT message. The link is atomic — nothing is
 * written when this throws.
 */
export class AttachmentLinkError extends Error {
  constructor(
    readonly reason: AttachmentLinkRejection,
    readonly attachmentId: AttachmentId,
  ) {
    super(`attachToMessage rejected id ${attachmentId}: ${reason}`);
    this.name = "AttachmentLinkError";
  }
}

/**
 * Media attachment persistence (ADR 0008). Lifecycle:
 *   createPending → markReady → attachToMessage
 * Authorization (channel visibility, guest/text-channel checks, mime/size/kind
 * validation, magic-byte sniff) lives at the API boundary — this layer only
 * persists and enforces the ownership/lifecycle invariants that protect the
 * graph (an attachment can never be linked by a non-owner or before it is ready).
 */
export function attachmentsRepo(db: Db) {
  return {
    /**
     * Create the row for a signed upload, `status='pending'`, `message_id=null`.
     * The API creates this after authorizing the channel and validating
     * kind/mime/size; the bytes are uploaded directly to storage afterward.
     */
    async createPending(input: {
      channelId: ChannelId;
      uploaderId: UserId;
      kind: AttachmentKind;
      mime: string;
      sizeBytes: number;
      storagePath: string;
      width?: number | null;
      height?: number | null;
      durationMs?: number | null;
    }): Promise<AttachmentRecord> {
      const [row] = await db
        .insert(attachments)
        .values({
          channelId: input.channelId,
          uploaderId: input.uploaderId,
          kind: input.kind,
          mime: input.mime,
          sizeBytes: input.sizeBytes,
          storagePath: input.storagePath,
          width: input.width ?? null,
          height: input.height ?? null,
          durationMs: input.durationMs ?? null,
          status: "pending",
        })
        .returning();
      if (!row) throw new Error("insert attachments returned no row");
      return toAttachmentRecord(row);
    },

    async findById(attachmentId: AttachmentId): Promise<AttachmentRecord | null> {
      const [row] = await db
        .select()
        .from(attachments)
        .where(eq(attachments.id, attachmentId))
        .limit(1);
      return row ? toAttachmentRecord(row) : null;
    },

    /**
     * Complete an upload: flip `pending → ready` for an uploader-owned row, and
     * optionally persist client-measured dimensions (the API sanity-clamps them
     * first). Idempotent: a retried complete on an already-ready, still-unlinked
     * row returns that row instead of null. Returns null when the id is unknown,
     * owned by someone else, or already linked to a message.
     */
    async markReady(
      attachmentId: AttachmentId,
      input: {
        uploaderId: UserId;
        width?: number | null;
        height?: number | null;
        durationMs?: number | null;
      },
    ): Promise<AttachmentRecord | null> {
      const dims: Partial<typeof attachments.$inferInsert> = {};
      if (input.width !== undefined) dims.width = input.width;
      if (input.height !== undefined) dims.height = input.height;
      if (input.durationMs !== undefined) dims.durationMs = input.durationMs;

      const [flipped] = await db
        .update(attachments)
        .set({ status: "ready", ...dims })
        .where(
          and(
            eq(attachments.id, attachmentId),
            eq(attachments.uploaderId, input.uploaderId),
            eq(attachments.status, "pending"),
          ),
        )
        .returning();
      if (flipped) return toAttachmentRecord(flipped);

      // No pending row flipped — treat a retried complete on an already-ready,
      // still-unlinked, owned row as success (idempotent); everything else null.
      const existing = await this.findById(attachmentId);
      if (
        existing &&
        existing.uploaderId === input.uploaderId &&
        existing.status === "ready" &&
        existing.messageId === null
      ) {
        return existing;
      }
      return null;
    },

    /**
     * Link ready, unlinked, uploader-owned attachments to a message
     * (`message_id` NULL → messageId). Atomic: if ANY requested id is unknown,
     * owned by another user, not yet `ready`, or already attached to a DIFFERENT
     * message, it throws {@link AttachmentLinkError} and writes nothing.
     *
     * Idempotent for retried sends: ids already linked to THIS `messageId` (same
     * nonce resolves to the same message) are accepted as no-ops, so a
     * re-delivered `message.send` never duplicates or errors. Returns the full,
     * ordered attachment set now on the message.
     */
    async attachToMessage(
      attachmentIds: AttachmentId[],
      messageId: MessageId,
      uploaderId: UserId,
    ): Promise<AttachmentRecord[]> {
      const ids = [...new Set(attachmentIds)];
      if (ids.length === 0) return [];

      return db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(attachments)
          .where(inArray(attachments.id, ids));
        const byId = new Map(rows.map((r) => [r.id, r]));

        const toLink: AttachmentId[] = [];
        for (const id of ids) {
          const row = byId.get(id);
          if (!row) throw new AttachmentLinkError("not_found", id);
          if (row.uploaderId !== uploaderId) {
            throw new AttachmentLinkError("foreign_uploader", id);
          }
          if (row.messageId === messageId) continue; // already linked here → no-op
          if (row.messageId !== null) {
            throw new AttachmentLinkError("already_linked", id);
          }
          if (row.status !== "ready") throw new AttachmentLinkError("not_ready", id);
          toLink.push(id);
        }

        if (toLink.length > 0) {
          // Re-assert the guard in the WHERE so a concurrent link can't slip a
          // row in between the read above and this write.
          await tx
            .update(attachments)
            .set({ messageId })
            .where(
              and(
                inArray(attachments.id, toLink),
                eq(attachments.uploaderId, uploaderId),
                eq(attachments.status, "ready"),
                isNull(attachments.messageId),
              ),
            );
        }

        const linked = await tx
          .select()
          .from(attachments)
          .where(eq(attachments.messageId, messageId))
          .orderBy(asc(attachments.createdAt), asc(attachments.id));
        return linked.map(toAttachmentRecord);
      });
    },

    /** Attachments on a single message, in stable upload order. */
    async listForMessage(messageId: MessageId): Promise<AttachmentRecord[]> {
      const rows = await db
        .select()
        .from(attachments)
        .where(eq(attachments.messageId, messageId))
        .orderBy(asc(attachments.createdAt), asc(attachments.id));
      return rows.map(toAttachmentRecord);
    },

    /**
     * Bulk fetch for a page of messages — one query, grouped by message id (no
     * N+1). Messages with no attachments are simply absent from the map; the
     * caller reads `map.get(id) ?? []`.
     */
    async listForMessages(
      messageIds: MessageId[],
    ): Promise<Map<MessageId, AttachmentRecord[]>> {
      const grouped = new Map<MessageId, AttachmentRecord[]>();
      const ids = [...new Set(messageIds)];
      if (ids.length === 0) return grouped;

      const rows = await db
        .select()
        .from(attachments)
        .where(inArray(attachments.messageId, ids))
        .orderBy(asc(attachments.createdAt), asc(attachments.id));

      for (const row of rows) {
        // messageId is non-null here (the inArray filters out nulls).
        const key = row.messageId as MessageId;
        const bucket = grouped.get(key);
        if (bucket) bucket.push(toAttachmentRecord(row));
        else grouped.set(key, [toAttachmentRecord(row)]);
      }
      return grouped;
    },

    /**
     * Delete every attachment row of a message and return the deleted records
     * (with `storagePath`) so the API can purge the storage objects. Used on
     * message delete — hard delete already cascades the rows, but soft delete
     * does not, so the API calls this explicitly to reap the bytes.
     */
    async deleteForMessage(messageId: MessageId): Promise<AttachmentRecord[]> {
      const rows = await db
        .delete(attachments)
        .where(eq(attachments.messageId, messageId))
        .returning();
      return rows.map(toAttachmentRecord);
    },

    /**
     * Cancel a single unsent upload: delete the row IFF it is still UNLINKED
     * (`message_id IS NULL`) and owned by `uploaderId`. Returns the deleted
     * record (with `storagePath`) so the API can purge the storage object, or
     * null when nothing matched — an unknown id, another user's row, or one that
     * has since been attached to a message. Atomic and race-safe: the
     * `message_id IS NULL` guard is in the WHERE, so a concurrent
     * {@link attachToMessage} that wins keeps the now-linked row intact.
     */
    async deleteUnlinkedById(
      attachmentId: AttachmentId,
      uploaderId: UserId,
    ): Promise<AttachmentRecord | null> {
      const [row] = await db
        .delete(attachments)
        .where(
          and(
            eq(attachments.id, attachmentId),
            eq(attachments.uploaderId, uploaderId),
            isNull(attachments.messageId),
          ),
        )
        .returning();
      return row ? toAttachmentRecord(row) : null;
    },

    /**
     * Orphan sweep (backstop for uploads that were never sent): delete UNLINKED
     * rows (`message_id IS NULL`) older than `olderThanHours` — both never-
     * completed `pending` and completed-but-never-sent `ready` rows. Returns the
     * deleted records so the API can delete their storage objects (ADR 0008 §3).
     */
    async sweepStalePending(olderThanHours: number): Promise<AttachmentRecord[]> {
      const cutoff = new Date(Date.now() - olderThanHours * 60 * 60 * 1000);
      const rows = await db
        .delete(attachments)
        .where(and(isNull(attachments.messageId), lt(attachments.createdAt, cutoff)))
        .returning();
      return rows.map(toAttachmentRecord);
    },
  };
}

export type AttachmentsRepo = ReturnType<typeof attachmentsRepo>;
