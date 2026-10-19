import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { GROUP_NAME_MAX_LENGTH, USERNAME_MAX_LENGTH } from "@demli/config";
import type { RealtimeMutationPublisher } from "@demli/db";
import { serverEvent } from "@demli/protocol";
import { ApiError, parseWith } from "../../errors.js";
import { assertNotBlocked } from "../../lib/blocks.js";
import { evictFromGroupVoice, type VoiceEjector } from "../../lib/voice-eviction.js";
import { requireUser } from "../../plugins/auth.js";
import { LIST_LIMIT, userRateLimit } from "../../lib/rate-limit.js";

/**
 * Flat "group chat" endpoints (ADR 0005). A group is a `friend_groups` row with
 * `kind='group'` owning exactly one hidden stream channel; messages reuse the
 * existing `/channels/:streamId/messages` pipeline unchanged, so there are NO
 * message routes here. All reads/writes go through `repos.groupChats`; ownership
 * and membership are always checked server-side (§28) — never trust the client.
 */

const idParamsSchema = z.object({
  id: z.string().uuid("Invalid group id."),
});

const memberParamsSchema = z.object({
  id: z.string().uuid("Invalid group id."),
  userId: z.string().uuid("Invalid user id."),
});

const createGroupChatSchema = z.object({
  name: z.string().trim().min(1).max(GROUP_NAME_MAX_LENGTH),
});

const addMemberSchema = z.object({
  username: z.string().trim().min(1).max(USERNAME_MAX_LENGTH),
});

/**
 * Group-DM invite-link options (M18). DELIBERATELY the same shape and the same
 * bounds as the server invite body (`modules/invites`): a group-DM link is the
 * SAME `invites` row against a `kind='group'` friend_group, redeemed through the
 * SAME `POST /invites/:code/redeem` endpoint — so one deep link format and one
 * redeem flow serve both, and there is no second invite system to keep in sync.
 */
const createGroupChatInviteSchema = z.object({
  /** Hours until expiry; omit for a non-expiring link. */
  expiresInHours: z.number().int().min(1).max(24 * 30).optional(),
  /** Maximum redemptions; omit for unlimited. */
  maxUses: z.number().int().min(1).max(100).optional(),
});

const inviteParamsSchema = z.object({
  id: z.string().uuid("Invalid group id."),
  inviteId: z.string().uuid("Invalid invite id."),
});

export interface GroupChatsModuleOptions {
  /**
   * SFU admin used to end the media session of a member the owner removed — a
   * group chat upgraded from a DM call runs its voice channel in the call's room
   * (see {@link evictFromGroupVoice}). Null/omitted ⇒ membership-only removal.
   */
  voiceEjector?: VoiceEjector | null;
}

