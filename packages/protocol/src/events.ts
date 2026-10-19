/**
 * Typed realtime event contract between clients and the realtime gateway.
 *
 * Rules (see CLAUDE.md §24):
 * - Every event name is a typed literal, never a loose string.
 * - Voice/video media frames NEVER travel over this protocol — WebRTC/LiveKit only.
 * - This package is the only place event names may be defined.
 */

import type {
  Attachment,
  AttachmentId,
  CallEndReason,
  CallId,
  CallMedia,
  CallTarget,
  CategoryId,
  Channel,
  ChannelCategory,
  ChannelId,
  CustomEmoji,
  CustomEmojiId,
  Dm,
  DmCall,
  FriendGroup,
  FriendGroupMember,
  Friendship,
  Group,
  GroupId,
  Message,
  MessageEmbed,
  MessageId,
  NotificationMuteMode,
  NotificationMuteScope,
  PresencePlatform,
  PresenceStatus,
  Role,
  RoleId,
  User,
  UserId,
} from "@demli/types";

// ---------------------------------------------------------------------------
// Payloads
// ---------------------------------------------------------------------------

export interface SendMessagePayload {
  channelId: ChannelId;
  content: string;
  /** Client-generated id for optimistic UI reconciliation. */
  nonce: string;
  /**
   * Ids of already-uploaded, ready, uploader-owned attachments to link to this
   * message (ADR 0008). Optional and additive — text-only sends omit it. When
   * present, `content` may be empty (a caption-less gif); the schema rejects a
   * send that has neither text nor attachments. Capped at
   * `ATTACHMENT_MAX_PER_MESSAGE`.
   */
  attachmentIds?: AttachmentId[];
  /**
   * The message this send replies to (ADR 0011 §2). Optional and additive —
   * non-reply sends omit it, so pre-M14 clients are unaffected. The server
   * validates the target exists and belongs to the SAME channel (else
   * `INVALID_PAYLOAD`); a reply is set at send time and never changed.
   */
  replyToMessageId?: MessageId;
}

export interface TypingPayload {
  channelId: ChannelId;
  userId: UserId;
}

/**
 * Presence for one user. Shared by `presence.update` (client→server),
 * `presence.updated` (server→client) and the `auth.succeeded` snapshot.
 *
 * DIRECTIONAL MEANING of `status` (ADR 0020 — unchanged wire shape, so pre-ADR
 * clients keep working as-is):
 * - client→server, `presence.update`: "THIS CONNECTION declares `status`". The
 *   gateway records it against the sending socket, not the account.
 * - server→client, `presence.updated` / snapshot: the ACCOUNT's status, derived
 *   from every live connection (`derivePresenceStatus`) and then masked for peers
 *   (`publicPresenceStatus`).
 *
 * The distinction matters because availability is per-device: a desktop's
 * auto-away timer only knows about that machine, so its "idle" must not speak for
 * a phone that is wide awake.
 *
 * WHO RECEIVES WHICH FORM (M16 — same wire shape, the meaning was always this,
 * the gateway now actually does it):
 * - A PEER (co-member / accepted friend) receives the MASKED status: `invisible`
 *   arrives as `offline`, with no `platform`.
 * - The SUBJECT's own sockets receive `presence.updated` about themselves with
 *   the REAL status — `invisible` stays `invisible`, never `offline` — so a status
 *   picked on one device repaints the user's other devices (ADR 0020 derivation:
 *   a phone's `dnd`/`invisible` holds for the whole account). The originating
 *   device gets it too, as the derived answer to its own declaration. The socket
 *   whose HANDSHAKE triggered a broadcast is the one exception: it learns its
 *   real status from the echo of its own connect-time re-assert instead.
 * - The `auth.succeeded` snapshot holds PEERS ONLY (masked); the connecting user
 *   is never in it, and seeds their own dot from their locally chosen status.
 *
 * Clients must still treat a self `offline` as impossible and drop it: they are
 * reading it on a live socket, and a pre-M16 gateway sent self the peer mask.
 */
export interface PresencePayload {
  userId: UserId;
  status: PresenceStatus;
  /**
   * The client kind the user is (dominantly) connected from — desktop wins over
   * mobile (ADR/§10). Optional and additive: omitted for offline users and for
   * pre-platform clients, and unknown to old readers, so this is a fully
   * backward-compatible extension of `presence.updated`, `presence.update`, and
   * the `auth.succeeded` presence snapshot (all share this payload).
   */
  platform?: PresencePlatform;
  /**
   * The user's live custom status line (M18), or null when they have none. Optional
   * and additive: unknown to pre-M18 readers, absent on payloads built by clients,
   * and filled in by the gateway on every server-side presence broadcast + the
   * `auth.succeeded` snapshot — so a status change propagates to the same audience
   * (co-members ∪ accepted friends) that already sees the status dot, with no new
   * routing. The DURABLE copy still rides `User.customStatus` on every user DTO;
   * this is the live delta for member lists that are already presence-driven.
   */
  customStatus?: string | null;
}

/**
 * The client's application lifecycle state for THIS connection (#110). Purely a
 * TRANSPORT concern for the WhatsApp-style push gate — it is NEVER shown as a
 * presence status to other users (a backgrounded phone still reads "online" to
 * peers). "foreground" = the app is on screen and actively listening; a message
 * to a non-active surface shows an in-app banner, so no OS push is needed.
 * "background" = the socket is alive but the app is off screen, so the user is
 * "away" for push purposes and MUST receive an OS push (this is the gap behind
 * the founder's "desktop→phone message, no notification" report). A connection
 * that never reports one defaults to "foreground" (the gateway writes it on
 * connect), so pre-#110 clients behave exactly as before.
 */
export type AppLifecycleState = "foreground" | "background";

/**
 * `presence.app_state` (client→server, #110). The client reports when it moves
 * between foreground and background so the gateway can record it PER CONNECTION
 * (a Redis hash keyed by connection id). The push gate then treats a user as
 * "away" — and pushes — only when NONE of their live connections is foreground
 * (all offline or backgrounded), matching WhatsApp. Carries no `userId`/
 * `connectionId`: the gateway authoritatively uses the authenticated socket's
 * own identity, never a client-supplied one. First reported by mobile
 * (AppState), but the event is platform-agnostic — desktop may report it too.
 */
export interface AppStatePayload {
  state: AppLifecycleState;
}

export interface VoiceJoinPayload {
  channelId: ChannelId;
}

export interface VoiceLeavePayload {
  channelId: ChannelId;
}

export interface MessageDeletedPayload {
  channelId: ChannelId;
  messageId: string;
}

/**
 * A single reaction delta (ADR 0011 §3), shared by `message.reaction_added` and
 * `message.reaction_removed` (mirroring how `typing.started`/`typing.stopped`
 * share {@link TypingPayload}). Deliberately a DELTA, not a full summary: the
 * client folds it into the target message's cached `reactions` (bump/drop the
 * emoji's count; toggle `reactedByMe` when `userId` is the viewer). Both events
 * are CHANNEL-scoped on the mutation bus — routed by `channelId` exactly like
 * `message.created`, so they need no new gateway code.
 */
export interface MessageReactionPayload {
  channelId: ChannelId;
  messageId: MessageId;
  /** The reaction key: a single unicode emoji, or a `:name:` custom-emoji shortcode (M17). */
  emoji: string;
  /** The user who added/removed the reaction. */
  userId: UserId;
}

export interface VoiceParticipantPayload {
  channelId: ChannelId;
  userId: UserId;
  muted: boolean;
}

/**
 * One member currently connected to a voice channel, as it appears in an
 * occupancy snapshot. Deliberately mirrors the per-user fields of
 * {@link VoiceParticipantPayload} (minus `channelId`, which is carried once by
 * the enclosing {@link VoiceChannelOccupants}) so a client folds a snapshot
 * occupant and a `voice.participant_joined` delta into the SAME participant
 * shape. `muted` is part of the contract for forward-compat with a future
 * mute event; the in-memory `auth.succeeded` snapshot emits it `false`.
 *
 * `screenSharing`/`camera` are OPTIONAL and additive: the in-memory
 * `auth.succeeded` snapshot and the `voice.participant_joined/left` delta stream
 * omit them (unknown, so old readers are unaffected), while the AUTHORITATIVE
 * media-plane snapshot (`voice.resync` + `GET /voice/occupancy`, sourced from
 * LiveKit) fills them in — this is what heals the "I see a screen share, my peer
 * doesn't" desync at its root: the live published tracks are the ground truth.
 */
