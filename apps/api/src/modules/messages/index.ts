import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ATTACHMENT_MAX_PER_MESSAGE,
  MESSAGE_MAX_LENGTH,
  parseCustomEmojiShortcode,
  REACTION_KEY_MAX_LENGTH,
} from "@demli/config";
import {
  AttachmentLinkError,
  MESSAGES_PAGE_MAX_LIMIT,
  MESSAGES_SEARCH_MAX_LIMIT,
  type RealtimeMutationPublisher,
  type SlowmodeStore,
} from "@demli/db";
import {
  dispatchChannelMessagePush,
  filterMutedRecipients,
  dmMessagePush,
  type OfflineNotifier,
} from "@demli/notifications";
import { contentMentionsUser, serverEvent } from "@demli/protocol";
import type { UnfurlService } from "@demli/unfurl";
import { isChatCapableChannel, PERMISSIONS } from "@demli/types";
import { ApiError, parseWith } from "../../errors.js";
import {
  enrichMessageWithAttachments,
  linkErrorToApiError,
} from "../../lib/attachments.js";
import { assertNotBlocked, blockedAuthorIds } from "../../lib/blocks.js";
import { assertNotTimedOut } from "../../lib/timeout.js";
import { enrichMessage, enrichMessages } from "../../lib/message-enrichment.js";
import { loadVisibleChannel, requirePerm } from "../../lib/permissions.js";
import { isUnicodeEmojiReaction } from "../../lib/reaction-emoji.js";
import type { AttachmentStorage } from "../../lib/storage.js";
import { requireUser } from "../../plugins/auth.js";
import { MESSAGE_PAGE_LIMIT, userRateLimit } from "../../lib/rate-limit.js";

const channelParamsSchema = z.object({
  channelId: z.string().uuid("Invalid channel id."),
});

const messageParamsSchema = z.object({
  messageId: z.string().uuid("Invalid message id."),
});

/**
 * Reaction route params. `:messageId` is a uuid; `:emoji` is URL-encoded on the
 * wire and Fastify decodes it into `params.emoji`. The value's SHAPE is checked
 * in the handler (`loadReactionTarget`): a single unicode emoji, or a `:name:`
 * custom-emoji shortcode resolvable in the message's group. This schema only
 * bounds the segment's length so it can never carry unbounded text.
 */
const reactionParamsSchema = z.object({
  messageId: z.string().uuid("Invalid message id."),
  emoji: z.string().min(1).max(REACTION_KEY_MAX_LENGTH),
});

const contentSchema = z
  .string()
  .min(1, "Message cannot be empty.")
  .max(MESSAGE_MAX_LENGTH)
  .refine((value) => value.trim().length > 0, { message: "Message cannot be empty." });

/**
 * Create body (ADR 0008): a message needs EITHER non-empty text OR ≥1
 * attachment. `content` is optional/blank-tolerant so a caption-less image can
 * be sent; the cross-field refine keeps the old "no empty message" rule for
 * text-only sends, so pre-M10 text clients are unaffected. Mirrors the WS
 * `sendMessagePayloadSchema` rule (the REST path carries no nonce).
 */
const createMessageSchema = z
  .object({
    content: z.string().max(MESSAGE_MAX_LENGTH).optional(),
    attachmentIds: z
      .array(z.string().uuid("Invalid attachment id."))
      .max(ATTACHMENT_MAX_PER_MESSAGE)
      .optional(),
    /**
     * The message this send replies to (ADR 0011 §2). Optional/additive so
     * pre-M14 clients are unaffected. The handler validates the target exists
     * and belongs to the SAME channel; the preview is built into the response.
     */
    replyToMessageId: z.string().uuid("Invalid reply target id.").optional(),
  })
  .refine(
    (b) => (b.content?.trim().length ?? 0) > 0 || (b.attachmentIds?.length ?? 0) > 0,
    { message: "Message must have text or at least one attachment." },
  );

const editMessageSchema = z.object({ content: contentSchema });

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MESSAGES_PAGE_MAX_LIMIT).optional(),
  cursor: z.string().min(1).max(512).optional(),
});

