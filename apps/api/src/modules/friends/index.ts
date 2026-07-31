import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RealtimeMutationPublisher } from "@demli/db";
import type { OfflineNotifier } from "@demli/notifications";
import { friendUsernameField, serverEvent } from "@demli/protocol";
import type { User } from "@demli/types";
import { ApiError, parseWith } from "../../errors.js";
import { assertNotBlocked } from "../../lib/blocks.js";
import { requireUser } from "../../plugins/auth.js";
import { LIST_LIMIT, userRateLimit } from "../../lib/rate-limit.js";

/**
 * Friendship endpoints (ADR 0010 §2). One row per unordered pair lives in
 * `friendships`; the repo owns canonical ordering, the reverse-pending
 * auto-accept, and the addressee-only accept guard, so these handlers never
 * reason about pair ordering — they map repo outcomes to status codes and fan
 * the four user-scoped social events out through the mutation bus (§4).
 *
 * Route param note (W1b): `friendships` has NO surrogate id — its PK is the
 * pair. The plan's `/friends/requests/:id` param is therefore the OTHER user's
 * id, not a request id. Every request/friend route keys on a user id.
 *
 * Events are best-effort (the DB row is the source of truth); a failed publish
 * never fails the HTTP request — the publisher swallows and logs.
 */

const otherUserParamsSchema = z.object({
  id: z.string().uuid("Invalid user id."),
});

const unfriendParamsSchema = z.object({
  userId: z.string().uuid("Invalid user id."),
});

const requestsQuerySchema = z.object({
  direction: z.enum(["incoming", "outgoing"]),
});

/**
 * Send body: EXACTLY one of `friendCode` or `userId` (from a member list /
 * profile).
 *
 * @deprecated The `friendCode` path is retained ONLY so pre-#111 clients keep
 * working for a release or two. Friend codes are being removed (founder
 * directive #111) in favour of add-by-username — new clients call
 * `POST /friends/requests/by-username` (see {@link sendByUsernameSchema}). Do
 * not build new features on `friendCode`; the `userId` path stays first-class.
 */
const sendRequestSchema = z
  .object({
    friendCode: z.string().trim().min(1).max(64).optional(),
    userId: z.string().uuid("Invalid user id.").optional(),
  })
  .refine((b) => (b.friendCode === undefined) !== (b.userId === undefined), {
    message: "Provide exactly one of friendCode or userId.",
  });

/**
 * Add-by-username WIRE envelope (#111). Deliberately looser than the username
 * rule: any non-empty ≤64-char string parses here, and the real rule
 * ({@link friendUsernameField}, shared with the desktop form) is applied
 * afterwards inside the handler.
 *
 * The split exists so the wire contract does not move under clients that are
 * already installed. A shipped client that posts 40 characters gets today's
 * "that is not a user" answer rather than a shape error for a body the server
 * used to accept — and the user still sees a message that names their mistake,
 * because a value that cannot satisfy the username rule cannot match an account
 * and therefore resolves to USER_NOT_FOUND.
 */
const sendByUsernameSchema = z.object({
  username: z.string().trim().min(1).max(64),
});

/**
 * Shared friend-request-creation core, reused by EVERY entry point (add by
 * userId, by friend code, and by username). Runs the idempotent + consent-aware
 * repo `send` primitive and fans out the SAME realtime event + offline push:
 *
 * - `created`       → `friend.request_received` + a "sent you a friend request"
 *                     push to the addressee.
 * - `auto_accepted` → the addressee had already asked me, so we are now friends
 *                     → `friend.request_accepted` + an "accepted" push to them.
 * - `self` / `already_pending` / `already_friends` → no fan-out (no-op).
 *
 * Events/pushes are best-effort — the DB row is the source of truth, so a failed
 * publish/notify never fails the request (both swallow). Returns the raw repo
 * outcome so each caller can map it to a status code: the by-code/by-userId path
 * surfaces distinct codes, while the by-username path collapses every outcome it
 * reaches into one 200 — it discloses whether the USER exists (founder directive,
 * 2026-07-28) but never the state of a relationship (§28; see that route).
 */
