/**
 * Typed HTTP client for the Demli API (apps/api). Shared by desktop and
 * mobile (ADR 0002) — framework-, store-, and DOM-free.
 *
 * - `createApiClient({ baseUrl })` builds an instance; the base URL is injected
 *   (desktop passes VITE_API_URL, mobile passes its env). No `import.meta`.
 * - Auth is a Bearer session token, held in an instance-local closure and set
 *   via the returned `setAuthToken`, so this module never imports stores.
 * - Failures become typed ApiClientError values with user-friendly messages —
 *   raw stack traces or fetch internals never reach the UI (CLAUDE.md §26).
 *
 * Runtime deps: only the global `fetch`/`URLSearchParams`, which exist in the
 * browser, the Electron renderer, and React Native alike.
 */

import {
  CLIENT_UPDATE_REQUIRED_CODE,
  isClientUpdateRequiredStatus,
  readClientUpdateDownloadUrl,
  type ClientUpdateRequired,
} from "./client-gate.js";
import {
  CLIENT_SIGNATURE_HEADER,
  isValidClientSignature,
} from "@demli/config";
import type {
  DmCallActiveResponse,
  GameType,
  WireGameAction,
  WireGameState,
} from "@demli/protocol";
import type {
  Attachment,
  AttachmentId,
  BlockedUser,
  CallId,
  CallMedia,
  CallStatus,
  CategoryId,
  Channel,
  ChannelCategory,
  ChannelId,
  ChannelKind,
  CustomEmoji,
  CustomEmojiId,
  CustomEmojiUrl,
  Dm,
  DmCall,
  DmId,
  FriendGroup,
  FriendGroupMember,
  Friendship,
  GameId,
  Group,
  GroupBan,
  GroupId,
  IgnoredUser,
  Invite,
  InviteId,
  InvitePolicy,
  InvitePreview,
  InviteTargetChannel,
  Message,
  MessageId,
  MessageReactionSummary,
  ModerationActionEntry,
  NotificationMute,
  NotificationMuteMode,
  NotificationMuteScope,
  PermissionBitfield,
  PinnedMessage,
  PresencePlatform,
  Role,
  RoleId,
  SessionSummary,
  User,
  UserBlock,
  UserId,
  UserIgnore,
  UserNicknameEntry,
  UserNote,
  UserProfile,
} from "@demli/types";
import type {
  AttachmentUrl,
  DmCallTokenResponse,
  VoiceOccupancySnapshot,
  WatchCapabilities,
  WatchSearchResponse,
} from "@demli/protocol";

/** Config for {@link createApiClient}. `baseUrl` has no trailing slash, e.g. http://localhost:4000. */
export interface ApiClientConfig {
  baseUrl: string;
  /**
   * This build's identity mark, `demli-<app>/<version>` — build it with
   * `formatClientSignature` from `@demli/config`, never by hand.
   *
   * REQUIRED, and that is the whole point. The server's client gate tells a
   * current build from a retired one by the PRESENCE of this header, so a
   * surface that forgets it is locked out of production the moment the gate is
   * armed — a failure that would show up nowhere until it showed up everywhere.
   * Making the field mandatory moves that from a runtime outage to a compile
   * error, and the constructor rejects a malformed value on top (see below), so
   * a typo cannot ship either.
   */
  clientSignature: string;
  /**
   * Called whenever the server refuses this BUILD (`426 CLIENT_UPDATE_REQUIRED`,
   * see client-gate.ts) — before the typed error is thrown, so a caller that
   * swallows its own errors still cannot hide the refusal.
   *
   * One hook instead of a check at every call site: the refusal applies to every
   * endpoint at once, so each app wires this in exactly one place (desktop:
   * renderer/src/lib/api-client.ts) and its migration screen takes over.
   */
  onClientUpdateRequired?: (info: ClientUpdateRequired) => void;
}

/** Error codes the API can return, plus client-side transport failures. */
export type ApiClientErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  // #111: `POST /friends/requests/by-username` found no account with that
  // username. Separate from NOT_FOUND because it is the one not-found a user can
  // actually fix, so every client owes it real copy ("no user with that
  // username") instead of the generic "we couldn't find what you were looking
  // for". See {@link Api.sendFriendRequestByUsername} for what it does and does
  // not disclose.
  | "USER_NOT_FOUND"
  | "CONFLICT"
  | "INVALID_CHANNEL"
  | "INVITE_EXPIRED"
  | "INVITE_EXHAUSTED"
  // Server moderation (migration 0017): redeeming an invite for a server you are
  // banned from answers 403 GROUP_BANNED (no leak of whether the invite was valid).
  | "GROUP_BANNED"
  | "RATE_LIMITED"
  | "SLOWMODE"
  // Message enrichment (ADR 0011 / M14). INVALID_REACTION: a reaction key that is
  // neither a unicode emoji nor a `:name:` custom emoji resolvable in the group
  // (M17). INVALID_PAYLOAD: a reply target that is missing or lives in another
  // channel (also surfaced over the gateway as error.raised).
  | "INVALID_REACTION"
  | "INVALID_PAYLOAD"
  // Media attachments (ADR 0008). INVALID_ATTACHMENT: non-whitelisted mime,
  // over-cap size, magic-byte mismatch, or a bad link id. ATTACHMENTS_DISABLED:
  // Supabase Storage is not configured on this server, so uploads are off.
  | "INVALID_ATTACHMENT"
  | "ATTACHMENTS_DISABLED"
  // Avatar uploads (profile photo). INVALID_AVATAR: declared MIME off the
  // whitelist or the real magic bytes disagree with it. AVATAR_TOO_LARGE: over
  // the 2 MB cap. AVATAR_UPLOADS_DISABLED: the server has no avatar bucket
  // configured (feature off). AVATAR_REJECTED: the server-side NSFW seam rejected
  // the image.
  | "INVALID_AVATAR"
  | "AVATAR_TOO_LARGE"
  | "AVATAR_UPLOADS_DISABLED"
  | "AVATAR_REJECTED"
  // User blocking (M18 / ADR 0017): a block exists between the caller and the
  // other party. ONE code for BOTH directions on purpose — the API never says
  // which side blocked, because telling someone they have been blocked is exactly
  // the information a block is meant to withhold (§28). Every render site must
  // keep that neutrality: "you can't message this user", never "they blocked you".
  | "BLOCKED"
  // Set-once date of birth (M15 age gate): PATCH /users/me answered 409 because
  // the account already has one. IS in the union on purpose — unlike the codes
  // noted below, this one reaches a user, so both clients must be forced to give
  // it real copy ("your date of birth is already set") instead of "something
  // went wrong". See age-gate.ts `isBirthdateLockedError`.
  | "BIRTHDATE_LOCKED"
  // Watch Party video search (M20). Three codes, deliberately NOT collapsed into
  // one, because they clear on three different timescales and the user's next
  // move differs for each: DISABLED never clears on this deployment (no API key
  // — paste a link, always), QUOTA clears at midnight Pacific (paste a link
  // today), UNAVAILABLE is YouTube not answering and may clear in a minute. A
  // shared "search failed" would make the two permanent ones look transient.
  | "WATCH_SEARCH_DISABLED"
  | "WATCH_SEARCH_QUOTA"
  | "WATCH_SEARCH_UNAVAILABLE"
  // The server refused this BUILD, not this request (HTTP
  // 426). Typed here so a client can branch on it; the copy never comes from the
  // server, because the whole point is that this binary has to be replaced and
  // only the client knows how to say that in the user's language. See
  // client-gate.ts and `ApiClientConfig.onClientUpdateRequired`.
  | "CLIENT_UPDATE_REQUIRED"
  | "INTERNAL"
  | "NETWORK";
// NOTE: some server error codes are deliberately kept OUT of the union above so
// they stay purely additive and never force a user-facing message-key mapping.
// `VOICE_OCCUPANCY_UNAVAILABLE` (503 from GET /voice/occupancy, state-resync) is
// one: the focus-pull caller swallows every failure and KEEPS its current view,
// so this code is never rendered — it round-trips as the runtime `.code` string
// without being a typed member (see {@link Api.getVoiceOccupancy}).