/**
 * Message-search query (ADR 0011 §5). `q` is trimmed FIRST, then length-gated:
 * < 3 chars is a 400 (too short for a useful full-text/substring match, and a
 * cheap abuse guard). `before` is the opaque keyset cursor from a previous
 * page's `nextCursor`.
 */
const searchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(3, "Search query must be at least 3 characters.")
    .max(128, "Search query is too long."),
  limit: z.coerce.number().int().min(1).max(MESSAGES_SEARCH_MAX_LIMIT).optional(),
  before: z.string().min(1).max(512).optional(),
});

export interface MessagesModuleDeps {
  mutationBus?: RealtimeMutationPublisher;
  slowmode: SlowmodeStore;
  /** Attachment storage (ADR 0008) — used to purge objects on message delete. */
  storage?: AttachmentStorage | null;
  /**
   * Offline mobile-push dispatcher (task #46, extended by #94). Pushes an offline
   * recipient on: a DM message (the other member), and EVERY message in a
   * group/server channel they can see — @mentioned members get the mention push,
   * everyone else the plain channel push (`dispatchChannelMessagePush`), each
   * gated by their notification mutes. Broadcast @everyone/@here fan-out remains a
   * documented seam — not separately notified. Optional — omitted in tests that
   * do not assert push.
   */
  notifier?: OfflineNotifier;
  /**
   * Link-preview (unfurl) service (M17). When present, a created message's
   * content is unfurled ASYNCHRONOUSLY (fire-and-forget) after the 201 — the send
   * never waits on it, and embeds arrive later via `message.embeds_updated`.
   * Omitted in tests that do not assert unfurl (and in prod when disabled), in
   * which case messages simply carry no previews.
   */
  unfurl?: UnfurlService;
}