async function createFriendRequest(
  server: FastifyInstance,
  mutationBus: RealtimeMutationPublisher | undefined,
  notifier: OfflineNotifier | undefined,
  requester: User,
  addresseeId: string,
) {
  const result = await server.repos.friendships.send(requester.id, addresseeId);
  if (result.outcome === "created" && result.friendship) {
    await mutationBus?.publish({
      userId: addresseeId,
      event: serverEvent.friendRequestReceived({
        request: result.friendship,
        requester,
      }),
    });
    await notifier?.notify([addresseeId], {
      title: requester.displayName,
      body: "sent you a friend request.",
      data: { type: "friend_request", userId: requester.id },
    });
  } else if (result.outcome === "auto_accepted" && result.friendship) {
    await mutationBus?.publish({
      userId: addresseeId,
      event: serverEvent.friendRequestAccepted({
        friendship: result.friendship,
        friend: requester,
      }),
    });
    await notifier?.notify([addresseeId], {
      title: requester.displayName,
      body: "accepted your friend request.",
      data: { type: "friend", userId: requester.id },
    });
  }
  return result;
}

export async function registerFriendsModule(
  server: FastifyInstance,
  mutationBus?: RealtimeMutationPublisher,
  notifier?: OfflineNotifier,
): Promise<void> {
  // Accepted friends, each with the other user's record. Presence is NOT read
  // here — it lives in the realtime layer; the client merges live
  // `presence.updated` events (accepted friends are now in the presence
  // audience, ADR 0010 §4 / W3). This is the roster source of truth.
  server.get(
    "/friends",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit(LIST_LIMIT) },
    },
    async (request) => {
      const user = requireUser(request);
      return { friends: await server.repos.friendships.listFriends(user.id) };
    },
  );

  // Pending requests, filtered by direction: `incoming` = someone asked me (I
  // may accept), `outgoing` = I asked someone. Embedded user is the OTHER party.
  server.get(
    "/friends/requests",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit(LIST_LIMIT) },
    },
    async (request) => {
      const user = requireUser(request);
      const { direction } = parseWith(requestsQuerySchema, request.query);
      return {
        requests: await server.repos.friendships.listRequests(user.id, direction),
      };
    },
  );

  // Send a friend request by user id or (DEPRECATED, #111) friend code.
  // Idempotent + consent-aware (the repo resolves duplicates and reverse-pending
  // auto-accept). Rate-limited to curb request spam and friend-code guessing
  // (§28 / ADR 0010 §6). New clients use `/friends/requests/by-username` below;
  // this route stays for older clients until the friend-code path is retired.
  server.post(
    "/friends/requests",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 10, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const body = parseWith(sendRequestSchema, request.body);

      // Resolve the addressee. Unknown code / unknown id both answer a generic
      // NOT_FOUND — a correct code guess yields only a pending request the
      // target must accept, so existence is not a meaningful leak (ADR 0010 §6).
      const target =
        body.userId !== undefined
          ? await server.repos.users.findById(body.userId)
          : await server.repos.users.findByFriendCode(body.friendCode ?? "");
      if (!target) {
        const message =
          body.userId !== undefined ? "User not found." : "No user found for that friend code.";
        throw new ApiError(404, "NOT_FOUND", message);
      }

      // Block gate (M18, ADR 0017): a block in EITHER direction refuses the
      // request. Same 403 both ways — the requester never learns which side
      // blocked (§28). Checked BEFORE the write so no row and no event is created.
      await assertNotBlocked(server, user.id, target.id);

      const result = await createFriendRequest(server, mutationBus, notifier, user, target.id);
      switch (result.outcome) {
        case "self":
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            "You cannot send a friend request to yourself.",
          );
        case "already_pending":
          throw new ApiError(
            409,
            "CONFLICT",
            "You already have a pending request to this user.",
          );
        case "already_friends":
          throw new ApiError(409, "CONFLICT", "You are already friends with this user.");
        case "created":
          return reply.status(201).send({ friendship: result.friendship, outcome: result.outcome });
        case "auto_accepted":
          return reply.status(200).send({ friendship: result.friendship, outcome: result.outcome });
      }
    },
  );

  // Send a friend request BY USERNAME (#111 — the friend-code replacement).
  //
  // ENUMERATION POSTURE (§28) — this REVERSES the route's original design, and
  // the reasoning matters, so read it before "restoring" the uniform response:
  //
  // This route used to answer a single `200 { ok: true }` whether or not the
  // username existed, so it could not be used to probe which usernames are
  // registered. The cost of that was paid by every ordinary user who mistyped a
  // handle: they were told "sent — if that user exists", and then waited for a
  // request that was never going to arrive. With real users on the product that
  // stopped being a theoretical trade and became the support load it was always
  // going to be (founder directive, 2026-07-28). The thing the silence was
  // "protecting" is a PUBLIC handle — visible on every message, member list and
  // mention the moment you share one server — so the enumeration it guarded
  // against was already free to anyone who wanted it, paid for by everyone else.
  //
  // So the route now discloses non-existence via 404 USER_NOT_FOUND, and the
  // RATE LIMIT below is no longer a secondary control — it is the primary and
  // ONLY enumeration control. Do not remove it, do not raise `max`, and do not
  // shorten `timeWindow`: at 10 attempts per session per 5 minutes, a scraper
  // needs its own authenticated session and ~35 hours to test 5,000 guesses.
  // Anything that touches those numbers has to justify itself against that.
  //
  // What is deliberately NOT disclosed, so the surface stays exactly as leaky as
  // "this username exists" and no leakier:
  //   - `already_pending` / `already_friends` stay no-ops inside the shared core
  //     and answer the same 200 as a fresh send, so the route never reports the
  //     state of a relationship the caller has not been let into.
  //   - a SOFT-DELETED account answers USER_NOT_FOUND, the same as an unknown
  //     handle, because it genuinely is not reachable by username any more.
  //   - a BLOCK answers 403 BLOCKED, the same neutral code and copy as every
  //     other blocked interaction (`assertNotBlocked`). ADR 0017's rule is that a
  //     block never reveals WHO blocked WHOM — not that it must impersonate a
  //     missing account. Hiding it behind USER_NOT_FOUND is worse: to anyone who
  //     already knows the handle exists, a 404 for it reads as "they blocked me",
  //     which is the very disclosure the collapse was meant to avoid.
  //
  // Adding yourself stays its own 400: it concerns only the caller's own
  // account, so it leaks nothing about anyone else.
  server.post(
    "/friends/requests/by-username",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 10, timeWindow: "5 minutes" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { username } = parseWith(sendByUsernameSchema, request.body);

      // The real username rule, shared verbatim with the add-friend form
      // (`friendUsernameField` normalizes: strips a leading "@", trims,
      // lowercases). A value that fails it cannot match any stored account —
      // register, rename and the Google-derived path all produce `[a-z0-9_]{3,32}`
      // names — so it collapses into the same USER_NOT_FOUND as an unknown handle
      // instead of a shape error the user cannot interpret.
      const parsed = friendUsernameField.safeParse(username);
      const target = parsed.success
        ? await server.repos.users.findByUsername(parsed.data)
        : null;

      // Self-add first: it is about the caller, not the target, and it must not
      // be reported as "no such user" when the account plainly exists.
      if (target && target.id === user.id) {
        throw new ApiError(
          400,
          "VALIDATION_ERROR",
          "You cannot send a friend request to yourself.",
        );
      }

      // A SOFT-DELETED (frozen/purged) account (M15) is genuinely not reachable
      // by username, so it answers the same 404 as an unknown handle.
      if (!target || target.deletedAt) {
        throw new ApiError(404, "USER_NOT_FOUND", "No user with that username.");
      }

      // A BLOCK answers 403 BLOCKED — the same neutral, direction-free code and
      // copy every other blocked interaction uses (`assertNotBlocked`: DM send,
      // group-DM add, invite redeem). ADR 0017's rule is that a block does not
      // reveal WHO blocked WHOM, not that it pretends the account is gone.
      //
      // Folding a block into USER_NOT_FOUND was tried and is worse, precisely
      // backwards from how it reads: it is only indistinguishable from "no such
      // user" to someone who does not already know the account exists. Anyone who
      // does — and you generally block people you have interacted with — reads a
      // 404 for a handle they have seen as "they blocked me". Answering the same
      // BLOCKED as everywhere else leaks strictly less, because it says nothing a
      // DM attempt would not have said a moment later.
      await assertNotBlocked(server, user.id, target.id);

      // Fan out through the SHARED core so the realtime event + offline push fire
      // exactly as for the userId/friend-code paths. The outcome is intentionally
      // ignored: `created`, `auto_accepted`, `already_pending` and
      // `already_friends` all answer the same 200, so an existing relationship is
      // never reported back.
      await createFriendRequest(server, mutationBus, notifier, user, target.id);

      return reply.status(200).send({ ok: true });
    },
  );

  // Accept an incoming request. `:id` is the requester's user id. Only the
  // ADDRESSEE may accept (the repo rejects a requester accepting their own).
  server.post(
    "/friends/requests/:id/accept",
    {
      preHandler: [server.authenticate],
      config: {
        // An accept writes the friendship AND pushes `friend.request_accepted`
        // plus a presence exchange to both sides. Nobody accepts more than a
        // handful at a time; 30/min is abuse headroom only.
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { id: otherUserId } = parseWith(otherUserParamsSchema, request.params);

      // Block gate (M18): a request that predates the block must not be
      // acceptable into a friendship. Blocking already deletes the pending row,
      // so this is the belt-and-braces guard for a racing accept.
      await assertNotBlocked(server, user.id, otherUserId);

      const result = await server.repos.friendships.accept(user.id, otherUserId);
      if (!result.ok) {
        switch (result.reason) {
          case "not_found":
            throw new ApiError(404, "NOT_FOUND", "Friend request not found.");
          case "not_pending":
            throw new ApiError(409, "CONFLICT", "This request is no longer pending.");
          case "not_addressee":
            throw new ApiError(
              403,
              "FORBIDDEN",
              "Only the person who received the request can accept it.",
            );
        }
      }

      // Notify the requester (the other user) that I accepted; `friend` is me.
      await mutationBus?.publish({
        userId: otherUserId,
        event: serverEvent.friendRequestAccepted({
          friendship: result.friendship,
          friend: user,
        }),
      });
      // Mobile push when the requester is offline (GAP 1). Mirrors the request-
      // sent push: the WS event above covers the online (in-app) case, this
      // reaches an offline requester. Best-effort + offline-gated (the notifier
      // swallows), so a push failure never fails this accept. `type: "friend"`
      // routes the tap to the friends screen (mobile notification-target contract).
      await notifier?.notify([otherUserId], {
        title: user.displayName,
        body: "accepted your friend request.",
        data: { type: "friend", userId: user.id },
      });
      return { friendship: result.friendship };
    },
  );

  // Decline (I am the addressee) or cancel (I am the requester) a pending
  // request. Both collapse to the same delete primitive; `:id` is the other
  // user's id. The other party is told to drop me from their pending list.
  server.delete(
    "/friends/requests/:id",
    {
      preHandler: [server.authenticate],
      config: {
        // Same budget as accept: decline/cancel also notifies the other party,
        // so it must not be the cheap way to spam someone's client.
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { id: otherUserId } = parseWith(otherUserParamsSchema, request.params);

      const removed = await server.repos.friendships.remove(user.id, otherUserId);
      if (!removed) throw new ApiError(404, "NOT_FOUND", "Friend request not found.");

      // `friend.removed` covers decline/cancel/unfriend. The payload carries MY
      // id so the recipient knows whom to remove from their list.
      await mutationBus?.publish({
        userId: otherUserId,
        event: serverEvent.friendRemoved({ userId: user.id }),
      });
      return reply.status(204).send();
    },
  );

  // Unfriend: remove an accepted friendship. `:userId` is the friend's id.
  server.delete(
    "/friends/:userId",
    {
      preHandler: [server.authenticate],
      config: {
        // Unfriend emits `friend.removed` to the other side; without a limit an
        // add/remove loop is a notification-spam channel. 30/min is unreachable
        // by hand.
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { userId: otherUserId } = parseWith(unfriendParamsSchema, request.params);

      const removed = await server.repos.friendships.remove(user.id, otherUserId);
      if (!removed) throw new ApiError(404, "NOT_FOUND", "Friend not found.");

      await mutationBus?.publish({
        userId: otherUserId,
        event: serverEvent.friendRemoved({ userId: user.id }),
      });
      return reply.status(204).send();
    },
  );
}
