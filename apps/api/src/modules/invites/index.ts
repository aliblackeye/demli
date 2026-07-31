import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { PublicOnlineCounter, RealtimeMutationPublisher } from "@demli/db";
import { serverEvent } from "@demli/protocol";
import { PERMISSIONS, type InvitePreview } from "@demli/types";
import { ApiError, parseWith } from "../../errors.js";
import { postMembershipSystemMessage } from "../../lib/system-messages.js";
import { requirePerm } from "../../lib/permissions.js";
import { requireUser } from "../../plugins/auth.js";
import { userRateLimit } from "../../lib/rate-limit.js";

const groupParamsSchema = z.object({
  groupId: z.string().uuid("Invalid group id."),
});

const createInviteSchema = z.object({
  /** Hours until expiry; omit for a non-expiring invite. */
  expiresInHours: z.number().int().min(1).max(24 * 30).optional(),
  /** Maximum redemptions; omit for unlimited. */
  maxUses: z.number().int().min(1).max(100).optional(),
  /**
   * Channel this invite lands the joiner on (migration 0021); omit for a plain
   * server invite — which is exactly what every pre-0021 caller sends, so the
   * whole feature is opt-in and backward compatible.
   *
   * Mirrors `createServerInviteBodySchema` in @demli/protocol (the form-side
   * copy); the group-chat invite body deliberately does NOT gain this field.
   */
  targetChannelId: z.string().uuid("Invalid channel id.").optional(),
});

const redeemParamsSchema = z.object({
  code: z.string().trim().min(4).max(64),
});

export interface InvitesModuleOptions {
  /**
   * Presence read seam for the preview card's online count (the gateway writes
   * presence to Redis; the API reads the same keys). Absent — tests without
   * Redis, or a deployment without the shared client — ⇒ `onlineCount: null`:
   * the card hides the line instead of showing a made-up number.
   */
  presence?: PublicOnlineCounter;
}