export interface VoiceOccupant {
  userId: UserId;
  muted: boolean;
  /**
   * True when this member is publishing a screen-share track right now (media
   * plane truth). Absent in the in-memory snapshot / delta stream.
   */
  screenSharing?: boolean;
  /**
   * True when this member is publishing a camera track right now (media plane
   * truth). Absent in the in-memory snapshot / delta stream.
   */
  camera?: boolean;
}

/**
 * The current occupants of a single voice channel. One entry per visible voice
 * channel appears in the {@link AuthSucceededPayload.voiceOccupancy} snapshot
 * and in the authoritative {@link VoiceOccupancySnapshot}.
 */
export interface VoiceChannelOccupants {
  channelId: ChannelId;
  occupants: VoiceOccupant[];
}

/**
 * Authoritative, point-in-time voice occupancy: every voice channel the reader
 * can SEE that currently has ≥1 occupant, each with its live occupants and their
 * screen-share/camera state. Sourced from the media plane (LiveKit) — the ground
 * truth for who is connected and who is sharing — so it self-heals any occupancy
 * or screen-share desync left by a missed realtime delta.
 *
 * ONE shape shared by two delivery paths so they cannot drift:
 *  - the `voice.resync` server event (pushed on every (re)connect), and
 *  - the `GET /voice/occupancy` HTTP response (pulled on app focus).
 *
 * Only OCCUPIED channels are present; an empty `channels` array is the valid
 * "nobody is in any voice channel you can see" answer (the client authoritatively
 * clears its per-channel occupancy on receipt). Visibility is enforced at both
 * boundaries: a voice channel the reader may not see never appears here (§28).
 */
export interface VoiceOccupancySnapshot {
  channels: VoiceChannelOccupants[];
}

/**
 * Payload of the `voice.resync` server event — the authoritative occupancy
 * snapshot above, delivered over the socket. Sent to a connection right after
 * `auth.succeeded` and on every reconnect (each reconnect is a fresh handshake),
 * so the client re-seats on ground truth without waiting for the next delta.
 * Identical shape to the HTTP endpoint's response.
 */
export type VoiceResyncPayload = VoiceOccupancySnapshot;

/**
 * Why a user's voice session was replaced (single-active-voice-session model —
 * a user is in AT MOST one voice room across all devices).
 * A typed reason (not free text) so the client localizes the notice; today the
 * only cause is a join from another device/room.
 */
export type VoiceSessionReplacedReason = "joined_elsewhere";

/**
 * USER-scoped (like the social events): the server issued the user a media token
 * for a DIFFERENT voice room than the one they were in, so their previous
 * session is being evicted (the SFU participant is force-removed server-side).
 * The gateway forwards this to ALL the user's live connections; the device that
 * was in `roomId` cleanly leaves voice and shows the localized notice, while the
 * device that just joined (now in another room) ignores it — see the client
 * roomId guard. Media stays on WebRTC/LiveKit; this is only the control signal
 * (CLAUDE.md §10/§35).
 */
export interface VoiceSessionReplacedPayload {
  /** The room the evicted session was in — the client leaves exactly this room. */
  roomId: ChannelId;
  /** Why the session was replaced, so the client can localize the message. */
  reason: VoiceSessionReplacedReason;
}

/**
 * The serialized, over-the-wire form of an {@link Attachment} (ADR 0008).
 *
 * It is intentionally IDENTICAL to the domain `Attachment` — metadata only.
 * The signed read URL is NOT carried here: access URLs are short-lived (~1 h)
 * and channel-authorized per request, so they are minted on demand by the batch
 * attachments-URL endpoint and returned as {@link AttachmentUrl}, never baked
 * into this durable, cacheable message payload. Kept as a distinct name so the
 * wire contract has one obvious extension point without touching the domain type.
 */
export type AttachmentDTO = Attachment;

/**
 * A short-lived signed read URL for one attachment (ADR 0008 §2), returned by
 * the batch `POST /channels/:channelId/attachments/urls` endpoint — the SOLE
 * source of playable/renderable URLs. Clients request these lazily when a tile
 * nears the viewport and re-request when `urlExpiresAt` passes. This is an HTTP
 * response shape, not a realtime event; it lives here so the API (mints it) and
 * the clients (consume it) share one typed contract and cannot drift.
 */
export interface AttachmentUrl {
  attachmentId: AttachmentId;
  /** Short-lived signed URL for the full object. */
  url: string;
  /** ISO instant at which `url` stops working and must be re-requested. */
  urlExpiresAt: string;
  /** Optional signed URL for a server-side image transform, when available. */
  thumbnailUrl?: string;
}

/**
 * The over-the-wire form of a {@link DmCall} (ADR 0012 §7/§8). Intentionally
 * IDENTICAL to the domain type — the call log carries no server-internal field.
 * Kept as a distinct name (mirroring `AttachmentDTO`/`MessageDTO`) so the wire
 * contract has one obvious extension point without touching the domain type.
 */
export type DmCallDTO = DmCall;

/**
 * The response to `POST /dm-calls` (returns the caller's token) and
 * `POST /dm-calls/:id/accept` (returns the callee's token), ADR 0012 §2. It
 * MIRRORS {@link MediaTokenResponse} (the `/media/token` shape) so the media
 * engine's join path is identical for a DM call and a voice channel — `url`,
 * `token`, `roomName` (`dmcall:<id>`), `identity`, `expiresAt` — and ALSO
 * carries the {@link DmCallDTO} it just created/accepted, so the client learns
 * the `callId`, ring `expiresAt`, and status WITHOUT parsing the room string.
 * There is deliberately no arbitrary-room token endpoint; a call-room token is
 * minted ONLY through this gated lifecycle response.
 */
export interface DmCallTokenResponse {
  /** The call this token admits the user to (id, room, status, timing). */
  call: DmCallDTO;
  /** LiveKit websocket URL the client should connect to. */
  url: string;
  /** LiveKit access token (JWT). */
  token: string;
  /** LiveKit room name — always `call.roomName` (`dmcall:<id>`). */
  roomName: string;
  /** Token identity — always the authenticated user id. */
  identity: string;
  /** ISO timestamp after which the token is no longer valid. */
  expiresAt: string;
}

export type MessageDTO = Message & {
  /** Echoes the client nonce when the message originated from this client. */
  nonce?: string;
};

/**
 * Link previews became available for a message (M17). CHANNEL-scoped on the
 * mutation bus — routed by `channelId` exactly like `message.created`, so it
 * needs NO new gateway routing code (the generic channel fan-out delivers it to
 * the channel's visibility-filtered subscribers). Emitted by the async unfurl
 * service AFTER the message was already sent, so the client folds `embeds` onto
 * its cached copy of `messageId`. `embeds` is the FULL current set for the
 * message (a replace, not a delta); an empty array is never emitted — the service
 * only publishes once it has ≥1 card.
 */
export interface MessageEmbedsUpdatedPayload {
  channelId: ChannelId;
  messageId: MessageId;
  embeds: MessageEmbed[];
}

/**
 * A message was pinned to its channel's board (M17). CHANNEL-scoped on the
 * mutation bus — routed by `channelId` exactly like `message.created`, so it
 * needs NO new gateway routing code.
 *
 * Deliberately THIN: it carries the pin's own facts (who, when) but NOT the
 * message. Two reasons. First, every client that can see the channel already has
 * the message cached when it is a recent one, and folding a `pinned: true` flag
 * onto that cached row is a single-row update rather than a list rebuild (§27).
 * Second, pinning an OLD message must not push its full body — with attachments,
 * embeds and reply preview — to every connected member; those clients simply
 * invalidate their pin-board query and refetch it if the panel is open.
 */