export async function registerGroupChatsModule(
  server: FastifyInstance,
  mutationBus?: RealtimeMutationPublisher,
  options: GroupChatsModuleOptions = {},
): Promise<void> {
  const voiceEjector = options.voiceEjector ?? null;
  // Create a flat group chat; the caller becomes its owner.
  server.post(
    "/group-chats",
    {
      preHandler: [server.authenticate],
      config: {
        // Each create writes a group, a membership and a hidden stream channel,
        // so unlimited it is a cheap way to inflate the database. A person makes
        // a couple of group chats a day; 20/min is abuse headroom only.
        rateLimit: userRateLimit({ max: 20, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const body = parseWith(createGroupChatSchema, request.body);
      const group = await server.repos.groupChats.create({
        name: body.name,
        ownerId: user.id,
      });
      return reply.status(201).send({ group });
    },
  );

  // Every flat group chat the caller belongs to.
  server.get(
    "/group-chats",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit(LIST_LIMIT) },
    },
    async (request) => {
      const user = requireUser(request);
      return { groups: await server.repos.groupChats.listForUser(user.id) };
    },
  );

  // Group details + members. Non-members get 404 (existence is not leaked, §28).
  server.get(
    "/group-chats/:id",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit(LIST_LIMIT) },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = parseWith(idParamsSchema, request.params);

      const membership = await server.repos.groups.getMembership(id, user.id);
      if (!membership) throw new ApiError(404, "NOT_FOUND", "Group not found.");

      const details = await server.repos.groupChats.getDetails(id);
      if (!details) throw new ApiError(404, "NOT_FOUND", "Group not found.");
      return details;
    },
  );

  // Owner adds a member by username.
  server.post(
    "/group-chats/:id/members",
    {
      preHandler: [server.authenticate],
      config: {
        // Adding a member posts a system message and pushes `group_chat.added`
        // to the target — an add/remove loop would be a notification-spam
        // channel aimed at one person. 30/min is far above real use.
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { id } = parseWith(idParamsSchema, request.params);
      const body = parseWith(addMemberSchema, request.body);

      // Must be a real group chat (findById is kind-filtered → null for servers).
      const group = await server.repos.groupChats.findById(id);
      if (!group) throw new ApiError(404, "NOT_FOUND", "Group not found.");

      const membership = await server.repos.groups.getMembership(id, user.id);
      if (!membership) throw new ApiError(404, "NOT_FOUND", "Group not found.");
      if (membership.role !== "owner") {
        throw new ApiError(403, "FORBIDDEN", "Only the group owner can add members.");
      }

      const target = await server.repos.users.findByUsername(body.username);
      if (!target) throw new ApiError(404, "NOT_FOUND", "User not found.");

      // Block gate (M18, ADR 0017): the ADD-BY-USERNAME surface. Refused when a
      // block exists between the adder and the target in either direction — a
      // group DM is a private space, so a block must keep the two out of it.
      await assertNotBlocked(server, user.id, target.id);
      // …and against every EXISTING member: adding someone a current member has
      // blocked would force the pair together through a third party. Sequential
      // over a handful of ids (a flat chat is small by design), so this stays a
      // few indexed lookups, not a scan.
      const existingMembers = await server.repos.groupChats.getDetails(id);
      for (const member of existingMembers?.members ?? []) {
        if (member.userId === user.id || member.userId === target.id) continue;
        await assertNotBlocked(server, member.userId, target.id);
      }

      const already = await server.repos.groups.getMembership(id, target.id);
      if (already) {
        throw new ApiError(409, "CONFLICT", "This user is already a member.");
      }

      const added = await server.repos.groupChats.addMember(id, target.id);

      // Fan-out to the ADDED member so the group appears in their list (and a
      // notification fires) the instant they are added — the group-chat twin of
      // `dm.created` (ADR 0010 §4).
      //
      // USER-scoped, and it stays that way for a reason that is no longer the
      // one this comment used to give. It used to say a group-scoped event
      // "would reach nobody" because the gateway indexed connections with
      // `groups.listForUser`, which is server-only. That is no longer true: the
      // gateway now indexes membership with `groups.listMemberGroupIds`, which
      // covers servers, flat group chats AND dms, so a group-scoped event here
      // WOULD be delivered. The reason this must remain user-scoped is the
      // opposite one — the new member is not yet subscribed at the moment they
      // are added, and the user-scoped path is what reaches them through
      // `connectionsByUser` and subscribes their live connections to
      // `group.streamId` so messages flow with no reconnect.
      // Best-effort (§4): a failed publish never fails the HTTP add — the member
      // still self-heals on their next reconnect/refetch (seq-gap fallback).
      await mutationBus?.publish({
        userId: target.id,
        event: serverEvent.groupChatAdded({ group }),
      });

      // Strip the auth-only password hash; return the public member DTO.
      const { passwordHash: _passwordHash, ...publicUser } = target;
      return reply.status(201).send({ member: { ...added, user: publicUser } });
    },
  );

  // --- Group-DM invite links (M18) ----------------------------------------
  //
  // A group DM had no shareable link: the only way in was the owner typing your
  // username. These three routes give it the same link flow servers have, reusing
  // the SAME `invites` table and the SAME `POST /invites/:code/redeem` endpoint
  // (which branches on the group's kind) — one deep-link format, one redeem path,
  // no second invite system.
  //
  // Authority: ANY member may create a link (a flat chat has no roles and no
  // invite policy — those are server concepts), but only the OWNER may revoke
  // one, mirroring "only the owner adds members". Expiry/use-cap bounds are
  // identical to server invites.
  server.post(
    "/group-chats/:id/invites",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 hour" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { id } = parseWith(idParamsSchema, request.params);
      const body = parseWith(createGroupChatInviteSchema, request.body ?? {});

      // kind-filtered → null for servers AND dms: a DM is a fixed pair and can
      // never be joined by link, so it must not mint one.
      const group = await server.repos.groupChats.findById(id);
      if (!group) throw new ApiError(404, "NOT_FOUND", "Group not found.");
      const membership = await server.repos.groups.getMembership(id, user.id);
      if (!membership) throw new ApiError(404, "NOT_FOUND", "Group not found.");

      const invite = await server.repos.invites.create({
        groupId: id,
        createdBy: user.id,
        expiresAt: body.expiresInHours
          ? new Date(Date.now() + body.expiresInHours * 60 * 60 * 1000)
          : null,
        maxUses: body.maxUses ?? null,
      });
      return reply.status(201).send({ invite });
    },
  );

  server.get(
    "/group-chats/:id/invites",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit(LIST_LIMIT) },
    },
    async (request) => {
      const user = requireUser(request);
      const { id } = parseWith(idParamsSchema, request.params);

      const group = await server.repos.groupChats.findById(id);
      if (!group) throw new ApiError(404, "NOT_FOUND", "Group not found.");
      const membership = await server.repos.groups.getMembership(id, user.id);
      if (!membership) throw new ApiError(404, "NOT_FOUND", "Group not found.");

      return { invites: await server.repos.invites.listForGroup(id) };
    },
  );

  server.delete(
    "/group-chats/:id/invites/:inviteId",
    {
      preHandler: [server.authenticate],
      config: {
        // Pairs with the invite-create limit already on this module so revoke
        // cannot be looped faster than create.
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { id, inviteId } = parseWith(inviteParamsSchema, request.params);

      const group = await server.repos.groupChats.findById(id);
      if (!group) throw new ApiError(404, "NOT_FOUND", "Group not found.");
      const membership = await server.repos.groups.getMembership(id, user.id);
      if (!membership) throw new ApiError(404, "NOT_FOUND", "Group not found.");
      if (membership.role !== "owner") {
        throw new ApiError(403, "FORBIDDEN", "Only the group owner can revoke invites.");
      }

      const revoked = await server.repos.invites.revoke(inviteId, id);
      if (!revoked) throw new ApiError(404, "NOT_FOUND", "Invite not found.");
      return reply.status(204).send();
    },
  );

  // Remove a member: the owner may remove any member; a member may remove only
  // themselves. The owner may only leave when they are the last member (which
  // auto-deletes the group); while others remain they must delete it instead.
  server.delete(
    "/group-chats/:id/members/:userId",
    {
      preHandler: [server.authenticate],
      config: {
        // Same budget as the add above — removal also posts a system message and
        // broadcasts, so the add/remove pair is bounded symmetrically.
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { id, userId } = parseWith(memberParamsSchema, request.params);

      // kind-filtered → null for servers AND dms, so DMs are exempt from this
      // leave/auto-delete path (ADR 0010: a DM is hidden, never deleted).
      const group = await server.repos.groupChats.findById(id);
      if (!group) throw new ApiError(404, "NOT_FOUND", "Group not found.");

      const membership = await server.repos.groups.getMembership(id, user.id);
      if (!membership) throw new ApiError(404, "NOT_FOUND", "Group not found.");

      const isSelf = userId === user.id;
      if (userId === group.ownerId) {
        if (!isSelf) {
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            "The group owner cannot be removed. Delete the group instead.",
          );
        }
        if ((await server.repos.groups.countMembers(id)) > 1) {
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            "The group owner can't leave while other members remain. Delete the group instead.",
          );
        }
      } else if (membership.role !== "owner" && !isSelf) {
        throw new ApiError(403, "FORBIDDEN", "You can only remove yourself.");
      }

      const { removed, groupDeleted } =
        await server.repos.groups.removeMemberAndPruneIfEmpty(id, userId);
      if (!removed) throw new ApiError(404, "NOT_FOUND", "Member not found.");

      if (!isSelf && !groupDeleted) {
        await evictFromGroupVoice(server, { ejector: voiceEjector, mutationBus, log: request.log }, {
          groupId: id,
          userId,
        });
      }

      // Lifecycle events: group.deleted when the last member left (the group and
      // its hidden stream channel are gone), otherwise member.left so the gateway
      // drops the leaver's subscription to the stream and the roster refreshes.
      await mutationBus?.publish(
        groupDeleted
          ? { groupId: id, event: serverEvent.groupDeleted({ groupId: id }) }
          : { groupId: id, event: serverEvent.memberLeft({ groupId: id, userId }) },
      );

      return reply.status(204).send();
    },
  );

  // Delete a flat group chat and everything it owns (its hidden stream channel,
  // messages, memberships cascade). Owner-only; group-kind only (dms are hidden,
  // never deleted — ADR 0010).
  server.delete(
    "/group-chats/:id",
    {
      preHandler: [server.authenticate],
      config: {
        // Cascades over the hidden channel, every message and every membership.
        // Matched to the create budget: you cannot delete more than you can make.
        rateLimit: userRateLimit({ max: 20, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { id } = parseWith(idParamsSchema, request.params);

      const group = await server.repos.groupChats.findById(id);
      if (!group) throw new ApiError(404, "NOT_FOUND", "Group not found.");

      const membership = await server.repos.groups.getMembership(id, user.id);
      if (!membership) throw new ApiError(404, "NOT_FOUND", "Group not found.");
      if (membership.role !== "owner") {
        throw new ApiError(403, "FORBIDDEN", "Only the group owner can delete this group.");
      }

      await server.repos.groups.delete(id);

      await mutationBus?.publish({
        groupId: id,
        event: serverEvent.groupDeleted({ groupId: id }),
      });

      return reply.status(204).send();
    },
  );
}
