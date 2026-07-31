/**
 * Pinned-messages module (M17) — the per-channel pin board.
 *
 *   POST   /channels/:channelId/pins/:messageId   → pin   (201)
 *   DELETE /channels/:channelId/pins/:messageId   → unpin (204)
 *   GET    /channels/:channelId/pins              → the board
 *
 * Authorization is layered, and the ORDER matters (§28):
 *  1. `loadVisibleChannel` — the caller must be a member AND able to see the
 *     channel. A restricted channel they lack the role for answers 404, never
 *     403, so its existence is not leaked (M9/ADR 0007).
 *  2. The message must exist, be non-deleted, and live in THIS channel — so
 *     `/channels/A/pins/<message-in-B>` can never pin across channels.
 *  3. Then, and only then, the pin permission (see {@link assertMayPin}).
 *
 * Deliberately NO system message is written when a message is pinned: the
 * founder brief calls that noise, and a pin already fans out a realtime event
 * plus a header affordance, so the channel stays clean.
 */

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { PINS_MAX_PER_CHANNEL } from "@demli/config";
import type { RealtimeMutationPublisher } from "@demli/db";
import { serverEvent } from "@demli/protocol";
import { PERMISSIONS, type Message, type PinnedMessage } from "@demli/types";
import { ApiError, parseWith } from "../../errors.js";
import { enrichMessages } from "../../lib/message-enrichment.js";
import { hasPerm, loadVisibleChannel } from "../../lib/permissions.js";
import { requireUser } from "../../plugins/auth.js";
import { LIST_LIMIT, userRateLimit } from "../../lib/rate-limit.js";

const channelParamsSchema = z.object({
  channelId: z.string().uuid("Invalid channel id."),
});

const pinParamsSchema = z.object({
  channelId: z.string().uuid("Invalid channel id."),
  messageId: z.string().uuid("Invalid message id."),
});