export async function registerMessagesModule(
  server: FastifyInstance,
  deps: MessagesModuleDeps,
): Promise<void> {
  const { mutationBus, slowmode, storage, notifier, unfurl } = deps;

  server.post(
    "/channels/:channelId/messages",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 20, timeWindow: "10 seconds" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { channelId } = parseWith(channelParamsSchema, request.params);
      const body = parseWith(createMessageSchema, request.body);
      const attachmentIds = body.attachmentIds ?? [];

      // Visibility-filtered: a restricted channel the caller's roles do not
      // grant answers "Channel not found." (existence not leaked — M9).
      const access = await loadVisibleChannel(server, channelId, user.id);
      // Voice channels carry their own text chat since M20, so
      // this gate now asks the shared `isChatCapableChannel` question rather than
      // `kind === "text"`. Note what did NOT change with it: SEEING the channel is
      // still the entire access rule (`loadVisibleChannel` above), and being in
      // the voice ROOM is deliberately not required — you read and write a voice
      // channel's chat from the sidebar exactly like a text channel's. The gate
      // stays, rather than being deleted, because a future non-chat channel kind
      // must fail closed here.
      if (!isChatCapableChannel(access.channel.kind)) {
        throw new ApiError(
          400,
          "INVALID_CHANNEL",
          "Messages cannot be sent to this channel.",
        );
      }

      // Timeout gate (migration 0020, ADR 0019). A timed-out member cannot send
      // in this server until the mute expires. Placed here — before the reply
      // lookup, before slowmode, before the write — for the same reason the block
      // gate was hoisted: a refused send must persist NOTHING and must not burn a
      // slowmode slot. `timedOutUntil` rides along on the membership row
      // `loadVisibleChannel` already read, so this costs no extra query, and
      // expiry is compared to the clock right here (no sweeper).
      assertNotTimedOut(access.timedOutUntil);

      // If attachments are requested but the feature is off, fail clearly rather
      // than letting the link step reject them as "not found".
      if (attachmentIds.length > 0 && storage === null) {
        throw new ApiError(
          503,
          "ATTACHMENTS_DISABLED",
          "Attachments are not available on this server.",
        );
      }

      // Reply target (ADR 0011 §2): the quoted message must exist and live in
      // THIS channel — you cannot quote across channels (else INVALID_PAYLOAD).
      // A soft-deleted target is allowed (findById returns it): the reply sends
      // and its preview renders the "deleted" stub. A hard-deleted target would
      // have gone SET NULL, so an id pointing at one simply reads as not-found.
      // Validated before slowmode so a bad target never burns a slowmode slot.
      const replyToMessageId = body.replyToMessageId ?? null;
      if (replyToMessageId !== null) {
        const target = await server.repos.messages.findById(replyToMessageId);
        if (!target || target.channelId !== channelId) {
          throw new ApiError(
            400,
            "INVALID_PAYLOAD",
            "You can only reply to a message in this channel.",
          );
        }
      }

      // DM block gate (M18, ADR 0017). `dms.findById` is kind-filtered, so it
      // resolves the DM (participant = the OTHER member) ONLY when this channel's
      // group is a DM — it doubles as the DM detector. HOISTED above the write
      // (it used to run after) so a blocked DM send is refused BEFORE anything is
      // persisted; the post-create branch below reuses this same value, so the
      // hot path pays no extra query. Symmetric by construction: the shared guard
      // checks both directions, so neither side can message the other.
      const dm = await server.repos.dms.findById(access.channel.groupId, user.id);
      if (dm) {
        await assertNotBlocked(server, user.id, dm.participant.id);
      }

      // Slowmode: at most one message per `slowmodeSeconds` per member.
      // Owners are exempt; the same Redis-backed slot is shared with the WS
      // gateway so switching transports cannot bypass the limit.
      const slowmodeSeconds = access.channel.slowmodeSeconds ?? 0;
      if (slowmodeSeconds > 0 && access.role !== "owner") {
        const verdict = await slowmode.check(channelId, user.id, slowmodeSeconds);
        if (!verdict.ok) {
          throw new ApiError(
            429,
            "SLOWMODE",
            `Slowmode is on. Try again in ${verdict.retryAfterSeconds}s.`,
            verdict.retryAfterSeconds,
          );
        }
      }

      const message = await server.repos.messages.create({
        channelId,
        authorId: user.id,
        content: body.content?.trim() ?? "",
        replyToMessageId,
      });

      // Link ready, uploader-owned, unlinked attachments to the new message
      // (ready → linked, atomic). A foreign/not-ready/already-linked id throws
      // AttachmentLinkError, mapped to a 400. The message row already exists;
      // orphaning it on a bad link is acceptable (it carries valid text or is
      // swept), and keeping the create+link non-transactional matches the WS
      // path which links after the nonce upsert.
      if (attachmentIds.length > 0) {
        try {
          await server.repos.attachments.attachToMessage(attachmentIds, message.id, user.id);
        } catch (err) {
          if (err instanceof AttachmentLinkError) throw linkErrorToApiError(err);
          throw err;
        }
      }

      // DM re-open on inbound (ADR 0010 §1, API side): a message landing in a
      // hidden DM re-surfaces it for the recipient. `dms.findById` returns the
      // DM (participant = the OTHER member) ONLY when this channel's group is a
      // DM and the sender is a member, so it doubles as a cheap DM detector —
      // one kind-filtered lookup, null (no unhide) for server/group channels.
      // Best-effort: the message is already persisted, so a failure here must
      // never fail the send. The realtime (WS) path clears it too — that is W3.
      try {
        if (dm) {
          await server.repos.dms.unhide(dm.id, dm.participant.id);
          // Mobile push when the DM recipient is offline (task #46). Best-effort
          // and offline-gated by the notifier; `dm.participant` is the recipient
          // (the OTHER member) relative to the sender. A DM mute (0013) silences
          // this — mode="all" drops it, mode="mentions" keeps it only when this
          // message directly @mentions the recipient (a DM is otherwise not a
          // "mention"). The DM's group is the mute's group scope.
          const dmRecipients = await filterMutedRecipients(
            server.repos.notificationMutes,
            [dm.participant.id],
            {
              channelId,
              groupId: access.channel.groupId,
              isMention: contentMentionsUser(message.content, dm.participant.id),
            },
            (m) => request.log.info(m),
          );
          // Ignore filter (migration 0020, ADR 0019 §4). A DM has an audience of
          // one, so this is a single membership test rather than the batched form
          // the channel fan-out uses — but it must be here, or "ignore" would
          // silence a noisy server member while the same person could still ping
          // the phone directly. The message itself still sends and still lands in
          // the DM; only the notification stops.
          const dmNotifiable =
            dmRecipients.length > 0 &&
            !(await server.repos.userIgnores.isIgnoring(dm.participant.id, user.id))
              ? dmRecipients
              : [];
          await notifier?.notify(
            dmNotifiable,
            dmMessagePush({
              authorId: user.id,
              authorName: user.displayName,
              dmId: dm.id,
              channelId,
              messageId: message.id,
              content: message.content,
            }),
          );
        } else {
          // Non-DM (group/server) channel: fan the "all messages" offline push
          // (#94) out to every member who can SEE the channel — @mentioned members
          // get the mention push, everyone else the plain channel push — each
          // gated by their notification mutes and the notifier's offline gate.
          // Runs ONLY when `dm` is null so a message in a DM (whose 2-member
          // roster overlaps this fan-out) is not double-notified. The shared
          // dispatcher enforces channel visibility server-side (never trusts the
          // sender, §28) and is identical to the WS gateway path.
          await dispatchChannelMessagePush(
            { repos: server.repos, notifier, log: (m) => request.log.info(m) },
            {
              channelId,
              groupId: access.channel.groupId,
              channelName: access.channel.name,
              authorId: user.id,
              content: message.content,
              messageId: message.id,
            },
          );
        }
      } catch (err) {
        request.log.error({ err, channelId }, "dm reopen / mention push on inbound failed");
      }

      // Enrich the 201 with attachments + reactions (none yet) + the reply
      // preview so the sender renders the quote immediately (viewer = sender).
      const dto = await enrichMessage(server.repos, message, user.id);

      // Link preview (M17): unfurl any http(s) URLs in the content
      // ASYNCHRONOUSLY. Fired AFTER the response DTO is built, so the 201
      // deterministically reflects the message as sent — embeds arrive later via
      // `message.embeds_updated` (the send never waits on a network fetch). Only
      // for text sends; `message.content` is the persisted (trimmed) content.
      // Best-effort: the service never throws, and a failure here must not affect
      // the already-sent message.
      if (unfurl && message.content.length > 0) {
        void unfurl
          .unfurlMessage({
            messageId: message.id,
            channelId,
            authorId: user.id,
            content: message.content,
          })
          .catch((err: unknown) =>
            request.log.error({ err, messageId: message.id }, "unfurl failed"),
          );
      }

      return reply.status(201).send({ message: dto });
    },
  );

  server.get(
    "/channels/:channelId/messages",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit(MESSAGE_PAGE_LIMIT) },
    },
    async (request) => {
      const user = requireUser(request);
      const { channelId } = parseWith(channelParamsSchema, request.params);
      const query = parseWith(listQuerySchema, request.query);

      // Visibility-filtered (M9): invisible channel ⇒ "Channel not found.".
      await loadVisibleChannel(server, channelId, user.id);

      // Block filter (M18, ADR 0017): a blocked user's messages are excluded IN
      // SQL, so their content never leaves the server — a client-side hide would
      // still ship the text to the machine that blocked them. Applied before the
      // `limit + 1` slice, so pages stay full and the keyset cursor stays disjoint
      // (no duplicates, §22). ONE extra query, and none at all for the common case
      // of a user who has blocked nobody (the set comes back empty).
      const hidden = await blockedAuthorIds(server, user.id);

      const page = await server.repos.messages.listPage({
        channelId,
        limit: query.limit,
        cursor: query.cursor ?? null,
        excludeAuthorIds: hidden,
      });
      // Enrich this page in three batched queries (no N+1): attachment metadata
      // (no signed URLs — lazily fetched), the per-viewer reaction summary, and
      // reply previews (ADR 0011). `reactedByMe` is relative to the caller.
      const messages = await enrichMessages(
        server.repos,
        page.items,
        user.id,
        new Set(hidden),
      );
      return { messages, nextCursor: page.nextCursor };
    },
  );

  /**
   * Full-text message search within one channel (ADR 0011 §5). Same auth +
   * visibility gate as the list read (invisible/non-member channel ⇒ 404, no
   * existence leak, M9), same `{ messages, nextCursor }` envelope and MessageDTO
   * enrichment. Results are newest-first and keyset-paged via `?before=<cursor>`.
   * Rate-limited per session: search is heavier than a keyset list read.
   */
  server.get(
    "/channels/:channelId/messages/search",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "10 seconds" }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { channelId } = parseWith(channelParamsSchema, request.params);
      const query = parseWith(searchQuerySchema, request.query);

      // Visibility-filtered (M9): invisible/non-member channel ⇒ "Channel not found.".
      await loadVisibleChannel(server, channelId, user.id);

      // Block filter (M18): a blocked user's messages must not be FINDABLE either
      // — search is the surface most likely to resurface hidden history, so it
      // shares the exact SQL exclusion the list read uses.
      const hidden = await blockedAuthorIds(server, user.id);

      const page = await server.repos.messages.search(channelId, query.q, {
        limit: query.limit,
        before: query.before ?? null,
        excludeAuthorIds: hidden,
      });
      // Enrich each hit exactly like the list path (attachments → reactions →
      // reply previews, all batched; `reactedByMe` relative to the caller).
      const messages = await enrichMessages(
        server.repos,
        page.items,
        user.id,
        new Set(hidden),
      );
      return { messages, nextCursor: page.nextCursor };
    },
  );

  server.patch(
    "/messages/:messageId",
    {
      preHandler: [server.authenticate],
      config: {
        // Same budget as the other message writes in this module: an edit
        // re-enriches the message and broadcasts `message.updated` to the whole
        // channel, so it costs about what a send does and must not be cheaper
        // to spam than one.
        rateLimit: userRateLimit({ max: 30, timeWindow: "10 seconds" }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { messageId } = parseWith(messageParamsSchema, request.params);
      const body = parseWith(editMessageSchema, request.body);

      const existing = await server.repos.messages.findById(messageId);
      if (!existing || existing.deletedAt) {
        throw new ApiError(404, "NOT_FOUND", "Message not found.");
      }
      const access = await server.repos.channels.findWithMembership(
        existing.channelId,
        user.id,
      );
      if (!access) throw new ApiError(404, "NOT_FOUND", "Message not found.");
      // Invisible restricted channel ⇒ same "not found" (M9, no leak).
      const canSee = await server.repos.channelAccess.canUserSeeChannel(
        access.channel.groupId,
        existing.channelId,
        user.id,
      );
      if (!canSee) throw new ApiError(404, "NOT_FOUND", "Message not found.");
      if (existing.authorId !== user.id) {
        throw new ApiError(403, "FORBIDDEN", "You can only edit your own messages.");
      }

      const updated = await server.repos.messages.updateContent(
        messageId,
        user.id,
        body.content,
      );
      if (!updated) throw new ApiError(404, "NOT_FOUND", "Message not found.");

      // Re-attach metadata so an edit never drops a message's attachments from
      // the client's copy (a content edit leaves the attachment set unchanged).
      const dto = await enrichMessageWithAttachments(server.repos, updated);

      // Fan the edit out to connected WS clients (separate realtime process).
      // Best-effort: the DB row is the source of truth, so a failed publish
      // never fails the request — the publisher swallows and logs.
      if (mutationBus) {
        await mutationBus.publish({
          channelId: updated.channelId,
          event: serverEvent.messageUpdated(dto),
        });
      }
      return { message: dto };
    },
  );

  server.delete(
    "/messages/:messageId",
    {
      preHandler: [server.authenticate],
      config: {
        // Matches the edit/reaction budget — a delete also broadcasts to the
        // whole channel and additionally purges attachment objects.
        rateLimit: userRateLimit({ max: 30, timeWindow: "10 seconds" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { messageId } = parseWith(messageParamsSchema, request.params);

      const existing = await server.repos.messages.findById(messageId);
      if (!existing || existing.deletedAt) {
        throw new ApiError(404, "NOT_FOUND", "Message not found.");
      }
      const access = await server.repos.channels.findWithMembership(
        existing.channelId,
        user.id,
      );
      if (!access) throw new ApiError(404, "NOT_FOUND", "Message not found.");
      // Invisible restricted channel ⇒ same "not found" (M9, no leak).
      const canSee = await server.repos.channelAccess.canUserSeeChannel(
        access.channel.groupId,
        existing.channelId,
        user.id,
      );
      if (!canSee) throw new ApiError(404, "NOT_FOUND", "Message not found.");

      // Author deletes their own; others need owner ∨ MANAGE_MESSAGES (M9).
      if (existing.authorId !== user.id) {
        await requirePerm(
          server,
          access.channel.groupId,
          access.role,
          user.id,
          PERMISSIONS.MANAGE_MESSAGES,
          "You cannot delete this message.",
        );
      }

      await server.repos.messages.softDelete(messageId);

      // Reap the message's link previews (M17). Soft-delete does not cascade the
      // rows, so drop them explicitly (mirroring the attachment reap below) — a
      // deleted message must show no embeds. Best-effort: the message is already
      // deleted, so a failure here must not fail the request.
      try {
        await server.repos.messageEmbeds.deleteForMessage(messageId);
      } catch (err) {
        request.log.error({ err, messageId }, "message delete: embed reap failed");
      }

      // Reap the pin (M17), same reasoning: a soft delete does not cascade, and a
      // deleted message must not linger on the channel's pin board. When a row was
      // actually removed, fan `message.unpinned` out FIRST so clients drop the
      // board entry even if they ignore `message.deleted` (e.g. a pin panel open
      // on a message scrolled out of the cached page). Best-effort throughout.
      try {
        const wasPinned = await server.repos.messagePins.deleteForMessage(messageId);
        if (wasPinned && mutationBus) {
          await mutationBus.publish({
            channelId: existing.channelId,
            event: serverEvent.messageUnpinned({
              channelId: existing.channelId,
              messageId,
            }),
          });
        }
      } catch (err) {
        request.log.error({ err, messageId }, "message delete: pin reap failed");
      }

      // Purge the message's attachment rows AND their storage objects (ADR 0008
      // §3). Soft-delete does not cascade the rows, so this is the primary reap;
      // storage removal is best-effort (the sweep is the backstop).
      const purged = await server.repos.attachments.deleteForMessage(messageId);
      if (purged.length > 0 && storage) {
        try {
          await storage.remove(purged.map((a) => a.storagePath));
        } catch (err) {
          request.log.error({ err, messageId }, "message delete: attachment storage purge failed");
        }
      }

      // Fan the delete out to connected WS clients (best-effort, see edit above).
      if (mutationBus) {
        await mutationBus.publish({
          channelId: existing.channelId,
          event: serverEvent.messageDeleted({
            channelId: existing.channelId,
            messageId,
          }),
        });
      }
      return reply.status(204).send();
    },
  );

  /**
   * Resolve + authorize a reaction target (ADR 0011 §4; M17 widening), shared by
   * PUT/DELETE so the guard order is identical.
   *
   * Order:
   *  1. SHAPE gate (pure input, leaks nothing): the key must be a `:name:`
   *     custom-emoji shortcode OR a single unicode emoji. Arbitrary text is a
   *     `400 INVALID_REACTION` before any DB read.
   *  2. The message must exist and be non-deleted (a soft-deleted message carries
   *     no reactions — its rows were reaped on delete → `404`).
   *  3. The channel must be VISIBLE to the caller (M9: invisible/restricted ⇒
   *     `404`, no existence leak).
   *  4. A `:name:` reaction must resolve to an emoji uploaded to THIS message's
   *     group (§28, per-group scope) — a DM / flat chat has none ⇒ `400`.
   *
   * Returns the CANONICAL emoji key (a custom reaction is stored as the lowercased
   * `:name:`, so casing can never split one emoji into two reaction buckets).
   */
  async function loadReactionTarget(request: FastifyRequest): Promise<{
    messageId: string;
    channelId: string;
    emoji: string;
    userId: string;
    /**
     * The caller's timeout expiry in this message's server (migration 0020),
     * forwarded raw. Returned rather than asserted INSIDE this resolver because
     * the two callers differ on purpose: adding a reaction is speech and is
     * blocked while timed out; REMOVING your own reaction is a retraction and
     * stays allowed, since a timeout silences someone rather than trapping them
     * with whatever they had already said.
     */
    timedOutUntil: Date | string | null | undefined;
  }> {
    const user = requireUser(request);
    const { messageId, emoji } = parseWith(reactionParamsSchema, request.params);

    const shortcodeName = parseCustomEmojiShortcode(emoji);
    if (shortcodeName === null && !isUnicodeEmojiReaction(emoji)) {
      throw new ApiError(
        400,
        "INVALID_REACTION",
        "That emoji is not available as a reaction.",
      );
    }

    const message = await server.repos.messages.findById(messageId);
    if (!message || message.deletedAt) {
      throw new ApiError(404, "NOT_FOUND", "Message not found.");
    }
    const { channel, timedOutUntil } = await loadVisibleChannel(
      server,
      message.channelId,
      user.id,
    );

    let canonicalEmoji = emoji;
    if (shortcodeName !== null) {
      const found = await server.repos.customEmojis.findByNameInGroup(
        shortcodeName,
        channel.groupId,
      );
      if (!found) {
        throw new ApiError(
          400,
          "INVALID_REACTION",
          "That emoji is not available as a reaction.",
        );
      }
      // Canonicalize to the stored lowercased `:name:` (the parser already
      // validated the grammar), so `:Cat:` and `:cat:` fold into one bucket.
      canonicalEmoji = `:${shortcodeName}:`;
    }

    return {
      messageId,
      channelId: message.channelId,
      emoji: canonicalEmoji,
      userId: user.id,
      timedOutUntil,
    };
  }

  /** Refreshed per-viewer summary the reaction endpoints echo so the initiator reconciles. */
  async function reactionSummary(messageId: string, viewerId: string) {
    const byMessage = await server.repos.messageReactions.summariesForMessages(
      [messageId],
      viewerId,
    );
    return byMessage.get(messageId) ?? [];
  }

  server.put(
    "/messages/:messageId/reactions/:emoji",
    {
      preHandler: [server.authenticate],
      // Reactions are cheap but spammable — cap per session (ADR 0011 §4).
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "10 seconds" }),
      },
    },
    async (request) => {
      const { messageId, channelId, emoji, userId, timedOutUntil } =
        await loadReactionTarget(request);

      // Timeout gate (migration 0020, ADR 0019). Adding a reaction is a visible
      // contribution to a channel a timed-out member is muted in, so it is
      // refused for the same reason a message is. Removing one is NOT gated —
      // see the resolver's doc comment.
      assertNotTimedOut(timedOutUntil);

      const { added } = await server.repos.messageReactions.add(messageId, userId, emoji);
      // Idempotent: skip the fan-out on a duplicate add (the row already
      // existed) so a spammed PUT does not re-broadcast; the initiator still
      // gets the authoritative summary back below.
      if (added && mutationBus) {
        await mutationBus.publish({
          channelId,
          event: serverEvent.messageReactionAdded({ channelId, messageId, emoji, userId }),
        });
      }
      return { reactions: await reactionSummary(messageId, userId) };
    },
  );

  server.delete(
    "/messages/:messageId/reactions/:emoji",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "10 seconds" }),
      },
    },
    async (request) => {
      const { messageId, channelId, emoji, userId } = await loadReactionTarget(request);

      const { removed } = await server.repos.messageReactions.remove(messageId, userId, emoji);
      // Idempotent: only fan out when a row was actually removed.
      if (removed && mutationBus) {
        await mutationBus.publish({
          channelId,
          event: serverEvent.messageReactionRemoved({ channelId, messageId, emoji, userId }),
        });
      }
      return { reactions: await reactionSummary(messageId, userId) };
    },
  );
}