export interface MessagePinnedPayload {
  channelId: ChannelId;
  messageId: MessageId;
  /** The member who pinned it. */
  pinnedBy: UserId;
  /** ISO instant the pin was created. */
  pinnedAt: string;
}

/**
 * A message was unpinned (M17). CHANNEL-scoped, the mirror of
 * {@link MessagePinnedPayload}. Carries no pin metadata — the row is gone, so
 * `messageId` is everything a receiver needs to clear the flag and drop the entry
 * from its board. Also emitted when a PINNED message is deleted, so a pin board
 * never keeps a dangling entry.
 */
export interface MessageUnpinnedPayload {
  channelId: ChannelId;
  messageId: MessageId;
}

// ---------------------------------------------------------------------------
// Custom-emoji payloads (M17, server→client only)
//
// Both are GROUP-scoped on the mutation bus (`RealtimeMutation.groupId`) — an
// emoji belongs to a group and every member's picker and message renderer must
// learn about it. All emoji mutations happen over HTTP (`/groups/:id/emojis`);
// these events only tell connected clients to fold the change into their cached
// per-group emoji map, so a `:name:` typed by one member renders for everyone
// without a reconnect.
//
// Unlike the role/access group events these carry NO subscription implication —
// an emoji cannot change channel visibility — so the gateway forwards them
// WITHOUT the visibility resync those events trigger (§27).
// ---------------------------------------------------------------------------

/**
 * An emoji was added to a group. Carries the full {@link CustomEmoji} record so
 * the client's `name → id` lookup table updates with no extra fetch. The image
 * URL is deliberately absent (the record carries none): clients mint short-lived
 * signed URLs from the batch emoji-URL endpoint for the emoji they actually
 * render, exactly like attachments.
 */
export interface EmojiCreatedPayload {
  groupId: GroupId;
  emoji: CustomEmoji;
}

/**
 * An emoji was removed from a group. Clients drop it from their lookup table;
 * any `:name:` already sitting in message history then renders as literal text
 * again, which is the intended graceful degradation — message CONTENT stores the
 * shortcode, never a resolved image reference, so deleting an emoji can never
 * leave a broken image in the scrollback.
 */
export interface EmojiDeletedPayload {
  groupId: GroupId;
  emojiId: CustomEmojiId;
}

// ---------------------------------------------------------------------------
// Roles & channel-access payloads (ADR 0007, server→client only)
//
// All role/access mutations happen over HTTP; these events only notify
// connected clients so they refetch and re-apply the visibility filter. Every
// payload is group-scoped — `role.created`/`role.updated` carry the group id
// inside `role.groupId`, the others carry an explicit `groupId` — so the
// mutation bus can route each event to exactly the affected group's connections
// (see the group-scoped bus variant, ADR 0007 §"Channel visibility × WS
// gateway").
// ---------------------------------------------------------------------------

export interface RoleCreatedPayload {
  role: Role;
}

export interface RoleUpdatedPayload {
  role: Role;
}

export interface RoleDeletedPayload {
  groupId: GroupId;
  roleId: RoleId;
}

export interface MemberRolesUpdatedPayload {
  groupId: GroupId;
  userId: UserId;
  roleIds: RoleId[];
}

/**
 * Thin signal that a channel's role-access list changed. Carries no access
 * detail (that would leak a restricted channel's shape): clients refetch the
 * group's channels and re-apply the visibility filter. Sent to the whole group
 * because losers of access must hear it too (ADR 0007).
 */
export interface ChannelAccessChangedPayload {
  groupId: GroupId;
  channelId: ChannelId;
}

// ---------------------------------------------------------------------------
// Channel & member lifecycle payloads (task #43, server→client only)
//
// A channel created/renamed/deleted, or a member joining/leaving a server, must
// reach every connected member of that group so their cached channel/member
// views update WITHOUT a manual navigation or reconnect (the class of bug where
// a freshly created voice channel stays invisible until you flip away and back).
// All are group-scoped: routed on the mutation bus by `groupId` exactly like the
// role/access events above. The gateway ALSO reconciles subscriptions off these
// (subscribe visible members to a new channel, drop everyone from a deleted one,
// (un)index a joining/leaving member) — the thin event alone only refreshes UI.
//
// `channel.created` / `channel.updated` carry the full {@link Channel} (its
// `groupId` is the routing scope); the rest carry an explicit `groupId`.
// ---------------------------------------------------------------------------

export interface ChannelDeletedPayload {
  channelId: ChannelId;
  groupId: GroupId;
}

export interface MemberJoinedPayload {
  groupId: GroupId;
  member: FriendGroupMember;
  user: User;
}

export interface MemberLeftPayload {
  groupId: GroupId;
  userId: UserId;
}

// ---------------------------------------------------------------------------
// Group (server / flat group chat) lifecycle payloads (task #49/#50,
// server→client only)
//
// A whole server or flat group chat being renamed or destroyed must reach every
// connected member so their group list, roster and — when they are looking at
// the affected group — the surface they are on all update WITHOUT a manual
// reconnect. Both are group-scoped: routed on the mutation bus by `groupId`,
// exactly like the channel/member lifecycle events above.
//
// DM "groups" (`friend_groups.kind='dm'`, ADR 0010) are EXEMPT from this
// lifecycle: a DM is never deleted or auto-pruned when it empties — it is hidden
// per-user (`hidden_at`) instead — so the API never emits these events for a DM.
//
// `group.updated` carries the full {@link FriendGroup} (its `id` is the routing
// scope); `group.deleted` carries only the id — by the time it fires the row and
// everything it owned (channels, messages, members, invites) are already gone,
// so there is nothing else to send.
// ---------------------------------------------------------------------------

export interface GroupUpdatedPayload {
  group: FriendGroup;
}

export interface GroupDeletedPayload {
  groupId: GroupId;
}

// ---------------------------------------------------------------------------
// Social payloads (ADR 0010, server→client only)
//
// All four events are USER-scoped on the mutation bus (`RealtimeMutation.userId`
// — the third, mutually-exclusive scope beside `channelId`/`groupId`): the
// gateway forwards each to `connectionsByUser.get(userId)` only, never to a
// channel or group audience. Friendship/DM mutations happen over HTTP; these
// events notify the affected user's live connections so friend lists and DM
// lists update without polling or reconnecting.
// ---------------------------------------------------------------------------

/**
 * A pending {@link Friendship} presented as a friend request. Identical shape
 * today — the alias (mirroring `AttachmentDTO`/`MessageDTO`) gives the wire
 * contract an obvious extension point without touching the domain type.
 * `status` is always `"pending"` in this context.
 */
export type FriendRequestDTO = Friendship;

/** To the addressee when someone sends them a friend request. */
export interface FriendRequestReceivedPayload {
  request: FriendRequestDTO;
  /** Hydrated requester so the request row renders with no extra fetch. */
  requester: User;
}

/**
 * To the original requester when the addressee accepts (including the
 * reverse-pending auto-accept path, ADR 0010 §2).
 */
export interface FriendRequestAcceptedPayload {
  friendship: Friendship;
  /** Hydrated new friend so the friends list renders with no extra fetch. */
  friend: User;
}

/**
 * To the other party on decline, cancel, or unfriend — one event covers all
 * three: the friendship row is gone either way, and distinguishing them would
 * leak intent ("declined" vs "cancelled"). The receiver simply drops any
 * relationship state held for `userId`.
 */
export interface FriendRemovedPayload {
  /** The user on the other side of the removed/declined/cancelled row. */
  userId: UserId;
}

/**
 * To BOTH members when a DM is created (each connection gets its own
 * user-scoped copy with `dm.participant` resolved to the other side). The
 * gateway subscribes the recipient's live connections to `dm.streamId` BEFORE
 * forwarding this event, so the new conversation delivers messages without a
 * reconnect (ADR 0010 §4). Not emitted on the idempotent `POST /dms` hit of an
 * existing DM.
 */
