/**
 * Custom-emoji module (M17) — per-group emoji referenced in message content as
 * `:name:`.
 *
 *   GET    /groups/:groupId/emojis        → the group's emoji (metadata only)
 *   POST   /groups/:groupId/emojis        → upload one (inline base64)
 *   DELETE /groups/:groupId/emojis/:id    → remove one
 *   POST   /groups/:groupId/emojis/urls   → batch short-lived signed image URLs
 *
 * The upload is ONE request carrying the image inline, unlike the attachment
 * pipeline's sign → PUT → complete dance. That is a deliberate consequence of the
 * 256 KB cap: with the bytes in hand the API validates the REAL content (size +
 * magic bytes) BEFORE storing anything, so an unverified object never reaches the
 * bucket and there is no pending row or orphan sweep to maintain. See
 * `lib/custom-emojis.ts` for the validation rules.
 *
 * Image URLs are minted per request and never persisted on the emoji record —
 * exactly the `AttachmentUrl` contract (ADR 0008 §2). The storage path never
 * leaves the API.
 *
 * Emoji are GROUP-scoped, never global: `:name:` in a message resolves against
 * that message's own group, so two groups may define the same name and neither
 * can read the other's (§28).
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  CUSTOM_EMOJI_MAX_BYTES,
  CUSTOM_EMOJI_MAX_PER_GROUP,
  CUSTOM_EMOJI_NAME_MAX_LENGTH,
  CUSTOM_EMOJI_NAME_MIN_LENGTH,
  isCustomEmojiName,
} from "@demli/config";
import type { RealtimeMutationPublisher } from "@demli/db";
import { serverEvent } from "@demli/protocol";
import type { CustomEmojiUrl, GroupId, MemberRole, UserId } from "@demli/types";
import { ApiError, parseWith } from "../../errors.js";
import { decodeEmojiUpload, buildEmojiStoragePath } from "../../lib/custom-emojis.js";
import type { AttachmentStorage } from "../../lib/storage.js";
import { requireUser } from "../../plugins/auth.js";
import { LIST_LIMIT, userRateLimit } from "../../lib/rate-limit.js";

/** Signed emoji read URL lifetime (~1 h) — same bound as attachment read URLs. */
export const EMOJI_READ_URL_TTL_SECONDS = 60 * 60;

const groupParamsSchema = z.object({
  groupId: z.string().uuid("Invalid group id."),
});

const emojiParamsSchema = z.object({
  groupId: z.string().uuid("Invalid group id."),
  emojiId: z.string().uuid("Invalid emoji id."),
});

/**
 * Upload body. `name` is lowercased BEFORE the grammar check so `:Cat:` and
 * `:cat:` are the same emoji rather than two colliding rows — the transform is
 * part of the schema so no handler can forget it.
 */
const createEmojiSchema = z.object({
  name: z
    .string()
    .min(CUSTOM_EMOJI_NAME_MIN_LENGTH)
    .max(CUSTOM_EMOJI_NAME_MAX_LENGTH)
    .transform((value) => value.trim().toLowerCase())
    .refine(isCustomEmojiName, {
      message: "Emoji names may only use lowercase letters, numbers and underscores.",
    }),
  mime: z.string().min(1).max(255),
  /** The raw image, base64-encoded. Length-capped again during decode. */
  dataBase64: z.string().min(1),
});

const urlsBodySchema = z.object({
  emojiIds: z
    .array(z.string().uuid("Invalid emoji id."))
    .min(1, "Provide at least one emoji id.")
    .max(CUSTOM_EMOJI_MAX_PER_GROUP),
});

/** Throw EMOJI_STORAGE_DISABLED unless the storage backend is configured. */
function requireStorage(storage: AttachmentStorage | null): AttachmentStorage {
  if (!storage) {
    throw new ApiError(
      503,
      "EMOJI_DISABLED",
      "Custom emoji are not available on this server.",
    );
  }
  return storage;
}

export interface CustomEmojisModuleDeps {
  /** Storage wrapper, or null when the feature is disabled (shared with attachments). */
  storage: AttachmentStorage | null;
  mutationBus?: RealtimeMutationPublisher;
}

