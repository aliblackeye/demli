import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { RealtimeMutationPublisher } from "@demli/db";
import {
  channelDescriptionField,
  channelNameField,
  serverEvent,
  type ServerToClientEvent,
} from "@demli/protocol";
import type { Channel } from "@demli/types";
import { isChatCapableChannel, PERMISSIONS } from "@demli/types";
import { AUDIO_BITRATE_MAX_KBPS, AUDIO_BITRATE_MIN_KBPS } from "@demli/config";
import { ApiError, parseWith } from "../../errors.js";
import { loadServer, loadVisibleChannel, requirePerm } from "../../lib/permissions.js";
import { requireUser } from "../../plugins/auth.js";
import { LIST_LIMIT, userRateLimit } from "../../lib/rate-limit.js";

// The name and description bounds are NOT re-declared here. They come with
// `channelNameField` / `channelDescriptionField` from @demli/protocol, which
// reads them from @demli/config — the same numbers the client forms validate
// against. Local copies are how a client and a server end up disagreeing about
// what is a legal value, which already happened once with the voice bitrate
// window (see the note below).
/** Upper bound for the additive channel metadata (0003_channel_meta). */
const CHANNEL_MAX_PARTICIPANTS = 99;
/** Slowmode ceiling — 6 hours (0004_system_slowmode). */
const SLOWMODE_MAX_SECONDS = 21_600;
// The voice bitrate window is NOT re-declared here: it comes from @demli/config,
// the same module packages/protocol validates against. It had drifted into a local
// copy, which is exactly how a client and a server end up disagreeing about what is
// a legal value. The window stays WIDE (8..510) on purpose while the UI offers only
// the three presets — see AUDIO_BITRATE_PRESETS_KBPS for why.
/** Safety cap on the create-time visibility role list (mirrors the roles module). */
const ROLE_ID_LIST_MAX = 100;

const groupParamsSchema = z.object({
  groupId: z.string().uuid("Invalid group id."),
});

const channelParamsSchema = z.object({
  channelId: z.string().uuid("Invalid channel id."),
});

/**
 * `channelNameField` / `channelDescriptionField` come from `@demli/protocol`
 * rather than being re-declared as `z.string().trim()`: a channel name is drawn
 * in every member's sidebar and a topic in the channel header, and an
 * unsanitized value there can carry U+202E (which flips the rest of the line
 * right-to-left) or be made entirely of zero-width characters and render as an
 * unexplainable blank row. Not XSS — the sinks escape — but it lets one member
 * decide what everyone else's UI looks like. Same bounds, invisible characters
 * removed, and a name must contain at least one visible character.
 */
const createChannelSchema = z.object({
  name: channelNameField,
  kind: z.enum(["text", "voice"]),
  /** Age-restricted (NSFW) flag (M15); defaults false. */
  nsfw: z.boolean().optional(),
  /**
   * Optional create-time visibility restriction (ADR 0007 / task #51). Omitted or
   * empty = public to every member (the existing default). Non-empty locks the new
   * channel to the owner + members holding one of these roles — the same model as
   * PUT /channels/:id/access, applied atomically at creation.
   */
  roleIds: z
    .array(z.string().uuid("Invalid role id."))
    .max(ROLE_ID_LIST_MAX)
    .optional(),
  /**
   * Sidebar category to file the new channel under (M18). Omitted/null = the
   * uncategorized top-level list (the pre-M18 default). Validated against THIS
   * group before the write.
   */
  categoryId: z.string().uuid("Invalid category id.").nullable().optional(),
});

const updateChannelSchema = z
  .object({
    name: channelNameField.optional(),
    description: channelDescriptionField.nullable().optional(),
    maxParticipants: z
      .number()
      .int()
      .min(1)
      .max(CHANNEL_MAX_PARTICIPANTS)
      .nullable()
      .optional(),
    /** Text channels only; 0 disables slowmode. */
    slowmodeSeconds: z.number().int().min(0).max(SLOWMODE_MAX_SECONDS).optional(),
    /** Voice channels only; null resets to the media default. */
    audioBitrateKbps: z
      .number()
      .int()
      .min(AUDIO_BITRATE_MIN_KBPS)
      .max(AUDIO_BITRATE_MAX_KBPS)
      .nullable()
      .optional(),
    /** Age-restricted (NSFW) flag (M15); toggles the channel's NSFW gate. */
    nsfw: z.boolean().optional(),
    /**
     * Move the channel into a category, or out of one with `null` (M18). Position
     * within the bucket is NOT set here — bulk placement is
     * `PATCH /groups/:groupId/channel-order`, which rewrites both axes atomically.
     */
    categoryId: z.string().uuid("Invalid category id.").nullable().optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to update.",
  });