export interface DmCreatedPayload {
  dm: Dm;
}

/**
 * To the member just ADDED to a flat group chat (ADR 0005) — the group-chat twin
 * of {@link DmCreatedPayload}. USER-scoped on the mutation bus: a flat group chat
 * is a `friend_groups` row with `kind='group'`, and such rows are NOT indexed in
 * the gateway's group index (`groups.listForUser` is server-only), so the added
 * member is reached through `connectionsByUser`, exactly like `dm.created` — never
 * a group-scoped fan-out. The gateway subscribes the added member's live
 * connections to `group.streamId` BEFORE forwarding this event, so the new
 * conversation delivers messages without a reconnect. Carries the flat-chat
 * {@link Group} projection (with `streamId`) so the client can surface the group
 * in its list and notify with its name in one shot. Emitted ONLY on a genuine add
 * (owner adds a new member), never for an already-present member.
 */
export interface GroupChatAddedPayload {
  group: Group;
}

// ---------------------------------------------------------------------------
// Notification-mute payload (migration 0013, server→client only)
//
// USER-scoped on the mutation bus (`RealtimeMutation.userId`), exactly like the
// social events above: a mute is per-user, so the change must reach the SAME
// user's OTHER devices (mute a channel on the phone → the desktop dims it and
// drops the unread badge at once). The gateway forwards it generically to the
// user's connections — no bespoke routing (it is neither `dm.created` nor
// `friend.request_accepted`, so `handleUserMutation` just fans it out).
//
// The push filter itself lives server-side (packages/notifications) and reads
// the DB directly; this event is ONLY the cross-device UI sync signal.
// ---------------------------------------------------------------------------

/**
 * To the muting user's own connections when they mute/unmute a channel or group
 * (or change the mode/duration). `mute: null` means the target was UNMUTED — the
 * client drops any local mute entry for `(scope, targetId)`; otherwise it upserts
 * the entry. `until` is the ISO auto-expiry instant (null = indefinite). Carries
 * no target detail beyond the id, so it is safe even if a device cannot see the
 * target (it just updates its lookup map).
 */
export interface NotificationMuteUpdatedPayload {
  scope: NotificationMuteScope;
  targetId: string;
  mute: { mode: NotificationMuteMode; until: string | null } | null;
}

// ---------------------------------------------------------------------------
// DM-call signaling payloads (ADR 0012 §4, server→client only)
//
// All four are USER-scoped on the mutation bus (`RealtimeMutation.userId`) —
// exactly like the social events above: the gateway forwards each to the target
// user's connections only, so `call.*` needs NO new gateway routing code. There
// are deliberately NO client→server `call.*` events — control is HTTP over
// `/dm-calls/*`, where the mutual-friend gate, call-log write, token minting,
// rate limits, and offline push already live. Media never rides this protocol
// (§10/§35): these events carry control metadata only; audio/video is LiveKit.
//
// The `target` discriminant ({@link CallTarget}) lets the SAME `call.invite`
// ring a fresh DM call and the group-upgrade invitee.
// ---------------------------------------------------------------------------

/**
 * To the callee when someone starts a call (ADR 0012 §4). Also fired to the
 * third person on upgrade with `target.kind === "group"`. Carries the hydrated
 * `caller` so the ring renders with no extra fetch, and `expiresAt` so the
 * callee UI can show/anticipate the ring deadline.
 */
export interface CallInvitePayload {
  callId: CallId;
  target: CallTarget;
  /** Hydrated initiator so the incoming-call screen renders with no fetch. */
  caller: User;
  /** Media the call was started with (screen share is an in-call action). */
  media: CallMedia;
  /** ISO ring deadline; the caller cancels with `reason:"timeout"` at expiry. */
  expiresAt: string;
}

/** To the caller when the callee accepts (ADR 0012 §4). */
export interface CallAcceptedPayload {
  callId: CallId;
  target: CallTarget;
  /** Hydrated accepter so the caller's in-call UI renders with no fetch. */
  callee: User;
}

/**
 * To the OTHER participant on any terminal outcome (ADR 0012 §4). One event
 * covers decline / cancel / timeout / hang-up / busy / failure / upgrade — the
 * recipient knows its own role, so it maps `reason` to the right UI without the
 * sender leaking intent.
 */
export interface CallEndedPayload {
  callId: CallId;
  reason: CallEndReason;
}

/**
 * To BOTH originals when a call upgrades into a group (ADR 0012 §6). Their UI
 * navigates from "DM call" to the new group's voice channel and sends
 * `voice.join {voiceChannelId}` for occupancy ONLY — media stays put (the voice
 * channel's LiveKit room IS the ongoing call room), so there is zero reconnect.
 */
export interface CallUpgradedPayload {
  callId: CallId;
  group: Group;
  voiceChannelId: ChannelId;
}

// ---------------------------------------------------------------------------
// Session revocation payload (#98, server→client only)
//
// USER-scoped on the mutation bus (`RealtimeMutation.userId`), exactly like the
// social / notification-mute events above: "sign out this device" and "sign out
// everywhere else" (DELETE /sessions/:id, DELETE /sessions/others) revoke one or
// more of the caller's OWN sessions. Before this event a revoked session's LIVE
// WebSocket (and any screen-share it carried) lingered until its NEXT HTTP request
// re-checked the token; the gateway now drops it at once. It forwards this event
// ONLY to the connections whose session id appears in `sessionIds`, then closes
// each with the auth-expired code (4401) — a NON-revoked session of the same user
// (e.g. the device that pressed "sign out others") is left completely untouched.
// Media never rides this protocol (§10/§35); this is a pure control signal.
// ---------------------------------------------------------------------------

/**
 * The sessions that were just revoked. The gateway matches each of the user's
 * live connections' session id against this list, so it targets exactly the
 * sessions that were signed out. Carries only ids — never a token, device label,
 * or user detail (§28) — so it is safe even for a client that logs itself out on
 * receipt without inspecting it.
 */
export interface SessionRevokedPayload {
  sessionIds: string[];
}

/**
 * A user's PUBLIC profile changed (displayName / avatarUrl / bannerUrl / bio).
 * Published by every profile mutation (`PATCH /users/me`, `POST /users/me/avatar`,
 * `POST /users/me/banner`) so a viewer's member sidebar, message rows and profile
 * card update live instead of staying stale until reload.
 *
 * The payload is the PUBLIC `User` DTO and nothing else. `userSchema` is the wire
 * codec, and it deliberately omits the me-only fields — `friendCode` (ADR 0010 §2)
 * and `birthdate`/`isAdult` (M15) — so even a mapper that hands the full self row
 * to the factory has them stripped before the frame leaves the process. Do NOT
 * widen this payload with account-private data.
 *
 * Routing: USER-scoped on the mutation bus (`RealtimeMutation.userId` = the user
 * who changed), but UNLIKE every other user-scoped event the gateway does not
 * deliver it to that user alone — it EXPANDS the recipient set to the same
 * audience presence already uses (co-members of any shared group ∪ accepted
 * friends) plus the user's own other sessions. A user sharing no context with the
 * subject never receives it.
 */
export interface UserUpdatedPayload {
  user: User;
}

// ---------------------------------------------------------------------------
// Server-moderation payloads (migration 0017, server→client only)
//
// `member.kicked` and `member.banned` are USER-scoped on the mutation bus
// (`RealtimeMutation.userId`), exactly like the social / session events above:
// the gateway forwards each to the TARGET user's live connections only, so they
// need NO new gateway routing (the generic user fan-out delivers them). They are
// the "this happened TO YOU" notice — the removed member's own devices show a
// localized "you were removed / banned from ⟨name⟩" and route out. The roster
// refresh + subscription teardown for EVERYONE (and the forced voice-leave of
// the removed member) rides the SEPARATE group-scoped `member.left` the same
// endpoints publish, which the gateway already handles — so these events add a
// notice, never bespoke surgery.
//
// `groupName` is carried because a kick/ban races the group-scoped `member.left`
// that drops the group from the client's cache: by the time this notice lands the
// name may be gone, so it travels with the event and the toast always renders.
// ---------------------------------------------------------------------------

