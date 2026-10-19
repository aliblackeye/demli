/**
 * zod schemas for the realtime event contract.
 *
 * The gateway validates every inbound frame against these schemas before
 * touching a handler; clients may use the server-side schemas to validate
 * envelopes. Schemas and the TypeScript unions in events.ts are asserted to
 * stay in sync at compile time (see the `_assert*` checks at the bottom).
 */

import { z } from "zod";
import {
  ATTACHMENT_MAX_PER_MESSAGE,
  CUSTOM_EMOJI_NAME_MAX_LENGTH,
  MEMBER_NICKNAME_MAX_LENGTH,
  MESSAGE_MAX_LENGTH,
  parseYouTubeVideoId,
  sanitizeWatchDisplayText,
  USER_NICKNAME_MAX_LENGTH,
  WATCH_POSITION_MAX_SECONDS,
  WATCH_QUEUE_MAX_ITEMS,
  WATCH_QUEUE_TITLE_MAX_LENGTH,
  WATCH_VIDEO_ID_PATTERN,
  WATCH_VIDEO_REF_MAX_LENGTH,
} from "@demli/config";
import type { AttachmentLimitKind } from "@demli/config";
import type {
  Attachment,
  AttachmentKind,
  CallTarget,
  Channel,
  ChannelCategory,
  CustomEmoji,
  Dm,
  DmCall,
  FriendGroup,
  FriendGroupMember,
  Friendship,
  Group,
  MessageEmbed,
  User,
} from "@demli/types";
import type {
  ClientToServerEvent,
  ServerEnvelope,
  ServerToClientEvent,
} from "./events.js";

// ---------------------------------------------------------------------------
// Shared fragments
// ---------------------------------------------------------------------------

const id = z.string().min(1).max(128);

export const presenceStatusSchema = z.enum(["online", "idle", "dnd", "invisible", "offline"]);

export const presencePlatformSchema = z.enum(["desktop", "mobile"]);

// ---------------------------------------------------------------------------
// Payload schemas
// ---------------------------------------------------------------------------

export const sendMessagePayloadSchema = z
  .object({
    channelId: id,
    // `min(0)`: content may be empty WHEN attachments are present (a caption-less
    // gif). The cross-field refine below preserves the old "no empty message"
    // rule for text-only sends, so pre-M10 text clients are unaffected.
    content: z.string().max(MESSAGE_MAX_LENGTH),
    nonce: z.string().min(1).max(64),
    attachmentIds: z.array(id).max(ATTACHMENT_MAX_PER_MESSAGE).optional(),
    // ADR 0011 §2: the message this send replies to. Optional/additive — the
    // server validates it exists in the SAME channel. Not palette/kind checked
    // here (it is a message id, validated authoritatively at the API boundary).
    replyToMessageId: id.optional(),
  })
  .refine(
    (p) => p.content.trim().length > 0 || (p.attachmentIds?.length ?? 0) > 0,
    { message: "Message must have text or at least one attachment" },
  );

export const typingPayloadSchema = z.object({
  channelId: id,
  userId: id,
});

export const presencePayloadSchema = z.object({
  userId: id,
  status: presenceStatusSchema,
  // Optional + backward compatible (`.optional()`): pre-platform clients omit it
  // and it is absent for offline users. Present, it is the user's DOMINANT client
  // kind (desktop wins over mobile). Shared by `presence.update` (client→server —
  // ignored there, platform is taken from the handshake, not trusted from a
  // presence frame), `presence.updated`, and the `auth.succeeded` snapshot.
  platform: presencePlatformSchema.optional(),
  // Live custom status (M18). Optional + additive: clients omit it (the gateway
  // is authoritative and fills it from the DB on every broadcast), and pre-M18
  // readers ignore it. Bounded to the same 128 chars the API enforces.
  customStatus: z.string().max(128).nullable().optional(),
});

/**
 * App lifecycle state for the WhatsApp-style push gate (#110). A closed enum so
 * the gateway records exactly "foreground"/"background" per connection — any
 * other value fails validation at the boundary and the frame is rejected.
 */
export const appLifecycleStateSchema = z.enum(["foreground", "background"]);

export const appStatePayloadSchema = z.object({
  state: appLifecycleStateSchema,
});

export const voiceJoinPayloadSchema = z.object({
  channelId: id,
});

export const voiceLeavePayloadSchema = z.object({
  channelId: id,
});

export const messageDeletedPayloadSchema = z.object({
  channelId: id,
  messageId: id,
});

/**
 * Reaction delta (ADR 0011 §3), shared by `message.reaction_added` /
 * `message.reaction_removed`. `emoji` is a plain string on the wire (palette
 * validation is authoritative at the API boundary), bounded to keep the payload
 * small.
 */
export const messageReactionPayloadSchema = z.object({
  channelId: id,
  messageId: id,
  emoji: z.string().min(1).max(32),
  userId: id,
});

export const voiceParticipantPayloadSchema = z.object({
  channelId: id,
  userId: id,
  muted: z.boolean(),
});

/**
 * One occupant in a voice-channel occupancy snapshot (mirrors `VoiceOccupant`).
 * `screenSharing`/`camera` are OPTIONAL + additive — the in-memory snapshot and
 * delta stream omit them; the authoritative media-plane snapshot fills them in.
 */
export const voiceOccupantSchema = z.object({
  userId: id,
  muted: z.boolean(),
  screenSharing: z.boolean().optional(),
  camera: z.boolean().optional(),
});

/** The occupants of a single voice channel (mirrors `VoiceChannelOccupants`). */
export const voiceChannelOccupantsSchema = z.object({
  channelId: id,
  occupants: z.array(voiceOccupantSchema),
});

/**
 * Authoritative voice occupancy snapshot (mirrors `VoiceOccupancySnapshot`).
 * ONE schema shared by the `voice.resync` event payload and the
 * `GET /voice/occupancy` HTTP response so they cannot drift. Only occupied
 * channels appear; an empty `channels` array is the valid "nobody visible" answer.
 */
export const voiceOccupancySnapshotSchema = z.object({
  channels: z.array(voiceChannelOccupantsSchema),
});

