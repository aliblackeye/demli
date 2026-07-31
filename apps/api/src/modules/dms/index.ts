import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RealtimeMutationPublisher } from "@demli/db";
import { serverEvent } from "@demli/protocol";
import { ApiError, parseWith } from "../../errors.js";
import { assertNotBlocked } from "../../lib/blocks.js";
import { requireUser } from "../../plugins/auth.js";
import { LIST_LIMIT, userRateLimit } from "../../lib/rate-limit.js";

/**
 * Direct-message endpoints (ADR 0010 §1). A DM is a `friend_groups` row with
 * `kind='dm'`, exactly two members, owning one hidden stream channel — so its
 * messages reuse the `/channels/:streamId/messages` pipeline unchanged (there
 * are NO message routes here). `dmsRepo` owns the `dm_key` uniqueness and the
 * hide-for-self semantics; these handlers add the friendship precondition, the
 * caller re-open, and the `dm.created` fan-out.
 *
 * The `Dm.participant` DTO field is always the OTHER member relative to the
 * reader, so `dm.created` is built PER recipient (`findById(dmId, recipientId)`)
 * — never once (W1b handoff). Events are best-effort (§4).
 */

const openDmSchema = z.object({
  userId: z.string().uuid("Invalid user id."),
});

const dmParamsSchema = z.object({
  id: z.string().uuid("Invalid DM id."),
});

/** Max preview length attached to each DM (a one-line list preview, not the body). */
const DM_PREVIEW_MAX = 200;

export async function registerDmsModule(
  server: FastifyInstance,
  mutationBus?: RealtimeMutationPublisher,
): Promise<void> {
  // Every DM the caller has open (`hidden_at IS NULL`), newest first, the other
  // participant resolved. A hidden DM is absent here but untouched for its
  // counterpart.
  server.get(
    "/dms",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit(LIST_LIMIT) },
    },
    async (request) => {
      const user = requireUser(request);
      const dms = await server.repos.dms.listForUser(user.id);

      // Attach a one-line last-message preview per DM for the mobile Home list
      // (each DM row shows its latest line). One `limit:1` lookup per DM — the DM list is a
      // short, friend-scoped set, so this stays cheap; a system token (`@sys:*`,
      // e.g. a DM-call outcome) is passed through untouched for the client to
      // localize. `listPage` is newest-first and skips soft-deleted rows, so
      // `items[0]` is the latest visible message (null when the DM has none).
      const enriched = await Promise.all(
        dms.map(async (dm) => {
          const { items } = await server.repos.messages.listPage({
            channelId: dm.streamId,
            limit: 1,
          });
          const last = items[0];
          return {
            ...dm,
            lastMessagePreview: last
              ? {
                  content: last.content.slice(0, DM_PREVIEW_MAX),
                  authorId: last.authorId,
                  kind: last.kind ?? "user",
                  createdAt: last.createdAt,
                }
              : null,
          };
        }),
      );

      return { dms: enriched };
    },
  );

  // Open (idempotently create) the DM with another user. DMs require an
  // ACCEPTED friendship (ADR 0010 §1); a stranger / pending relation is 403.
  // Rate-limited to curb DM-open spam (§28). On CREATE, both members are told
  // via `dm.created`; on re-open of an existing (possibly hidden) DM, the
  // caller's side is un-hidden with no event.
  server.post(
    "/dms",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 20, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { userId: otherId } = parseWith(openDmSchema, request.body);

      if (otherId === user.id) {
        throw new ApiError(400, "VALIDATION_ERROR", "You cannot open a DM with yourself.");
      }

      // Block gate (M18, ADR 0017) BEFORE the friendship read: a block in either
      // direction refuses the open outright. Blocking severs the friendship, so
      // in practice the friendship gate below would also reject — this is the
      // explicit, correctly-worded guard, and it also covers the window where a
      // block lands while a stale client still holds a friendship.
      await assertNotBlocked(server, user.id, otherId);

      // Friendship gate: must be accepted. Pending / none both answer 403 with
      // the same message so a non-friend cannot probe relationship state.
      const friendship = await server.repos.friendships.getFriendshipWith(user.id, otherId);
      if (!friendship || friendship.status !== "accepted") {
        throw new ApiError(403, "FORBIDDEN", "You can only message friends.");
      }

      const { dm, created } = await server.repos.dms.getOrCreate(user.id, otherId);

      // Re-open for the caller: clicking "Message" always re-surfaces the DM in
      // their list (clears any prior hide). No-op when already visible.
      await server.repos.dms.unhide(dm.id, user.id);

      if (created) {
        // Announce to BOTH members, each with a participant-relative DTO. The
        // caller's view is `dm`; the other member's view resolves the caller as
        // their participant.
        await mutationBus?.publish({
          userId: user.id,
          event: serverEvent.dmCreated({ dm }),
        });
        const otherView = await server.repos.dms.findById(dm.id, otherId);
        if (otherView) {
          await mutationBus?.publish({
            userId: otherId,
            event: serverEvent.dmCreated({ dm: otherView }),
          });
        }
        return reply.status(201).send({ dm });
      }

      return reply.status(200).send({ dm });
    },
  );

  // Close a DM for the caller only (hide-for-self). The counterpart's copy and
  // the full history are untouched; a new inbound message or a re-open
  // re-surfaces it. `:id` is the DM's group id; non-members / non-DMs → 404.
  server.delete(
    "/dms/:id",
    {
      preHandler: [server.authenticate],
      config: {
        // Mirrors the DM-open budget above (20/min): closing is the inverse of
        // opening, so it gets the same ceiling and cannot be looped faster.
        rateLimit: userRateLimit({ max: 20, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { id } = parseWith(dmParamsSchema, request.params);

      // Membership + kind gate: findById returns null unless the caller is one
      // of the DM's two members (existence is not leaked, §28).
      const dm = await server.repos.dms.findById(id, user.id);
      if (!dm) throw new ApiError(404, "NOT_FOUND", "DM not found.");

      await server.repos.dms.hide(id, user.id);
      return reply.status(204).send();
    },
  );
}