export async function registerInvitesModule(
  server: FastifyInstance,
  mutationBus?: RealtimeMutationPublisher,
  options: InvitesModuleOptions = {},
): Promise<void> {
  server.post(
    "/groups/:groupId/invites",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 hour" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { groupId } = parseWith(groupParamsSchema, request.params);
      const body = parseWith(createInviteSchema, request.body ?? {});

      const membership = await server.repos.groups.getMembership(groupId, user.id);
      if (!membership) throw new ApiError(404, "NOT_FOUND", "Group not found.");
      if (membership.role === "guest") {
        throw new ApiError(403, "FORBIDDEN", "Guests cannot create invites.");
      }

      // Invite policy (M9). "members" (default): any non-guest member creates
      // invites (unchanged). "roles": only the owner or CREATE_INVITE holders.
      const group = await server.repos.groups.findById(groupId);
      if (!group) throw new ApiError(404, "NOT_FOUND", "Group not found.");
      if ((group.invitePolicy ?? "members") === "roles") {
        await requirePerm(
          server,
          groupId,
          membership.role,
          user.id,
          PERMISSIONS.CREATE_INVITE,
          "You do not have permission to create invites for this server.",
        );
      }

      // Channel target (migration 0021). Two independent conditions, ONE answer:
      //
      //  1. the channel must belong to THIS group — an id from another server can
      //     never be smuggled in as a destination;
      //  2. the creator must be able to SEE it (ADR 0007) — you cannot mint an
      //     invite into a role-restricted channel you have no access to, which
      //     would otherwise be a way to hand out a door you were never given.
      //
      // Both refuse with the same 400 and the same message on purpose: the
      // response must not become an oracle that distinguishes "no such channel
      // here" from "restricted, and you are not in it" (§28) — a restricted
      // channel never leaks its existence, exactly as `loadVisibleChannel` does
      // for every other channel-scoped route.
      let targetChannelId: string | null = null;
      if (body.targetChannelId) {
        const channel = await server.repos.channels.findById(body.targetChannelId);
        const visible =
          channel?.groupId === groupId &&
          (await server.repos.channelAccess.canUserSeeChannel(
            groupId,
            body.targetChannelId,
            user.id,
          ));
        if (!visible) {
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            "That channel is not part of this server.",
          );
        }
        targetChannelId = body.targetChannelId;
      }

      const invite = await server.repos.invites.create({
        groupId,
        createdBy: user.id,
        expiresAt: body.expiresInHours
          ? new Date(Date.now() + body.expiresInHours * 60 * 60 * 1000)
          : null,
        maxUses: body.maxUses ?? null,
        targetChannelId,
      });
      return reply.status(201).send({ invite });
    },
  );

  // Invite embed card (M17 link previews × invites): a link pasted into chat
  // renders server icon/name/member/online counts + a join button WITHOUT
  // consuming the invite — strictly read-only, `use_count` never moves.
  // Refusal codes are IDENTICAL to redeem (NOT_FOUND / INVITE_EXPIRED /
  // INVITE_EXHAUSTED / GROUP_BANNED) so the client needs one error map, and the
  // rate limit matches redeem's tightness — a preview must not become a cheaper
  // oracle for brute-forcing live codes than the redeem endpoint itself (§28).
  server.get(
    "/invites/:code/preview",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 10, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { code } = parseWith(redeemParamsSchema, request.params);

      const result = await server.repos.invites.previewByCode(code, user.id);
      if (!result.ok) {
        switch (result.reason) {
          case "not_found":
            throw new ApiError(404, "NOT_FOUND", "Invite not found.");
          case "expired":
            throw new ApiError(410, "INVITE_EXPIRED", "This invite has expired.");
          case "exhausted":
            throw new ApiError(410, "INVITE_EXHAUSTED", "This invite has no uses left.");
          case "banned":
            // Same single answer as redeem for a banned user, whatever the
            // invite's state — never an oracle for code validity (§28).
            throw new ApiError(403, "GROUP_BANNED", "You are banned from this group.");
        }
      }

      // Online count via the shared presence keys (gateway = writer, API =
      // reader). Best-effort and honest: no presence seam or a Redis error ⇒
      // null (the card omits the line) — NEVER a guessed number. Invisible
      // members are excluded inside the counter (publicPresenceStatus mask).
      let onlineCount: number | null = null;
      if (options.presence) {
        try {
          onlineCount = await options.presence.countPublicOnline(result.memberIds);
        } catch (err) {
          request.log.warn({ err }, "invite preview: presence read failed");
          onlineCount = null;
        }
      }

      const preview: InvitePreview = {
        code: result.invite.code,
        // The repo answers not_found for kind='dm', so non-server here means a
        // flat group chat (M18 group-DM link).
        kind: result.group.kind === "server" ? "server" : "group",
        groupName: result.group.name,
        groupIconUrl: result.group.iconUrl,
        memberCount: result.memberCount,
        onlineCount,
        createdAt: result.group.createdAt,
        alreadyMember: result.alreadyMember,
        // Only members learn the group id (it powers "open server" navigation);
        // a non-member gets null — the id is otherwise never disclosed pre-join.
        groupId: result.alreadyMember ? result.group.id : null,
        // Channel destination (migration 0021), resolved per-viewer in the repo.
        // Null for an untargeted invite, a deleted channel, or a channel THIS
        // viewer would not be able to see after joining — the card never shows a
        // destination the join cannot deliver (§35).
        targetChannel: result.targetChannel,
      };
      return { preview };
    },
  );

  server.post(
    "/invites/:code/redeem",
    {
      preHandler: [server.authenticate],
      config: {
        rateLimit: userRateLimit({ max: 10, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { code } = parseWith(redeemParamsSchema, request.params);

      const result = await server.repos.invites.redeem(code, user.id);
      if (!result.ok) {
        switch (result.reason) {
          case "not_found":
            throw new ApiError(404, "NOT_FOUND", "Invite not found.");
          case "expired":
            throw new ApiError(410, "INVITE_EXPIRED", "This invite has expired.");
          case "exhausted":
            throw new ApiError(410, "INVITE_EXHAUSTED", "This invite has no uses left.");
          case "already_member":
            throw new ApiError(409, "CONFLICT", "You are already a member of this group.");
          case "banned":
            // The user is on this server's ban list (migration 0017). A ban blocks
            // rejoin via ANY invite; do not leak whether the invite itself was
            // valid (§28) — a banned user gets one answer regardless.
            throw new ApiError(403, "GROUP_BANNED", "You are banned from this group.");
          case "blocked":
            // M18 (ADR 0017): a GROUP-DM link whose creator and the redeemer have
            // blocked each other. A group DM is a private space, so a link must
            // not put the two in the same room. Same code + copy as every other
            // block refusal — which side blocked is never disclosed (§28).
            throw new ApiError(
              403,
              "BLOCKED",
              "You can't do that because of a block between you and this user.",
            );
        }
      }

      // GROUP-DM link (M18): the redeemed invite points at a flat group chat, not
      // a server. Two things differ from the server path and both matter:
      //
      //  1. There is no system channel and no "X joined the server" notice — a
      //     flat chat has one hidden stream and no membership feed, so
      //     `postMembershipSystemMessage` is skipped rather than made a no-op by
      //     accident.
      //  2. The joiner is reached USER-scoped with `group_chat.added`, exactly
      //     like `POST /group-chats/:id/members` does. NOT because a flat chat is
      //     missing from the gateway's index — it used to be, when that index was
      //     built from the server-only `groups.listForUser`, but the gateway now
      //     uses `groups.listMemberGroupIds`, which covers every kind. The reason
      //     is that the joiner has no subscription to this group YET: the
      //     user-scoped path is what reaches their live sockets through
      //     `connectionsByUser` and subscribes them to the stream, so messages
      //     flow with no reconnect.
      if (result.group.kind !== "server") {
        const joined = await server.repos.groupChats.findById(result.group.id);
        if (joined) {
          await mutationBus?.publish({
            userId: user.id,
            event: serverEvent.groupChatAdded({ group: joined }),
          });
        }
        // A flat group chat has no channel picker, so its invites never carry a
        // target — answered explicitly rather than omitted so the response shape
        // is identical on both branches and the client needs one parser.
        return { group: result.group, targetChannel: null };
      }

      // "X joined the server" — persisted + broadcast through the normal
      // message pipeline. Best-effort: never fails the redeem (membership is
      // already committed). Servers only; no-op for group chats / unset channel.
      await postMembershipSystemMessage({
        repos: server.repos,
        mutationBus,
        log: request.log,
        group: result.group,
        affectedUser: user,
        event: "joined",
      });

      // Lifecycle event (task #43), independent of the system message above: tell
      // the group so existing members' rosters refresh and — if the new member
      // has another device already connected — the gateway subscribes it to this
      // server's channels. Best-effort: the membership is already committed.
      const member = await server.repos.groups.getMembership(result.group.id, user.id);
      if (member) {
        await mutationBus?.publish({
          groupId: result.group.id,
          event: serverEvent.memberJoined({ groupId: result.group.id, member, user }),
        });
      }

      // Where to land them (migration 0021). Resolved by the repo against the
      // membership this redeem just created, so it is the joiner's REAL
      // visibility — a role-restricted target reads null and the client simply
      // lands on the server, which is the founder's flow minus a destination it
      // could not have opened anyway.
      return { group: result.group, targetChannel: result.targetChannel };
    },
  );
}