/**
 * Single-active-voice-session eviction (user-scoped). `reason` is a closed enum
 * (not free text) so the client maps it to a localized notice; `joined_elsewhere`
 * is the only cause today. Validated on the mutation bus like every other event.
 */
export const voiceSessionReplacedPayloadSchema = z.object({
  roomId: id,
  reason: z.literal("joined_elsewhere"),
});

// Media attachments (ADR 0008). `attachmentDTOSchema` mirrors the domain
// `Attachment` EXACTLY — metadata only, no signed URL, no storagePath. Signed
// read URLs are never carried in a message; they are minted per request and
// validated by `attachmentUrlSchema` below.
export const attachmentDTOSchema = z.object({
  id: id,
  messageId: id.nullable(),
  channelId: id,
  uploaderId: id,
  kind: z.enum(["image", "video", "audio"]),
  mime: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  width: z.number().int().nonnegative().nullable(),
  height: z.number().int().nonnegative().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  createdAt: z.string(),
});

/**
 * The batch attachments-URL endpoint response element. This — NOT the message
 * DTO — is the only place a signed read URL appears on the wire (ADR 0008 §2).
 */
export const attachmentUrlSchema = z.object({
  attachmentId: id,
  url: z.string(),
  urlExpiresAt: z.string(),
  thumbnailUrl: z.string().optional(),
});

// Message enrichment (ADR 0011). The reaction summary is aggregated per message
// (one entry per emoji); the reply preview is a lean denormalized quote. Both
// mirror the domain shapes in @demli/types.
export const messageReactionSummarySchema = z.object({
  emoji: z.string().min(1).max(32),
  count: z.number().int().nonnegative(),
  reactedByMe: z.boolean(),
});

export const messageReplyPreviewSchema = z.object({
  id: id,
  authorId: id,
  content: z.string(),
  kind: z.enum(["user", "system"]),
  deleted: z.boolean(),
});

/**
 * A link-preview (unfurl) card (M17), mirroring the domain `MessageEmbed` — a
 * field added to one side without the other fails the `_assertMessageEmbedDTO`
 * check below. Every OG field is nullable (a page may expose only some). `url`
 * and `imageUrl` are plain strings on the wire; the server only ever persists an
 * absolute http(s) `imageUrl` (the unfurl parser drops anything else), so no URL
 * format is asserted here — the payload is presentational metadata, never markup.
 */