/**
 * To the kicked user's own connections when a moderator removes them from a
 * server (owner ∨ KICK_MEMBERS). A kick removes membership WITHOUT barring
 * rejoin — an invite still works. USER-scoped.
 */
export interface MemberKickedPayload {
  groupId: GroupId;
  /** The server's name, so the notice renders after the group is dropped. */
  groupName: string;
}

/**
 * To the banned user's own connections when a moderator bans them from a server
 * (owner ∨ KICK_MEMBERS). A ban removes membership AND records a `group_bans`
 * row, so no invite can bring them back (§28). USER-scoped.
 */
export interface MemberBannedPayload {
  groupId: GroupId;
  /** The server's name, so the notice renders after the group is dropped. */
  groupName: string;
}

/**
 * Why a user was force-disconnected from a voice room. A typed reason (not free
 * text) so the client localizes the notice. Mirrors
 * {@link VoiceSessionReplacedReason}.
 *
 * - `moderator` — a room moderator used the disconnect action.
 * - `alone` — the user was the last person in a CALL surface (a DM call or a
 *   group-DM voice channel) for the idle window, so the server ended it for them.
 *   Never emitted for a SERVER voice channel: sitting alone in one is a legitimate
 *   use (music, "I'm here") and is deliberately unlimited.
 */
export type VoiceDisconnectedReason = "moderator" | "alone";

/**
 * USER-scoped: a moderator disconnected this user from a voice channel WITHOUT
 * removing them from the server (owner ∨ KICK_MEMBERS). The AUTHORITATIVE media
 * teardown is the SFU force-remove (`RoomServiceClient.removeParticipant`,
 * server-side) — exactly like {@link VoiceSessionReplacedPayload}, whose comment
 * this mirrors — so this event is only the control signal that lets the target's
 * device leave voice cleanly (FSM → idle) and show a localized notice, never an
 * error (§26). The device that is NOT in `roomId` ignores it. Media stays on
 * WebRTC/LiveKit; this carries no frames (§10/§35).
 */
export interface VoiceDisconnectedPayload {
  /** The room the user was removed from — the client leaves exactly this room. */
  roomId: ChannelId;
  /** The voice channel the disconnect happened in (for the UI reference). */
  channelId: ChannelId;
  /** Why they were disconnected, so the client can localize the message. */
  reason: VoiceDisconnectedReason;
}

/**
 * Sent once by the server after the WebSocket handshake token is validated.
 * Carries the authenticated user id plus a presence snapshot of every OTHER user
 * in this user's presence audience (group co-members ∪ accepted friends).
 */
export interface AuthSucceededPayload {
  userId: UserId;
  /**
   * Peers only, masked for peers (`invisible` → `offline`). Never contains an
   * entry for `userId` — see {@link PresencePayload} for where the user's own,
   * unmasked status comes from.
   */
  presence: PresencePayload[];
  /**
   * Point-in-time snapshot of WHO is currently in each voice channel this
   * connection is allowed to SEE — the member list rendered under a voice
   * channel in the sidebar. Optional and additive — omitted by pre-occupancy servers and unknown
   * to pre-occupancy clients (zod strips it), so this is a fully
   * backward-compatible extension, exactly like `platform?` on
   * {@link PresencePayload}. Lets a freshly connected client render existing
   * occupancy WITHOUT waiting for the next join/leave delta; thereafter
   * `voice.participant_joined`/`_left` keep it live, and every reconnect
   * handshake re-sends it so a missed delta self-heals.
   *
   * Visibility: built ONLY from the connection's visibility-filtered voice
   * subscriptions (the same authorization boundary the deltas obey) — a voice
   * channel the user may not see never appears here. Only channels with ≥1
   * occupant are included; empty voice channels are omitted (client defaults
   * them to empty).
   */
  voiceOccupancy?: VoiceChannelOccupants[];
}

/** Typed, user-friendly gateway error codes. Never raw stack traces. */
export type RealtimeErrorCode =
  | "INVALID_PAYLOAD"
  | "NOT_A_MEMBER"
  | "CHANNEL_NOT_FOUND"
  | "INVALID_CHANNEL"
  | "RATE_LIMITED"
  | "SLOWMODE"
  | "MESSAGE_FAILED"
  // M18 (ADR 0017): a DM send refused because a block exists between the two
  // users, in either direction. Mirrors the REST `BLOCKED` ApiError code; one
  // code and one message for both directions, so which side blocked is never
  // disclosed (§28).
  | "BLOCKED"
  // Migration 0020 (ADR 0019): the sender is TIMED OUT in this channel's server.
  // Mirrors the REST `TIMED_OUT` ApiError code so the same refusal reads the same
  // on both transports — a timeout that only held over HTTP would be bypassable
  // by sending over the socket instead.
  | "TIMED_OUT"
  // M20 (ADR 0016). Three codes for the three distinct refusals a voice-scoped
  // action has, kept apart because they need different UI: "join the room first",
  // "ask the host", "there is nothing running". Collapsing them would leave the
  // client guessing which of the three to say.
  //
  // The sender is not IN the voice channel the action targets. Generic on
  // purpose — occupancy is the gate for any future voice-scoped event, not just
  // watch parties.
  | "NOT_IN_VOICE"
  // The sender is neither the watch-party host nor the server owner.
  | "NOT_HOST"
  // The action needs a live session in that channel and there is none (it ended,
  // or the client is acting on a stale view).
  | "WATCH_NOT_ACTIVE"
  // M20 wave 2: the queue already holds WATCH_QUEUE_MAX_ITEMS videos. Its own
  // code because the honest answer ("the queue is full — remove something") is
  // actionable, and INVALID_PAYLOAD would have told the user their video was
  // wrong when it was fine.
  | "WATCH_QUEUE_FULL";

export interface ErrorRaisedPayload {
  code: RealtimeErrorCode;
  message: string;
  /** Echoes the client nonce when the error relates to a message.send. */
  nonce?: string;
  /**
   * SLOWMODE only: seconds until the user may send again in this channel.
   *
   * TIMED_OUT deliberately does NOT reuse this. A slowmode wait is seconds and
   * the client counts it down in place; a timeout can be days, and the useful
   * value is the absolute expiry the roster already carries — not a countdown a
   * client would have to re-derive.
   */
  retryAfterSeconds?: number;
  /**
   * voice.join refusals only: the channel the refused join targeted. Lets the
   * client tell "my voice announcement was refused" from any other refusal and
   * retry it — the gateway can refuse a legitimate join when it has not yet
   * processed the membership that allows it (the DM → group upgrade race).
   */
  channelId?: ChannelId;
}

// ---------------------------------------------------------------------------
// M18 — channel categories, blocking, custom status (migration 0019, ADR 0017)
// ---------------------------------------------------------------------------

/** The category DTO on the wire — the domain shape, unchanged. */
export type ChannelCategoryDTO = ChannelCategory;

/**
 * A category was created or renamed (M18). GROUP-scoped: forwarded to every
 * connected member of the server. Carries the FULL row so clients insert/patch
 * without a refetch. Categories hold no permissions and never move channel
 * visibility, so the gateway forwards these WITHOUT a subscription resync (§27) —
 * the same treatment `channel.updated` and `emoji.*` already get.
 */
export interface CategoryCreatedPayload {
  category: ChannelCategoryDTO;
}

export interface CategoryUpdatedPayload {
  category: ChannelCategoryDTO;
}

/**
 * A category was deleted (M18). GROUP-scoped. Its channels are NOT deleted — the
 * FK is ON DELETE SET NULL, so they become uncategorized. `channelIds` names the
 * channels that were freed so a client can move them to the top-level list
 * without refetching the whole channel list.
 */
export interface CategoryDeletedPayload {
  groupId: GroupId;
  categoryId: CategoryId;
  /** The channels that just became uncategorized (may be empty). */
  channelIds: ChannelId[];
}

