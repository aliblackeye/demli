/**
 * User blocking (M18, ADR 0017).
 *
 * Routes:
 *   GET    /users/me/blocks            everyone I have blocked (newest first)
 *   PUT    /users/me/blocks/:userId    block someone (idempotent)
 *   DELETE /users/me/blocks/:userId    unblock (idempotent-ish: 404 if not blocked)
 *
 * Blocking is stored one-sided and enforced symmetrically everywhere else (see
 * `lib/blocks.ts`). This module owns only the LIST + the two mutations; every
 * surface a block cuts enforces it at its own boundary through the shared
 * helpers, because a block must hold on the WRITE path (a DM send, a call) as
 * well as the READ path (history, search, push) — a single choke point does not
 * exist for both.
 *
 * Blocking also implicitly severs the friendship: you cannot be friends with
 * someone you have blocked, and leaving the row would let the pair keep
 * appearing in each other's friend list while every interaction 403s. The friend removal fans out `friend.removed` to the other side exactly
 * like an unfriend, so their client drops the relationship without learning it
 * was a block.
 *
 * Realtime: `user.blocks_updated` (USER-scoped) to the blocker's own devices —
 * the RESYNC signal (M9-4 pattern) that makes the gateway re-derive that user's
 * block set and re-apply its message fan-out filter without a reconnect.
 */

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RealtimeMutationPublisher } from "@demli/db";
import { serverEvent } from "@demli/protocol";
import { ApiError, parseWith } from "../../errors.js";
import { requireUser } from "../../plugins/auth.js";
import { LIST_LIMIT, userRateLimit } from "../../lib/rate-limit.js";

const targetParamsSchema = z.object({
  userId: z.string().uuid("Invalid user id."),
});

export async function registerBlocksModule(
  server: FastifyInstance,
  mutationBus?: RealtimeMutationPublisher,
): Promise<void> {
  // Everyone I have blocked, hydrated for the settings list. Deliberately NOT
  // "who blocked me" — that is never queryable (§28).
  server.get(
    "/users/me/blocks",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit(LIST_LIMIT) },
    },
    async (request) => {
      const user = requireUser(request);
      return { blocks: await server.repos.userBlocks.listBlocked(user.id) };
    },
  );

  server.put(
    "/users/me/blocks/:userId",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { userId } = parseWith(targetParamsSchema, request.params);

      if (userId === user.id) {
        throw new ApiError(400, "VALIDATION_ERROR", "You cannot block yourself.");
      }
      // The target must exist. This is not an enumeration concern: blocking is an
      // authenticated, rate-limited action on a uuid the caller already holds
      // (from a profile card / member list), so a 404 here reveals nothing a
      // profile fetch would not.
      const target = await server.repos.users.findById(userId);
      if (!target) throw new ApiError(404, "NOT_FOUND", "User not found.");

      const block = await server.repos.userBlocks.block(user.id, userId);
      if (!block) throw new ApiError(400, "VALIDATION_ERROR", "You cannot block yourself.");

      // Sever any friendship / pending request in the same breath. The
      // repo's `remove` covers accepted friendships AND pending requests in both
      // directions with one primitive; `false` simply means there was nothing to
      // remove. Best-effort fan-out to the other side, exactly like an unfriend —
      // the payload is identical, so their client cannot tell a block from an
      // unfriend (§28).
      const unfriended = await server.repos.friendships.remove(user.id, userId);
      if (unfriended) {
        await mutationBus?.publish({
          userId,
          event: serverEvent.friendRemoved({ userId: user.id }),
        });
      }

      // RESYNC signal to MY OWN devices: the gateway re-derives my block set and
      // stops forwarding the blocked user's messages to my sockets; my clients
      // drop their cached messages. Never sent to the blocked user.
      await mutationBus?.publish({
        userId: user.id,
        event: serverEvent.blocksUpdated({ userId, blocked: true }),
      });

      return reply.status(201).send({ block });
    },
  );

  server.delete(
    "/users/me/blocks/:userId",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { userId } = parseWith(targetParamsSchema, request.params);

      const removed = await server.repos.userBlocks.unblock(user.id, userId);
      if (!removed) throw new ApiError(404, "NOT_FOUND", "That user is not blocked.");

      // Same resync signal in reverse: the gateway re-derives the set (the user is
      // no longer filtered) and my clients refetch so the previously hidden
      // history reappears. Unblocking does NOT restore the friendship — that is a
      // fresh, consent-requiring friend request.
      await mutationBus?.publish({
        userId: user.id,
        event: serverEvent.blocksUpdated({ userId, blocked: false }),
      });

      return reply.status(204).send();
    },
  );
}