export const messageEmbedSchema = z.object({
  url: z.string(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  imageUrl: z.string().nullable(),
  siteName: z.string().nullable(),
  fetchedAt: z.string(),
});

export const messageDTOSchema = z.object({
  id: id,
  channelId: id,
  authorId: id,
  content: z.string(),
  /** Always sent by the server; optional for tolerance ("user" when absent). */
  kind: z.enum(["user", "system"]).optional(),
  /**
   * Attachment metadata for this message (ADR 0008). Optional so text-only
   * messages and pre-M10 fixtures are unchanged. Metadata only — signed URLs
   * are fetched separately (see `attachmentUrlSchema`).
   */
  attachments: z.array(attachmentDTOSchema).optional(),
  /**
   * Aggregated reactions (ADR 0011 §1). Optional/additive — absent === none, so
   * pre-M14 messages are unchanged. Built by page enrichment, not the mapper.
   */
  reactions: z.array(messageReactionSummarySchema).optional(),
  /**
   * The quoted-message preview (ADR 0011 §2), built by enrichment. `null`/absent
   * for non-replies or a hard-deleted target. The raw `replyToMessageId` FK is
   * deliberately NOT on the wire — the client uses this built preview (its `.id`
   * is the target); the codec strips the FK if a mapper includes it.
   */
  replyTo: messageReplyPreviewSchema.nullable().optional(),
  /**
   * Link previews (M17). Optional/additive — absent === none, so pre-M17 messages
   * and every message before its async unfurl completes are unchanged. Populated
   * by GET page enrichment (a repo join); the realtime `message.created` never
   * carries embeds (they are not ready at send time — they arrive later via
   * `message.embeds_updated`).
   */
  embeds: z.array(messageEmbedSchema).optional(),
  /**
   * Pin flag (M17). Optional/additive — absent === not pinned, so pre-M17
   * messages and the realtime `message.created` (never pinned at send time) are
   * unchanged. Set by GET page enrichment; the `message.pinned`/`message.unpinned`
   * events flip it on the client's cached copy.
   */
  pinned: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
  nonce: z.string().optional(),
});

/**
 * `message.embeds_updated` payload (M17). Channel-scoped, so it carries
 * `channelId` for mutation-bus routing plus the full current embed set for
 * `messageId`. Validated on the bus like every other server event.
 */
export const messageEmbedsUpdatedPayloadSchema = z.object({
  channelId: id,
  messageId: id,
  embeds: z.array(messageEmbedSchema),
});

/**
 * `message.pinned` payload (M17). Channel-scoped, so it carries `channelId` for
 * mutation-bus routing plus the pin's own facts. Deliberately thin — no message
 * body (see the events.ts doc); a receiver folds `pinned: true` onto its cached
 * row and refreshes its pin board.
 */
export const messagePinnedPayloadSchema = z.object({
  channelId: id,
  messageId: id,
  pinnedBy: id,
  pinnedAt: z.string(),
});

/** `message.unpinned` payload (M17). The mirror of the above; the row is gone. */
export const messageUnpinnedPayloadSchema = z.object({
  channelId: id,
  messageId: id,
});

/**
 * A custom emoji on the wire (M17), mirroring the domain `CustomEmoji` — a field
 * added to one side without the other fails the `_assertCustomEmojiDTO` check
 * below. Carries NO image URL and NO storage path: emoji images are fetched as
 * short-lived signed URLs from the batch endpoint, exactly like attachments, so
 * this durable record never embeds a URL that expires (§28 — the bucket key must
 * never leave the API).
 */
export const customEmojiSchema = z.object({
  id: id,
  groupId: id,
  name: z.string().min(1).max(CUSTOM_EMOJI_NAME_MAX_LENGTH),
  mime: z.string().min(1).max(255),
  sizeBytes: z.number().int().nonnegative(),
  createdBy: id,
  createdAt: z.string(),
});

/** `emoji.created` payload (M17). Group-scoped; carries the full record. */
export const emojiCreatedPayloadSchema = z.object({
  groupId: id,
  emoji: customEmojiSchema,
});

/** `emoji.deleted` payload (M17). Group-scoped; the id is all a receiver needs. */
export const emojiDeletedPayloadSchema = z.object({
  groupId: id,
  emojiId: id,
});

export const authSucceededPayloadSchema = z.object({
  userId: id,
  presence: z.array(presencePayloadSchema),
  // Optional + additive (`.optional()`): pre-occupancy servers omit it and
  // pre-occupancy clients strip it, so `auth.succeeded` stays backward
  // compatible. Present, it seeds voice-channel occupancy at handshake.
  voiceOccupancy: z.array(voiceChannelOccupantsSchema).optional(),
});

export const realtimeErrorCodeSchema = z.enum([
  "INVALID_PAYLOAD",
  "NOT_A_MEMBER",
  "CHANNEL_NOT_FOUND",
  "INVALID_CHANNEL",
  "RATE_LIMITED",
  "SLOWMODE",
  "MESSAGE_FAILED",
  // M18 (ADR 0017): a DM send refused by a block in either direction.
  "BLOCKED",
  // Migration 0020 (ADR 0019): the sender is timed out in this server.
  "TIMED_OUT",
  // M20 (ADR 0016) watch party — see the RealtimeErrorCode doc for why these are
  // three codes and not one.
  "NOT_IN_VOICE",
  "NOT_HOST",
  "WATCH_NOT_ACTIVE",
  // M20 wave 2: the queue is at WATCH_QUEUE_MAX_ITEMS.
  "WATCH_QUEUE_FULL",
]);

export const errorRaisedPayloadSchema = z.object({
  code: realtimeErrorCodeSchema,
  message: z.string(),
  nonce: z.string().optional(),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
  channelId: id.optional(),
});

// ADR 0007 roles & channel-access payloads.

/** Non-negative integer bitfield; the DB bigint fits safely in a JS number. */
export const permissionBitfieldSchema = z.number().int().nonnegative();

export const roleSchema = z.object({
  id: id,
  groupId: id,
  name: z.string(),
  color: z.string().nullable(),
  position: z.number().int(),
  permissions: permissionBitfieldSchema,
  createdAt: z.string(),
});

export const roleCreatedPayloadSchema = z.object({
  role: roleSchema,
});

export const roleUpdatedPayloadSchema = z.object({
  role: roleSchema,
});

export const roleDeletedPayloadSchema = z.object({
  groupId: id,
  roleId: id,
});

export const memberRolesUpdatedPayloadSchema = z.object({
  groupId: id,
  userId: id,
  roleIds: z.array(id),
});

export const channelAccessChangedPayloadSchema = z.object({
  groupId: id,
  channelId: id,
});

// Channel & member lifecycle payloads (task #43).

/** Mirrors the domain `Channel` EXACTLY — asserted below (`_assertChannelDTO`). */
export const channelSchema = z.object({
  id: id,
  groupId: id,
  kind: z.enum(["text", "voice"]),
  name: z.string(),
  position: z.number().int(),
  description: z.string().nullable().optional(),
  maxParticipants: z.number().int().nullable().optional(),
  slowmodeSeconds: z.number().int().optional(),
  audioBitrateKbps: z.number().int().nullable().optional(),
  restricted: z.boolean().optional(),
  // Age-restricted channel flag (M15). Optional/additive — absent === not NSFW,
  // so pre-M15 channels and fixtures are unchanged.
  nsfw: z.boolean().optional(),
  // Sidebar category (M18). Optional/additive — absent or null === uncategorized,
  // so pre-M18 channels and fixtures are unchanged.
  categoryId: id.nullable().optional(),
  createdAt: z.string(),
});

/**
 * Mirrors the domain `User` — asserted below (`_assertUserDTO`) — with TWO
 * deliberate omissions that are `/users/me`-only and must NEVER travel in
 * realtime events: `friendCode` (ADR 0010 §2) and `birthdate`/`isAdult` (M15 —
 * the raw DOB and its derived age gate are private to the account). zod strips
 * unknown keys on parse, so a mapper that accidentally includes any of them has
 * it removed by the codec before the event reaches any other user. Do NOT add
 * `friendCode`, `birthdate`, or `isAdult` here. `bannerUrl` IS public (like
 * `avatarUrl`) and therefore carried.
 */
export const userSchema = z.object({
  id: id,
  username: z.string(),
  displayName: z.string(),
  avatarUrl: z.string().nullable(),
  bio: z.string().nullable().optional(),
  bannerUrl: z.string().nullable().optional(),
  // Custom status (M18) — PUBLIC, unlike friendCode/birthdate/isAdult, so it
  // rides every user DTO and realtime event exactly like `bio`/`bannerUrl`.
  customStatus: z.string().nullable().optional(),
  customStatusExpiresAt: z.string().nullable().optional(),
  createdAt: z.string(),
});

/** Mirrors `FriendGroupMember` EXACTLY — asserted below (`_assertMemberDTO`). */
export const friendGroupMemberSchema = z.object({
  groupId: id,
  userId: id,
  role: z.enum(["owner", "member", "guest"]),
  roleIds: z.array(id).optional(),
  // Migration 0020 (ADR 0019). Both `.optional()` and additive: a pre-0020
  // server omits them and a pre-0020 client strips them, so `member.joined`
  // stays backward compatible in both directions.
  nickname: z.string().max(MEMBER_NICKNAME_MAX_LENGTH).nullable().optional(),
  timedOutUntil: z.string().nullable().optional(),
  joinedAt: z.string(),
});

export const channelDeletedPayloadSchema = z.object({
  channelId: id,
  groupId: id,
});

export const memberJoinedPayloadSchema = z.object({
  groupId: id,
  member: friendGroupMemberSchema,
  user: userSchema,
});

export const memberLeftPayloadSchema = z.object({
  groupId: id,
  userId: id,
});

// Server-moderation payloads (migration 0017). `member.kicked` / `member.banned`
// are USER-scoped (the target's own devices show the notice); `voice.disconnected`
// is USER-scoped too. All carry a bounded set of ids/strings — validated on the
// mutation bus like every other server event.
export const memberKickedPayloadSchema = z.object({
  groupId: id,
  groupName: z.string(),
});

export const memberBannedPayloadSchema = z.object({
  groupId: id,
  groupName: z.string(),
});

/**
 * Voice force-disconnect (user-scoped, migration 0017). `reason` is a closed enum
 * (not free text) so the client maps it to a localized notice: `moderator` (the
 * disconnect action) or `alone` (last person left in a CALL surface for the idle
 * window — never a server voice channel). Mirrors
 * {@link voiceSessionReplacedPayloadSchema}.
 */
export const voiceDisconnectedPayloadSchema = z.object({
  roomId: id,
  channelId: id,
  reason: z.enum(["moderator", "alone"]),
});

// Group (server / flat group chat) lifecycle payloads (task #49/#50).

/** Mirrors the domain `FriendGroup` EXACTLY — asserted below (`_assertGroupDTO`). */
export const friendGroupSchema = z.object({
  id: id,
  name: z.string(),
  iconUrl: z.string().nullable(),
  bannerUrl: z.string().nullable().optional(),
  ownerId: id,
  kind: z.enum(["server", "group", "dm"]),
  systemChannelId: id.nullable().optional(),
  invitePolicy: z.enum(["members", "roles"]).optional(),
  createdAt: z.string(),
});

export const groupUpdatedPayloadSchema = z.object({
  group: friendGroupSchema,
});

export const groupDeletedPayloadSchema = z.object({
  groupId: id,
});

// Social payloads (ADR 0010). All four events are USER-scoped on the mutation
// bus (`RealtimeMutation.userId`, the third mutually-exclusive scope beside
// `channelId`/`groupId`): the gateway forwards each to exactly the target
// user's connections — never to a channel or group audience.

/** Mirrors the domain `Friendship` EXACTLY — asserted below (`_assertFriendshipDTO`). */
export const friendshipSchema = z.object({
  userA: id,
  userB: id,
  status: z.enum(["pending", "accepted"]),
  requestedBy: id,
  createdAt: z.string(),
  updatedAt: z.string().nullable(),
});

/**
 * Mirrors the domain `Dm` EXACTLY — asserted below (`_assertDmDTO`). The
 * embedded `participant` goes through `userSchema`, which strips `friendCode`
 * (me-only) if a mapper ever includes it.
 */
export const dmSchema = z.object({
  id: id,
  streamId: id,
  participant: userSchema,
  createdAt: z.string(),
});

export const friendRequestReceivedPayloadSchema = z.object({
  request: friendshipSchema,
  requester: userSchema,
});

export const friendRequestAcceptedPayloadSchema = z.object({
  friendship: friendshipSchema,
  friend: userSchema,
});

export const friendRemovedPayloadSchema = z.object({
  userId: id,
});

export const dmCreatedPayloadSchema = z.object({
  dm: dmSchema,
});

// Notification-mute cross-device sync (migration 0013). USER-scoped like the
// social events above. `mute: null` ⇒ the target was unmuted; otherwise it
// carries the active `{ mode, until }` (until null = indefinite).
export const notificationMuteScopeSchema = z.enum(["channel", "group"]);
export const notificationMuteModeSchema = z.enum(["all", "mentions"]);

export const notificationMuteUpdatedPayloadSchema = z.object({
  scope: notificationMuteScopeSchema,
  targetId: id,
  mute: z
    .object({
      mode: notificationMuteModeSchema,
      until: z.string().nullable(),
    })
    .nullable(),
});

// DM-call signaling (ADR 0012 §4). All four events are USER-scoped like the
// social events above. `call.*` carries control metadata only — media is
// LiveKit (§10/§35). `callTargetSchema` is a discriminated union so the SAME
// ring covers a DM call and the group-upgrade invitee.

export const callMediaSchema = z.enum(["audio", "video"]);

export const callStatusSchema = z.enum([
  "ringing",
  "active",
  "ended",
  "missed",
  "declined",
  "canceled",
  "upgraded",
]);

export const callEndReasonSchema = z.enum([
  "declined",
  "canceled",
  "timeout",
  "hung_up",
  "busy",
  "failed",
  "upgraded",
]);

/** Discriminated on `kind` — asserted mutually assignable with `CallTarget`. */
export const callTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("dm"), dmId: id }),
  z.object({ kind: z.literal("group"), groupId: id, voiceChannelId: id }),
]);

