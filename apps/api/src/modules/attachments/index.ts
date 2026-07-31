/**
 * Media attachments module (ADR 0008, M10). Direct client→Supabase upload with
 * the API as the signing + recording authority:
 *
 *   1. POST /channels/:channelId/attachments/upload-url  → authorize + sign + record `pending`
 *   2. (client PUTs bytes directly to the signed URL)
 *   3. POST /attachments/:id/complete                    → verify object + magic bytes → `ready`
 *   4. (client sends a message with attachmentIds — see the messages module)
 *   -  POST /channels/:channelId/attachments/urls        → mint short-lived signed READ URLs
 *   -  DELETE /attachments/:id                            → cancel an unsent upload
 *
 * Authorization reuses the ADR 0007 channel-visibility guard (`loadVisibleChannel`)
 * — attachments inherit the message's channel ACL, no second ACL. The signed
 * read URL is the ONLY thing not carried in the message DTO; it is minted here
 * per request, never baked into a cacheable message (ADR 0008 §2, contract §M10-2).
 *
 * When Supabase is not configured the wrapper is `null` and every route answers
 * ATTACHMENTS_DISABLED (503) — the app still boots; attachments are simply off.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Repositories } from "@demli/db";
import type { AttachmentUrl } from "@demli/protocol";
import { isChatCapableChannel } from "@demli/types";
import { ApiError, parseWith } from "../../errors.js";
import { loadVisibleChannel } from "../../lib/permissions.js";
import { requireUser } from "../../plugins/auth.js";
import type { AttachmentStorage } from "../../lib/storage.js";
import type { MediaModerator } from "../../lib/media-moderation.js";
import {
  ATTACHMENT_SNIFF_BYTES,
  assertWithinSizeCap,
  buildStoragePath,
  clampDimension,
  clampDuration,
  resolveKindOrReject,
  sniffAttachmentKind,
  toAttachmentDTO,
} from "../../lib/attachments.js";
import { userRateLimit } from "../../lib/rate-limit.js";

/** Signed read URL lifetime (~1 h): long enough to render, short enough to bound a leak. */
export const ATTACHMENT_READ_URL_TTL_SECONDS = 60 * 60;

/** Max attachment ids one batch URL request may resolve (scroll-back safe upper bound). */
export const ATTACHMENT_URL_BATCH_MAX = 100;

const channelParamsSchema = z.object({
  channelId: z.string().uuid("Invalid channel id."),
});

const attachmentParamsSchema = z.object({
  id: z.string().uuid("Invalid attachment id."),
});

const uploadUrlBodySchema = z.object({
  /** Client display hint only — not stored; the object key is a random UUID. */
  filename: z.string().min(1).max(255).optional(),
  mime: z.string().min(1).max(255),
  sizeBytes: z.number().int().positive(),
});

const completeBodySchema = z.object({
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});

const urlsBodySchema = z.object({
  attachmentIds: z
    .array(z.string().uuid("Invalid attachment id."))
    .min(1, "Provide at least one attachment id.")
    .max(ATTACHMENT_URL_BATCH_MAX),
});

/** Throw ATTACHMENTS_DISABLED unless the storage backend is configured. */
function requireStorage(storage: AttachmentStorage | null): AttachmentStorage {
  if (!storage) {
    throw new ApiError(
      503,
      "ATTACHMENTS_DISABLED",
      "Attachments are not available on this server.",
    );
  }
  return storage;
}

export interface AttachmentsModuleDeps {
  /** Supabase Storage wrapper, or null when the feature is disabled. */
  storage: AttachmentStorage | null;
  /**
   * NSFW media seam (M15). An image attachment completed into a NON-NSFW channel
   * is screened; a flagged image is rejected (`nsfw_content_blocked`) and its
   * bytes purged. Fail-open + disabled by default (`enabled === false` skips the
   * check entirely, including the signed-URL round trip).
   */
  mediaModerator: MediaModerator;
}