export class ApiClientError extends Error {
  constructor(
    readonly code: ApiClientErrorCode,
    message: string,
    readonly status: number | null = null,
    /**
     * SLOWMODE only (HTTP 429): seconds the caller must wait before sending
     * again in this channel. Null for every other error.
     */
    readonly retryAfterSeconds: number | null = null,
    /**
     * The full parsed error response body, when the server sent one — lets a
     * caller read sibling fields the typed error shape omits. The DM-call start
     * 409 (`{ error, call }`, ADR 0012 §7) uses this to hand the existing
     * {@link DmCall} back so the caller can rejoin it. Null for transport
     * failures (no HTTP body) and 204s.
     */
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

/** Friendly message for any thrown value — safe to render directly. */
export function friendlyErrorMessage(err: unknown): string {
  if (err instanceof ApiClientError) return err.message;
  return "Something went wrong. Please try again.";
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  /** Send the Bearer token (default true). */
  auth?: boolean;
}

// ---------------------------------------------------------------------------
// Response DTOs (mirror apps/api module responses)
// ---------------------------------------------------------------------------

export interface AuthResponse {
  token: string;
  user: User;
}

/**
 * Optional device metadata (M15) a client may attach to a login/register call so
 * the issued session is labelled in the "active sessions" list. Both fields are
 * lenient server-side (an omitted/blank/unknown value never fails auth):
 * `deviceName` is a client-facing label (e.g. "Windows · Demli"); `platform`
 * is the client surface. Desktop and mobile fill these before calling; the vault
 * multi-account switcher (ADR 0013) relies on nothing here — it is purely for the
 * server-side session list.
 */
export interface SessionDeviceMetadata {
  deviceName?: string;
  platform?: PresencePlatform;
}

/**
 * Response of the PUBLIC GET /mobile/version (native-update prompt). The
 * mobile app fetches this on launch, compares its own native `runtimeVersion` against
 * `latestRuntimeVersion` (and, when present, the `minSupportedRuntimeVersion`
 * floor) locally, and prompts a reinstall from `apkUrl` when it is behind.
 *
 * This is native-only in practice, but the DTO lives here so the one shared wire
 * client (ADR 0002) owns every endpoint shape. Semver comparison is the client's
 * job — the server only serves these values.
 */
export interface MobileVersionInfo {
  /** Newest shipped native `runtimeVersion`, e.g. "1.3.0". */
  latestRuntimeVersion: string;
  /** Stable public APK download link. */
  apkUrl: string;
  /** Optional forced-update floor; absent ⇒ any update is advisory only. */
  minSupportedRuntimeVersion?: string;
}

// ---------------------------------------------------------------------------
// Push devices (task #46 — FCM/Expo push). A "device" is one install's push
// token. Mobile registers its Expo push token ("ExponentPushToken[…]") after
// login and drops it on logout; the API fans server-side push out to every
// registered token of a user (see the parallel apps/api `devices` module).
// ---------------------------------------------------------------------------

/** OS a push token belongs to. Mirrors React Native's `Platform.OS` (mobile only). */
export type DevicePlatform = "ios" | "android";

/** Body for {@link Api.registerDevice}: the push token + the OS that minted it. */
export interface RegisterDeviceInput {
  /** Expo push token, e.g. "ExponentPushToken[xxxxxxxx]". */
  token: string;
  platform: DevicePlatform;
}

export type GroupMemberWithUser = FriendGroupMember & { user: User };

/**
 * A ban list entry (migration 0017): the {@link GroupBan} record joined with the
 * banned user so the moderation list renders a name/avatar without follow-up
 * fetches. `bannedBy` stays an id — the client already has the roster.
 */
export type GroupBanWithUser = GroupBan & { user: User };

export interface GroupDetails {
  group: FriendGroup;
  channels: Channel[];
  members: GroupMemberWithUser[];
}

/**
 * Details of a flat group chat (ADR 0005). `group.streamId` is the channel key
 * for all message operations (list/send/typing) — a group has no channel list.
 */
export interface GroupChatDetails {
  group: Group;
  members: GroupMemberWithUser[];
}

/** Fields patchable on a server via {@link Api.updateGroup}. */
export interface UpdateGroupInput {
  name?: string;
  iconUrl?: string | null;
  /**
   * Servers only (owner-only): REMOVE the server banner by sending `null`.
   * Setting a banner is not expressible here — a new image goes through
   * {@link Api.uploadGroupBanner}, the only path that verifies the bytes. The API
   * rejects any non-null value with INVALID_GROUP_BANNER.
   */
  bannerUrl?: null;
  /**
   * Servers only: the text channel that receives system messages (member
   * joined/left). Must be a text channel of this server; `null` disables it.
   * The API rejects a non-text or foreign channel with INVALID_CHANNEL.
   */
  systemChannelId?: ChannelId | null;
  /**
   * Servers only (owner-only): who may create invites (ADR 0007). `"members"`
   * = every member can invite (pre-M9 default); `"roles"` = owner + members
   * holding CREATE_INVITE only.
   */
  invitePolicy?: InvitePolicy;
}

/** Fields accepted when creating a role via {@link Api.createRole}. */
export interface CreateRoleInput {
  /** 1–32 chars. */
  name: string;
  /** `"#rrggbb"` or null (default text color). Omitted ⇒ null. */
  color?: string | null;
  /** PERMISSIONS bitfield; omitted ⇒ 0 (no permissions). */
  permissions?: PermissionBitfield;
}

/** Fields patchable on a role via {@link Api.updateRole} (send at least one). */
export interface UpdateRoleInput {
  name?: string;
  color?: string | null;
  permissions?: PermissionBitfield;
}

/** Fields patchable on a channel via {@link Api.updateChannel}. */
export interface UpdateChannelInput {
  name?: string;
  description?: string | null;
  /** Voice channels only; the API rejects it on text channels. */
  maxParticipants?: number | null;
  /**
   * Minimum seconds between messages per non-owner member (0–21600; 0 = off).
   * Accepted on ANY chat-capable channel — text and, since M20, voice, whose
   * text chat is exactly where a busy room's spam burst lands. Rejected only on
   * a kind that carries no chat at all (`isChatCapableChannel`, @demli/types).
   */
  slowmodeSeconds?: number;
  /**
   * Voice channels only: preferred mic bitrate in kbps (8–510; `null` = media
   * default). The API rejects it on text channels.
   */
  audioBitrateKbps?: number | null;
  /**
   * Text channels only (M18): mark/unmark the channel as NSFW / 18+. The API
   * rejects it on voice channels. Toggling it re-gates the channel for viewers.
   */
  nsfw?: boolean;
  /**
   * File the channel under a category, or `null` to move it back to the
   * uncategorized top-level list (M18). Purely organizational — a category holds
   * no permissions and never changes channel visibility. Position is untouched;
   * bulk placement is {@link Api.reorderChannels}.
   */
  categoryId?: CategoryId | null;
}

/**
 * Inline avatar upload ({@link Api.uploadAvatar}): the image bytes (base64) plus
 * their declared MIME. The declared MIME is only a hint — the server magic-byte
 * sniffs the real bytes and enforces the 2 MB cap (§28). On success the server
 * stores the resulting public URL on the user row and returns the updated user.
 */
export interface UploadAvatarInput {
  /** e.g. "image/png" | "image/jpeg" | "image/webp". */
  mime: string;
  /** The raw image, base64-encoded (no data-URL prefix). */
  dataBase64: string;
}

/** Fields patchable on the signed-in user via {@link Api.updateMe}. */
export interface UpdateMeInput {
  displayName?: string;
  avatarUrl?: string | null;
  /**
   * `null` removes the profile banner (the API's `updateProfileSchema` already
   * accepts it); a new banner is set through `uploadBanner`, never a URL here.
   */
  bannerUrl?: string | null;
  /**
   * Profile bio (ADR 0010 §3): ≤280 chars, plain text, `null` clears it.
   * Stored raw; escaped at render like message content (§28).
   */
  bio?: string | null;
  /**
   * Date of birth (M15) as `YYYY-MM-DD`. SET-ONCE: the server accepts it only
   * while the account has none yet (pre-M15 users + the NSFW age-gate flow), and
   * answers `409 BIRTHDATE_LOCKED` on any later change. Drives the me-only
   * `isAdult` gate; never sent for other users.
   */
  birthdate?: string;
}

// ---------------------------------------------------------------------------
// Social layer (ADR 0010 — friendships, DMs, profiles). Mirrors the apps/api
// `friends` / `dms` modules and the extended `users` profile endpoints.
// ---------------------------------------------------------------------------

/**
 * A friend (accepted) or a pending-request counterpart, paired with the
 * relationship row. `user` is always the OTHER party relative to the caller
 * (the API resolves it), so clients never reason about pair ordering.
 */
export interface FriendWithUser {
  user: User;
  friendship: Friendship;
}

/** Which pending requests to list: `incoming` = asked me, `outgoing` = I asked. */
export type FriendRequestDirection = "incoming" | "outgoing";

/**
 * Body for {@link Api.sendFriendRequest}: EXACTLY one of a typed-in friend code
 * or a target user id (from a member list / profile card).
 *
 * @deprecated The `{ friendCode }` variant is retained ONLY for older clients
 * (founder directive #111 removes friend codes). New code adds friends with
 * {@link Api.sendFriendRequestByUsername}; the `{ userId }` variant (add from a
 * member list / profile card) stays first-class.
 */
export type SendFriendRequestInput = { friendCode: string } | { userId: UserId };

/**
 * Result of {@link Api.sendFriendRequestByUsername}.
 *
 * Opaque about the RELATIONSHIP, not about the user. A missing username is now a
 * `USER_NOT_FOUND` rejection (founder directive, 2026-07-28 — a mistyped handle
 * used to be answered "sent, if that user exists", which left the sender waiting
 * for a request that could never arrive). But every outcome that DID reach an
 * account — freshly created, auto-accepted, already pending, already friends —
 * still answers the same `{ ok: true }`, so the route never reports the state of
 * a relationship the caller has not been let into.
 */
export interface SendFriendRequestByUsernameResult {
  ok: true;
}

/**
 * Successful send outcome: `created` (a fresh pending request → 201) or
 * `auto_accepted` (the target had already requested me → now friends, 200).
 * `already_pending` / `already_friends` / `self` surface as ApiClientError
 * (409 / 409 / 400) instead.
 */
export type SendFriendRequestOutcome = "created" | "auto_accepted";

export interface SendFriendRequestResult {
  friendship: Friendship;
  outcome: SendFriendRequestOutcome;
}

export interface MessagesPage {
  /** Newest-first within the page (keyset pagination, see packages/db). */
  messages: Message[];
  nextCursor: string | null;
}

/**
 * Response of POST /channels/:channelId/attachments/upload-url (ADR 0008).
 * The client PUTs the raw bytes to `uploadUrl` (with the file's Content-Type)
 * and then calls {@link Api.completeAttachment}.
 */
export interface AttachmentUploadTicket {
  attachmentId: AttachmentId;
  /** Signed direct-to-storage upload URL (short-lived). */
  uploadUrl: string;
  /** ISO instant at which `uploadUrl` stops accepting the PUT. */
  expiresAt: string;
}

/** Client-measured media dimensions sent on complete (server sanity-clamps). */
export interface CompleteAttachmentInput {
  /** Pixel width (image/video). */
  width?: number;
  /** Pixel height (image/video). */
  height?: number;
  /** Duration in ms (audio/video). */
  durationMs?: number;
}

/**
 * Response of `POST /dm-calls/:id/upgrade` (ADR 0012 §6). The server created a
 * new group, moved the two originals' media into it WITHOUT a reconnect (the new
 * voice channel's LiveKit room IS the ongoing call room), and rang the invitee.
 * The inviter uses this to navigate into the group; the seamless surface swap for
 * both originals is driven by the `call.upgraded` event, not this response.
 */
export interface DmCallUpgradeResponse {
  group: Group;
  voiceChannelId: ChannelId;
}

/**
 * Response of `GET /dm-calls/active` (call-UX plan K2.2) — the RESYNC read that
 * makes a lost `call.accepted` recoverable. The control plane for calls is HTTP
 * (ADR 0012 §2) and `call.accepted` is fan-out to the sockets connected AT THAT
 * INSTANT, with no queue/replay: a caller whose FSM had not reached `outgoing`
 * yet (the start response was still in flight) or whose socket blinked between
 * invite and accept used to lose that one frame FOREVER and ring into a timeout
 * while the callee sat alone in a live room. This endpoint is the authority the
 * client re-reads instead.
 *
 * Shape contract (owned server-side by the W1A task; consumed here as a
 * SUPERSET-tolerant read):
 * - `call` — the caller/callee's single live call (`ringing` | `active`), or null
 *   when nothing is live. Scoped to the authenticated user — no id to tamper with.
 * - `url` / `token` / `roomName` — a REJOIN grant for that call's LiveKit room,
 *   mirroring {@link DmCallTokenResponse}. Optional here on purpose: the fields
 *   are what lets a resynced client actually get media up (a client that adopts
 *   `active` without media is the "I'm in the room and hear nothing" bug), and a
 *   server build that answers without them makes the client end the call cleanly
 *   instead of pretending to be connected.
 */
/**
 * Re-export of the SERVER's contract, not a second guess at it.
 *
 * This started life as a local superset — `{ call, url?, token?, roomName? }` —
 * written while the endpoint did not exist yet. The endpoint landed with the
 * credentials NESTED under `media`, so the two shapes never overlapped: every
 * read of `snapshot.url` would have been `undefined`, the client would have
 * concluded "no media" and hung up the very call it was trying to heal. Typed
 * against the same interface, that mismatch is a compile error instead of a
 * silent failure on a real call.
 */
export type ActiveDmCallResponse = DmCallActiveResponse;

/** Which side of a call the viewer was on (Voice-UX #2). */
export type RecentCallDirection = "incoming" | "outgoing";

/**
 * One row of the caller's cross-DM call history — the wire shape of
 * `GET /dm-calls/recent` (Voice-UX #2). Read-only, relative to the caller:
 * - `peer`            — the OTHER participant (public {@link User}, no friendCode).
 * - `direction`       — the caller's role: `outgoing` (they placed it) vs
 *   `incoming` (they were rung). A missed call is `incoming` + `status === "missed"`.
 * - `durationSeconds` — talk time, present ONLY for a connected-then-hung-up call
 *   (`status === "ended"`); null for every other outcome.
 */
export interface RecentCall {
  id: CallId;
  dmId: DmId;
  peer: User;
  media: CallMedia;
  status: CallStatus;
  direction: RecentCallDirection;
  durationSeconds: number | null;
  createdAt: string;
}

/** `{ calls, nextCursor }` page of {@link RecentCall} — keyset-paged via `before`. */
export interface RecentCallsPage {
  /** Newest-first within the page (keyset pagination, see packages/db). */
  calls: RecentCall[];
  nextCursor: string | null;
}

/** Single GIF result from the Tenor proxy. */
export interface GifItem {
  id: string;
  title: string;
  previewUrl: string;
  previewWidth: number;
  previewHeight: number;
  fullUrl: string;
  fullWidth: number;
  fullHeight: number;
  fullSize: number;
}

/** Paginated GIF search response. */
export interface GifSearchResult {
  results: GifItem[];
  next: string;
}

/** Response of POST /media/token — LiveKit connection grant (see apps/api media module). */
export interface MediaTokenResponse {
  /** LiveKit websocket URL, e.g. ws://localhost:7880 — pass to the voice engine. */
  url: string;
  /** LiveKit access token (JWT) minted server-side. */
  token: string;
  /** Room name == the voice channel id (rooms are 1:1 with voice channels). */
  roomName: string;
  /** Token identity == the authenticated user id. */
  identity: string;
  /** ISO 8601 expiry (~6h from mint). */
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Media attachments (ADR 0008 — M10). Signed-URL upload flow: the client asks
// the API for a signed upload URL, PUTs the bytes DIRECTLY to Supabase Storage
// (see `uploadToSignedUrl`), then tells the API to `complete` (magic-byte sniff
// + ready). Signed READ urls are never on the message DTO — they come only from
// the batch `getAttachmentUrls` endpoint (metadata-only messages stay cacheable).
// ---------------------------------------------------------------------------

/**
 * Body for {@link Api.createCustomEmoji} (M17).
 *
 * The image travels inline as base64 rather than through a signed direct upload.
 * That is a consequence of the small size cap (`CUSTOM_EMOJI_MAX_BYTES`, 256 KB):
 * with the bytes in hand the server can verify the REAL content type from its
 * magic bytes before storing anything, so an unverified object never lands in the
 * bucket and there is no pending-row/complete round trip for the client to drive.
 */
export interface CreateCustomEmojiInput {
  /**
   * Shortcode. Lowercased and validated server-side against
   * `CUSTOM_EMOJI_NAME_PATTERN` (`[a-z0-9_]{2,32}`); clients should pre-check with
   * `isCustomEmojiName` for a fast, local reject.
   */
  name: string;
  /** Declared image type — `image/png` or `image/webp`. Re-verified server-side. */
  mime: string;
  /** The raw image bytes, base64-encoded (no data-URI prefix). */
  dataBase64: string;
}

/** Body for the REST message-send path ({@link Api.sendMessage}). */
export interface SendMessageInput {
  /** Message text; may be empty/omitted iff `attachmentIds` has ≥1 entry. */
  content?: string;
  /** Ready, uploader-owned attachment ids to link (ADR 0008). */
  attachmentIds?: AttachmentId[];
  /**
   * The message this send replies to (ADR 0011 §2). Optional/additive — the
   * server validates it exists in the SAME channel (else INVALID_PAYLOAD). The
   * desktop app sends replies over the gateway; this REST field is for the
   * portable path (e.g. mobile).
   */
  replyToMessageId?: MessageId;
}

/**
 * Response of the reaction add/remove endpoints (ADR 0011 §4). Carries the
 * target message's freshly-aggregated reaction summary so the initiator
 * reconciles its optimistic state against the server truth.
 */
export interface MessageReactionsResponse {
  reactions: MessageReactionSummary[];
}

/**
 * Body for {@link Api.setNotificationMute} (`PUT /notification-mutes`, migration
 * 0013). Mutes a channel (`scope:"channel"`, `targetId` = channel id) or a whole
 * server / group chat / DM (`scope:"group"`, `targetId` = friend_group id).
 * `until` is the ISO auto-expiry instant computed from a preset (15m/1h/8h);
 * omit it for an indefinite mute.
 */
export interface SetNotificationMuteInput {
  scope: NotificationMuteScope;
  targetId: string;
  mode: NotificationMuteMode;
  /** ISO auto-expiry; omit for indefinite. */
  until?: string;
}

/**
 * Inline banner upload ({@link Api.uploadBanner}) — mirrors {@link UploadAvatarInput}:
 * the image bytes (base64) plus their declared MIME. Banners additionally allow an
 * animated GIF alongside PNG/JPEG/WebP. The declared MIME is a hint only — the
 * server magic-byte sniffs the real bytes and enforces its own size cap. On success
 * it stores the resulting public URL on the user row and returns the updated user.
 */
export interface UploadBannerInput {
  /** e.g. "image/png" | "image/jpeg" | "image/webp" | "image/gif". */
  mime: string;
  /** The raw image, base64-encoded (no data-URL prefix). */
  dataBase64: string;
}

/** The endpoint surface returned by {@link createApiClient} (via `.api`). */
// ---------------------------------------------------------------------------
// M18 — channel categories, blocking, moderation log (migration 0019, ADR 0017)
// ---------------------------------------------------------------------------

/**
 * Body of {@link Api.reorderChannels} (`PATCH /groups/:groupId/channel-order`).
 * Both halves are optional but at least one must be non-empty:
 *
 *  - `categoryIds` — the server's categories in their new order;
 *  - `channels`    — the channels whose bucket and/or position changed, each with
 *    its target category (`null` = the uncategorized top-level list). The ARRAY
 *    ORDER is the new order within the bucket, and each touched bucket must be
 *    listed in FULL (see the note on {@link Api.reorderChannels}).
 */
export interface ChannelOrderInput {
  categoryIds?: CategoryId[];
  channels?: Array<{ channelId: ChannelId; categoryId: CategoryId | null }>;
}

/**
 * One page of a server's moderation audit log. `nextCursor` is the opaque keyset
 * cursor to pass back as `before`; `null` means the last page.
 */
export interface ModerationLogPage {
  entries: ModerationActionEntry[];
  nextCursor: string | null;
}

export interface Api {
  register(input: {
    username: string;
    password: string;
    displayName?: string;
    /**
     * ISO calendar date of birth `YYYY-MM-DD` (M15). Collected at registration and
     * used server-side to derive the user's `isAdult` flag for +18 content gating.
     * Optional on the wire so older clients keep working; new clients send it.
     */
    birthdate?: string;
  } & SessionDeviceMetadata): Promise<AuthResponse>;
  login(input: { username: string; password: string } & SessionDeviceMetadata): Promise<AuthResponse>;
  logout(): Promise<void>;
  getMe(): Promise<{ user: User }>;

  // --- Active sessions (M15-A — the "where you're signed in" screen) ---
  /** The caller's own unexpired sessions, most-recently-active first; `current` flags this one. */
  listSessions(): Promise<{ sessions: SessionSummary[] }>;
  /**
   * Close ONE session the caller owns (DELETE /sessions/:id → 204). Closing the
   * `current` session logs THIS device out server-side. A foreign/unknown id 404s.
   */
  revokeSession(sessionId: string): Promise<void>;
  /** Sign out every OTHER session, keeping this one (DELETE /sessions/others). Returns the count closed. */
  revokeOtherSessions(): Promise<{ revoked: number }>;
  /** Patch the signed-in user's own profile fields. */
  updateMe(input: UpdateMeInput): Promise<{ user: User }>;
  /**
   * Upload a profile photo (inline base64). The server validates the real bytes
   * (whitelist → 2 MB cap → magic bytes), runs a server-side NSFW check, stores
   * the image in a public bucket and returns the updated user with its new
   * `avatarUrl`. Answers AVATAR_UPLOADS_DISABLED when the server has no avatar
   * bucket configured, AVATAR_REJECTED when moderation blocks the image.
   */
  uploadAvatar(input: UploadAvatarInput): Promise<{ user: User }>;

  /**
   * Fetch the advertised native version + APK link — PUBLIC, no auth (called on
   * launch, before sign-in). The caller compares its own runtimeVersion locally
   * (see the mobile `updates/` native-update flow). Never send the Bearer token.
   */
  getMobileVersion(): Promise<MobileVersionInfo>;

  // --- Push devices (task #46) ---
  /**
   * Register (idempotent upsert) this install's push token so the server can
   * deliver push notifications to it — POST /devices/token. Called after
   * login/permission grant. Re-registering the same token just refreshes it.
   */
  registerDevice(input: RegisterDeviceInput): Promise<void>;
  /**
   * Unregister this install's push token — DELETE /devices/token. Called on
   * logout (and when the OS permission is revoked) so a signed-out / reassigned
   * device stops receiving this user's pushes. The token rides in the body.
   */
  unregisterDevice(input: { token: string }): Promise<void>;
  /** Minimal public profile of any user by id. */
  getUser(userId: string): Promise<{ user: User }>;
  /**
   * Context-aware profile card (ADR 0010 §3): the target user + the viewer→
   * target friendship state + the target's roles WHEN `groupId` names a server
   * both belong to (the API gates role visibility). `friendCode` is never present.
   */
  getUserProfile(userId: UserId, groupId?: GroupId): Promise<{ profile: UserProfile }>;
  /**
   * Mint a fresh friend code, invalidating the old one (self-only, rate-limited).
   *
   * @deprecated (#111) Friend codes are being removed. Kept for older clients;
   * new clients no longer surface a regenerate action.
   */
  regenerateFriendCode(): Promise<{ user: User }>;
  listGroups(): Promise<{ groups: FriendGroup[] }>;
  createGroup(input: { name: string }): Promise<{ group: FriendGroup }>;
  getGroupDetails(groupId: GroupId): Promise<GroupDetails>;
  /** Rename / re-icon a server, or remove its banner (owner-only). */
  updateGroup(groupId: GroupId, input: UpdateGroupInput): Promise<{ group: FriendGroup }>;
  /**
   * Upload a SERVER banner (inline base64), mirroring {@link Api.uploadBanner}.
   * Owner-only. The server validates the real bytes (MIME whitelist, size cap,
   * magic bytes, pixel budget), stores a public URL and returns the updated
   * group; every member receives `group.updated`.
   */
  uploadGroupBanner(
    groupId: GroupId,
    input: UploadBannerInput,
  ): Promise<{ group: FriendGroup }>;
  /** Delete a server and everything it owns (owner-only). */
  deleteGroup(groupId: GroupId): Promise<void>;
  /**
   * Remove a member from a server: a member leaves themselves, the owner kicks
   * anyone else. Emits a "left" system message. The owner cannot be removed
   * (the API returns VALIDATION_ERROR — delete the server instead).
   */
  leaveGroup(groupId: GroupId, userId: UserId): Promise<void>;

  // --- Server moderation (migration 0017) — owner ∨ KICK_MEMBERS; the server
  // re-checks every permission (§28). The owner can never be targeted by another
  // member, and you cannot kick/ban yourself (leave instead). ---
  /**
   * Kick a member from a server (`POST /groups/:groupId/members/:userId/kick`,
   * 204). Removes the membership WITHOUT barring rejoin — a new invite still
   * works. The removed member's own devices get a `member.kicked` notice and are
   * dropped from the server's channels/voice; every roster refreshes via
   * `member.left`. Throws `FORBIDDEN` without permission (or when targeting the
   * owner), `VALIDATION_ERROR` for self, `NOT_FOUND` for a non-member.
   */
  kickMember(groupId: GroupId, userId: UserId): Promise<void>;
  /**
   * Ban a member from a server (`POST /groups/:groupId/bans`, 201). Kick PLUS a
   * permanent block: a `group_bans` row is recorded so no invite can bring them
   * back (`GROUP_BANNED` on redeem). `reason` is an optional moderator note.
   * Same guards as {@link kickMember}. Returns the created ban.
   */
  banMember(groupId: GroupId, userId: UserId, reason?: string): Promise<{ ban: GroupBan }>;
  /**
   * Lift a ban (`DELETE /groups/:groupId/bans/:userId`, 204). Owner ∨
   * KICK_MEMBERS. `NOT_FOUND` when that user is not banned.
   */
  unbanMember(groupId: GroupId, userId: UserId): Promise<void>;
  /**
   * A server's ban list, newest first (`GET /groups/:groupId/bans`). Owner ∨
   * KICK_MEMBERS. Each entry carries the banned user hydrated for the list UI.
   */
  listBans(groupId: GroupId): Promise<{ bans: GroupBanWithUser[] }>;
  /**
   * Force-disconnect a user from a voice channel WITHOUT removing them from the
   * server (`POST /channels/:channelId/voice/:userId/disconnect`, 204). Owner ∨
   * KICK_MEMBERS in the channel's group; the owner can only be disconnected by
   * themselves. The SFU participant is force-removed and the target gets a
   * user-scoped `voice.disconnected` so their client leaves the room cleanly.
   */
  disconnectFromVoice(channelId: ChannelId, userId: UserId): Promise<void>;
  createChannel(
    groupId: GroupId,
    input: {
      name: string;
      kind: ChannelKind;
      /**
       * Optional create-time visibility restriction (ADR 0007 / task #51). Omitted
       * or empty = public to all members. Non-empty locks the channel to the owner
       * + members holding one of these roles, applied atomically at creation.
       */
      roleIds?: RoleId[];
      /**
       * Text channels only (M18): create the channel already marked NSFW / 18+.
       * Omitted/false = normal. Rejected server-side on `kind: "voice"`.
       */
      nsfw?: boolean;
      /**
       * Create the channel already filed under a category (M18) — the "+" on a
       * category header. Omitted/null = the uncategorized top-level list.
       */
      categoryId?: CategoryId | null;
    },
  ): Promise<{ channel: Channel }>;
  /** Edit a channel's name/description/voice cap (server owner-only). */
  updateChannel(
    channelId: string,
    input: UpdateChannelInput,
  ): Promise<{ channel: Channel }>;
  /** Delete a channel and its messages (server owner-only). */
  deleteChannel(channelId: string): Promise<void>;
  // --- Flat group chats (ADR 0005) — messages reuse `group.streamId` as the channel key.
  /** Create a flat group chat; the caller becomes owner. */
  createGroupChat(input: { name: string }): Promise<{ group: Group }>;
  /** Every flat group chat the caller belongs to. */
  listGroupChats(): Promise<{ groups: Group[] }>;
  /** A group chat's details + members (404 for non-members). */
  getGroupChat(groupChatId: GroupId): Promise<GroupChatDetails>;
  /** Owner adds a member by username. */
  addGroupChatMember(
    groupChatId: GroupId,
    input: { username: string },
  ): Promise<{ member: GroupMemberWithUser }>;
  /** Owner removes any member; a member removes only themselves. */
  removeGroupChatMember(groupChatId: GroupId, userId: string): Promise<void>;
  /** Delete a flat group chat and its stream/messages (group owner-only). */
  deleteGroupChat(groupChatId: GroupId): Promise<void>;
  listMessages(
    channelId: string,
    options?: { cursor?: string | null; limit?: number },
  ): Promise<MessagesPage>;
  /**
   * Full-text search within one channel (ADR 0011 §5) —
   * `GET /channels/:channelId/messages/search`. Same auth + visibility gate as
   * {@link Api.listMessages} (an invisible / non-member channel answers
   * `NOT_FOUND`, no existence leak), the same `{ messages, nextCursor }` envelope
   * (newest-first, keyset-paged via `before`), and the same enriched MessageDTOs.
   *
   * `q` MUST be ≥ 3 characters after trimming — a shorter query is a
   * `VALIDATION_ERROR` (400), so callers should gate on length before calling.
   * `limit` is clamped server-side to 1..50 (default page size). This heavier
   * read is rate-limited per session; over the cap surfaces as `RATE_LIMITED`.
   */
  searchMessages(
    channelId: string,
    input: { q: string; limit?: number; before?: string | null },
  ): Promise<MessagesPage>;
  /**
   * Whether THIS deployment can search YouTube (M20 Watch Party).
   *
   * Constant per deployment, spends no quota, and is the gate a client asks
   * before it draws a search box at all — a build without an API key must show
   * the paste-a-link path and no dead search affordance (§35). Cache it: it
   * changes only when the server is reconfigured.
   */
  getWatchCapabilities(): Promise<WatchCapabilities>;
  /**
   * Search YouTube for a watch-party video, through OUR server (the API key
   * never reaches a client).
   *
   * EXPENSIVE, and the budget is shared: YouTube grants this deployment on the
   * order of a hundred searches a day for everybody combined, with a per-user
   * daily cap on top. Callers must issue this on a deliberate user act — a
   * submitted query — and never per keystroke, however debounced.
   *
   * `channelId` must be a VOICE channel the caller can see; anything else is
   * `NOT_FOUND` (never 403 — the route is not an existence oracle) or
   * `INVALID_CHANNEL`. Refusals arrive as the three `WATCH_SEARCH_*` codes,
   * each of which needs its own copy.
   */
  searchWatchVideos(input: { channelId: string; q: string }): Promise<WatchSearchResponse>;
  /**
   * Mint an invite for a server (or a flat group chat — one invite pipeline
   * serves both, ADR 0005).
   *
   * `targetChannelId` makes it a CHANNEL invite: the redeemer joins the server
   * and lands on that channel instead of the front door. Optional and additive —
   * an API that does not know the field ignores it and issues a plain server
   * invite, which is precisely the degraded behaviour the client already handles
   * (see `readInviteTargetChannel`), so sending it is always safe.
   */
  createInvite(
    groupId: GroupId,
    input?: { expiresInHours?: number; maxUses?: number; targetChannelId?: ChannelId },
  ): Promise<{ invite: Invite }>;
  /**
   * Join through an invite. `targetChannel` is where the joiner should land, or
   * `null` — which the server answers for a plain server invite, a deleted
   * channel, a group-DM link, AND a channel THIS viewer would not be able to
   * see. All four mean the same thing to a client: go to the front door. It is
   * never an error (§26).
   */
  redeemInvite(
    code: string,
  ): Promise<{ group: FriendGroup; targetChannel: InviteTargetChannel | null }>;

  // --- Media attachments (ADR 0008) — upload-url → PUT bytes → complete → send ---
  /**
   * Authorize + sign a direct upload into a channel's chat — text or, since M20,
   * voice (both are chat-capable, so a screenshot drops into a voice channel's
   * conversation like any other). Validate mime/size client-side first
   * (@demli/config ATTACHMENT_LIMITS); the API re-validates authoritatively.
   * Rejects for guests, non-whitelisted mimes and over-cap sizes; answers
   * ATTACHMENTS_DISABLED when storage is off.
   */
  createAttachmentUploadUrl(
    channelId: ChannelId,
    input: { filename?: string; mime: string; sizeBytes: number; isVoiceMessage?: boolean },
  ): Promise<AttachmentUploadTicket>;
  /**
   * Flip an uploaded attachment pending → ready after the bytes are PUT. The
   * server verifies the object exists and magic-byte-matches its declared kind.
   * Returns metadata only — render URLs come from {@link Api.getAttachmentUrls}.
   */
  completeAttachment(
    attachmentId: AttachmentId,
    input?: CompleteAttachmentInput,
  ): Promise<{ attachment: Attachment }>;
  /**
   * Mint short-lived signed READ URLs (~1 h) for attachments of one channel —
   * the SOLE source of renderable URLs (initial render, expiry refresh,
   * scroll-back). Max 100 ids per call.
   */
  getAttachmentUrls(
    channelId: ChannelId,
    attachmentIds: AttachmentId[],
  ): Promise<{ urls: AttachmentUrl[] }>;
  /** Cancel an upload before it is sent (uploader-only, unlinked-only ⇒ 409). */
  cancelAttachment(attachmentId: AttachmentId): Promise<void>;
  getMediaToken(channelId: string): Promise<MediaTokenResponse>;

  /** Search Tenor for GIFs. Returns 503 when the server has no Tenor key. */
  searchGifs(q: string, opts?: { limit?: number; pos?: string }): Promise<GifSearchResult>;
  /** Fetch trending GIFs from Tenor. */
  trendingGifs(opts?: { limit?: number; pos?: string }): Promise<GifSearchResult>;

  /**
   * Pull the AUTHORITATIVE voice occupancy snapshot (state-resync) —
   * `GET /voice/occupancy`, authed. Sourced from the media plane (LiveKit), so it
   * is the ground truth for who is connected and who is sharing across every voice
   * channel the caller can see. Same shape as the `voice.resync` gateway event;
   * clients REPLACE their per-channel occupancy from it (occupied channels only —
   * an absent channel is authoritatively empty). Pulled on app focus to heal any
   * desync a missed realtime delta left behind.
   *
   * When the media plane is briefly unreachable the server answers 503
   * `VOICE_OCCUPANCY_UNAVAILABLE` (a typed {@link ApiClientError}); the caller must
   * KEEP its current view on that (and on any other error) — never clear it (§26).
   */
  getVoiceOccupancy(): Promise<VoiceOccupancySnapshot>;

  // --- DM calls (ADR 0012) — control plane; media is LiveKit, signaling is call.* ---
  /**
   * Start a 1-1 call in a DM (`POST /dm-calls`). Returns the CALLER's
   * {@link DmCallTokenResponse} — hand `{ url, token }` + `roomName` straight to
   * the media engine's join. Throws `FORBIDDEN` when the two are not accepted
   * friends, `NOT_FOUND` for a bad DM, and `CONFLICT` when a call is already live
   * in this DM — that error's {@link ApiClientError.details} carries the existing
   * call as `{ call }` (a {@link DmCall}) so the caller can rejoin it.
   */
  startDmCall(input: { dmId: DmId; media: CallMedia }): Promise<DmCallTokenResponse>;
  /**
   * Accept a ringing call (`POST /dm-calls/:id/accept`, callee-only). Returns the
   * CALLEE's {@link DmCallTokenResponse} to join the SAME room. `CONFLICT` when the
   * call is no longer ringing or has expired; `FORBIDDEN` for a non-callee.
   */
  acceptDmCall(callId: CallId): Promise<DmCallTokenResponse>;
  /** Decline a ringing call (`POST /dm-calls/:id/reject`, callee-only). */
  rejectDmCall(callId: CallId): Promise<{ call: DmCall }>;
  /**
   * Withdraw a ringing call (`POST /dm-calls/:id/cancel`, caller-only). `reason`
   * `"timeout"` (the ring timer fired → the call is logged `missed`) distinguishes
   * it from a manual `"canceled"`; omitted defaults to a manual withdraw.
   */
  cancelDmCall(
    callId: CallId,
    reason?: "canceled" | "timeout",
  ): Promise<{ call: DmCall }>;
  /** End a live call (`POST /dm-calls/:id/hangup`, either participant). */
  hangupDmCall(callId: CallId): Promise<{ call: DmCall }>;
  /**
   * Add a third person to a live call (`POST /dm-calls/:id/upgrade`). The server
   * creates a group, moves the two originals' media into it WITHOUT a reconnect
   * (the group voice channel's LiveKit room IS the call room), and rings the
   * invitee. Returns the new group + its voice channel id.
   */
  upgradeDmCall(
    callId: CallId,
    input: { inviteeUserId: UserId },
  ): Promise<DmCallUpgradeResponse>;
  /**
   * The caller's cross-DM call history (`GET /dm-calls/recent`, Voice-UX #2) —
   * every call they took part in (caller OR callee), newest-first, keyset-paged
   * via `before`. `limit` is clamped server-side to 1..50 (default 25). Each
   * {@link RecentCall} carries the resolved `peer`, the caller's `direction`, and
   * `durationSeconds` (settled only for `ended` calls) so a row renders without a
   * follow-up fetch. Server-side authorization: the result is scoped to the
   * authenticated user — there is no id to tamper with.
   */
  getRecentCalls(options?: {
    limit?: number;
    before?: string | null;
  }): Promise<RecentCallsPage>;
  /**
   * The authenticated user's currently LIVE call, if any (`GET /dm-calls/active`)
   * — the resync read described on {@link ActiveDmCallResponse}. Called when a
   * `call.accepted` arrives that the FSM cannot place, and after a realtime
   * reconnect. Never throws for "no call": that is `{ call: null }`.
   */
  getActiveDmCall(): Promise<ActiveDmCallResponse>;

  /**
   * REST message send with optional attachment links (ADR 0008). The desktop
   * app sends over the gateway for optimistic reconciliation; this REST path is
   * the portable send used by clients without that pipeline (e.g. mobile) and
   * carries no nonce. `content` may be empty iff `attachmentIds` is non-empty.
   */
  sendMessage(channelId: string, input: SendMessageInput): Promise<{ message: Message }>;

  /**
   * Edit my own message's text — `PATCH /messages/:messageId`. Author-only: the
   * API returns `FORBIDDEN` for anyone else and `NOT_FOUND` for a missing/deleted
   * message. `content` is re-validated + trimmed server-side (1..MESSAGE_MAX_LENGTH,
   * non-blank) and NOT slowmode-gated. On success the row's `updatedAt` is set and
   * the server broadcasts `message.updated`, so every client (including this one)
   * reconciles its cache from the wire. Returns the fresh message DTO.
   */
  editMessage(messageId: MessageId, content: string): Promise<{ message: Message }>;
  /**
   * Delete a message — `DELETE /messages/:messageId` (204). Author-only for now;
   * the server also allows a moderator (owner ∨ MANAGE_MESSAGES) — a clean seam
   * for the later moderation wave. Soft-deletes the row and broadcasts
   * `message.deleted`, so clients drop it from the list (no tombstone).
   */
  deleteMessage(messageId: MessageId): Promise<void>;

  // --- Message reactions (ADR 0011 §4 — idempotent PUT/DELETE verbs) ---
  /**
   * Add my reaction to a message (`PUT`, idempotent). `emoji` may be any single
   * unicode emoji or a `:name:` custom-emoji shortcode resolvable in the message's
   * group (M17) — anything else is rejected with `INVALID_REACTION`. Authorization
   * rides `loadVisibleChannel`
   * (invisible/foreign channel ⇒ `NOT_FOUND`, no existence leak). Returns the
   * message's updated reaction summary so the caller reconciles. Rate-limited
   * (~30 / 10s per session).
   */
  addReaction(messageId: MessageId, emoji: string): Promise<MessageReactionsResponse>;
  /**
   * Remove my reaction from a message (`DELETE`, idempotent — removing a
   * reaction I never added is a no-op success). Same guards and return shape as
   * {@link Api.addReaction}.
   */
  removeReaction(messageId: MessageId, emoji: string): Promise<MessageReactionsResponse>;

  // --- Pinned messages (M17 — the per-channel pin board) ---
  /**
   * The channel's pinned messages, newest-pinned first. UN-paginated by design:
   * `PINS_MAX_PER_CHANNEL` (50) bounds the board, so the cap is the page size.
   * Each entry carries the fully enriched message (attachments, reactions, reply
   * preview, embeds) plus who pinned it and when. Same visibility gate as the
   * message list — an invisible/foreign channel answers `NOT_FOUND`.
   */
  listPins(channelId: ChannelId): Promise<{ pins: PinnedMessage[] }>;
  /**
   * Pin a message (idempotent — re-pinning is a no-op that keeps the original
   * `pinnedAt`). Allowed for the message's author, or a member with
   * MANAGE_MESSAGES / the owner; in DMs and flat group chats — which have no role
   * system — any member may pin. Answers `PINS_FULL` (409) when the channel
   * already holds 50. Broadcasts `message.pinned`.
   */
  pinMessage(
    channelId: ChannelId,
    messageId: MessageId,
  ): Promise<{ pin: PinnedMessage }>;
  /**
   * Unpin a message (204, idempotent). Same permission rule as
   * {@link Api.pinMessage}. Broadcasts `message.unpinned`.
   */
  unpinMessage(channelId: ChannelId, messageId: MessageId): Promise<void>;

  // --- Custom emoji (M17 — per-group `:name:` emoji) ---
  /**
   * A group's custom emoji (metadata only — no image URLs). Clients keep this to
   * resolve `:name:` in message content and to populate the picker, then mint
   * image URLs for the ones actually rendered via {@link Api.getCustomEmojiUrls}.
   * `maxPerGroup` echoes the server's cap so the UI can show "12 / 64".
   */
  listCustomEmojis(
    groupId: GroupId,
  ): Promise<{ emojis: CustomEmoji[]; maxPerGroup: number }>;
  /**
   * Upload a custom emoji. The image travels INLINE as base64 because it is
   * capped at `CUSTOM_EMOJI_MAX_BYTES` (256 KB) — that lets the server validate
   * the real bytes (size + magic bytes) before storing anything, so there is no
   * pending-upload dance. `name` is lowercased server-side and must match
   * `CUSTOM_EMOJI_NAME_PATTERN`.
   *
   * Errors: `INVALID_EMOJI` (not a real PNG/WebP), `EMOJI_TOO_LARGE`,
   * `EMOJI_NAME_TAKEN`, `EMOJI_LIMIT`, `EMOJI_DISABLED` (storage not configured).
   */
  createCustomEmoji(
    groupId: GroupId,
    input: CreateCustomEmojiInput,
  ): Promise<{ emoji: CustomEmoji }>;
  /**
   * Delete a custom emoji (204). The uploader may remove their own; anyone else
   * needs to be the group owner. Messages keep the literal `:name:` text, which
   * simply renders as plain text again — deleting an emoji never leaves a broken
   * image in the scrollback.
   */
  deleteCustomEmoji(groupId: GroupId, emojiId: CustomEmojiId): Promise<void>;
  /**
   * Mint short-lived signed READ URLs for a batch of the group's emoji — the SOLE
   * source of renderable emoji images (mirrors the attachment URL endpoint).
   * Re-request once `urlExpiresAt` passes.
   */
  getCustomEmojiUrls(
    groupId: GroupId,
    emojiIds: CustomEmojiId[],
  ): Promise<{ urls: CustomEmojiUrl[] }>;

  // --- Roles & permissions (ADR 0007 — servers only) ---
  /** All custom roles of a server, pre-sorted by `position` (owner ∨ member). */
  listRoles(groupId: GroupId): Promise<{ roles: Role[] }>;
  /** Create a role (owner ∨ MANAGE_ROLES). */
  createRole(groupId: GroupId, input: CreateRoleInput): Promise<{ role: Role }>;
  /** Rename / recolor / re-permission a role (owner ∨ MANAGE_ROLES). */
  updateRole(
    groupId: GroupId,
    roleId: RoleId,
    input: UpdateRoleInput,
  ): Promise<{ role: Role }>;
  /** Delete a role (owner ∨ MANAGE_ROLES). */
  deleteRole(groupId: GroupId, roleId: RoleId): Promise<void>;
  /**
   * Replace a member's full role set (owner ∨ MANAGE_ROLES). Send the complete
   * desired list; the server echoes the resulting `roleIds`.
   */
  setMemberRoles(
    groupId: GroupId,
    userId: UserId,
    roleIds: RoleId[],
  ): Promise<{ roleIds: RoleId[] }>;
  /** A channel's visibility role list (owner ∨ MANAGE_CHANNELS). `[]` = public. */
  listChannelRoles(channelId: ChannelId): Promise<{ roleIds: RoleId[] }>;
  /**
   * Replace a channel's visibility role list (owner ∨ MANAGE_CHANNELS). `[]`
   * makes the channel public to all members.
   */
  setChannelRoles(
    channelId: ChannelId,
    roleIds: RoleId[],
  ): Promise<{ roleIds: RoleId[] }>;

  // --- Social layer (ADR 0010): friendships, DMs ---
  /** Accepted friends, each with the other user's record (presence merged client-side). */
  listFriends(): Promise<{ friends: FriendWithUser[] }>;
  /** Pending requests by direction; the embedded `user` is the other party. */
  listFriendRequests(
    direction: FriendRequestDirection,
  ): Promise<{ requests: FriendWithUser[] }>;
  /**
   * Send a friend request by code or user id. Idempotent + consent-aware
   * server-side (duplicate → 409, reverse-pending → auto-accept). Rate-limited.
   */
  sendFriendRequest(input: SendFriendRequestInput): Promise<SendFriendRequestResult>;
  /**
   * Send a friend request BY USERNAME (#111 — the friend-code replacement).
   *
   * Rejects with `USER_NOT_FOUND` (404) when no account holds that username —
   * including a soft-deleted account and a blocked pair, which are deliberately
   * indistinguishable from an unknown handle (ADR 0017). `VALIDATION_ERROR` (400)
   * for adding yourself.
   *
   * Every outcome that reached a real account answers `{ ok: true }`, so callers
   * must NOT branch on the result: created, auto-accepted, already pending and
   * already friends are one indistinguishable success. Strictly rate-limited
   * (10 / 5 min per session) — since existence is now disclosed, that limit is
   * the only thing standing between this route and a username scraper.
   */
  sendFriendRequestByUsername(
    username: string,
  ): Promise<SendFriendRequestByUsernameResult>;
  /** Accept an incoming request (addressee-only). `userId` = the requester's id. */
  acceptFriendRequest(userId: UserId): Promise<{ friendship: Friendship }>;
  /** Decline (addressee) or cancel (requester) a pending request. `userId` = other party. */
  removeFriendRequest(userId: UserId): Promise<void>;
  /** Remove an accepted friendship. */
  unfriend(userId: UserId): Promise<void>;
  /** Every DM the caller has open (hidden ones filtered), newest first. */
  listDms(): Promise<{ dms: Dm[] }>;
  /**
   * Open (idempotently create) the DM with a friend — requires an accepted
   * friendship (403 otherwise). Always un-hides the caller's side. Rate-limited.
   */
  openDm(userId: UserId): Promise<{ dm: Dm }>;
  /** Close a DM for the caller only (hide-for-self; history preserved). */
  hideDm(dmId: DmId): Promise<void>;

  // --- Notification mutes (migration 0013 — "Kanalı/Sunucuyu Sustur") ---
  /** The caller's own mutes, newest first (includes expired rows the UI ignores). */
  listNotificationMutes(): Promise<{ mutes: NotificationMute[] }>;
  /**
   * Mute (or re-mute) a channel or group/server for the caller (`PUT`,
   * idempotent). Gated on visibility server-side: muting a channel/group you
   * cannot see answers `NOT_FOUND`. Fans out `notification_mute.updated` to the
   * caller's other devices. Returns the resulting mute row.
   */
  setNotificationMute(input: SetNotificationMuteInput): Promise<{ mute: NotificationMute }>;
  /**
   * Unmute a target (`DELETE`, idempotent — clearing a target that was not muted
   * is still a success). Fans out `notification_mute.updated` with `mute:null`.
   */
  clearNotificationMute(scope: NotificationMuteScope, targetId: string): Promise<void>;

  // --- Account lifecycle & profile banner (M15) ---
  /**
   * Soft-delete the signed-in account (`POST /users/me/delete`). The server marks
   * the account for deletion and FREEZES it for a 14-day grace window; signing in
   * again within that window reactivates it, after which it is permanently removed.
   * The caller should sign out locally on success.
   */
  deleteMe(): Promise<void>;
  /**
   * Cancel a pending deletion / reactivate a frozen account (`POST
   * /users/me/reactivate`). Reactivation normally happens implicitly on the next
   * sign-in within the grace window; this explicit endpoint is here for
   * completeness. Returns the reactivated user.
   */
  reactivateMe(): Promise<{ user: User }>;
  /**
   * Upload a profile BANNER (inline base64), mirroring {@link Api.uploadAvatar}.
   * The server validates the real bytes, stores a public URL and returns the
   * updated user with its new `bannerUrl`.
   */
  uploadBanner(input: UploadBannerInput): Promise<{ user: User }>;

  // --- M18: channel categories (migration 0019) ---
  /** A server's categories in sidebar order. Any member may read them. */
  listCategories(groupId: GroupId): Promise<{ categories: ChannelCategory[] }>;
  /** Append a category to the end of the server's list (owner ∨ MANAGE_CHANNELS). */
  createCategory(groupId: GroupId, input: { name: string }): Promise<{ category: ChannelCategory }>;
  /** Rename a category (owner ∨ MANAGE_CHANNELS). */
  renameCategory(
    categoryId: CategoryId,
    input: { name: string },
  ): Promise<{ category: ChannelCategory }>;
  /**
   * Delete a category (owner ∨ MANAGE_CHANNELS). Its channels are NOT deleted —
   * the FK is ON DELETE SET NULL, so they fall back to the uncategorized
   * top-level list. The group gets `category.deleted` naming the freed channels.
   */
  deleteCategory(categoryId: CategoryId): Promise<void>;
  /**
   * Rewrite the sidebar order (owner ∨ MANAGE_CHANNELS) — BOTH axes in ONE atomic
   * call, so the sidebar can never be observed half-reordered.
   *
   * IMPORTANT contract detail: for each target bucket the server rewrites
   * positions densely from 0 **in the order the `channels` array lists them, over
   * the listed ids only**. A caller must therefore send the COMPLETE ordered list
   * of every channel in each bucket it touches — sending just the moved channel
   * would renumber it to position 0 and collide with its new neighbours. The
   * helpers in `@demli/app-ui` (`channelOrder.ts`) build a conforming payload.
   */
  reorderChannels(groupId: GroupId, input: ChannelOrderInput): Promise<void>;

  // --- M18: user blocking (ADR 0017) ---
  /**
   * Everyone the CALLER has blocked, hydrated for the settings list. Deliberately
   * not "who blocked me" — that is never queryable (§28).
   */
  listBlocks(): Promise<{ blocks: BlockedUser[] }>;
  /**
   * Block a user (`PUT`, 201). Also severs any friendship / pending request in
   * both directions. The other side is told only that the friendship ended — their
   * client cannot distinguish a block from an unfriend.
   */
  blockUser(userId: UserId): Promise<{ block: UserBlock }>;
  /**
   * Lift a block (`DELETE`, 204). Does NOT restore the friendship — that needs a
   * fresh, consent-requiring friend request. 404s when the user was not blocked.
   */
  unblockUser(userId: UserId): Promise<void>;

  // --- M18: custom status ---
  /**
   * Set or clear the caller's custom status line. A null/blank `text` clears it
   * (and its expiry with it). `expiresInMinutes` auto-clears it later ("30 min",
   * "today"); omit for an indefinite status. Stored RAW as plain text and escaped
   * at render (§28) — never rendered as HTML or markdown.
   */
  setCustomStatus(input: {
    text: string | null;
    expiresInMinutes?: number;
  }): Promise<{ user: User }>;
  /** Explicit clear — the same primitive as {@link Api.setCustomStatus} with a null text. */
  clearCustomStatus(): Promise<{ user: User }>;

  // --- M18: moderation audit log ---
  /**
   * A server's moderation history, newest first (owner ∨ KICK_MEMBERS). Keyset
   * paged: pass the previous page's `nextCursor` as `before`. Entries are
   * hydrated with the actor/target user records; `actor` is null once that
   * account is hard-purged.
   */
  listModerationLog(
    groupId: GroupId,
    options?: { limit?: number; before?: string | null },
  ): Promise<ModerationLogPage>;

  // --- M18: group-DM invite links ---
  /**
   * Mint a join link for a flat group chat (ADR 0005). ANY member may create one
   * (a flat chat has no roles and no invite policy); redemption goes through the
   * SAME `POST /invites/:code/redeem` as a server invite, so there is exactly one
   * deep-link format.
   */
  createGroupChatInvite(
    groupChatId: GroupId,
    input?: { expiresInHours?: number; maxUses?: number },
  ): Promise<{ invite: Invite }>;
  /** The group chat's live invite links (any member). */
  listGroupChatInvites(groupChatId: GroupId): Promise<{ invites: Invite[] }>;
  /** Revoke one link (group OWNER only, mirroring "only the owner adds members"). */
  revokeGroupChatInvite(groupChatId: GroupId, inviteId: InviteId): Promise<void>;

  // --- Invite preview (in-chat davet embed kartı) ---
  /**
   * Peek at an invite WITHOUT redeeming it — this backs the preview card a
   * pasted invite link renders in chat. The response shape is the canonical
   * {@link InvitePreview} from `@demli/types` (shared with the API module).
   * Errors carry the invite's fate as an {@link ApiClientError} code:
   * NOT_FOUND, INVITE_EXPIRED, INVITE_EXHAUSTED, or GROUP_BANNED (the card
   * shows all four as a neutral "no longer valid"-style line — GROUP_BANNED
   * must not be distinguishable, §28).
   */
  getInvitePreview(code: string): Promise<{ preview: InvitePreview }>;

  // -------------------------------------------------------------------------
  // Migration 0020 / ADR 0019 — the member context menu's five private-or-
  // moderation actions: note, the TWO nickname layers, timeout, ignore.
  // -------------------------------------------------------------------------

  /**
   * The caller's private note about `userId` (ADR 0019 §1), or `{ note: null }`
   * when none exists. SINGLE-READER by construction: the endpoint is always
   * scoped to the session's own user, no profile/roster/realtime payload carries
   * a note, and the person it is about has no endpoint that returns it. Never
   * render one on any surface a third party can see.
   */
  getUserNote(userId: UserId): Promise<{ note: UserNote | null }>;
  /**
   * Write (or clear) the caller's private note about `userId`. `body: null` — or
   * an all-whitespace string — DELETES the note and resolves with `note: null`.
   * Max 256 chars (`USER_NOTE_MAX_LENGTH`); noting yourself is a 400.
   */
  setUserNote(userId: UserId, body: string | null): Promise<{ note: UserNote | null }>;

  /**
   * Set (or clear with `null`) the caller's PRIVATE nickname for `userId` — the
   * "friend nickname" only the caller ever sees (ADR 0019 §2). Global across
   * every surface, invisible to the target, and distinct from
   * {@link Api.setMemberNickname}, which renames someone FOR A WHOLE SERVER.
   * Max 32 chars (`USER_NICKNAME_MAX_LENGTH`).
   */
  setUserNickname(userId: UserId, nickname: string | null): Promise<{ nickname: string | null }>;
  /**
   * The caller's ENTIRE private-nickname map, in one call. Deliberately a bulk
   * sync rather than a per-user join: a private label must never ride along on a
   * roster/message payload where it could fan out to the wrong person, so the
   * client fetches the map once and resolves names locally (ADR 0019 §2).
   */
  listUserNicknames(): Promise<{ nicknames: UserNicknameEntry[] }>;

  /**
   * Set (or clear with `null`) a member's PER-SERVER nickname — visible to
   * everyone in that server. Renaming YOURSELF needs no permission; renaming
   * anyone else needs owner ∨ MANAGE_NICKNAMES, and the owner is immune.
   * Max 32 chars (`MEMBER_NICKNAME_MAX_LENGTH`).
   */
  setMemberNickname(
    groupId: GroupId,
    userId: UserId,
    nickname: string | null,
  ): Promise<{ member: FriendGroupMember }>;

  /**
   * Time a member out for `minutes` (owner ∨ KICK_MEMBERS; the owner is immune
   * and you cannot time yourself out). While it holds, the member cannot send
   * messages, react, or join voice IN THIS SERVER — enforced server-side on
   * every one of those paths, over BOTH transports (ADR 0019 §3).
   * `minutes` ∈ [`TIMEOUT_MIN_MINUTES`, `TIMEOUT_MAX_MINUTES`] (1 … 28 days).
   */
  timeoutMember(
    groupId: GroupId,
    userId: UserId,
    input: { minutes: number; reason?: string },
  ): Promise<{ member: FriendGroupMember }>;
  /** Lift a timeout early (same permission); logs a separate `timeout_remove` action. */
  removeMemberTimeout(groupId: GroupId, userId: UserId): Promise<void>;

  /**
   * Everyone the caller has ignored (the settings list). An ignore is NOT a
   * block (ADR 0019 §4): one-directional, silent, cuts no write path — it only
   * drops the ignorer's notifications server-side and folds the ignored user's
   * rows client-side.
   */
  listIgnores(): Promise<{ ignores: IgnoredUser[] }>;
  /** Start ignoring `userId`. Idempotent; the target is never told. */
  ignoreUser(userId: UserId): Promise<{ ignore: UserIgnore }>;
  /** Stop ignoring `userId` (404 when they were not ignored). */
  unignoreUser(userId: UserId): Promise<void>;

  // -- Games (MSN revival) ---------------------------------------------------

  /** Send a game invite to another user in a channel. */
  gameInvite(input: {
    targetUserId: UserId;
    channelId: ChannelId;
    gameType: GameType;
  }): Promise<{ gameId: GameId }>;

  /** Accept a pending game invite. */
  gameAccept(gameId: GameId): Promise<void>;

  /** Decline a pending game invite. */
  gameDecline(gameId: GameId): Promise<void>;

  /** Submit a move in an active game. */
  gameMove(gameId: GameId, action: WireGameAction): Promise<void>;
}

/** What {@link createApiClient} returns: the endpoints plus the token setter. */
export interface ApiClient {
  api: Api;
  /** Called by the auth store whenever the session token changes. */
  setAuthToken(token: string | null): void;
}

/**
 * Build a Demli API client bound to `config.baseUrl`. The auth token is
 * instance-local; call the returned `setAuthToken` from your session store.
 */
export function createApiClient(config: ApiClientConfig): ApiClient {
  const baseUrl = config.baseUrl;
  // FAIL AT STARTUP, not at the gate. A malformed mark type-checks fine but is
  // indistinguishable from no mark at all once the gate is armed, so the build
  // would look healthy on every machine that has the gate off and be dead on
  // the one that matters. Throwing here means a bad signature cannot survive
  // the first launch — or the test suite.
  if (!isValidClientSignature(config.clientSignature)) {
    throw new Error(
      `createApiClient: invalid clientSignature ${JSON.stringify(config.clientSignature)} — ` +
        "expected `demli-<app>/<version>`; build it with formatClientSignature() from @demli/config.",
    );
  }
  const clientSignature = config.clientSignature;
  let authToken: string | null = null;

  function setAuthToken(token: string | null): void {
    authToken = token;
  }

  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = {};
    // Sent on EVERY request, including the unauthenticated ones: the gate runs
    // ahead of auth on the server (an old build must not even be able to log
    // in), so an endpoint that skipped the mark would 426 instead of working.
    headers[CLIENT_SIGNATURE_HEADER] = clientSignature;
    if (options.body !== undefined) headers["Content-Type"] = "application/json";
    if (options.auth !== false && authToken) {
      headers["Authorization"] = `Bearer ${authToken}`;
    }

    let response: Response;
    try {
      response = await fetch(`${baseUrl}${path}`, {
        method: options.method ?? "GET",
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
    } catch {
      throw new ApiClientError(
        "NETWORK",
        "Can't reach the server. Check your connection and try again.",
      );
    }

    if (response.status === 204) return undefined as T;

    let payload: unknown = null;
    try {
      payload = await response.json();
    } catch {
      // Non-JSON body — fall through to the status check below.
    }

    if (!response.ok) {
      // The build refusal is decided by the STATUS, before the body is read: the
      // gate may answer with the flat `{ error: "CLIENT_UPDATE_REQUIRED", … }`
      // shape, with an empty body, or through a proxy that dropped the JSON —
      // and in every one of those cases the client must still know it has been
      // retired rather than fall through to a generic "something went wrong".
      const gated = isClientUpdateRequiredStatus(response.status);
      const errorShape = (
        payload as {
          error?: { code?: string; message?: string; retryAfterSeconds?: number };
        } | null
      )?.error;
      const code: ApiClientErrorCode = gated
        ? CLIENT_UPDATE_REQUIRED_CODE
        : ((errorShape?.code as ApiClientErrorCode | undefined) ?? "INTERNAL");
      if (gated) {
        const info: ClientUpdateRequired = {
          source: "http",
          downloadUrl: readClientUpdateDownloadUrl(payload),
        };
        try {
          config.onClientUpdateRequired?.(info);
        } catch {
          // A broken listener must not turn the refusal into a different error.
        }
      }
      const message = gated
        ? // Never rendered in the app — the migration screen owns that copy in
          // the user's language. This is the last-resort string for a log line.
          "This version of Demli can no longer connect. Install the new one."
        : (errorShape?.message ?? "Something went wrong on our side. Please try again.");
      // SLOWMODE (429) carries how long until the caller may send again.
      const retryAfterSeconds =
        typeof errorShape?.retryAfterSeconds === "number"
          ? errorShape.retryAfterSeconds
          : null;
      throw new ApiClientError(code, message, response.status, retryAfterSeconds, payload);
    }

    return payload as T;
  }

  const api: Api = {
    register(input) {
      return request<AuthResponse>("/auth/register", {
        method: "POST",
        body: input,
        auth: false,
      });
    },

    login(input) {
      return request<AuthResponse>("/auth/login", {
        method: "POST",
        body: input,
        auth: false,
      });
    },

    logout() {
      return request<void>("/auth/logout", { method: "POST" });
    },

    getMe() {
      return request<{ user: User }>("/users/me");
    },

    updateMe(input) {
      return request<{ user: User }>("/users/me", { method: "PATCH", body: input });
    },

    uploadAvatar(input) {
      return request<{ user: User }>("/users/me/avatar", { method: "POST", body: input });
    },

    // --- Active sessions (M15-A) ---
    listSessions() {
      return request<{ sessions: SessionSummary[] }>("/sessions");
    },

    revokeSession(sessionId) {
      return request<void>(`/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
    },

    revokeOtherSessions() {
      return request<{ revoked: number }>("/sessions/others", { method: "DELETE" });
    },

    getMobileVersion() {
      return request<MobileVersionInfo>("/mobile/version", { auth: false });
    },

    // --- Push devices (task #46) ---
    registerDevice(input) {
      return request<void>("/devices/token", { method: "POST", body: input });
    },

    unregisterDevice(input) {
      return request<void>("/devices/token", { method: "DELETE", body: input });
    },

    getUser(userId) {
      return request<{ user: User }>(`/users/${encodeURIComponent(userId)}`);
    },

    getUserProfile(userId, groupId) {
      const query = groupId ? `?groupId=${encodeURIComponent(groupId)}` : "";
      return request<{ profile: UserProfile }>(
        `/users/${encodeURIComponent(userId)}/profile${query}`,
      );
    },

    regenerateFriendCode() {
      return request<{ user: User }>("/users/me/friend-code/regenerate", {
        method: "POST",
      });
    },

    listGroups() {
      return request<{ groups: FriendGroup[] }>("/groups");
    },

    createGroup(input) {
      return request<{ group: FriendGroup }>("/groups", { method: "POST", body: input });
    },

    getGroupDetails(groupId) {
      return request<GroupDetails>(`/groups/${encodeURIComponent(groupId)}`);
    },

    updateGroup(groupId, input) {
      return request<{ group: FriendGroup }>(`/groups/${encodeURIComponent(groupId)}`, {
        method: "PATCH",
        body: input,
      });
    },

    uploadGroupBanner(groupId, input) {
      return request<{ group: FriendGroup }>(
        `/groups/${encodeURIComponent(groupId)}/banner`,
        { method: "POST", body: input },
      );
    },

    deleteGroup(groupId) {
      return request<void>(`/groups/${encodeURIComponent(groupId)}`, { method: "DELETE" });
    },

    leaveGroup(groupId, userId) {
      return request<void>(
        `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      );
    },

    // --- Server moderation (migration 0017) ---
    kickMember(groupId, userId) {
      return request<void>(
        `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/kick`,
        { method: "POST" },
      );
    },

    banMember(groupId, userId, reason) {
      return request<{ ban: GroupBan }>(`/groups/${encodeURIComponent(groupId)}/bans`, {
        method: "POST",
        body: reason !== undefined ? { userId, reason } : { userId },
      });
    },

    unbanMember(groupId, userId) {
      return request<void>(
        `/groups/${encodeURIComponent(groupId)}/bans/${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      );
    },

    listBans(groupId) {
      return request<{ bans: GroupBanWithUser[] }>(
        `/groups/${encodeURIComponent(groupId)}/bans`,
      );
    },

    disconnectFromVoice(channelId, userId) {
      return request<void>(
        `/channels/${encodeURIComponent(channelId)}/voice/${encodeURIComponent(userId)}/disconnect`,
        { method: "POST" },
      );
    },

    createChannel(groupId, input) {
      return request<{ channel: Channel }>(
        `/groups/${encodeURIComponent(groupId)}/channels`,
        { method: "POST", body: input },
      );
    },

    updateChannel(channelId, input) {
      return request<{ channel: Channel }>(`/channels/${encodeURIComponent(channelId)}`, {
        method: "PATCH",
        body: input,
      });
    },

    deleteChannel(channelId) {
      return request<void>(`/channels/${encodeURIComponent(channelId)}`, {
        method: "DELETE",
      });
    },

    createGroupChat(input) {
      return request<{ group: Group }>("/group-chats", { method: "POST", body: input });
    },

    listGroupChats() {
      return request<{ groups: Group[] }>("/group-chats");
    },

    getGroupChat(groupChatId) {
      return request<GroupChatDetails>(`/group-chats/${encodeURIComponent(groupChatId)}`);
    },

    addGroupChatMember(groupChatId, input) {
      return request<{ member: GroupMemberWithUser }>(
        `/group-chats/${encodeURIComponent(groupChatId)}/members`,
        { method: "POST", body: input },
      );
    },

    removeGroupChatMember(groupChatId, userId) {
      return request<void>(
        `/group-chats/${encodeURIComponent(groupChatId)}/members/${encodeURIComponent(userId)}`,
        { method: "DELETE" },
      );
    },

    deleteGroupChat(groupChatId) {
      return request<void>(`/group-chats/${encodeURIComponent(groupChatId)}`, {
        method: "DELETE",
      });
    },

    listMessages(channelId, options = {}) {
      const params = new URLSearchParams();
      if (options.cursor) params.set("cursor", options.cursor);
      if (options.limit) params.set("limit", String(options.limit));
      const query = params.size > 0 ? `?${params.toString()}` : "";
      return request<MessagesPage>(
        `/channels/${encodeURIComponent(channelId)}/messages${query}`,
      );
    },

    searchMessages(channelId, input) {
      const params = new URLSearchParams();
      params.set("q", input.q);
      if (input.limit) params.set("limit", String(input.limit));
      if (input.before) params.set("before", input.before);
      return request<MessagesPage>(
        `/channels/${encodeURIComponent(channelId)}/messages/search?${params.toString()}`,
      );
    },

    getWatchCapabilities() {
      return request<WatchCapabilities>("/watch/capabilities");
    },

    searchWatchVideos(input) {
      const params = new URLSearchParams();
      params.set("channelId", input.channelId);
      params.set("q", input.q);
      return request<WatchSearchResponse>(`/watch/search?${params.toString()}`);
    },

    createInvite(groupId, input = {}) {
      return request<{ invite: Invite }>(
        `/groups/${encodeURIComponent(groupId)}/invites`,
        { method: "POST", body: input },
      );
    },

    redeemInvite(code) {
      return request<{ group: FriendGroup; targetChannel: InviteTargetChannel | null }>(
        `/invites/${encodeURIComponent(code)}/redeem`,
        { method: "POST" },
      );
    },

    // --- Media attachments (ADR 0008) ---
    createAttachmentUploadUrl(channelId, input) {
      return request<AttachmentUploadTicket>(
        `/channels/${encodeURIComponent(channelId)}/attachments/upload-url`,
        { method: "POST", body: input },
      );
    },

    completeAttachment(attachmentId, input = {}) {
      return request<{ attachment: Attachment }>(
        `/attachments/${encodeURIComponent(attachmentId)}/complete`,
        { method: "POST", body: input },
      );
    },

    getAttachmentUrls(channelId, attachmentIds) {
      return request<{ urls: AttachmentUrl[] }>(
        `/channels/${encodeURIComponent(channelId)}/attachments/urls`,
        { method: "POST", body: { attachmentIds } },
      );
    },

    cancelAttachment(attachmentId) {
      return request<void>(`/attachments/${encodeURIComponent(attachmentId)}`, {
        method: "DELETE",
      });
    },

    /**
     * Mint a LiveKit access token for a voice channel the caller belongs to.
     * The voice engine consumes { url, token }; roomName/identity/expiresAt are
     * informational. Errors surface as typed ApiClientError values
     * (UNAUTHORIZED / NOT_FOUND / INVALID_CHANNEL / RATE_LIMITED / VALIDATION_ERROR).
     */
    getMediaToken(channelId) {
      return request<MediaTokenResponse>("/media/token", {
        method: "POST",
        body: { channelId },
      });
    },

    getVoiceOccupancy() {
      return request<VoiceOccupancySnapshot>("/voice/occupancy");
    },

    // --- GIF search (Tenor proxy) ---
    searchGifs(q, opts) {
      const params = new URLSearchParams({ q });
      if (opts?.limit) params.set("limit", String(opts.limit));
      if (opts?.pos) params.set("pos", opts.pos);
      return request<GifSearchResult>(`/gif/search?${params}`);
    },
    trendingGifs(opts) {
      const params = new URLSearchParams();
      if (opts?.limit) params.set("limit", String(opts.limit));
      if (opts?.pos) params.set("pos", opts.pos);
      return request<GifSearchResult>(`/gif/trending?${params}`);
    },

    // --- DM calls (ADR 0012) ---
    startDmCall(input) {
      return request<DmCallTokenResponse>("/dm-calls", {
        method: "POST",
        body: input,
      });
    },

    acceptDmCall(callId) {
      return request<DmCallTokenResponse>(
        `/dm-calls/${encodeURIComponent(callId)}/accept`,
        { method: "POST" },
      );
    },

    rejectDmCall(callId) {
      return request<{ call: DmCall }>(
        `/dm-calls/${encodeURIComponent(callId)}/reject`,
        { method: "POST" },
      );
    },

    cancelDmCall(callId, reason) {
      return request<{ call: DmCall }>(
        `/dm-calls/${encodeURIComponent(callId)}/cancel`,
        { method: "POST", body: reason ? { reason } : {} },
      );
    },

    hangupDmCall(callId) {
      return request<{ call: DmCall }>(
        `/dm-calls/${encodeURIComponent(callId)}/hangup`,
        { method: "POST" },
      );
    },

    upgradeDmCall(callId, input) {
      return request<DmCallUpgradeResponse>(
        `/dm-calls/${encodeURIComponent(callId)}/upgrade`,
        { method: "POST", body: input },
      );
    },

    getRecentCalls(options = {}) {
      const params = new URLSearchParams();
      if (options.limit) params.set("limit", String(options.limit));
      if (options.before) params.set("before", options.before);
      const query = params.size > 0 ? `?${params.toString()}` : "";
      return request<RecentCallsPage>(`/dm-calls/recent${query}`);
    },

    getActiveDmCall() {
      return request<ActiveDmCallResponse>("/dm-calls/active");
    },

    sendMessage(channelId, input) {
      return request<{ message: Message }>(
        `/channels/${encodeURIComponent(channelId)}/messages`,
        { method: "POST", body: input },
      );
    },

    editMessage(messageId, content) {
      return request<{ message: Message }>(`/messages/${encodeURIComponent(messageId)}`, {
        method: "PATCH",
        body: { content },
      });
    },

    deleteMessage(messageId) {
      return request<void>(`/messages/${encodeURIComponent(messageId)}`, {
        method: "DELETE",
      });
    },

    // --- Message reactions (ADR 0011) ---
    addReaction(messageId, emoji) {
      return request<MessageReactionsResponse>(        `/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`,
        { method: "PUT" },
      );
    },

    removeReaction(messageId, emoji) {
      return request<MessageReactionsResponse>(        `/messages/${encodeURIComponent(messageId)}/reactions/${encodeURIComponent(emoji)}`,
        { method: "DELETE" },
      );
    },

    // --- Pinned messages (M17) ---
    listPins(channelId) {
      return request<{ pins: PinnedMessage[] }>(
        `/channels/${encodeURIComponent(channelId)}/pins`,
      );
    },

    pinMessage(channelId, messageId) {
      return request<{ pin: PinnedMessage }>(
        `/channels/${encodeURIComponent(channelId)}/pins/${encodeURIComponent(messageId)}`,
        { method: "POST" },
      );
    },

    unpinMessage(channelId, messageId) {
      return request<void>(
        `/channels/${encodeURIComponent(channelId)}/pins/${encodeURIComponent(messageId)}`,
        { method: "DELETE" },
      );
    },

    // --- Custom emoji (M17) ---
    listCustomEmojis(groupId) {
      return request<{ emojis: CustomEmoji[]; maxPerGroup: number }>(
        `/groups/${encodeURIComponent(groupId)}/emojis`,
      );
    },

    createCustomEmoji(groupId, input) {
      return request<{ emoji: CustomEmoji }>(
        `/groups/${encodeURIComponent(groupId)}/emojis`,
        { method: "POST", body: input },
      );
    },

    deleteCustomEmoji(groupId, emojiId) {
      return request<void>(
        `/groups/${encodeURIComponent(groupId)}/emojis/${encodeURIComponent(emojiId)}`,
        { method: "DELETE" },
      );
    },

    getCustomEmojiUrls(groupId, emojiIds) {
      return request<{ urls: CustomEmojiUrl[] }>(
        `/groups/${encodeURIComponent(groupId)}/emojis/urls`,
        { method: "POST", body: { emojiIds } },
      );
    },

    // --- Roles & permissions (ADR 0007) ---
    listRoles(groupId) {
      return request<{ roles: Role[] }>(
        `/groups/${encodeURIComponent(groupId)}/roles`,
      );
    },

    createRole(groupId, input) {
      return request<{ role: Role }>(`/groups/${encodeURIComponent(groupId)}/roles`, {
        method: "POST",
        body: input,
      });
    },

    updateRole(groupId, roleId, input) {
      return request<{ role: Role }>(
        `/groups/${encodeURIComponent(groupId)}/roles/${encodeURIComponent(roleId)}`,
        { method: "PATCH", body: input },
      );
    },

    deleteRole(groupId, roleId) {
      return request<void>(
        `/groups/${encodeURIComponent(groupId)}/roles/${encodeURIComponent(roleId)}`,
        { method: "DELETE" },
      );
    },

    setMemberRoles(groupId, userId, roleIds) {
      return request<{ roleIds: RoleId[] }>(
        `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/roles`,
        { method: "PUT", body: { roleIds } },
      );
    },

    listChannelRoles(channelId) {
      return request<{ roleIds: RoleId[] }>(
        `/channels/${encodeURIComponent(channelId)}/access`,
      );
    },

    setChannelRoles(channelId, roleIds) {
      return request<{ roleIds: RoleId[] }>(
        `/channels/${encodeURIComponent(channelId)}/access`,
        { method: "PUT", body: { roleIds } },
      );
    },

    // --- Social layer (ADR 0010) ---
    listFriends() {
      return request<{ friends: FriendWithUser[] }>("/friends");
    },

    listFriendRequests(direction) {
      return request<{ requests: FriendWithUser[] }>(
        `/friends/requests?direction=${encodeURIComponent(direction)}`,
      );
    },

    sendFriendRequest(input) {
      return request<SendFriendRequestResult>("/friends/requests", {
        method: "POST",
        body: input,
      });
    },

    sendFriendRequestByUsername(username) {
      return request<SendFriendRequestByUsernameResult>("/friends/requests/by-username", {
        method: "POST",
        body: { username },
      });
    },

    acceptFriendRequest(userId) {
      return request<{ friendship: Friendship }>(
        `/friends/requests/${encodeURIComponent(userId)}/accept`,
        { method: "POST" },
      );
    },

    removeFriendRequest(userId) {
      return request<void>(`/friends/requests/${encodeURIComponent(userId)}`, {
        method: "DELETE",
      });
    },

    unfriend(userId) {
      return request<void>(`/friends/${encodeURIComponent(userId)}`, {
        method: "DELETE",
      });
    },

    listDms() {
      return request<{ dms: Dm[] }>("/dms");
    },

    openDm(userId) {
      return request<{ dm: Dm }>("/dms", { method: "POST", body: { userId } });
    },

    hideDm(dmId) {
      return request<void>(`/dms/${encodeURIComponent(dmId)}`, { method: "DELETE" });
    },

    listNotificationMutes() {
      return request<{ mutes: NotificationMute[] }>("/notification-mutes");
    },

    setNotificationMute(input) {
      return request<{ mute: NotificationMute }>("/notification-mutes", {
        method: "PUT",
        body: input,
      });
    },

    clearNotificationMute(scope, targetId) {
      return request<void>(
        `/notification-mutes/${encodeURIComponent(scope)}/${encodeURIComponent(targetId)}`,
        { method: "DELETE" },
      );
    },

    // --- Account lifecycle & profile banner (M15) ---
    deleteMe() {
      return request<void>("/users/me/delete", { method: "POST" });
    },

    reactivateMe() {
      return request<{ user: User }>("/users/me/reactivate", { method: "POST" });
    },

    uploadBanner(input) {
      return request<{ user: User }>("/users/me/banner", { method: "POST", body: input });
    },

    // --- M18: channel categories (migration 0019) ---
    listCategories(groupId) {
      return request<{ categories: ChannelCategory[] }>(
        `/groups/${encodeURIComponent(groupId)}/categories`,
      );
    },

    createCategory(groupId, input) {
      return request<{ category: ChannelCategory }>(
        `/groups/${encodeURIComponent(groupId)}/categories`,
        { method: "POST", body: input },
      );
    },

    renameCategory(categoryId, input) {
      return request<{ category: ChannelCategory }>(
        `/categories/${encodeURIComponent(categoryId)}`,
        { method: "PATCH", body: input },
      );
    },

    deleteCategory(categoryId) {
      return request<void>(`/categories/${encodeURIComponent(categoryId)}`, {
        method: "DELETE",
      });
    },

    reorderChannels(groupId, input) {
      return request<void>(`/groups/${encodeURIComponent(groupId)}/channel-order`, {
        method: "PATCH",
        body: input,
      });
    },

    // --- M18: user blocking (ADR 0017) ---
    listBlocks() {
      return request<{ blocks: BlockedUser[] }>("/users/me/blocks");
    },

    blockUser(userId) {
      return request<{ block: UserBlock }>(`/users/me/blocks/${encodeURIComponent(userId)}`, {
        method: "PUT",
      });
    },

    unblockUser(userId) {
      return request<void>(`/users/me/blocks/${encodeURIComponent(userId)}`, {
        method: "DELETE",
      });
    },

    // --- M18: custom status ---
    setCustomStatus(input) {
      return request<{ user: User }>("/users/me/custom-status", {
        method: "PUT",
        body: input,
      });
    },

    clearCustomStatus() {
      return request<{ user: User }>("/users/me/custom-status", { method: "DELETE" });
    },

    // --- M18: moderation audit log ---
    listModerationLog(groupId, options = {}) {
      const params = new URLSearchParams();
      if (options.limit !== undefined) params.set("limit", String(options.limit));
      if (options.before) params.set("before", options.before);
      const query = params.toString();
      return request<ModerationLogPage>(
        `/groups/${encodeURIComponent(groupId)}/moderation-log${query ? `?${query}` : ""}`,
      );
    },

    // --- M18: group-DM invite links ---
    createGroupChatInvite(groupChatId, input = {}) {
      return request<{ invite: Invite }>(
        `/group-chats/${encodeURIComponent(groupChatId)}/invites`,
        { method: "POST", body: input },
      );
    },

    listGroupChatInvites(groupChatId) {
      return request<{ invites: Invite[] }>(
        `/group-chats/${encodeURIComponent(groupChatId)}/invites`,
      );
    },

    revokeGroupChatInvite(groupChatId, inviteId) {
      return request<void>(
        `/group-chats/${encodeURIComponent(groupChatId)}/invites/${encodeURIComponent(inviteId)}`,
        { method: "DELETE" },
      );
    },

    // --- Invite preview (in-chat davet embed kartı) ---
    getInvitePreview(code) {
      return request<{ preview: InvitePreview }>(
        `/invites/${encodeURIComponent(code)}/preview`,
      );
    },

    // --- Migration 0020 / ADR 0019: note, nicknames, timeout, ignore ---
    getUserNote(userId) {
      return request<{ note: UserNote | null }>(
        `/users/${encodeURIComponent(userId)}/note`,
      );
    },

    setUserNote(userId, body) {
      return request<{ note: UserNote | null }>(
        `/users/${encodeURIComponent(userId)}/note`,
        { method: "PUT", body: { body } },
      );
    },

    setUserNickname(userId, nickname) {
      return request<{ nickname: string | null }>(
        `/users/${encodeURIComponent(userId)}/nickname`,
        { method: "PUT", body: { nickname } },
      );
    },

    listUserNicknames() {
      return request<{ nicknames: UserNicknameEntry[] }>("/users/me/nicknames");
    },

    setMemberNickname(groupId, userId, nickname) {
      return request<{ member: FriendGroupMember }>(
        `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/nickname`,
        { method: "PUT", body: { nickname } },
      );
    },

    timeoutMember(groupId, userId, input) {
      return request<{ member: FriendGroupMember }>(
        `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/timeout`,
        { method: "POST", body: input },
      );
    },

    removeMemberTimeout(groupId, userId) {
      return request<void>(
        `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}/timeout`,
        { method: "DELETE" },
      );
    },

    listIgnores() {
      return request<{ ignores: IgnoredUser[] }>("/users/me/ignores");
    },

    ignoreUser(userId) {
      return request<{ ignore: UserIgnore }>(
        `/users/me/ignores/${encodeURIComponent(userId)}`,
        { method: "PUT" },
      );
    },

    unignoreUser(userId) {
      return request<void>(`/users/me/ignores/${encodeURIComponent(userId)}`, {
        method: "DELETE",
      });
    },

    // -- Games (MSN revival) -------------------------------------------------

    gameInvite(input) {
      return request<{ gameId: GameId }>("/games/invite", {
        method: "POST",
        body: input,
      });
    },

    gameAccept(gameId) {
      return request<void>(`/games/${encodeURIComponent(gameId)}/accept`, {
        method: "POST",
      });
    },

    gameDecline(gameId) {
      return request<void>(`/games/${encodeURIComponent(gameId)}/decline`, {
        method: "POST",
      });
    },

    gameMove(gameId, action) {
      return request<void>(`/games/${encodeURIComponent(gameId)}/move`, {
        method: "POST",
        body: { action },
      });
    },
  };

  return { api, setAuthToken };
}