/**
 * Mirrors the domain `Group` (the flat-chat projection with `streamId`) EXACTLY
 * — asserted below (`_assertGroupChatDTO`). Distinct from {@link friendGroupSchema}
 * (the full `FriendGroup` row): `call.upgraded` carries this lean shape.
 */
export const groupSchema = z.object({
  id: id,
  name: z.string(),
  iconUrl: z.string().nullable(),
  ownerId: id,
  streamId: id,
  createdAt: z.string(),
});

/**
 * `group_chat.added` payload — the flat-chat {@link groupSchema} projection
 * delivered USER-scoped to a just-added member (the group-chat twin of
 * `dm.created`). Defined here, AFTER `groupSchema`, because it references it (a
 * TDZ trap if placed with the other social payloads above). Validated on the
 * mutation bus like every other server event.
 */
export const groupChatAddedPayloadSchema = z.object({
  group: groupSchema,
});

/** Mirrors the domain `DmCall` EXACTLY — asserted below (`_assertDmCallDTO`). */
export const dmCallSchema = z.object({
  id: id,
  dmId: id,
  roomName: z.string(),
  callerId: id,
  calleeId: id,
  media: callMediaSchema,
  status: callStatusSchema,
  upgradedToGroupId: id.nullable(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
});

/**
 * The `POST /dm-calls` / `/dm-calls/:id/accept` response (ADR 0012 §2). Mirrors
 * the `/media/token` token fields and embeds the created/accepted call. HTTP
 * response shape, not a realtime event — lives here so the API and clients share
 * one typed contract, exactly like {@link attachmentUrlSchema}.
 */
export const dmCallTokenResponseSchema = z.object({
  call: dmCallSchema,
  url: z.string(),
  token: z.string(),
  roomName: z.string(),
  identity: id,
  expiresAt: z.string(),
});

export const callInvitePayloadSchema = z.object({
  callId: id,
  target: callTargetSchema,
  caller: userSchema,
  media: callMediaSchema,
  expiresAt: z.string(),
});

export const callAcceptedPayloadSchema = z.object({
  callId: id,
  target: callTargetSchema,
  callee: userSchema,
});

export const callEndedPayloadSchema = z.object({
  callId: id,
  reason: callEndReasonSchema,
});

export const callUpgradedPayloadSchema = z.object({
  callId: id,
  group: groupSchema,
  voiceChannelId: id,
});

// Session revocation (#98). USER-scoped like the social events above. A NON-EMPTY
// list of the revoked session ids: the gateway matches each live connection's
// session id against it and closes the matches with the auth-expired code. The
// publishers (DELETE /sessions/:id, /sessions/others) only ever emit it with ≥1
// id, so `.min(1)` documents that invariant and rejects a pointless empty kick.
export const sessionRevokedPayloadSchema = z.object({
  sessionIds: z.array(id).min(1),
});

// A public profile changed. The payload carries the PUBLIC `User` DTO through
// `userSchema`, which STRIPS the me-only fields (`friendCode`, `birthdate`,
// `isAdult`) — zod drops unknown keys on parse, so handing this factory a full
// self row (as `/users/me` returns) cannot leak them onto the wire. That strip is
// the security property this event depends on; it is asserted in
// `__tests__/user-updated.test.ts`.
export const userUpdatedPayloadSchema = z.object({
  user: userSchema,
});

// M18 — channel categories, custom status, blocking (migration 0019, ADR 0017).
// The category payloads are GROUP-scoped; the two user payloads are USER-scoped.

/** Mirrors the domain `ChannelCategory` EXACTLY — asserted below. */
export const channelCategorySchema = z.object({
  id: id,
  groupId: id,
  name: z.string(),
  position: z.number().int(),
  createdAt: z.string(),
});

export const categoryCreatedPayloadSchema = z.object({
  category: channelCategorySchema,
});

export const categoryUpdatedPayloadSchema = z.object({
  category: channelCategorySchema,
});

export const categoryDeletedPayloadSchema = z.object({
  groupId: id,
  categoryId: id,
  /** The channels freed to the uncategorized list; bounded like every id list. */
  channelIds: z.array(id).max(500),
});

export const categoryReorderedPayloadSchema = z.object({
  groupId: id,
  categoryIds: z.array(id).max(500),
  channels: z
    .array(
      z.object({
        channelId: id,
        categoryId: id.nullable(),
        position: z.number().int(),
      }),
    )
    .max(500),
});

/**
 * Custom-status delta (M18). `text` is bounded to the SAME 128 chars the API
 * enforces, so an over-long line cannot ride the bus even if a publisher skipped
 * validation. Null = cleared/expired.
 */
export const customStatusUpdatedPayloadSchema = z.object({
  userId: id,
  text: z.string().max(128).nullable(),
  expiresAt: z.string().nullable(),
});

/** Block-list resync signal (M18) — deliberately thin, see the payload doc. */
export const blocksUpdatedPayloadSchema = z.object({
  userId: id,
  blocked: z.boolean(),
});

// Member context menu — nicknames, timeout, ignore (migration 0020, ADR 0019).

/** Per-server nickname changed. GROUP-scoped; null means cleared. */
export const memberNicknameUpdatedPayloadSchema = z.object({
  groupId: id,
  userId: id,
  nickname: z.string().max(MEMBER_NICKNAME_MAX_LENGTH).nullable(),
});

/** Timeout applied or lifted. GROUP-scoped; null `timedOutUntil` means lifted. */
export const memberTimeoutUpdatedPayloadSchema = z.object({
  groupId: id,
  userId: id,
  timedOutUntil: z.string().nullable(),
  actorId: id.nullable(),
});

/** PRIVATE nickname resync — USER-scoped to the viewer only, never the target. */
export const userNicknameUpdatedPayloadSchema = z.object({
  targetId: id,
  nickname: z.string().max(USER_NICKNAME_MAX_LENGTH).nullable(),
});

/** Ignore-list resync signal — thin, mirroring `user.blocks_updated`. */
export const ignoresUpdatedPayloadSchema = z.object({
  userId: id,
  ignored: z.boolean(),
});

// ---------------------------------------------------------------------------
// Watch Party (M20, ADR 0016)
//
// The security-relevant schema in this file. `videoRef` is the one client string
// that ends up inside an iframe URL on every other client's machine, so it is
// validated TWICE: bounded + must normalize here at the boundary, and normalized
// again by the gateway, which stores/broadcasts ONLY the resulting 11-character
// id (`watchVideoIdSchema`). A ref that reaches the handler is therefore already
// known-parseable, and a payload that leaves the server is known-safe.
// ---------------------------------------------------------------------------

export const watchSourceSchema = z.enum(["youtube"]);

export const watchControlActionSchema = z.enum(["play", "pause", "seek"]);

/**
 * A NORMALIZED YouTube video id — the only video shape the server ever emits.
 * Anchored and fixed-length, so nothing that parses here can carry a path
 * traversal, a query string, or a scheme into an embed URL.
 */
export const watchVideoIdSchema = z.string().regex(WATCH_VIDEO_ID_PATTERN);

/**
 * A CLIENT-supplied video reference: a bare id or an ordinary YouTube link.
 * Bounded first (so the parser is never handed an unbounded string) and then
 * required to normalize, which rejects unknown hosts, lookalike domains,
 * non-http(s) schemes, and ids of the wrong shape at the protocol boundary —
 * before any handler sees the frame.
 */
export const watchVideoRefSchema = z
  .string()
  .min(1)
  .max(WATCH_VIDEO_REF_MAX_LENGTH)
  .refine((value) => parseYouTubeVideoId(value) !== null, {
    message: "Not a YouTube video link or id",
  });

/**
 * A playback position in seconds. Finite, non-negative and bounded — an
 * unbounded (or NaN/Infinity) position would be projected forward by the drift
 * heartbeat and land every client's player somewhere different.
 */
export const watchPositionSchema = z
  .number()
  .finite()
  .nonnegative()
  .max(WATCH_POSITION_MAX_SECONDS);

export const watchStartPayloadSchema = z.object({
  channelId: id,
  source: watchSourceSchema,
  videoRef: watchVideoRefSchema,
});

export const watchControlPayloadSchema = z.object({
  channelId: id,
  action: watchControlActionSchema,
  positionSec: watchPositionSchema,
});

export const watchSetVideoPayloadSchema = z.object({
  channelId: id,
  videoRef: watchVideoRefSchema,
});

export const watchTransferHostPayloadSchema = z.object({
  channelId: id,
  toUserId: id,
});

export const watchStopPayloadSchema = z.object({
  channelId: id,
});

/** Shared by `watch.started` and `watch.state` (see the payload doc). */
export const watchSessionStatePayloadSchema = z.object({
  channelId: id,
  hostId: id,
  source: watchSourceSchema,
  videoId: watchVideoIdSchema,
  positionSec: watchPositionSchema,
  playing: z.boolean(),
  serverTime: z.string(),
});

export const watchHostChangedPayloadSchema = z.object({
  channelId: id,
  hostId: id,
});

export const watchStoppedPayloadSchema = z.object({
  channelId: id,
  reason: z.enum(["host_stopped", "channel_empty"]),
});

// --- Queue (M20 wave 2) ----------------------------------------------------

/**
 * A queue item's handle — deliberately a UUID, and deliberately stricter than
 * the ambient `id` every other field on this wire uses.
 *
 * `id` is `min(1).max(128)` because the gateway RELAYS ids the API minted and has
 * no business hard-coding their format. `itemId` is the opposite: it is minted by
 * the CLIENT, and two clients mint into the same queue (the host and the server
 * owner both control it). Under `id`, a client that numbered its rows "1", "2",
 * "3" would collide with the other controller's rows — and because an add is
 * idempotent on `itemId`, a collision does not error, it silently drops the
 * second person's video. A uuid makes that impossible by construction.
 */
export const watchQueueItemIdSchema = z.string().uuid();

/**
 * Display text supplied by the ADDING client for a queued video.
 *
 * Sanitized (not merely bounded) at the protocol boundary: control characters,
 * zero-width characters and bidi overrides are collapsed to spaces before the
 * length cap, so one queue row can never span several visual lines or reorder
 * itself against its neighbours on someone else's screen. Text that reduces to
 * nothing becomes `null` rather than an empty title.
 */
export const watchQueueTitleSchema = z
  .string()
  .max(WATCH_QUEUE_TITLE_MAX_LENGTH * 4)
  .transform((value) => sanitizeWatchDisplayText(value, WATCH_QUEUE_TITLE_MAX_LENGTH));

/** Display duration for a queued video; the same bound a position obeys. */
export const watchQueueDurationSchema = z
  .number()
  .finite()
  .nonnegative()
  .max(WATCH_POSITION_MAX_SECONDS);

/** A server-emitted queue row. `videoId` is always the normalized id. */
export const watchQueueItemSchema = z.object({
  itemId: watchQueueItemIdSchema,
  videoId: watchVideoIdSchema,
  addedBy: id,
  addedAt: z.string(),
  title: z.string().max(WATCH_QUEUE_TITLE_MAX_LENGTH).nullable(),
  durationSeconds: watchQueueDurationSchema.nullable(),
});

export const watchQueueAddPayloadSchema = z.object({
  channelId: id,
  itemId: watchQueueItemIdSchema,
  videoRef: watchVideoRefSchema,
  title: watchQueueTitleSchema.optional(),
  durationSeconds: watchQueueDurationSchema.optional(),
});

export const watchQueueRemovePayloadSchema = z.object({
  channelId: id,
  itemId: watchQueueItemIdSchema,
});

export const watchQueueReorderPayloadSchema = z.object({
  channelId: id,
  // Bounded by the queue cap: a reorder can never name more items than a queue
  // can hold, so a hostile frame cannot hand the server an unbounded array to
  // permute.
  itemIds: z.array(watchQueueItemIdSchema).max(WATCH_QUEUE_MAX_ITEMS),
});

export const watchQueuePlayPayloadSchema = z.object({
  channelId: id,
  itemId: watchQueueItemIdSchema,
});

export const watchEndedPayloadSchema = z.object({
  channelId: id,
  // The id that finished — checked against the session's current video so a
  // duplicate ENDED cannot advance the queue twice.
  videoId: watchVideoIdSchema,
});

export const watchQueueUpdatedPayloadSchema = z.object({
  channelId: id,
  queue: z.array(watchQueueItemSchema).max(WATCH_QUEUE_MAX_ITEMS),
});

// ---------------------------------------------------------------------------
// Event schemas (discriminated unions on `type`)
// ---------------------------------------------------------------------------

export const clientToServerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("message.send"), payload: sendMessagePayloadSchema }),
  z.object({ type: z.literal("typing.start"), payload: typingPayloadSchema }),
  z.object({ type: z.literal("typing.stop"), payload: typingPayloadSchema }),
  z.object({ type: z.literal("presence.update"), payload: presencePayloadSchema }),
  z.object({ type: z.literal("presence.app_state"), payload: appStatePayloadSchema }),
  z.object({ type: z.literal("voice.join"), payload: voiceJoinPayloadSchema }),
  z.object({ type: z.literal("voice.leave"), payload: voiceLeavePayloadSchema }),
  z.object({ type: z.literal("watch.start"), payload: watchStartPayloadSchema }),
  z.object({ type: z.literal("watch.control"), payload: watchControlPayloadSchema }),
  z.object({ type: z.literal("watch.set_video"), payload: watchSetVideoPayloadSchema }),
  z.object({
    type: z.literal("watch.transfer_host"),
    payload: watchTransferHostPayloadSchema,
  }),
  z.object({ type: z.literal("watch.stop"), payload: watchStopPayloadSchema }),
  z.object({ type: z.literal("watch.queue_add"), payload: watchQueueAddPayloadSchema }),
  z.object({
    type: z.literal("watch.queue_remove"),
    payload: watchQueueRemovePayloadSchema,
  }),
  z.object({
    type: z.literal("watch.queue_reorder"),
    payload: watchQueueReorderPayloadSchema,
  }),
  z.object({ type: z.literal("watch.queue_play"), payload: watchQueuePlayPayloadSchema }),
  z.object({ type: z.literal("watch.ended"), payload: watchEndedPayloadSchema }),
]);