export async function registerAttachmentsModule(
  server: FastifyInstance,
  deps: AttachmentsModuleDeps,
): Promise<void> {
  const { storage, mediaModerator } = deps;

  // 1. Sign a direct upload and record a pending attachment row.
  server.post(
    "/channels/:channelId/attachments/upload-url",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const store = requireStorage(storage);
      const user = requireUser(request);
      const { channelId } = parseWith(channelParamsSchema, request.params);
      const body = parseWith(uploadUrlBodySchema, request.body);

      // Visibility-filtered: an invisible restricted channel answers 404 (M9).
      const access = await loadVisibleChannel(server, channelId, user.id);
      // Chat-capable kinds only — which since M20 includes voice channels, whose
      // text chat would otherwise be the one chat in the app where you cannot
      // drop a screenshot. The NSFW screening on `complete` needs nothing new: it
      // reads `channels.findById(record.channelId).nsfw`, a per-channel flag that
      // was never kind-scoped, so an image posted to a non-NSFW VOICE channel is
      // screened by exactly the same seam as a text one.
      if (!isChatCapableChannel(access.channel.kind)) {
        throw new ApiError(
          400,
          "INVALID_CHANNEL",
          "Attachments cannot be uploaded to this channel.",
        );
      }
      // Guests cannot upload (ADR 0008 §3 — member, not guest).
      if (access.role === "guest") {
        throw new ApiError(403, "FORBIDDEN", "Guests cannot upload attachments.");
      }

      // Server is authoritative: derive the kind from the whitelist and cap the
      // declared size. The bytes are magic-byte-sniffed later on `complete`.
      const kind = resolveKindOrReject(body.mime);
      assertWithinSizeCap(kind, body.sizeBytes);

      // Random-UUID object key: sign the upload BEFORE the DB write so a signing
      // failure never orphans a row, and no bytes exist until the client PUTs.
      const storagePath = buildStoragePath(channelId, body.mime);
      const signed = await store.createSignedUploadUrl(storagePath);
      const record = await server.repos.attachments.createPending({
        channelId,
        uploaderId: user.id,
        kind,
        mime: body.mime,
        sizeBytes: body.sizeBytes,
        storagePath,
      });

      return reply.status(201).send({
        attachmentId: record.id,
        uploadUrl: signed.uploadUrl,
        expiresAt: signed.expiresAt,
      });
    },
  );

  // 2. Verify the uploaded object and flip pending → ready.
  server.post(
    "/attachments/:id/complete",
    {
      preHandler: [server.authenticate],
      config: {
        // Same budget as `upload-url` above: a client calls this exactly once per
        // signed upload, so 30/min can never be reached legitimately. It needs a
        // limit of its own because it is the EXPENSIVE half — a storage probe
        // plus, when moderation is on, a signed-URL round trip and a remote NSFW
        // check per call, all reachable with a bare attachment id.
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const store = requireStorage(storage);
      const user = requireUser(request);
      const { id } = parseWith(attachmentParamsSchema, request.params);
      const body = parseWith(completeBodySchema, request.body);

      const record = await server.repos.attachments.findById(id);
      // Unknown OR foreign uploader → same 404 (never confirm a foreign id exists).
      if (!record || record.uploaderId !== user.id) {
        throw new ApiError(404, "NOT_FOUND", "Attachment not found.");
      }
      if (record.messageId !== null) {
        throw new ApiError(409, "CONFLICT", "This attachment is already attached to a message.");
      }

      // The object must actually exist in storage, be within the per-kind cap
      // for its REAL size, and its magic bytes must match the declared kind — a
      // direct upload cannot be trusted on the client's declared MIME (§28).
      const probe = await store.probeObject(record.storagePath, ATTACHMENT_SNIFF_BYTES);
      if (!probe.exists) {
        throw new ApiError(400, "INVALID_ATTACHMENT", "The upload was not found in storage.");
      }
      if (probe.sizeBytes !== null) {
        assertWithinSizeCap(record.kind, probe.sizeBytes);
      }
      const sniffed = sniffAttachmentKind(probe.head);
      if (sniffed !== record.kind) {
        throw new ApiError(
          400,
          "INVALID_ATTACHMENT",
          "The uploaded file does not match its declared type.",
        );
      }

      // NSFW seam (M15): an IMAGE attachment posted to a NON-NSFW
      // channel is screened; a flagged image is rejected and its bytes purged. An
      // NSFW channel is exactly where such media belongs, so it is skipped there.
      // Gated by `mediaModerator.enabled` so the signed-URL round trip only
      // happens when moderation is actually on (it is OFF/fail-open by default —
      // no upload is ever rejected for NSFW until the founder flips the flag).
      if (mediaModerator.enabled && record.kind === "image") {
        const channel = await server.repos.channels.findById(record.channelId);
        if (channel && !channel.nsfw) {
          const read = await store.createSignedReadUrl(
            record.storagePath,
            ATTACHMENT_READ_URL_TTL_SECONDS,
          );
          const verdict = await mediaModerator.check({
            url: read.url,
            mime: record.mime,
            subject: "attachment",
          });
          if (verdict.verdict === "rejected") {
            // Purge the bytes and drop the still-unlinked row before answering.
            try {
              await store.remove([record.storagePath]);
            } catch (err) {
              request.log.error({ err, attachmentId: id }, "nsfw attachment: storage remove failed");
            }
            await server.repos.attachments.deleteUnlinkedById(id, user.id);
            request.log.info({ userId: user.id, attachmentId: id }, "attachment blocked by nsfw seam");
            throw new ApiError(
              422,
              "nsfw_content_blocked",
              "This image can't be posted in a non-NSFW channel.",
            );
          }
          if (verdict.verdict === "skipped" && verdict.error) {
            request.log.warn({ err: verdict.error }, "attachment moderation failed open");
          }
        }
      }

      const ready = await server.repos.attachments.markReady(id, {
        uploaderId: user.id,
        width: clampDimension(body.width),
        height: clampDimension(body.height),
        durationMs: clampDuration(body.durationMs),
      });
      // Null only on a race (linked/consumed between the checks above and here).
      if (!ready) {
        throw new ApiError(409, "CONFLICT", "This attachment can no longer be completed.");
      }
      return { attachment: toAttachmentDTO(ready) };
    },
  );

  // Cancel an unsent upload: purge the bytes AND delete the still-unlinked row
  // synchronously (no longer waiting on the 24h orphan sweep). Uploader-only.
  server.delete(
    "/attachments/:id",
    {
      preHandler: [server.authenticate],
      config: {
        // Mirrors the upload budget (one cancel per upload at most) and bounds
        // the storage-delete calls this endpoint issues on the provider.
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const store = requireStorage(storage);
      const user = requireUser(request);
      const { id } = parseWith(attachmentParamsSchema, request.params);

      const record = await server.repos.attachments.findById(id);
      if (!record || record.uploaderId !== user.id) {
        throw new ApiError(404, "NOT_FOUND", "Attachment not found.");
      }
      if (record.messageId !== null) {
        throw new ApiError(409, "CONFLICT", "A sent attachment cannot be cancelled.");
      }

      // Best-effort byte removal first (the security/cost-critical action). A
      // failure to purge is logged, not surfaced — the sweep remains the
      // backstop for any object the row delete below still frees.
      try {
        await store.remove([record.storagePath]);
      } catch (err) {
        request.log.error({ err, attachmentId: id }, "attachment cancel: storage remove failed");
      }

      // Then delete the row itself. The repo guards on `message_id IS NULL`, so
      // a concurrent send that linked this attachment between the check above
      // and here wins — the now-linked row is left intact (returns null).
      await server.repos.attachments.deleteUnlinkedById(id, user.id);

      return reply.status(204).send();
    },
  );

  // Mint short-lived signed READ URLs for a batch of attachments in this
  // channel. The SOLE source of playable/renderable URLs (ADR 0008 §2).
  server.post(
    "/channels/:channelId/attachments/urls",
    {
      preHandler: [server.authenticate],
      config: {
        // A read, but the most resource-consuming one in this module: each call
        // does up to ATTACHMENT_URL_BATCH_MAX (100) row lookups AND 100 signed-URL
        // mints against the storage provider — so unlimited, it is a 100× lever on
        // an upstream we pay for. 60/min is well above real usage (a client mints
        // one batch per screenful of history and caches until expiry) while
        // capping the lever at a known ceiling.
        rateLimit: userRateLimit({ max: 60, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const store = requireStorage(storage);
      const user = requireUser(request);
      const { channelId } = parseWith(channelParamsSchema, request.params);
      const body = parseWith(urlsBodySchema, request.body);

      // Channel-scoped authorization: invisible/foreign channel ⇒ 404 (M9).
      await loadVisibleChannel(server, channelId, user.id);

      const ids = [...new Set(body.attachmentIds)];
      const urls: AttachmentUrl[] = [];
      for (const id of ids) {
        const record = await server.repos.attachments.findById(id);
        // Channel-match: an attachment of another channel (or unknown) is 404,
        // so this endpoint can never be used to read across channel boundaries.
        if (!record || record.channelId !== channelId) {
          throw new ApiError(404, "NOT_FOUND", "Attachment not found.");
        }
        // Linked-or-owned (security-review M10-M2): a not-yet-posted upload is
        // readable only by its uploader — other members cannot mint URLs for
        // it just by knowing the id. Same 404 as unknown, no existence oracle.
        if (record.messageId === null && record.uploaderId !== user.id) {
          throw new ApiError(404, "NOT_FOUND", "Attachment not found.");
        }
        const signed = await store.createSignedReadUrl(
          record.storagePath,
          ATTACHMENT_READ_URL_TTL_SECONDS,
        );
        urls.push({
          attachmentId: record.id,
          url: signed.url,
          urlExpiresAt: signed.expiresAt,
        });
      }
      return { urls };
    },
  );
}

// ---------------------------------------------------------------------------
// Orphan sweep (ADR 0008 §3): a periodic backstop that deletes unlinked
// attachment rows older than the cutoff (uploads that were never sent) and
// purges their storage objects. Started at boot, cleared on graceful shutdown.
// ---------------------------------------------------------------------------

export interface AttachmentSweepOptions {
  repos: Repositories;
  storage: AttachmentStorage;
  /** How often to sweep (ms). */
  intervalMs?: number;
  /** Delete unlinked rows older than this many hours. */
  olderThanHours?: number;
  log?: (message: string) => void;
}

/** One hour. */
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60 * 1000;
/** ADR 0008 §3 — orphans older than 24 h. */
const DEFAULT_SWEEP_OLDER_THAN_HOURS = 24;

/**
 * Start the periodic orphan sweep. Returns a stop function that clears the
 * timer. The interval is `unref`'d so it never keeps the process alive on its
 * own, and each tick is fully guarded — a sweep failure is logged, never thrown.
 */
export function startAttachmentSweep(options: AttachmentSweepOptions): () => void {
  const intervalMs = options.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const olderThanHours = options.olderThanHours ?? DEFAULT_SWEEP_OLDER_THAN_HOURS;
  const log = options.log ?? (() => {});

  const tick = async (): Promise<void> => {
    try {
      const swept = await options.repos.attachments.sweepStalePending(olderThanHours);
      if (swept.length === 0) return;
      try {
        await options.storage.remove(swept.map((r) => r.storagePath));
      } catch (err) {
        log(`attachment sweep: storage remove failed for ${swept.length} objects: ${String(err)}`);
      }
      log(`attachment sweep: removed ${swept.length} orphan attachment(s)`);
    } catch (err) {
      log(`attachment sweep: db sweep failed: ${String(err)}`);
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