/**
 * The sidebar was reordered (M18). GROUP-scoped, and deliberately ONE event for
 * both axes so a client applies a single consistent snapshot rather than
 * reconciling two racing deltas:
 *  - `categoryIds` — the server's categories in their new order;
 *  - `channels`    — every channel whose category and/or position changed, each
 *    with its new placement.
 * Either list may be empty (reordering only categories, or only channels within
 * one category). This is a full statement of the affected placement, so applying
 * it twice is idempotent.
 */
export interface CategoryReorderedPayload {
  groupId: GroupId;
  categoryIds: CategoryId[];
  channels: Array<{
    channelId: ChannelId;
    /** New category, or null for the uncategorized top-level list. */
    categoryId: CategoryId | null;
    position: number;
  }>;
}

/**
 * A user changed (or cleared) their custom status (M18). Published USER-scoped by
 * the API; the gateway forwards it to that user's own devices AND re-broadcasts
 * their presence to the audience (co-members ∪ accepted friends), so peers pick
 * the new line up through the `presence.updated` they already handle. `text` is
 * null when the status was cleared or has expired.
 */
export interface CustomStatusUpdatedPayload {
  userId: UserId;
  /** Plain text, ≤128 chars; escaped at render time (§28). Null = cleared. */
  text: string | null;
  /** ISO auto-expiry instant, or null for an indefinite status. */
  expiresAt: string | null;
}

/**
 * This user's BLOCK LIST changed (M18) — they blocked or unblocked someone.
 * USER-scoped and deliberately THIN (no ids beyond the counterpart): it is a
 * RESYNC signal, reusing the M9-4 pattern. The gateway re-derives that user's
 * block set from the DB and re-applies its message fan-out filter; the client
 * refetches the affected channel(s) so previously hidden history appears (or
 * disappears) at once.
 */
export interface BlocksUpdatedPayload {
  /** The other party in the block that changed. */
  userId: UserId;
  /** true = they are now blocked, false = the block was lifted. */
  blocked: boolean;
}

// ---------------------------------------------------------------------------
// Member context menu — nicknames, timeout, ignore (migration 0020, ADR 0019)
//
// Four events across the TWO different scopes, and the split is the contract:
//
//   member.nickname_updated  GROUP-scoped — the per-server nickname is PUBLIC,
//   member.timeout_updated   so every member of that server must see it change.
//
//   user.nickname_updated    USER-scoped — a private annotation. Delivered ONLY
//   user.ignores_updated     to the viewer's OWN devices, so their phone and
//                            desktop agree without the subject ever being told.
//
// There is deliberately NO event for a NOTE. A note renders in exactly one place
// (the profile card, which fetches it on open), so a bus event would put private
// text on a fan-out path to buy nothing. The narrower the path a secret travels,
// the fewer places can leak it.
// ---------------------------------------------------------------------------

/**
 * A member's per-server nickname changed (or was cleared). GROUP-scoped: this
 * nickname is what EVERYONE in the server sees in the roster, on message rows
 * and in the voice panel, so every connected member needs the update — the same
 * audience and routing as {@link MemberRolesUpdatedPayload}.
 */
export interface MemberNicknameUpdatedPayload {
  groupId: GroupId;
  userId: UserId;
  /** The new nickname, or null when it was cleared (fall back to displayName). */
  nickname: string | null;
}

/**
 * A member was timed out, or their timeout was lifted. GROUP-scoped, and that
 * includes the TARGET (they are a member, so the group fan-out reaches their
 * devices) — no separate user-scoped notice is needed.
 *
 * The event is a UI signal only. The mute itself is enforced server-side on every
 * write path (message send over both transports, reaction add, voice-token mint),
 * so a client that ignores this event gains nothing: its sends are still refused.
 */
export interface MemberTimeoutUpdatedPayload {
  groupId: GroupId;
  userId: UserId;
  /** ISO expiry while the timeout is active; null once it is lifted. */
  timedOutUntil: string | null;
  /** Who applied or lifted it, for the localized notice. Null if unavailable. */
  actorId: UserId | null;
}

/**
 * This viewer's PRIVATE nickname for someone changed. USER-scoped to the VIEWER
 * only — the person renamed is never told, and their connections never receive
 * this. Exists so a rename on desktop reaches the same account's phone.
 */
export interface UserNicknameUpdatedPayload {
  /** Who was renamed. */
  targetId: UserId;
  /** The new private nickname, or null when it was cleared. */
  nickname: string | null;
}

/**
 * This viewer's IGNORE list changed. USER-scoped to the viewer only — the ignored
 * user receives NOTHING, which is the entire difference from a block (ADR 0019
 * §4): a block announces itself through refused sends and a severed friendship,
 * an ignore is invisible from the other side.
 *
 * Thin on purpose, mirroring {@link BlocksUpdatedPayload}: the client applies the
 * delta to its local set and re-renders the affected channels (collapsing or
 * un-collapsing that author's rows). No server-side history filter runs, so
 * nothing needs refetching.
 */
export interface IgnoresUpdatedPayload {
  /** The other party in the ignore that changed. */
  userId: UserId;
  /** true = now ignored, false = the ignore was lifted. */
  ignored: boolean;
}

// ---------------------------------------------------------------------------
// Watch Party (M20, ADR 0016)
//
// A watch party is bound to a VOICE CHANNEL and keyed by its `channelId` — one
// session per voice channel, mirroring voice occupancy, so there is no separate
// session id to leak or guess. State is ephemeral (Redis, TTL); there is no DB
// table in the MVP.
//
// These events carry PLAYBACK CONTROL ONLY. No video bytes ride this protocol
// (§10/§35): every member plays the video from YouTube themselves and the server
// syncs nothing but "which video, where, playing or not, and who is driving".
//
// Authority, in one place (enforced in `apps/realtime/src/watch-party.ts`):
//  - the sender must be an OCCUPANT of that voice channel — server truth (the
//    socket's own `voice.join` state), never a claim in the payload;
//  - every control (start/play/pause/seek/set_video/transfer_host/stop) requires
//    the HOST or the server OWNER;
//  - a timed-out member (ADR 0019) controls nothing, exactly as they cannot send
//    a message on either transport.
//
// Audience, deliberately split so the 5 s drift heartbeat does not fan out to
// people who are not watching (§27):
//  - `watch.started` / `watch.host_changed` / `watch.stopped` → every subscriber
//    of the channel (visibility-filtered), so a member who can SEE the voice
//    channel can render a "watch party running" affordance. `watch.started` is
//    ALSO sent to a single connection at (re)connect for each visible channel
//    that already has a live session — an UPSERT of the snapshot, not a "just
//    now" notification, exactly like the `auth.succeeded` voice occupancy;
//  - `watch.state` → only the sockets currently IN that voice room (control +
//    the ~5 s drift heartbeat), plus a one-shot copy to a connection the moment
//    it joins the room. Both are the same "re-seat on server truth" model as
//    `voice.resync`: the server pushes, the client never asks.
// ---------------------------------------------------------------------------

/**
 * Where the video is played from. Only YouTube in the MVP (ADR 0016 decision b);
 * the field exists because the sync protocol is deliberately source-agnostic, so
 * a later source needs no new events.
 */
export type WatchSource = "youtube";

/** What a `watch.control` frame asks for. */
export type WatchControlAction = "play" | "pause" | "seek";

/**
 * Start (or replace) the session in a voice channel.
 *
 * `videoRef` is a CLIENT-supplied reference: a bare video id or an ordinary
 * YouTube link. It is NOT what gets stored — the server normalizes it with
 * `parseYouTubeVideoId` and keeps only the 11-character id, so the raw string
 * never reaches another client, let alone an iframe URL. A ref that does not
 * normalize is refused with `INVALID_PAYLOAD`.
 */
export interface WatchStartPayload {
  channelId: ChannelId;
  source: WatchSource;
  videoRef: string;
}

/**
 * Play / pause / seek. `positionSec` is where the CONTROLLER's player is at the
 * moment they pressed — the server takes it as the new authoritative position
 * for all three actions, so a play after a long pause resumes everyone at the
 * same place rather than at a stale server estimate.
 */
