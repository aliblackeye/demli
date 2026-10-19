import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RealtimeMutationPublisher } from "@demli/db";
import {
  channelNameField,
  groupNameField,
  mediaUrlField,
  serverEvent,
} from "@demli/protocol";
import { PERMISSIONS } from "@demli/types";
import { ApiError, parseWith } from "../../errors.js";
import { postMembershipSystemMessage } from "../../lib/system-messages.js";
import { requirePerm } from "../../lib/permissions.js";
import { requireUser } from "../../plugins/auth.js";
import { ownedObjectPath, type AvatarStorage } from "../../lib/storage.js";
import { evictFromGroupVoice, type VoiceEjector } from "../../lib/voice-eviction.js";
import type { MediaModerator } from "../../lib/media-moderation.js";
import {
  buildGroupBannerStoragePath,
  decodeGroupBannerUpload,
} from "../../lib/group-banner-upload.js";
import { LIST_LIMIT, userRateLimit } from "../../lib/rate-limit.js";

/**
 * `POST /groups`.
 *
 * `groupNameField` / `channelNameField` rather than a hand-rolled
 * `z.string().trim()`: a server name is rendered in the group rail, the header
 * and every invite preview, and a channel name sits in the sidebar of everyone
 * who joins. Both are sanitized (invisible + bidi-override characters removed)
 * and both must contain one genuinely visible character, so a server cannot be
 * created with a name that flips the line it is drawn on or with one that is
 * technically non-empty and visually blank. The bounds are unchanged.
 */
const createGroupSchema = z.object({
  name: groupNameField,
  /**
   * Names for the two channels every new server is born with. Optional and
   * client-supplied on purpose: a channel name is untranslatable plain text once
   * written, and only the client knows the creator's UI language. Omitted ⇒ the
   * repo's English fallback (`general` / `Lobby`). Same rules as
   * `POST /groups/:groupId/channels`.
   */
  textChannelName: channelNameField.optional(),
  voiceChannelName: channelNameField.optional(),
});

/**
 * `PATCH /groups/:groupId`.
 *
 * `mediaUrlField` in place of `z.string().url()` on both image URLs: zod's
 * `.url()` only asks whether `new URL()` parses, which `javascript:`, `data:`
 * and `file:` all do. A server icon is fetched by every member's client the
 * moment the group renders, so an unrestricted scheme there is an
 * attacker-chosen fetch on behalf of an entire server's membership (and on
 * mobile there is no CSP standing behind it). Absolute http(s) only.
 */
const updateGroupSchema = z
  .object({
    name: groupNameField.optional(),
    iconUrl: mediaUrlField.nullable().optional(),
    /**
     * Server banner (M20). Only `null` is meaningful from a client — it REMOVES
     * the banner. A new image is bytes, and bytes only arrive through
     * `POST /groups/:groupId/banner`, the one path that can verify what they are;
     * the route below refuses any non-null value so this can never become a way
     * to point the banner at an unvalidated URL (§28).
     */
    bannerUrl: mediaUrlField.nullable().optional(),
    /** Text channel of THIS server that receives system messages; null = off. */
    systemChannelId: z.string().uuid("Invalid channel id.").nullable().optional(),
    /** Who may create invites (M9): "members" (default) or "roles". Owner-only. */
    invitePolicy: z.enum(["members", "roles"]).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to update.",
  });

/**
 * Inline server-banner upload body — identical shape to the profile-banner body.
 * The declared MIME is only a hint; the API magic-byte-sniffs the real bytes and
 * checks the pixel budget (§28). See `lib/group-banner-upload.ts`.
 */
const uploadGroupBannerSchema = z.object({
  mime: z.string().min(1).max(255),
  dataBase64: z.string().min(1),
});

const groupParamsSchema = z.object({
  groupId: z.string().uuid("Invalid group id."),
});

const memberParamsSchema = z.object({
  groupId: z.string().uuid("Invalid group id."),
  userId: z.string().uuid("Invalid user id."),
});