export const serverToClientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auth.succeeded"), payload: authSucceededPayloadSchema }),
  z.object({ type: z.literal("error.raised"), payload: errorRaisedPayloadSchema }),
  z.object({ type: z.literal("message.created"), payload: messageDTOSchema }),
  z.object({ type: z.literal("message.updated"), payload: messageDTOSchema }),
  z.object({ type: z.literal("message.deleted"), payload: messageDeletedPayloadSchema }),
  z.object({ type: z.literal("message.reaction_added"), payload: messageReactionPayloadSchema }),
  z.object({ type: z.literal("message.reaction_removed"), payload: messageReactionPayloadSchema }),
  z.object({
    type: z.literal("message.embeds_updated"),
    payload: messageEmbedsUpdatedPayloadSchema,
  }),
  z.object({ type: z.literal("message.pinned"), payload: messagePinnedPayloadSchema }),
  z.object({ type: z.literal("message.unpinned"), payload: messageUnpinnedPayloadSchema }),
  z.object({ type: z.literal("emoji.created"), payload: emojiCreatedPayloadSchema }),
  z.object({ type: z.literal("emoji.deleted"), payload: emojiDeletedPayloadSchema }),
  z.object({ type: z.literal("typing.started"), payload: typingPayloadSchema }),
  z.object({ type: z.literal("typing.stopped"), payload: typingPayloadSchema }),
  z.object({ type: z.literal("presence.updated"), payload: presencePayloadSchema }),
  z.object({ type: z.literal("voice.participant_joined"), payload: voiceParticipantPayloadSchema }),
  z.object({ type: z.literal("voice.participant_left"), payload: voiceParticipantPayloadSchema }),
  z.object({
    type: z.literal("voice.session_replaced"),
    payload: voiceSessionReplacedPayloadSchema,
  }),
  z.object({ type: z.literal("voice.resync"), payload: voiceOccupancySnapshotSchema }),
  z.object({ type: z.literal("role.created"), payload: roleCreatedPayloadSchema }),
  z.object({ type: z.literal("role.updated"), payload: roleUpdatedPayloadSchema }),
  z.object({ type: z.literal("role.deleted"), payload: roleDeletedPayloadSchema }),
  z.object({ type: z.literal("member.roles_updated"), payload: memberRolesUpdatedPayloadSchema }),
  z.object({ type: z.literal("channel.access_changed"), payload: channelAccessChangedPayloadSchema }),
  z.object({ type: z.literal("channel.created"), payload: channelSchema }),
  z.object({ type: z.literal("channel.updated"), payload: channelSchema }),
  z.object({ type: z.literal("channel.deleted"), payload: channelDeletedPayloadSchema }),
  z.object({ type: z.literal("member.joined"), payload: memberJoinedPayloadSchema }),
  z.object({ type: z.literal("member.left"), payload: memberLeftPayloadSchema }),
  z.object({ type: z.literal("member.kicked"), payload: memberKickedPayloadSchema }),
  z.object({ type: z.literal("member.banned"), payload: memberBannedPayloadSchema }),
  z.object({
    type: z.literal("voice.disconnected"),
    payload: voiceDisconnectedPayloadSchema,
  }),
  z.object({ type: z.literal("group.updated"), payload: groupUpdatedPayloadSchema }),
  z.object({ type: z.literal("group.deleted"), payload: groupDeletedPayloadSchema }),
  z.object({
    type: z.literal("friend.request_received"),
    payload: friendRequestReceivedPayloadSchema,
  }),
  z.object({
    type: z.literal("friend.request_accepted"),
    payload: friendRequestAcceptedPayloadSchema,
  }),
  z.object({ type: z.literal("friend.removed"), payload: friendRemovedPayloadSchema }),
  z.object({ type: z.literal("dm.created"), payload: dmCreatedPayloadSchema }),
  z.object({ type: z.literal("group_chat.added"), payload: groupChatAddedPayloadSchema }),
  z.object({
    type: z.literal("notification_mute.updated"),
    payload: notificationMuteUpdatedPayloadSchema,
  }),
  z.object({ type: z.literal("call.invite"), payload: callInvitePayloadSchema }),
  z.object({ type: z.literal("call.accepted"), payload: callAcceptedPayloadSchema }),
  z.object({ type: z.literal("call.ended"), payload: callEndedPayloadSchema }),
  z.object({ type: z.literal("call.upgraded"), payload: callUpgradedPayloadSchema }),
  z.object({ type: z.literal("session.revoked"), payload: sessionRevokedPayloadSchema }),
  z.object({ type: z.literal("user.updated"), payload: userUpdatedPayloadSchema }),
  z.object({ type: z.literal("category.created"), payload: categoryCreatedPayloadSchema }),
  z.object({ type: z.literal("category.updated"), payload: categoryUpdatedPayloadSchema }),
  z.object({ type: z.literal("category.deleted"), payload: categoryDeletedPayloadSchema }),
  z.object({
    type: z.literal("category.reordered"),
    payload: categoryReorderedPayloadSchema,
  }),
  z.object({
    type: z.literal("user.custom_status_updated"),
    payload: customStatusUpdatedPayloadSchema,
  }),
  z.object({ type: z.literal("user.blocks_updated"), payload: blocksUpdatedPayloadSchema }),
  z.object({
    type: z.literal("member.nickname_updated"),
    payload: memberNicknameUpdatedPayloadSchema,
  }),
  z.object({
    type: z.literal("member.timeout_updated"),
    payload: memberTimeoutUpdatedPayloadSchema,
  }),
  z.object({
    type: z.literal("user.nickname_updated"),
    payload: userNicknameUpdatedPayloadSchema,
  }),
  z.object({ type: z.literal("user.ignores_updated"), payload: ignoresUpdatedPayloadSchema }),
  z.object({ type: z.literal("watch.started"), payload: watchSessionStatePayloadSchema }),
  z.object({ type: z.literal("watch.state"), payload: watchSessionStatePayloadSchema }),
  z.object({ type: z.literal("watch.host_changed"), payload: watchHostChangedPayloadSchema }),
  z.object({ type: z.literal("watch.stopped"), payload: watchStoppedPayloadSchema }),
  z.object({
    type: z.literal("watch.queue_updated"),
    payload: watchQueueUpdatedPayloadSchema,
  }),
]);

