/**
 * Ignoring a user (migration 0020, ADR 0019 §4) — the SOFT counterpart to
 * blocking.
 *
 * Routes:
 *   GET    /users/me/ignores            everyone I ignore (newest first)
 *   PUT    /users/me/ignores/:userId    ignore (idempotent)
 *   DELETE /users/me/ignores/:userId    stop ignoring (404 if not ignored)
 *
 * **What an ignore is NOT.** Deliberately compare this module to `modules/blocks`,
 * because almost every line differs and each difference is a decision:
 *
 *  - A block SEVERS THE FRIENDSHIP. An ignore does not touch it — you can ignore
 *    a friend through a noisy week and still be friends afterwards, which is the
 *    entire reason to have a softer tool.
 *  - A block REFUSES SENDS with a 403 in both directions. An ignore refuses
 *    nothing: the ignored user's messages send, persist and deliver exactly as
 *    before, and nothing in the write path consults these rows.
 *  - A block HIDES HISTORY SERVER-SIDE. An ignore does not — see below.
 *  - A block is SYMMETRIC. An ignore is one-directional: it describes the
 *    ignorer's attention, not a relationship.
 *  - A block is DETECTABLE (the other side's sends start failing). An ignore is
 *    SILENT — no event, no error, no flag on any profile the target can read. An
 *    ignore the target can notice would just be a rude block.
 *
 * **Where an ignore actually bites, and why it splits across the wire.**
 *
 *  - NOTIFICATIONS (push + the in-app mention ping) are filtered SERVER-SIDE, in
 *    `dispatchChannelMessagePush`. They have to be: a push is delivered by the
 *    server to a device's OS, so a client cannot suppress a notification it never
 *    gets to see. This is the half that makes the feature felt.
 *  - MESSAGE CONTENT is collapsed CLIENT-SIDE. This is the deliberate departure
 *    from ADR 0017, and it is a threat-model difference rather than an
 *    inconsistency. A block promises "this person cannot reach me", which is a
 *    security property — so delivering their text at all is the leak, and §3 of
 *    that ADR filters it in SQL. An ignore promises "do not put this person in
 *    front of me right now", which is about attention. The user explicitly wants
 *    the option to expand a collapsed row and read it, replies that quote the
 *    ignored user must still render in context, and un-ignoring should restore
 *    the conversation instantly rather than forcing a refetch of history the
 *    server refused to send. Server-side hiding would break all three to defend
 *    against a threat that is not present: the ignorer is the one who chose this,
 *    and they are not hiding the content from themselves.
 *
 * Realtime: `user.ignores_updated`, USER-scoped to the ignorer's own devices — a
 * thin resync signal mirroring `user.blocks_updated`. The ignored user's
 * connections receive NOTHING.
 */

import type { FastifyInstance } from "fastify";
import type { RealtimeMutationPublisher } from "@demli/db";
import { serverEvent, targetUserParamsSchema } from "@demli/protocol";
import { ApiError, parseWith } from "../../errors.js";
import { requireUser } from "../../plugins/auth.js";
import { LIST_LIMIT, userRateLimit } from "../../lib/rate-limit.js";

/** Same budget as the block mutations — an identical shape of write. */
const IGNORE_RATE_LIMIT = userRateLimit({ max: 30, timeWindow: "1 minute" });

export async function registerIgnoresModule(
  server: FastifyInstance,
  mutationBus?: RealtimeMutationPublisher,
): Promise<void> {
  // Everyone I ignore, for the settings list AND for the client's local collapse
  // set. Deliberately NOT "who ignores me" — that is never queryable, by anyone,
  // which is what keeps an ignore silent (§28, and the repo has no such method).
  server.get(
    "/users/me/ignores",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit(LIST_LIMIT) },
    },
    async (request) => {
      const user = requireUser(request);
      return { ignores: await server.repos.userIgnores.listIgnored(user.id) };
    },
  );

  server.put(
    "/users/me/ignores/:userId",
    { preHandler: [server.authenticate], config: { rateLimit: IGNORE_RATE_LIMIT } },
    async (request, reply) => {
      const user = requireUser(request);
      const { userId } = parseWith(targetUserParamsSchema, request.params);

      if (userId === user.id) {
        throw new ApiError(400, "VALIDATION_ERROR", "You cannot ignore yourself.");
      }
      const target = await server.repos.users.findById(userId);
      if (!target) throw new ApiError(404, "NOT_FOUND", "User not found.");

      const ignore = await server.repos.userIgnores.ignore(user.id, userId);
      if (!ignore) throw new ApiError(400, "VALIDATION_ERROR", "You cannot ignore yourself.");

      // Note what is NOT here, compared to the block route: no `friendships
      // .remove`, no `friend.removed` to the other side, no notification of any
      // kind leaving for the ignored user. The ONLY publish is to my own devices.
      await mutationBus?.publish({
        userId: user.id,
        event: serverEvent.ignoresUpdated({ userId, ignored: true }),
      });

      return reply.status(201).send({ ignore });
    },
  );

  server.delete(
    "/users/me/ignores/:userId",
    { preHandler: [server.authenticate], config: { rateLimit: IGNORE_RATE_LIMIT } },
    async (request, reply) => {
      const user = requireUser(request);
      const { userId } = parseWith(targetUserParamsSchema, request.params);

      const removed = await server.repos.userIgnores.unignore(user.id, userId);
      if (!removed) throw new ApiError(404, "NOT_FOUND", "That user is not ignored.");

      // Same resync in reverse. Nothing was hidden server-side, so there is no
      // history to restore — the client simply stops collapsing those rows.
      await mutationBus?.publish({
        userId: user.id,
        event: serverEvent.ignoresUpdated({ userId, ignored: false }),
      });

      return reply.status(204).send();
    },
  );
}