export async function registerPinsModule(
  server: FastifyInstance,
  mutationBus?: RealtimeMutationPublisher,
): Promise<void> {
  /**
   * Resolve + authorize a pin target, shared by POST and DELETE so both obey the
   * identical guard order. Returns the ids the fan-out needs.
   *
   * A soft-deleted message is a 404: a deleted message must never be pinnable,
   * and its pin row is reaped on delete.
   */
  async function loadPinTarget(request: FastifyRequest): Promise<{
    messageId: string;
    channelId: string;
    groupId: string;
    message: Message;
    userId: string;
  }> {
    const user = requireUser(request);
    const { channelId, messageId } = parseWith(pinParamsSchema, request.params);

    // Visibility-filtered: an invisible restricted channel answers 404 (M9).
    const access = await loadVisibleChannel(server, channelId, user.id);

    const message = await server.repos.messages.findById(messageId);
    // Cross-channel guard: a message that exists but lives elsewhere answers the
    // SAME 404 as an unknown id, so this route is never an existence oracle for
    // messages in channels the caller cannot see.
    if (!message || message.deletedAt || message.channelId !== channelId) {
      throw new ApiError(404, "NOT_FOUND", "Message not found.");
    }

    await assertMayPin(access.channel.groupId, access.role, user.id, message);

    return {
      messageId,
      channelId,
      groupId: access.channel.groupId,
      message,
      userId: user.id,
    };
  }

  /**
   * The pin permission matrix. Throws 403 unless the caller may (un)pin.
   *
   * - SERVERS (`kind === "server"`): the message's own author, OR a member
   *   holding MANAGE_MESSAGES — with the owner bypassing the bitfield entirely
   *   (`hasPerm` applies owner-bypass and guest-deny). This mirrors the delete
   *   rule in the messages module, which is the closest existing analogue.
   * - DMs and flat GROUP CHATS: any member may pin. These group kinds have no
   *   role system at all — both DM members are stored with `role: "member"`, so a
   *   MANAGE_MESSAGES check would deny BOTH participants and make DM pins
   *   impossible. So either side may pin in a DM. Membership was
   *   already proven by `loadVisibleChannel`, so there is nothing further to
   *   check.
   *
   * Guests are denied in servers (via `hasPerm`) unless they are the author.
   */
  async function assertMayPin(
    groupId: string,
    role: Parameters<typeof hasPerm>[2],
    userId: string,
    message: Message,
  ): Promise<void> {
    const group = await server.repos.groups.findById(groupId);
    // Non-server kinds carry no roles — membership is the whole gate.
    if (group && group.kind !== "server") return;

    if (message.authorId === userId) return;

    const canManage = await hasPerm(
      server,
      groupId,
      role,
      userId,
      PERMISSIONS.MANAGE_MESSAGES,
    );
    if (!canManage) {
      throw new ApiError(403, "FORBIDDEN", "You cannot pin messages in this channel.");
    }
  }

  server.post(
    "/channels/:channelId/pins/:messageId",
    {
      preHandler: [server.authenticate],
      // Pinning is a cheap but spammable mutation — cap per session, matching
      // the reactions endpoints.
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "10 seconds" }),
      },
    },
    async (request, reply) => {
      const { messageId, channelId, message, userId } = await loadPinTarget(request);

      const result = await server.repos.messagePins.pin(messageId, channelId, userId);
      if (result.atCapacity) {
        throw new ApiError(
          409,
          "PINS_FULL",
          `This channel already has the maximum of ${PINS_MAX_PER_CHANNEL} pinned messages.`,
        );
      }
      if (!result.pin) {
        // Lost an insert race and the row vanished again — nothing to report.
        throw new ApiError(409, "CONFLICT", "That message could not be pinned.");
      }

      // Idempotent: only fan out when a row was actually written, so a spammed
      // pin does not re-broadcast (mirrors the reaction endpoints).
      if (result.pinned && mutationBus) {
        await mutationBus.publish({
          channelId,
          event: serverEvent.messagePinned({
            channelId,
            messageId,
            pinnedBy: result.pin.pinnedBy,
            pinnedAt: result.pin.pinnedAt,
          }),
        });
      }

      const [enriched] = await enrichMessages(server.repos, [message], userId);
      const pin: PinnedMessage = {
        message: { ...(enriched ?? message), pinned: true },
        pinnedBy: result.pin.pinnedBy,
        pinnedAt: result.pin.pinnedAt,
      };
      return reply.status(201).send({ pin });
    },
  );

  server.delete(
    "/channels/:channelId/pins/:messageId",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "10 seconds" }),
      },
    },
    async (request, reply) => {
      const { messageId, channelId } = await loadPinTarget(request);

      const { unpinned } = await server.repos.messagePins.unpin(messageId);
      // Idempotent: only fan out when a row was actually removed.
      if (unpinned && mutationBus) {
        await mutationBus.publish({
          channelId,
          event: serverEvent.messageUnpinned({ channelId, messageId }),
        });
      }
      return reply.status(204).send();
    },
  );

  /**
   * The channel's pin board. Un-paginated by design — `PINS_MAX_PER_CHANNEL`
   * bounds it at 50, so the cap IS the page size (§27). Same visibility gate as
   * the message list: an invisible/foreign channel answers 404.
   *
   * Reads need no pin PERMISSION: anyone who can read the channel can see what is
   * pinned in it, exactly like message history.
   */
  server.get(
    "/channels/:channelId/pins",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit(LIST_LIMIT) },
    },
    async (request) => {
      const user = requireUser(request);
      const { channelId } = parseWith(channelParamsSchema, request.params);

      await loadVisibleChannel(server, channelId, user.id);

      const rows = await server.repos.messagePins.listForChannel(channelId);
      if (rows.length === 0) return { pins: [] };

      // Enrich the whole board in the SAME batched passes a message page uses
      // (attachments → reactions → reply previews → embeds), so a pinned message
      // renders identically to its inline copy — no N+1 (§27).
      const enriched = await enrichMessages(
        server.repos,
        rows.map((row) => row.message),
        user.id,
      );
      const pins: PinnedMessage[] = rows.map((row, i) => ({
        message: { ...(enriched[i] ?? row.message), pinned: true },
        pinnedBy: row.pinnedBy,
        pinnedAt: row.pinnedAt,
      }));
      return { pins };
    },
  );
}