/** Envelope wrapping every server→client event. */
export const serverEnvelopeSchema = z.object({
  event: serverToClientEventSchema,
  seq: z.number().int().nonnegative(),
  sentAt: z.string(),
});

/** All client event type literals, derived for gateways/tooling. */
export const CLIENT_EVENT_TYPES = clientToServerEventSchema.options.map(
  (option) => option.shape.type.value,
);

/** All server event type literals, derived for clients/tooling. */
export const SERVER_EVENT_TYPES = serverToClientEventSchema.options.map(
  (option) => option.shape.type.value,
);

// ---------------------------------------------------------------------------
// Compile-time contract sync checks (schemas must match the unions exactly)
// ---------------------------------------------------------------------------

type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

const _assertClient: MutuallyAssignable<
  z.infer<typeof clientToServerEventSchema>,
  ClientToServerEvent
> = true;
const _assertServer: MutuallyAssignable<
  z.infer<typeof serverToClientEventSchema>,
  ServerToClientEvent
> = true;
const _assertEnvelope: z.infer<typeof serverEnvelopeSchema> extends ServerEnvelope
  ? true
  : false = true;

// The serialized attachment must mirror the domain `Attachment` EXACTLY — this
// fails to compile if a field (e.g. a signed URL or storagePath) is ever added
// to one side but not the other, guarding the "no URL/path on the message" rule.
const _assertAttachmentDTO: MutuallyAssignable<
  z.infer<typeof attachmentDTOSchema>,
  Attachment