export async function registerCustomEmojisModule(
  server: FastifyInstance,
  deps: CustomEmojisModuleDeps,
): Promise<void> {
  const { storage, mutationBus } = deps;

  /**
   * Resolve a group the caller is a MEMBER of, or 404.
   *
   * Deliberately NOT `loadServer`: emoji work in flat group chats and DMs too, so
   * this only requires membership and never filters on `kind`. A non-member (or
   * an unknown group) gets the same "Group not found." — membership is never
   * leaked (§28).
   */
  async function loadMembership(
    groupId: GroupId,
    userId: UserId,
  ): Promise<{ role: MemberRole }> {
    const membership = await server.repos.groups.getMembership(groupId, userId);
    if (!membership) throw new ApiError(404, "NOT_FOUND", "Group not found.");
    return { role: membership.role };
  }

  server.get(
    "/groups/:groupId/emojis",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit(LIST_LIMIT) },
    },
    async (request) => {
      const user = requireUser(request);
      const { groupId } = parseWith(groupParamsSchema, request.params);
      await loadMembership(groupId, user.id);

      // Metadata only — no URLs. Clients keep this list to resolve `:name:` in
      // message content and to render the picker, then mint image URLs for just
      // the emoji they actually paint (see the /urls route).
      const emojis = await server.repos.customEmojis.listForGroup(groupId);
      return { emojis, maxPerGroup: CUSTOM_EMOJI_MAX_PER_GROUP };
    },
  );

  server.post(
    "/groups/:groupId/emojis",
    {
      preHandler: [server.authenticate],
      // An emoji upload writes bytes to storage, so it is heavier than a normal
      // mutation. The cap is per session and sized for the realistic worst case:
      // someone seeding a fresh group's emoji set in one sitting. It is a burst
      // guard, not the real limit — `CUSTOM_EMOJI_MAX_PER_GROUP` (64) bounds
      // total storage, and `CUSTOM_EMOJI_MAX_BYTES` (256 KB) bounds each write,
      // so even a fully saturated bucket here is ~7.5 MB/min.
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
      // Base64 inflates the 256 KB cap to ~350 KB; 512 KB leaves room for the
      // JSON envelope while still rejecting a hostile body long before it is
      // parsed (the decoder re-checks the true size anyway).
      bodyLimit: 512 * 1024,
    },
    async (request, reply) => {
      const store = requireStorage(storage);
      const user = requireUser(request);
      const { groupId } = parseWith(groupParamsSchema, request.params);
      const body = parseWith(createEmojiSchema, request.body);

      const membership = await loadMembership(groupId, user.id);
      // Guests never write group assets (mirrors the attachment upload rule).
      if (membership.role === "guest") {
        throw new ApiError(403, "FORBIDDEN", "Guests cannot add emoji.");
      }

      // Validate the REAL bytes before anything is stored: whitelist → encoded
      // length → decode → true length → magic bytes (§28).
      const { bytes, mime } = decodeEmojiUpload({
        mime: body.mime,
        dataBase64: body.dataBase64,
      });

      // Cheap pre-check so an obviously-full group never uploads bytes it will
      // then have to purge. The repo re-counts inside its transaction, which is
      // the authoritative guard against a concurrent upload.
      const existing = await server.repos.customEmojis.countForGroup(groupId);
      if (existing >= CUSTOM_EMOJI_MAX_PER_GROUP) {
        throw new ApiError(
          409,
          "EMOJI_LIMIT",
          `This group already has the maximum of ${CUSTOM_EMOJI_MAX_PER_GROUP} emoji.`,
        );
      }

      const storagePath = buildEmojiStoragePath(groupId, mime);
      await store.upload(storagePath, bytes, mime);

      const { emoji, error } = await server.repos.customEmojis.create({
        groupId,
        name: body.name,
        mime,
        sizeBytes: bytes.length,
        storagePath,
        createdBy: user.id,
      });

      // The row lost to a concurrent upload (duplicate name, or the cap filled
      // between the pre-check and the transaction). The bytes are already in the
      // bucket and now belong to nothing, so purge them — best-effort, since the
      // request fails either way and a stray object is a cost, not a correctness,
      // problem.
      if (!emoji) {
        try {
          await store.remove([storagePath]);
        } catch (err) {
          request.log.error({ err, storagePath }, "emoji create: orphan purge failed");
        }
        if (error === "name_taken") {
          throw new ApiError(409, "EMOJI_NAME_TAKEN", "That emoji name is already used.");
        }
        throw new ApiError(
          409,
          "EMOJI_LIMIT",
          `This group already has the maximum of ${CUSTOM_EMOJI_MAX_PER_GROUP} emoji.`,
        );
      }

      // Group-scoped fan-out so every member's picker and `:name:` resolver
      // updates live. `storagePath` is stripped by the DTO mapper, so what goes
      // on the bus carries no bucket key.
      if (mutationBus) {
        const { storagePath: _omit, ...dto } = emoji;
        await mutationBus.publish({
          groupId,
          event: serverEvent.emojiCreated({ groupId, emoji: dto }),
        });
      }

      const { storagePath: _hidden, ...dto } = emoji;
      return reply.status(201).send({ emoji: dto });
    },
  );

  server.delete(
    "/groups/:groupId/emojis/:emojiId",
    {
      preHandler: [server.authenticate],
      config: {
        // Matches the emoji-create budget (30/min) and bounds the storage-delete
        // calls this issues on the provider.
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const store = requireStorage(storage);
      const user = requireUser(request);
      const { groupId, emojiId } = parseWith(emojiParamsSchema, request.params);

      const membership = await loadMembership(groupId, user.id);
      const existing = await server.repos.customEmojis.findByIdInGroup(emojiId, groupId);
      if (!existing) throw new ApiError(404, "NOT_FOUND", "Emoji not found.");

      // The uploader may remove their own; anyone else needs owner. Emoji are a
      // shared group asset, so this deliberately does NOT reuse MANAGE_MESSAGES
      // (a moderator bit about other people's messages) — and flat group chats /
      // DMs have no roles at all, where "owner or uploader" still reads sensibly.
      if (existing.createdBy !== user.id && membership.role !== "owner") {
        throw new ApiError(403, "FORBIDDEN", "You cannot remove this emoji.");
      }

      const removed = await server.repos.customEmojis.deleteInGroup(emojiId, groupId);
      if (!removed) throw new ApiError(404, "NOT_FOUND", "Emoji not found.");

      // Purge the bytes. Best-effort: the row is already gone, which is what
      // makes the emoji disappear for users; a lingering object is only cost.
      try {
        await store.remove([removed.storagePath]);
      } catch (err) {
        request.log.error({ err, emojiId }, "emoji delete: storage purge failed");
      }

      if (mutationBus) {
        await mutationBus.publish({
          groupId,
          event: serverEvent.emojiDeleted({ groupId, emojiId }),
        });
      }
      return reply.status(204).send();
    },
  );

  /**
   * Mint short-lived signed READ URLs for a batch of this group's emoji — the
   * SOLE source of renderable emoji images, mirroring the attachments URL
   * endpoint. Group-scoped: an id belonging to another group answers 404, so this
   * can never read across group boundaries.
   */
  server.post(
    "/groups/:groupId/emojis/urls",
    {
      preHandler: [server.authenticate],
      config: {
        // A read, but each call mints up to a group's worth (64) of signed URLs
        // against the storage provider — a multiplier on a paid upstream. Same
        // 60/min as the attachment URL endpoint it mirrors; clients cache these
        // until expiry, so real usage is a handful per session.
        rateLimit: userRateLimit({ max: 60, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const store = requireStorage(storage);
      const user = requireUser(request);
      const { groupId } = parseWith(groupParamsSchema, request.params);
      const body = parseWith(urlsBodySchema, request.body);
      await loadMembership(groupId, user.id);

      // One `listRecordsForGroup` instead of N `findByIdInGroup` calls: a group
      // holds at most 64 emoji, so fetching the set once and filtering in memory
      // is strictly cheaper than a query per requested id (§27).
      const records = await server.repos.customEmojis.listRecordsForGroup(groupId);
      const byId = new Map(records.map((record) => [record.id, record]));

      const ids = [...new Set(body.emojiIds)];
      const urls: CustomEmojiUrl[] = [];
      for (const emojiId of ids) {
        const record = byId.get(emojiId);
        // Unknown OR belonging to another group → the same 404, no existence
        // oracle for another group's emoji.
        if (!record) throw new ApiError(404, "NOT_FOUND", "Emoji not found.");
        const signed = await store.createSignedReadUrl(
          record.storagePath,
          EMOJI_READ_URL_TTL_SECONDS,
        );
        urls.push({ emojiId: record.id, url: signed.url, urlExpiresAt: signed.expiresAt });
      }
      return { urls };
    },
  );
}

/** Re-exported for tests and clients that surface the cap in copy. */
export { CUSTOM_EMOJI_MAX_BYTES, CUSTOM_EMOJI_MAX_PER_GROUP };