export interface WatchControlPayload {
  channelId: ChannelId;
  action: WatchControlAction;
  positionSec: number;
}

/** Swap the video without ending the session; playback restarts at 0. */
export interface WatchSetVideoPayload {
  channelId: ChannelId;
  /** Same normalization rules as {@link WatchStartPayload.videoRef}. */
  videoRef: string;
}

/**
 * Hand the host role to another member. The target must be an occupant of the
 * same voice channel (server truth), so a host cannot park control on someone
 * who is not there — the same check the auto-handoff uses.
 */
export interface WatchTransferHostPayload {
  channelId: ChannelId;
  toUserId: UserId;
}

/** End the session. Host or server owner only. */
export interface WatchStopPayload {
  channelId: ChannelId;
}

/**
 * The full state of a live session — the payload of BOTH `watch.started` (a
 * session exists in this channel, channel-wide) and `watch.state` (drift sync,
 * to the room), mirroring how `typing.started`/`typing.stopped` share one
 * payload. A receiver UPSERTS by `channelId` in either case, so a client needs
 * no special "first frame" branch, a late joiner and a party's opening frame
 * take the same path, and a missed event self-heals on the next heartbeat.
 *
 * `positionSec` is the authoritative playback position AT `serverTime` — while
 * playing the server projects it forward from the last control, and while paused
 * it is frozen. A client compares it to its own player and seeks when the gap
 * exceeds `WATCH_DRIFT_TOLERANCE_SECONDS`, using `serverTime` to discount the
 * frame's travel time.
 *
 * `videoId` is ALWAYS a normalized 11-character YouTube id — never the string a
 * client sent.
 */
export interface WatchSessionStatePayload {
  channelId: ChannelId;
  /** Who currently controls playback. */
  hostId: UserId;
  source: WatchSource;
  videoId: string;
  positionSec: number;
  playing: boolean;
  /** ISO instant `positionSec` is stated at. */
  serverTime: string;
}

/**
 * Control moved to another member — an explicit transfer, or the AUTOMATIC
 * handoff when the host leaves the voice channel (their socket closing counts:
 * every teardown path funnels through the same forced leave). Channel-wide, so
 * non-occupants' UI stays truthful about who is driving.
 */
export interface WatchHostChangedPayload {
  channelId: ChannelId;
  hostId: UserId;
}

/**
 * Why a session ended. `host_stopped` — the host (or the server owner) stopped
 * it. `channel_empty` — the last occupant left the voice channel, so there was
 * nobody left to watch it; the session is deleted rather than left dangling for
 * the next person who wanders in.
 */
export type WatchStoppedReason = "host_stopped" | "channel_empty";

export interface WatchStoppedPayload {
  channelId: ChannelId;
  reason: WatchStoppedReason;
}

// ---------------------------------------------------------------------------
// Watch Party — the QUEUE (M20 wave 2)
//
// A session gains an ORDERED LIST of videos to play next. It lives inside the
// same Redis session record as the playhead — same key, same TTL, same lifetime
// — because a queue that outlived its party would be a list of videos belonging
// to nobody, waiting in a room that has moved on.
//
// ## Why an `itemId` and not an index
//
// Every queue mutation names an ITEM, never a position. Two people (host and
// server owner) can act on the same queue, and the auto-advance mutates it from
// the server's side at the moment a video ends — so an index the client computed
// a moment ago may already mean a different row. `itemId` is generated by the
// ADDING client (a uuid) and never reused, so "remove that one" and "play that
// one" cannot land on a neighbour, whatever raced them.
//
// ## Authority
//
// Identical to playback control: HOST or SERVER OWNER, through the same
// `authorize()` gate (occupancy → membership/kind → timeout → host/owner). The
// founder's rule for this feature is "whoever opened the watch party queues,
// reorders and plays", and the host IS that person. No new gate was invented.
//
// ## Audience (§27)
//
// `watch.queue_updated` goes to OCCUPANTS ONLY, and only when the queue actually
// changes — never on the 5 s drift heartbeat. The playhead moves constantly and
// the queue almost never does, so folding the queue into `watch.state` would
// multiply the size of the one frame this feature sends most often. A client
// receives the queue when it joins the room and on every change thereafter.
// ---------------------------------------------------------------------------

/**
 * One video waiting to be played, as it appears on the wire.
 *
 * `videoId` is ALWAYS the normalized 11-character id — the server re-parses the
 * adder's `videoRef` exactly as it does for `watch.start`, so nothing else can
 * reach this field.
 *
 * `title` and `durationSeconds` are DISPLAY METADATA supplied by the adding
 * client (from the in-app search results, or absent for a bare pasted link). The
 * gateway has no metadata source of its own — it never calls YouTube — so the
 * honest description is: this is another member's text, bounded and stripped of
 * control characters by the server, to be rendered as PLAIN TEXT and never as
 * markup or a link. `addedBy` is server truth and always attributes it.
 */
export interface WatchQueueItem {
  /** Stable client-generated uuid; the handle every mutation names. */
  itemId: string;
  /** Normalized 11-character YouTube id (server-enforced). */
  videoId: string;
  addedBy: UserId;
  /** ISO instant the server accepted the item. */
  addedAt: string;
  /** Untrusted display text, bounded server-side. Null when none was supplied. */
  title: string | null;
  /** Untrusted display duration in seconds. Null when unknown. */
  durationSeconds: number | null;
}

/**
 * Append a video to the queue.
 *
 * Requires a LIVE session (`WATCH_NOT_ACTIVE` otherwise): `watch.start` stays the
 * one and only way a session comes into existence, so there is exactly one place
 * that decides who may open a party. A client with an empty channel calls
 * `watch.start` for the first pick and this for every one after.
 *
 * Idempotent on `itemId`: re-sending an add that already landed is a no-op rather
 * than a duplicate row, so a client that retries after a reconnect cannot double
 * the queue.
 */
export interface WatchQueueAddPayload {
  channelId: ChannelId;
  /** Client-generated uuid. Re-using one that is already queued is a no-op. */
  itemId: string;
  /** Same grammar and same server-side normalization as `watch.start`. */
  videoRef: string;
  /**
   * Optional display text. Absent and `null` both mean "no title"; the schema
   * sanitizes at the boundary and text that reduces to nothing becomes `null`,
   * which is why this is nullable and not merely optional.
   */
  title?: string | null;
  /** Optional display duration in seconds. */
  durationSeconds?: number;
}

/** Drop one queued item. Unknown `itemId` is a no-op, not an error. */
export interface WatchQueueRemovePayload {
  channelId: ChannelId;
  itemId: string;
}

/**
 * Reorder the queue by naming the DESIRED FULL ORDER of item ids.
 *
 * Deliberately not "move item X to index N". A full ordering is idempotent and
 * self-repairing under concurrency: the server treats it as a permutation of what
 * it actually holds — ids it does not know are ignored, and items the client did
 * not mention (added by someone else, or consumed by the auto-advance, between
 * the client rendering the list and this frame arriving) keep their relative
 * order at the end. So two racing reorders always leave a queue containing
 * exactly the server's items, each exactly once; the later one simply wins the
 * arrangement. An index-based move under the same race silently reorders the
 * wrong row.
 */
export interface WatchQueueReorderPayload {
  channelId: ChannelId;
  /** Desired order, most-next first. Capped at WATCH_QUEUE_MAX_ITEMS. */
  itemIds: string[];
}

/**
 * Play a specific queued item NOW: it becomes the current video (position 0,
 * playing) and leaves the queue. Skipping ahead is this same event — the items
 * jumped over stay queued, because "play that one next" is not "throw those away".
 */
export interface WatchQueuePlayPayload {
  channelId: ChannelId;
  itemId: string;
}