> = true;

// The config MIME/size whitelist must cover exactly the `attachment_kind` union
// — a new kind in @demli/types without a config limit (or vice-versa) fails
// to compile here rather than at runtime. `AttachmentLimitKind` is config's
// `keyof typeof ATTACHMENT_LIMITS`.
const _assertAttachmentKinds: MutuallyAssignable<AttachmentKind, AttachmentLimitKind> = true;

// The lifecycle wire types must mirror the domain shapes EXACTLY — a field added
// to `Channel` / `User` / `FriendGroupMember` without the matching schema change
// (or vice-versa) fails to compile here rather than silently dropping on the wire.
const _assertChannelDTO: MutuallyAssignable<z.infer<typeof channelSchema>, Channel> = true;
const _assertUserDTO: MutuallyAssignable<z.infer<typeof userSchema>, User> = true;
const _assertMemberDTO: MutuallyAssignable<
  z.infer<typeof friendGroupMemberSchema>,
  FriendGroupMember
> = true;
const _assertGroupDTO: MutuallyAssignable<z.infer<typeof friendGroupSchema>, FriendGroup> = true;

// The social wire types must mirror the domain shapes EXACTLY (ADR 0010) — a
// field added to `Friendship` / `Dm` without the matching schema change (or
// vice-versa) fails to compile here rather than silently dropping on the wire.
const _assertFriendshipDTO: MutuallyAssignable<
  z.infer<typeof friendshipSchema>,
  Friendship