export interface GroupsModuleDeps {
  /** Realtime publisher for `group.updated` / `member.*` fan-out. */
  mutationBus?: RealtimeMutationPublisher;
  /**
   * Public avatar/banner bucket wrapper, or null when uploads are disabled
   * (feature off). Shared with the profile banner — same bucket, same gate, so
   * turning image uploads on stays ONE env line rather than two (M20).
   */
  avatarStorage?: AvatarStorage | null;
  /** Server-side NSFW seam; fail-open `skipped` until MEDIA_MODERATION_MODE is flipped. */
  mediaModerator?: MediaModerator;
  /**
   * SFU admin used to end the media session of a member someone ELSE removed
   * (see {@link evictFromGroupVoice}). Null/omitted ⇒ membership-only removal.
   */
  voiceEjector?: VoiceEjector | null;
}

export async function registerGroupsModule(
  server: FastifyInstance,
  deps: GroupsModuleDeps = {},
): Promise<void> {
  const { mutationBus, avatarStorage = null, mediaModerator, voiceEjector = null } = deps;

  /**
   * "May this user change this server's settings?" — the ONE rule the settings
   * writes share, lifted out of `PATCH /groups/:groupId` verbatim rather than
   * re-derived, so the banner cannot end up with a different answer than the name
   * and icon it sits beside.
   *
   * OWNER-ONLY, deliberately: server settings have no permission bit. The roles
   * system grants MANAGE_CHANNELS / MANAGE_ROLES / KICK_MEMBERS and friends, but
   * nothing that means "edit the server itself", so there is no admin tier to
   * honour here and inventing one would be a permission-model change, not a
   * banner feature (§33, CLAUDE.md §6 "no full permission hierarchy in MVP").
   *
   * A non-member and a group-chat id both answer 404 rather than 403 so neither
   * membership nor the kind of a group is ever leaked (§28).
   */
  async function requireServerOwner(groupId: string, userId: string): Promise<void> {
    const membership = await server.repos.groups.getMembership(groupId, userId);
    if (!membership) throw new ApiError(404, "NOT_FOUND", "Group not found.");
    const group = await server.repos.groups.findById(groupId);
    if (!group || group.kind !== "server") {
      throw new ApiError(404, "NOT_FOUND", "Group not found.");
    }
    if (membership.role !== "owner") {
      throw new ApiError(403, "FORBIDDEN", "Only the owner can edit this server.");
    }
  }
  server.post(
    "/groups",
    {
      preHandler: [server.authenticate],
      config: {
        // Unbounded group creation is the cheapest way for one session to grow
        // the database without limit (group + membership + default channels per
        // call). Nobody makes more than a couple of servers in a sitting, so
        // 20/min is far above real use and still caps the write amplification.
        rateLimit: userRateLimit({ max: 20, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const body = parseWith(createGroupSchema, request.body);

      // Group + owner membership + starter text/voice channels in ONE
      // transaction: a server is never visible half-provisioned, and it is never
      // born empty (founder request). Response carries the channels so the
      // client can render the sidebar without a second round trip.
      const { group, channels } = await server.repos.groups.createServerWithDefaults({
        name: body.name,
        ownerId: user.id,
        textChannelName: body.textChannelName,
        voiceChannelName: body.voiceChannelName,
      });

      // No fan-out to "the group" — it has exactly one member, the creator, and
      // the gateway has nobody indexed under a server that did not exist a moment
      // ago (`connectionsByGroup` is built at handshake). What this DOES do is the
      // creator-side half of `handleMemberJoined`: index the creator's own live
      // connections into the new server and subscribe them to its two channels,
      // so messages flow without a reconnect. Same pattern the DM→group upgrade
      // uses for its brand-new group. `channel.created` would be a pure no-op
      // here (its handler returns early when no connection is indexed), so it is
      // deliberately not published. Best-effort: the server is already committed.
      const member = await server.repos.groups.getMembership(group.id, user.id);
      if (member) {
        await mutationBus?.publish({
          groupId: group.id,
          event: serverEvent.memberJoined({ groupId: group.id, member, user }),
        });
      }

      return reply.status(201).send({ group, channels });
    },
  );

  server.get(
    "/groups",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit(LIST_LIMIT) },
    },
    async (request) => {
      const user = requireUser(request);
      return { groups: await server.repos.groups.listForUser(user.id) };
    },
  );

  server.get(
    "/groups/:groupId",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit(LIST_LIMIT) },
    },
    async (request) => {
      const user = requireUser(request);
      const { groupId } = parseWith(groupParamsSchema, request.params);

      // Non-members get 404, not 403 — membership is not leaked (§28).
      const membership = await server.repos.groups.getMembership(groupId, user.id);
      if (!membership) throw new ApiError(404, "NOT_FOUND", "Group not found.");

      const details = await server.repos.groups.getDetails(groupId);
      if (!details) throw new ApiError(404, "NOT_FOUND", "Group not found.");

      // Flat group chats have no roles/visibility — return as-is (M9 servers only).
      if (details.group.kind !== "server") return details;

      // M9: hide restricted channels the caller cannot see (existence not
      // leaked), flag the ones that survive, and attach each member's roleIds
      // (one assignments query, not N).
      const [visibleIds, restrictedIds, assignments] = await Promise.all([
        server.repos.channelAccess.visibleChannelIdsForUser(groupId, user.id),
        server.repos.channelAccess.restrictedChannelIds(groupId),
        server.repos.roles.listAssignmentsForGroup(groupId),
      ]);
      const visible = new Set(visibleIds);
      const restricted = new Set(restrictedIds);
      const roleIdsByUser = new Map<string, string[]>();
      for (const a of assignments) {
        const list = roleIdsByUser.get(a.userId);
        if (list) list.push(a.roleId);
        else roleIdsByUser.set(a.userId, [a.roleId]);
      }

      return {
        group: details.group,
        channels: details.channels
          .filter((c) => visible.has(c.id))
          .map((c) => ({ ...c, restricted: restricted.has(c.id) })),
        members: details.members.map((m) => ({
          ...m,
          roleIds: roleIdsByUser.get(m.userId) ?? [],
        })),
      };
    },
  );

  // Rename / re-icon a server. Owner-only; server-kind only (group chats are
  // managed via /group-chats). Non-members and group-chat ids get 404 (§28).
  server.patch(
    "/groups/:groupId",
    {
      preHandler: [server.authenticate],
      config: {
        // Every edit broadcasts `group.updated` to all members, so this is a
        // fan-out lever. 30/min matches the other settings-style writes.
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { groupId } = parseWith(groupParamsSchema, request.params);
      const body = parseWith(updateGroupSchema, request.body);

      await requireServerOwner(groupId, user.id);

      // A banner can only be REMOVED here. Accepting an arbitrary URL would hand
      // a client the power to point every member's sidebar header at a host we
      // never checked — the exact thing the upload route's byte verification
      // exists to prevent, reachable by skipping it (§28).
      if (body.bannerUrl != null) {
        throw new ApiError(
          400,
          "INVALID_GROUP_BANNER",
          "Upload a banner image instead; only removal (null) is allowed here.",
        );
      }

      // The system channel must be one of THIS server's text channels
      // (null = disable system messages). Never trust the client id (§28).
      if (body.systemChannelId != null) {
        const channel = await server.repos.channels.findById(body.systemChannelId);
        if (!channel || channel.groupId !== groupId) {
          throw new ApiError(
            400,
            "INVALID_CHANNEL",
            "systemChannelId must be a channel of this server.",
          );
        }
        if (channel.kind !== "text") {
          throw new ApiError(
            400,
            "INVALID_CHANNEL",
            "systemChannelId must be a text channel.",
          );
        }
      }

      // Read the outgoing banner BEFORE the write, so an explicit removal can take
      // the object out of the bucket too. Only when the caller actually asked
      // (`bannerUrl` present and null) — an unrelated rename must never delete an
      // image.
      const removingBanner = body.bannerUrl === null;
      const previousBannerUrl = removingBanner
        ? ((await server.repos.groups.findById(groupId))?.bannerUrl ?? null)
        : null;

      const updated = await server.repos.groups.update(groupId, body);
      if (!updated) throw new ApiError(404, "NOT_FOUND", "Group not found.");

      if (removingBanner && avatarStorage) {
        const previousPath = ownedObjectPath(previousBannerUrl, avatarStorage);
        if (previousPath) {
          // Best-effort: the row already says "no banner", which is the state the
          // user asked for. A stranded object costs storage, not correctness.
          try {
            await avatarStorage.remove([previousPath]);
          } catch (err) {
            request.log.error({ err, previousPath }, "group banner removal: purge failed");
          }
        }
      }

      // Lifecycle event (task #50): tell every connected member the server was
      // renamed / re-iconed / re-bannered so their group list + header refresh live.
      await mutationBus?.publish({
        groupId,
        event: serverEvent.groupUpdated({ group: updated }),
      });

      return { group: updated };
    },
  );

  // Upload a SERVER banner (M20) — the profile-banner path applied to a group.
  // Inline base64, real bytes validated (whitelist → cap → magic bytes → pixel
  // budget) BEFORE storage, same public avatar bucket + gate, stored under
  // `group-banners/<groupId>/…`. Owner-only and server-kind-only, exactly like
  // the PATCH it sits beside. With the bucket unset this answers 503
  // GROUP_BANNER_UPLOADS_DISABLED, so production is untouched until the founder
  // turns image uploads on. Always NSFW-screened: unlike a profile banner, this
  // image is pushed to every member of the server without them opening anything.
  server.post(
    "/groups/:groupId/banner",
    {
      preHandler: [server.authenticate],
      config: {
        // Each successful upload writes an object AND broadcasts `group.updated`
        // to every member — a storage-and-fan-out lever. 12/min matches the
        // profile-banner route, which is the same action class.
        rateLimit: userRateLimit({ max: 12, timeWindow: "1 minute" }),
      },
      // Base64 inflates the 5 MB cap to ~6.7 MB; 8 MB leaves room for the JSON
      // envelope while rejecting a hostile body before it is parsed.
      bodyLimit: 8 * 1024 * 1024,
    },
    async (request) => {
      if (!avatarStorage) {
        throw new ApiError(
          503,
          "GROUP_BANNER_UPLOADS_DISABLED",
          "Banner uploads are not available on this server.",
        );
      }
      const user = requireUser(request);
      const { groupId } = parseWith(groupParamsSchema, request.params);
      const body = parseWith(uploadGroupBannerSchema, request.body);

      // Authorize BEFORE decoding: a non-owner must not get to spend the server's
      // CPU on a 5 MB base64 decode just to be told no.
      await requireServerOwner(groupId, user.id);

      const { bytes, mime } = decodeGroupBannerUpload(body);

      const moderation = await mediaModerator?.check({ bytes, mime, subject: "banner" });
      if (moderation?.verdict === "rejected") {
        request.log.info(
          { groupId, userId: user.id, reason: moderation.reason },
          "group banner rejected by moderation",
        );
        throw new ApiError(
          422,
          "GROUP_BANNER_REJECTED",
          "That image can't be used as a server banner.",
        );
      }
      if (moderation?.verdict === "skipped" && moderation.error) {
        request.log.warn({ err: moderation.error }, "group banner moderation failed open");
      }

      const storagePath = buildGroupBannerStoragePath(groupId, mime);
      await avatarStorage.upload(storagePath, bytes, mime);
      const publicUrl = avatarStorage.publicUrl(storagePath);

      const previous = await server.repos.groups.findById(groupId);
      const previousBannerUrl = previous?.bannerUrl ?? null;

      const updated = await server.repos.groups.update(groupId, { bannerUrl: publicUrl });
      if (!updated) {
        // The row vanished between the ownership check and the write. Take the
        // object back out rather than leaving it orphaned in the bucket.
        try {
          await avatarStorage.remove([storagePath]);
        } catch (err) {
          request.log.error({ err, storagePath }, "group banner upload: orphan purge failed");
        }
        throw new ApiError(404, "NOT_FOUND", "Group not found.");
      }

      const previousPath = ownedObjectPath(previousBannerUrl, avatarStorage);
      if (previousPath && previousPath !== storagePath) {
        try {
          await avatarStorage.remove([previousPath]);
        } catch (err) {
          request.log.error(
            { err, previousPath },
            "group banner upload: old-object purge failed",
          );
        }
      }

      await mutationBus?.publish({
        groupId,
        event: serverEvent.groupUpdated({ group: updated }),
      });

      return { group: updated };
    },
  );

  // Remove a member from a server: the owner may remove any member; a member
  // may remove only themselves (leave). The owner cannot leave (delete the
  // server instead). Posts a "left" system message on success.
  server.delete(
    "/groups/:groupId/members/:userId",
    {
      preHandler: [server.authenticate],
      config: {
        // Membership removal posts a system message and broadcasts `member.left`
        // group-wide — a message-generating fan-out an owner could otherwise
        // loop. Matches the 30/min the moderation module already uses for
        // kick/ban, which is the same action class.
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { groupId, userId } = parseWith(memberParamsSchema, request.params);

      const membership = await server.repos.groups.getMembership(groupId, user.id);
      if (!membership) throw new ApiError(404, "NOT_FOUND", "Group not found.");
      const group = await server.repos.groups.findById(groupId);
      if (!group || group.kind !== "server") {
        throw new ApiError(404, "NOT_FOUND", "Group not found.");
      }

      const isSelf = userId === user.id;
      if (userId === group.ownerId) {
        // The owner is never kickable by someone else. They may only LEAVE when
        // they are the last member — which auto-deletes the server (below);
        // while others remain they must delete it instead (task #50).
        if (!isSelf) {
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            "The server owner cannot be removed. Delete the server instead.",
          );
        }
        if ((await server.repos.groups.countMembers(groupId)) > 1) {
          throw new ApiError(
            400,
            "VALIDATION_ERROR",
            "The server owner can't leave while other members remain. Delete the server instead.",
          );
        }
      } else if (!isSelf) {
        // Removing someone else requires owner ∨ KICK_MEMBERS (M9).
        await requirePerm(
          server,
          groupId,
          membership.role,
          user.id,
          PERMISSIONS.KICK_MEMBERS,
          "You do not have permission to remove members.",
        );
      }

      const affectedUser = isSelf ? user : await server.repos.users.findById(userId);
      // Remove the member; if that empties the server, delete it (cascade) in the
      // same transaction (task #50 auto-delete).
      const { removed, groupDeleted } =
        await server.repos.groups.removeMemberAndPruneIfEmpty(groupId, userId);
      if (!removed) throw new ApiError(404, "NOT_FOUND", "Member not found.");

      if (groupDeleted) {
        // The last member left — the whole server is gone. Drop it live for every
        // connection; no "left" system message (its channel is gone) and no
        // member.left (group.deleted supersedes it).
        await mutationBus?.publish({
          groupId,
          event: serverEvent.groupDeleted({ groupId }),
        });
        return reply.status(204).send();
      }

      // Removed by someone else: their media session ends with the membership.
      // A member leaving on their own takes their client out of voice themselves.
      if (!isSelf) {
        await evictFromGroupVoice(server, { ejector: voiceEjector, mutationBus, log: request.log }, {
          groupId,
          userId,
        });
      }

      // "X left the server" — best-effort, never fails the removal.
      if (affectedUser) {
        await postMembershipSystemMessage({
          repos: server.repos,
          mutationBus,
          log: request.log,
          group,
          affectedUser,
          event: "left",
        });
      }

      // Lifecycle event (task #43), independent of the system message above: tell
      // the group so remaining members' rosters refresh and — for the removed
      // member's own connections — the gateway drops this server's channel
      // subscriptions (and forces them out of any of its voice rooms).
      await mutationBus?.publish({
        groupId,
        event: serverEvent.memberLeft({ groupId, userId }),
      });

      return reply.status(204).send();
    },
  );

  // Delete a server and everything it owns (channels, members, messages, invites
  // cascade). Owner-only; server-kind only.
  server.delete(
    "/groups/:groupId",
    {
      preHandler: [server.authenticate],
      config: {
        // The largest cascade in the product (channels + every message + every
        // membership) plus a broadcast to all members. Matched to the create
        // budget: you cannot delete more servers than you can make.
        rateLimit: userRateLimit({ max: 20, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { groupId } = parseWith(groupParamsSchema, request.params);

      const membership = await server.repos.groups.getMembership(groupId, user.id);
      if (!membership) throw new ApiError(404, "NOT_FOUND", "Group not found.");
      const group = await server.repos.groups.findById(groupId);
      if (!group || group.kind !== "server") {
        throw new ApiError(404, "NOT_FOUND", "Group not found.");
      }
      if (membership.role !== "owner") {
        throw new ApiError(403, "FORBIDDEN", "Only the owner can delete this server.");
      }

      await server.repos.groups.delete(groupId);

      // Lifecycle event (task #50): drop the server live for every connected
      // member — the gateway unsubscribes them from its (now-gone) channels,
      // forces anyone in its voice rooms out, and clients route away from it.
      await mutationBus?.publish({
        groupId,
        event: serverEvent.groupDeleted({ groupId }),
      });

      return reply.status(204).send();
    },
  );
}