/**
 * The current video finished; advance to the head of the queue.
 *
 * The HOST'S CLIENT reports this and the SERVER decides what happens next. That
 * split is forced by what each side actually knows: the server never learns a
 * video's DURATION (playback needs no API key and the gateway calls nothing), so
 * it cannot time an ending — while the host's player knows the instant it ends,
 * and the host's playhead is already the authority for every other control
 * (`watch.control` carries the host's own `positionSec`). Letting the server own
 * the CONSEQUENCE keeps the queue and the fan-out in one place, so "what plays
 * next" is never negotiated between clients.
 *
 * `videoId` is the video that ended, and it is an IDEMPOTENCY GUARD, not
 * information: a player can report ENDED more than once, and a late report can
 * arrive after the video has already been changed by hand. The server ignores any
 * `watch.ended` whose `videoId` is not the one currently playing, so a duplicate
 * can never eat an extra item off the queue.
 */
export interface WatchEndedPayload {
  channelId: ChannelId;
  /** The id that just finished. Must match the session's current video. */
  videoId: string;
}

/**
 * The queue, in full, after a change. Occupants only (see the section header).
 *
 * Always the complete list rather than a delta: a queue is capped at 50 short
 * rows and changes rarely, so a full replace costs less than a diff protocol that
 * can desync — and a client applies it with one assignment, with no ordering
 * assumptions about the frames it may have missed.
 */
export interface WatchQueueUpdatedPayload {
  channelId: ChannelId;
  queue: WatchQueueItem[];
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type ClientToServerEvent =
  | { type: "message.send"; payload: SendMessagePayload }
  | { type: "typing.start"; payload: TypingPayload }
  | { type: "typing.stop"; payload: TypingPayload }
  | { type: "presence.update"; payload: PresencePayload }
  | { type: "presence.app_state"; payload: AppStatePayload }
  | { type: "voice.join"; payload: VoiceJoinPayload }
  | { type: "voice.leave"; payload: VoiceLeavePayload }
  | { type: "watch.start"; payload: WatchStartPayload }
  | { type: "watch.control"; payload: WatchControlPayload }
  | { type: "watch.set_video"; payload: WatchSetVideoPayload }
  | { type: "watch.transfer_host"; payload: WatchTransferHostPayload }
  | { type: "watch.stop"; payload: WatchStopPayload }
  | { type: "watch.queue_add"; payload: WatchQueueAddPayload }
  | { type: "watch.queue_remove"; payload: WatchQueueRemovePayload }
  | { type: "watch.queue_reorder"; payload: WatchQueueReorderPayload }
  | { type: "watch.queue_play"; payload: WatchQueuePlayPayload }
  | { type: "watch.ended"; payload: WatchEndedPayload };

export type ServerToClientEvent =
  | { type: "auth.succeeded"; payload: AuthSucceededPayload }
  | { type: "error.raised"; payload: ErrorRaisedPayload }
  | { type: "message.created"; payload: MessageDTO }
  | { type: "message.updated"; payload: MessageDTO }
  | { type: "message.deleted"; payload: MessageDeletedPayload }
  | { type: "message.reaction_added"; payload: MessageReactionPayload }
  | { type: "message.reaction_removed"; payload: MessageReactionPayload }
  | { type: "message.embeds_updated"; payload: MessageEmbedsUpdatedPayload }
  | { type: "message.pinned"; payload: MessagePinnedPayload }
  | { type: "message.unpinned"; payload: MessageUnpinnedPayload }
  | { type: "emoji.created"; payload: EmojiCreatedPayload }
  | { type: "emoji.deleted"; payload: EmojiDeletedPayload }
  | { type: "typing.started"; payload: TypingPayload }
  | { type: "typing.stopped"; payload: TypingPayload }
  | { type: "presence.updated"; payload: PresencePayload }
  | { type: "voice.participant_joined"; payload: VoiceParticipantPayload }
  | { type: "voice.participant_left"; payload: VoiceParticipantPayload }
  | { type: "voice.session_replaced"; payload: VoiceSessionReplacedPayload }
  | { type: "voice.resync"; payload: VoiceResyncPayload }
  | { type: "role.created"; payload: RoleCreatedPayload }
  | { type: "role.updated"; payload: RoleUpdatedPayload }
  | { type: "role.deleted"; payload: RoleDeletedPayload }
  | { type: "member.roles_updated"; payload: MemberRolesUpdatedPayload }
  | { type: "channel.access_changed"; payload: ChannelAccessChangedPayload }
  | { type: "channel.created"; payload: Channel }
  | { type: "channel.updated"; payload: Channel }
  | { type: "channel.deleted"; payload: ChannelDeletedPayload }
  | { type: "member.joined"; payload: MemberJoinedPayload }
  | { type: "member.left"; payload: MemberLeftPayload }
  | { type: "member.kicked"; payload: MemberKickedPayload }
  | { type: "member.banned"; payload: MemberBannedPayload }
  | { type: "voice.disconnected"; payload: VoiceDisconnectedPayload }
  | { type: "group.updated"; payload: GroupUpdatedPayload }
  | { type: "group.deleted"; payload: GroupDeletedPayload }
  | { type: "friend.request_received"; payload: FriendRequestReceivedPayload }
  | { type: "friend.request_accepted"; payload: FriendRequestAcceptedPayload }
  | { type: "friend.removed"; payload: FriendRemovedPayload }
  | { type: "dm.created"; payload: DmCreatedPayload }
  | { type: "group_chat.added"; payload: GroupChatAddedPayload }
  | { type: "notification_mute.updated"; payload: NotificationMuteUpdatedPayload }
  | { type: "call.invite"; payload: CallInvitePayload }
  | { type: "call.accepted"; payload: CallAcceptedPayload }
  | { type: "call.ended"; payload: CallEndedPayload }
  | { type: "call.upgraded"; payload: CallUpgradedPayload }
  | { type: "session.revoked"; payload: SessionRevokedPayload }
  | { type: "user.updated"; payload: UserUpdatedPayload }
  | { type: "category.created"; payload: CategoryCreatedPayload }
  | { type: "category.updated"; payload: CategoryUpdatedPayload }
  | { type: "category.deleted"; payload: CategoryDeletedPayload }
  | { type: "category.reordered"; payload: CategoryReorderedPayload }
  | { type: "user.custom_status_updated"; payload: CustomStatusUpdatedPayload }
  | { type: "user.blocks_updated"; payload: BlocksUpdatedPayload }
  | { type: "member.nickname_updated"; payload: MemberNicknameUpdatedPayload }
  | { type: "member.timeout_updated"; payload: MemberTimeoutUpdatedPayload }
  | { type: "user.nickname_updated"; payload: UserNicknameUpdatedPayload }
  | { type: "user.ignores_updated"; payload: IgnoresUpdatedPayload }
  | { type: "watch.started"; payload: WatchSessionStatePayload }
  | { type: "watch.state"; payload: WatchSessionStatePayload }
  | { type: "watch.host_changed"; payload: WatchHostChangedPayload }
  | { type: "watch.stopped"; payload: WatchStoppedPayload }
  | { type: "watch.queue_updated"; payload: WatchQueueUpdatedPayload };

export type ClientEventType = ClientToServerEvent["type"];
export type ServerEventType = ServerToClientEvent["type"];

/** Narrow a server event union member by its type literal. */
export type ServerEventOf<T extends ServerEventType> = Extract<
  ServerToClientEvent,
  { type: T }
>;

/** Narrow a client event union member by its type literal. */
export type ClientEventOf<T extends ClientEventType> = Extract<
  ClientToServerEvent,
  { type: T }
>;

/**
 * Every server→client event is wrapped in this envelope. `seq` is monotonic
 * per connection: a gap after reconnect means events were missed and the
 * client must refetch via the HTTP API instead of trusting the socket.
 */
export interface RealtimeEnvelope<E> {
  event: E;
  /** Monotonic sequence for ordering / gap detection. */
  seq: number;
  sentAt: string;
}

export type ServerEnvelope = RealtimeEnvelope<ServerToClientEvent>;

export type {
  GroupId,
  ChannelId,
  UserId,
  RoleId,
  AttachmentId,
  Attachment,
  CategoryId,
  Channel,
  ChannelCategory,
  Dm,
  FriendGroup,
  FriendGroupMember,
  Friendship,
  MessageEmbed,
  PresencePlatform,
  PresenceStatus,
  User,
};