> = true;
const _assertDmDTO: MutuallyAssignable<z.infer<typeof dmSchema>, Dm> = true;

// The link-preview wire type must mirror the domain `MessageEmbed` EXACTLY (M17)
// — a field added to one side without the other fails to compile here rather than
// silently dropping on the wire (embeds ride the mutation bus through this codec).
const _assertMessageEmbedDTO: MutuallyAssignable<
  z.infer<typeof messageEmbedSchema>,
  MessageEmbed
> = true;

// The custom-emoji wire type must mirror the domain `CustomEmoji` EXACTLY (M17).
// This is the guard that keeps `storagePath` OFF the wire: adding it to the
// domain type without adding it here (or vice-versa) fails to compile, so the
// bucket key cannot silently start shipping to clients (§28) — the same role
// `_assertAttachmentDTO` plays for attachments.
const _assertCustomEmojiDTO: MutuallyAssignable<
  z.infer<typeof customEmojiSchema>,
  CustomEmoji
> = true;

// The DM-call wire types must mirror the domain shapes EXACTLY (ADR 0012) — a
// field added to `CallTarget` / `DmCall` / `Group` without the matching schema
// change (or vice-versa) fails to compile here rather than silently dropping on
// the wire.
const _assertCallTarget: MutuallyAssignable<z.infer<typeof callTargetSchema>, CallTarget> = true;
const _assertDmCallDTO: MutuallyAssignable<z.infer<typeof dmCallSchema>, DmCall> = true;
const _assertGroupChatDTO: MutuallyAssignable<z.infer<typeof groupSchema>, Group> = true;

// The category wire type must mirror the domain `ChannelCategory` EXACTLY (M18)
// — a field added to one side without the other fails to compile here rather than
// silently dropping on the wire (categories ride the mutation bus through this codec).
const _assertChannelCategoryDTO: MutuallyAssignable<
  z.infer<typeof channelCategorySchema>,
  ChannelCategory
> = true;

void _assertClient;
void _assertServer;
void _assertEnvelope;
void _assertAttachmentDTO;
void _assertAttachmentKinds;
void _assertChannelDTO;
void _assertUserDTO;
void _assertMemberDTO;
void _assertGroupDTO;
void _assertFriendshipDTO;
void _assertDmDTO;
void _assertMessageEmbedDTO;
void _assertCustomEmojiDTO;
void _assertCallTarget;
void _assertDmCallDTO;
void _assertGroupChatDTO;
void _assertChannelCategoryDTO;