export async function registerChannelsModule(
  server: FastifyInstance,
  mutationBus?: RealtimeMutationPublisher,
): Promise<void> {
  server.post(
    "/groups/:groupId/channels",
    {
      preHandler: [server.authenticate],
      config: {
        // Channel creation writes rows AND fans a `channel.created` out to every
        // group member, so unlimited it is both a storage and a fan-out lever.
        // An owner setting up a server makes a handful in a sitting; 20/min
        // leaves that untouched.
        rateLimit: userRateLimit({ max: 20, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { groupId } = parseWith(groupParamsSchema, request.params);
      const body = parseWith(createChannelSchema, request.body);

      // SERVERS ONLY. `loadServer` rather than a bare membership lookup: channels
      // are a SERVER concept. A flat group chat and a DM are single-stream by
      // construction — they have no sidebar, no channel picker and no roles — so
      // a channel created inside one is a row no client can ever reach, and the
      // group's owner could grow the table with them indefinitely. The membership
      // check alone let that happen, because `kind` was never consulted.
      //
      // The refusal is 404 "Group not found.", the same answer a non-member gets:
      // whether an id names a server or a group DM is not something an outsider
      // gets to probe (§28). Same guard the roles and invite-policy endpoints use.
      const { role } = await loadServer(server, groupId, user.id);
      // Owner ∨ MANAGE_CHANNELS (M9); the bit covers create/edit/delete (ADR
      // 0007). Setting create-time visibility roles is the same authority as PUT
      // /channels/:id/access (also MANAGE_CHANNELS), so this single check covers it.
      await requirePerm(
        server,
        groupId,
        role,
        user.id,
        PERMISSIONS.MANAGE_CHANNELS,
        "You do not have permission to create channels.",
      );

      // Validate the optional visibility roles against THIS group before the
      // write. A role from another group (or an unknown id) is bad input → 400;
      // the composite FK would also reject it, but a friendly error beats a raw
      // constraint failure. Deduped so the atomic insert cannot trip the PK.
      const roleIds = body.roleIds ? [...new Set(body.roleIds)] : [];
      if (roleIds.length > 0) {
        const groupRoleIds = new Set(
          (await server.repos.roles.listForGroup(groupId)).map((r) => r.id),
        );
        for (const id of roleIds) {
          if (!groupRoleIds.has(id)) {
            throw new ApiError(400, "VALIDATION_ERROR", "Role does not belong to this group.");
          }
        }
      }

      // Category (M18) must belong to THIS group — a foreign id is bad input, not
      // a silent no-op. Null/omitted leaves the channel uncategorized.
      const categoryId = body.categoryId ?? null;
      if (categoryId !== null) {
        await assertCategoryInGroup(server, groupId, categoryId);
      }

      // Channel + its visibility rows land in ONE transaction (task #51): a
      // restricted channel is never briefly public.
      const channel = await server.repos.channels.create({
        groupId,
        kind: body.kind,
        name: body.name,
        nsfw: body.nsfw ?? false,
        roleIds,
        categoryId,
      });
      // Fan the new channel out so every connected member who CAN SEE it subscribes
      // and sees it appear immediately — without this the gateway never subscribes
      // anyone to a channel created after their handshake (task #43). The gateway
      // routes channel.created through the visibility filter, so a restricted
      // channel never reaches a member without a granting role (task #51, §28).
      await publishGroupEvent(mutationBus, serverEvent.channelCreated(channel), groupId);
      return reply.status(201).send({ channel });
    },
  );

  server.get(
    "/groups/:groupId/channels",
    {
      preHandler: [server.authenticate],
      config: { rateLimit: userRateLimit(LIST_LIMIT) },
    },
    async (request) => {
      const user = requireUser(request);
      const { groupId } = parseWith(groupParamsSchema, request.params);

      const membership = await server.repos.groups.getMembership(groupId, user.id);
      if (!membership) throw new ApiError(404, "NOT_FOUND", "Group not found.");

      // M9: only channels the caller may see, each flagged `restricted`.
      const [all, visibleIds, restrictedIds] = await Promise.all([
        server.repos.channels.listForGroup(groupId),
        server.repos.channelAccess.visibleChannelIdsForUser(groupId, user.id),
        server.repos.channelAccess.restrictedChannelIds(groupId),
      ]);
      const visible = new Set(visibleIds);
      const restricted = new Set(restrictedIds);
      return {
        channels: all
          .filter((c) => visible.has(c.id))
          .map((c) => ({ ...c, restricted: restricted.has(c.id) })),
      };
    },
  );

  // Edit a channel (name / description / voice cap). Owner-only, server channels
  // only. A group chat's hidden stream channel is not manageable here (404) — its
  // lifecycle is owned by the group. `maxParticipants` is voice-only.
  server.patch(
    "/channels/:channelId",
    {
      preHandler: [server.authenticate],
      config: {
        // Each edit broadcasts `channel.updated` to the whole group, so the
        // fan-out — not the write — is what needs bounding. Matches the 30/min
        // used by the other settings-style writes in this codebase.
        rateLimit: userRateLimit({ max: 30, timeWindow: "1 minute" }),
      },
    },
    async (request) => {
      const user = requireUser(request);
      const { channelId } = parseWith(channelParamsSchema, request.params);
      const body = parseWith(updateChannelSchema, request.body);

      const target = await loadManageableChannel(server, channelId, user.id);

      if (body.maxParticipants != null && target.channel.kind !== "voice") {
        throw new ApiError(
          400,
          "INVALID_CHANNEL",
          "maxParticipants can only be set on voice channels.",
        );
      }
      if (body.audioBitrateKbps != null && target.channel.kind !== "voice") {
        throw new ApiError(
          400,
          "INVALID_CHANNEL",
          "audioBitrateKbps can only be set on voice channels.",
        );
      }
      // Slowmode follows the CHAT, not the kind (M20): a voice channel's text
      // chat is the one most likely to need it — a busy room's sidebar chat is
      // where a spam burst lands — and the limiter itself is already shared
      // between transports by channel id, so turning it on here throttles the WS
      // and REST send paths identically. `maxParticipants` / `audioBitrateKbps`
      // above stay voice-only: those describe the ROOM, which text has none of.
      if (
        body.slowmodeSeconds !== undefined &&
        !isChatCapableChannel(target.channel.kind)
      ) {
        throw new ApiError(
          400,
          "INVALID_CHANNEL",
          "slowmodeSeconds cannot be set on this channel.",
        );
      }

      // Category move (M18): validate the target belongs to the channel's OWN
      // group before writing, then apply it separately — `channels.update` owns
      // the metadata patch, `setCategory` owns placement, so neither grows a
      // second responsibility.
      const { categoryId, ...metadata } = body;
      if (categoryId !== undefined && categoryId !== null) {
        await assertCategoryInGroup(server, target.channel.groupId, categoryId);
      }

      let updated =
        Object.keys(metadata).length > 0
          ? await server.repos.channels.update(channelId, metadata)
          : target.channel;
      if (!updated) throw new ApiError(404, "NOT_FOUND", "Channel not found.");
      if (categoryId !== undefined) {
        const moved = await server.repos.channels.setCategory(channelId, categoryId);
        if (!moved) throw new ApiError(404, "NOT_FOUND", "Channel not found.");
        updated = moved;
      }
      await publishGroupEvent(mutationBus, serverEvent.channelUpdated(updated), updated.groupId);
      return { channel: updated };
    },
  );

  // Delete a channel and its messages (FK cascade). Owner-only, server channels only.
  server.delete(
    "/channels/:channelId",
    {
      preHandler: [server.authenticate],
      config: {
        // The heaviest channel write: an FK cascade over every message row, plus
        // a group-wide broadcast. Matched to the create budget — you cannot
        // delete more channels than you can make.
        rateLimit: userRateLimit({ max: 20, timeWindow: "1 minute" }),
      },
    },
    async (request, reply) => {
      const user = requireUser(request);
      const { channelId } = parseWith(channelParamsSchema, request.params);

      const { channel } = await loadManageableChannel(server, channelId, user.id);

      await server.repos.channels.delete(channelId);
      // Tell the group so the gateway drops every subscription to the dead channel
      // (forcing out anyone in its voice room) and clients prune it from their UI.
      await publishGroupEvent(
        mutationBus,
        serverEvent.channelDeleted({ channelId, groupId: channel.groupId }),
        channel.groupId,
      );
      return reply.status(204).send();
    },
  );
}

/**
 * Fan a group-scoped channel-lifecycle event out on the mutation bus. Best-effort
 * (the publisher swallows and logs): the DB write is the source of truth, so a
 * failed publish never fails the request — clients recover on the next refetch.
 * The gateway routes it to the group's connections and reconciles subscriptions
 * (task #43).
 */
async function publishGroupEvent(
  bus: RealtimeMutationPublisher | undefined,
  event: ServerToClientEvent,
  groupId: string,
): Promise<void> {
  await bus?.publish({ groupId, event });
}

/**
 * Throw 400 unless `categoryId` names a category of `groupId` (M18). A category
 * from another server is bad input; the FK alone would accept it (categories are
 * not composite-keyed to the channel's group at the DB level), so this boundary
 * check is what keeps a channel from being filed under a foreign server's header.
 */
async function assertCategoryInGroup(
  server: FastifyInstance,
  groupId: string,
  categoryId: string,
): Promise<void> {
  const category = await server.repos.channelCategories.findById(categoryId);
  if (!category || category.groupId !== groupId) {
    throw new ApiError(400, "VALIDATION_ERROR", "Category does not belong to this group.");
  }
}

/**
 * Resolve a channel the caller is allowed to manage, or throw the right typed
 * error. Enforces (M9): the caller can SEE the channel (invisible restricted
 * channels 404, no existence leak, §28), the channel belongs to a server not a
 * group chat (404), and the caller is owner ∨ MANAGE_CHANNELS (403).
 */
async function loadManageableChannel(
  server: FastifyInstance,
  channelId: string,
  userId: string,
): Promise<{ channel: Channel }> {
  const { channel, role } = await loadVisibleChannel(server, channelId, userId);

  const group = await server.repos.groups.findById(channel.groupId);
  if (!group || group.kind !== "server") {
    throw new ApiError(404, "NOT_FOUND", "Channel not found.");
  }
  await requirePerm(
    server,
    group.id,
    role,
    userId,
    PERMISSIONS.MANAGE_CHANNELS,
    "You do not have permission to manage channels.",
  );
  return { channel };
}
