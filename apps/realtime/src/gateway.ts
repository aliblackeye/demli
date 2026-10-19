import { WebSocketServer, type WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import {
  AttachmentLinkError,
  hashSessionToken,
  InMemorySlowmodeStore,
  InMemoryWatchPartyStore,
  type RealtimeMutationBus,
  type Repositories,
  type SlowmodeStore,
  type WatchPartyStore,
} from "@demli/db";
import {
  CLIENT_EVENT,
  clientToServerEventSchema,
  contentMentionsUser,
  makeEnvelope,
  presencePlatformSchema,
  SERVER_EVENT,
  serverEvent,
  type ClientToServerEvent,
  type ErrorRaisedPayload,
  type MessageDTO,
  type SendMessagePayload,
  type ServerToClientEvent,
  type VoiceChannelOccupants,
  type VoiceOccupant,
} from "@demli/protocol";
import {
  isChatCapableChannel,
  isTimedOut,
  publicPresenceStatus,
  type Channel,
  type ChannelId,
  type ChannelKind,
  type GroupId,
  type PresencePlatform,
  type UserId,
} from "@demli/types";
import type { PresencePayload } from "@demli/protocol";
import type { RealtimeMutation } from "@demli/db";
import {
  dispatchChannelMessagePush,
  filterMutedRecipients,
  mentionPushBody,
  type OfflineNotifier,
} from "@demli/notifications";
import type { UnfurlService } from "@demli/unfurl";
import {
  CLIENT_SIGNATURE_QUERY_PARAM,
  CLIENT_UPDATE_REQUIRED_CLOSE_CODE,
  CLIENT_UPDATE_REQUIRED_CODE,
  isValidClientSignature,
} from "@demli/config";
import { enrichMessageWithAttachments, linkErrorToErrorRaised } from "./attachments.js";
import { dropIfOverBuffered, MAX_BUFFERED_BYTES } from "./backpressure.js";
import { canSeeChannelFresh } from "./channel-visibility.js";
import {
  clientIpFrom,
  CLOSE_TOO_MANY_CONNECTIONS,
  HandshakeLimiter,
  MAX_CONNECTIONS_PER_USER,
} from "./connection-limits.js";
import { enrichMessageWithReplyPreview } from "./replies.js";
import type { PresenceStore } from "./presence.js";
import { TokenBucket } from "./rate-limit.js";
import { SubscriptionRegistry } from "./subscriptions.js";
import { createDmCallDisconnectReaper } from "./dm-call-disconnect.js";
import type { VoiceOccupancyReader } from "./voice-occupancy.js";
import {
  createWatchPartyCoordinator,
  type WatchActor,
  type WatchClientEvent,
} from "./watch-party.js";

/**
 * Realtime WebSocket gateway.
 *
 * Carries ONLY lightweight typed protocol events (chat, presence, typing,
 * voice signaling metadata). Voice/video media frames go through
 * LiveKit/WebRTC, never through this socket (CLAUDE.md §10/§35) — binary
 * frames are rejected outright below.
 *
 * Handshake: `ws://host:port/?token=<session token>`. The token is validated
 * against the sessions table; failures close with code 4401. On success the
 * socket receives `auth.succeeded` (with a presence snapshot) and is subscribed
 * to every channel the user can SEE — role-visibility filtered (ADR 0007), not
 * merely every channel of every group. Every server→client event is wrapped in
 * RealtimeEnvelope with a per-connection monotonic `seq`.
 *
 * Role/access changes happen over the HTTP API, which publishes a group-scoped
 * mutation on the bus. The gateway re-derives the affected connections' visible
 * channel sets, diffs the subscription registry, drops any voice channel that
 * lost visibility, and forwards the thin event so clients refetch (§10/§24).
 *
 * That bus-driven cache is a DELIVERY optimization, never an authorization
 * source: every write/join decision re-reads membership + role visibility from
 * the database through `canSeeChannelFresh` (see channel-visibility.ts for why).
 */

/** Application close codes. */
export const CLOSE_UNAUTHORIZED = 4401;

/**
 * Client-identity gate refusal — re-exported
 * under the gateway's own close-code naming so call sites read like the 4401
 * beside it. The value itself is shared with the API (`@demli/config`), because
 * the HTTP 426 and this close code are the same decision on two transports and
 * clients switch on both.
 *
 * WHY THE GATEWAY NEEDS ITS OWN COPY OF THE GATE: closing only the HTTP door
 * leaves the socket open, and the socket is where chat, presence and voice
 * signalling actually live. A retired client refused by the API but still
 * connected here would keep receiving messages it can no longer send — the worst
 * possible half-state.
 */
export const CLOSE_CLIENT_UPDATE_REQUIRED = CLIENT_UPDATE_REQUIRED_CLOSE_CODE;

const MESSAGE_BUCKET_CAPACITY = 10; // burst
const MESSAGE_BUCKET_REFILL_PER_SECOND = 2; // sustained msgs/sec

/**
 * Hard ceiling on ONE inbound WebSocket frame, in bytes.
 *
 * `ws` defaults `maxPayload` to 100 MiB, so before this cap a single socket
 * could hand the gateway a 100 MB buffer per frame — allocated by the receiver
 * BEFORE any of our validation runs — and repeat it. That is the cheapest
 * memory-exhaustion path into this process.
 *
 * Sized from the largest LEGITIMATE client frame, `message.send`:
 *   content            4 000 chars (MESSAGE_MAX_LENGTH) × ≤6 B worst-case
 *                      JSON escaping (`\uXXXX`)                     ≈ 24 000 B
 *   attachmentIds      10 (ATTACHMENT_MAX_PER_MESSAGE) × 128-char id ≈  1 400 B
 *   channelId + replyToMessageId + nonce + JSON keys                 <    600 B
 *                                                            total  ≈ 26 000 B
 *
 * 64 KiB leaves ~2.4× headroom over that worst case and still caps a hostile
 * frame at a rounding error. Nothing legitimate can outgrow it: media never
 * travels here (binary frames are rejected outright, §10/§35) and attachment
 * bytes upload over HTTP, so the message body is the only thing that scales.
 * `ws` answers an oversized frame with a 1009 (Message Too Big) close and the
 * process stays up.
 */
const MAX_FRAME_BYTES = 64 * 1024;

/**
 * `typing.start`/`typing.stop` budget. Cheap per frame (no DB) but it
 * AMPLIFIES: one inbound frame fans out to every subscriber of the channel.
 *
 * Both clients already self-throttle `typing.start` to one per 4 s per channel
 * (TYPING_START_THROTTLE_MS) plus one `typing.stop` after 5 s idle, so an honest
 * peak stays under ~1 frame/s even while switching channels fast. 20 burst /
 * 5 per second is ~10× that headroom — unreachable by a real composer — while
 * bounding a hostile socket's fan-out to something the gateway shrugs off.
 */
const TYPING_BUCKET_CAPACITY = 20;
const TYPING_BUCKET_REFILL_PER_SECOND = 5;

/**
 * `presence.update` budget. The most DB-expensive non-message frame: a status
 * write plus the audience + custom-status reads behind every broadcast (4
 * queries), fanned out to every co-member and friend connection.
 *
 * Honest traffic is a handful per session — a manual status pick, the auto-away
 * flip, and one re-assert per (re)connect. 10 burst / 1 per second covers
 * clicking through every status repeatedly and still caps an abuser at one
 * fan-out per second.
 */
const PRESENCE_BUCKET_CAPACITY = 10;
const PRESENCE_BUCKET_REFILL_PER_SECOND = 1;

/**
 * Shared budget for the cheap control frames: `presence.app_state` (one Redis
 * hset) and `voice.join`/`voice.leave` (in-memory bookkeeping + a channel
 * fan-out).
 *
 * Generous on purpose — dropping an app-state frame desyncs the push gate
 * (#110) and costs a real user a missed or spurious notification — but still
 * bounded, because voice join/leave amplifies to every channel subscriber. A
 * human produces a few of these per minute; 30 burst / 5 per second is orders
 * of magnitude above that.
 */
const CONTROL_BUCKET_CAPACITY = 30;
const CONTROL_BUCKET_REFILL_PER_SECOND = 5;

/**
 * `watch.*` budget (M20, ADR 0016). Its own bucket rather than a share of the
 * control budget, because a watch control is BOTH a DB read (the fresh
 * membership/role/timeout lookup) and a fan-out to the room — the same cost
 * shape as `message.send`, so it gets the same treatment.
 *
 * A human dragging a seek bar produces a handful of frames per second and the
 * clients coalesce a drag into one `watch.control` on release; 20 burst / 4 per
 * second sits far above that and still bounds a socket that decides to seek in a
 * loop. Over budget the frame is REFUSED with `RATE_LIMITED` rather than dropped
 * silently: unlike typing, a lost pause is a visible failure the user must be
 * told about, and the reply is 1:1 with the inbound frame, so it amplifies
 * nothing.
 */
const WATCH_BUCKET_CAPACITY = 20;
const WATCH_BUCKET_REFILL_PER_SECOND = 4;

interface Connection {
  /** Opaque per-connection id; keys this socket in the presence store. */
  id: string;
  socket: WebSocket;
  userId: UserId;
  /**
   * The session this socket authenticated with (the row resolved from the
   * handshake token). Lets a user-scoped `session.revoked` kick EXACTLY the
   * connections whose session was signed out, leaving the user's other sessions
   * connected (#98).
   */
  sessionId: string;
  seq: number;
  /**
   * Channels (with kind) currently VISIBLE to this user — the live subscription
   * set. Seeded from role-visibility at handshake and kept in sync by the
   * group resync path (role/access changes over HTTP).
   */
  channelKinds: Map<ChannelId, ChannelKind>;
  /**
   * EVERY group this connection's user is a member of — servers, flat group
   * chats AND dms — which keys it in `connectionsByGroup`.
   *
   * Membership, not `kind`, is the rule: the API publishes group-scoped events
   * (`member.left`, `group.deleted`, `emoji.*`) with a group-chat or dm id too,
   * and while this set was seeded server-only those events reached nobody. The
   * live consequence was a privacy hole: a member kicked from a group chat was
   * never unsubscribed from its stream, so every later message kept flowing to
   * their socket until they reconnected.
   */
  groupIds: Set<GroupId>;
  /**
   * Users this connection must never see content from (M18, ADR 0017): everyone
   * with a `user_blocks` row against this user in EITHER direction. Seeded from
   * the DB at handshake and refreshed by the `user.blocks_updated` resync (the
   * same "re-derive, don't patch" model the M9-4 visibility resync uses).
   *
   * This is the REALTIME half of the block: the HTTP read paths filter history
   * and search in SQL, and this filters the live fan-out, so a blocked user's
   * message never reaches this socket at all — not "reaches it and is hidden".
   * Usually empty, in which case every send path is byte-for-byte pre-M18.
   */
  blockedUserIds: Set<UserId>;
  voiceChannelId: ChannelId | null;
  messageBucket: TokenBucket;
  /** typing.start / typing.stop budget (see TYPING_BUCKET_CAPACITY). */
  typingBucket: TokenBucket;
  /** presence.update budget (see PRESENCE_BUCKET_CAPACITY). */
  presenceBucket: TokenBucket;
  /** presence.app_state + voice.join/leave budget (see CONTROL_BUCKET_CAPACITY). */
  controlBucket: TokenBucket;
  /** watch.* budget (see WATCH_BUCKET_CAPACITY). */
  watchBucket: TokenBucket;
  isAlive: boolean;
  /**
   * When this socket last proved it was alive — any inbound frame, or a pong.
   * Only used to pick the victim when an account is at
   * {@link MAX_CONNECTIONS_PER_USER}: the LEAST RECENTLY ACTIVE socket is the
   * one to drop, which is almost always a half-dead connection the heartbeat has
   * not reaped yet. Evicting by connection AGE instead would pick the desktop app
   * the user opened this morning — the one they care about most.
   */
  lastSeenAt: number;
  /**
   * Teardown ran. `handleClose` is reachable twice for one socket (eviction
   * closes it AND the `close` event fires), and presence bookkeeping must not run
   * twice for the same connection id.
   */
  closed: boolean;
}

export interface GatewayDeps {
  repos: Repositories;
  presence: PresenceStore;
  /**
   * Optional pub/sub bridge. When present, the gateway subscribes and fans
   * API-originated mutations (message.created/updated/deleted — including
   * system messages) out to local subscribers of the mutation's channel.
   */
  mutationBus?: RealtimeMutationBus;
  /**
   * Slowmode enforcement backend. Production wires the Redis store (slots
   * shared with the HTTP API); defaults to in-memory (single process).
   */
  slowmode?: SlowmodeStore;
  /**
   * Offline mobile-push dispatcher. When present, an inbound message fires an
   * offline push at its audience — the DM recipient for a DM message, or each
   * DIRECTLY @mentioned member for a server/group channel (mutually exclusive, so
   * never both for one message — see {@link handleInboundSideEffects}). The WS
   * gateway is the PRIMARY send path (desktop + mobile both send here), so without
   * this a DM/mention over WS would never notify. Best-effort and fire-and-forget
   * (see {@link handleMessageSend}); optional so tests that do not assert push can
   * omit it.
   */
  notifier?: OfflineNotifier;
  /**
   * Authoritative voice-occupancy reader (STATE RESYNC). When present, the
   * gateway reads media-plane truth (LiveKit) and pushes it as `voice.resync`
   * right after `auth.succeeded` — so a client re-seats on ground truth on every
   * (re)connect, healing any missed voice/screen-share delta. Optional and
   * additive: without it the gateway behaves exactly as before (the in-memory
   * `auth.succeeded` occupancy snapshot + live deltas), which is why every
   * existing test that omits it is unaffected.
   */
  voiceOccupancy?: VoiceOccupancyReader;
  /**
   * Link-preview (unfurl) service (M17). When present, a WS-created message's
   * content is unfurled ASYNCHRONOUSLY (fire-and-forget) after `message.created`
   * is broadcast — the send never waits on a network fetch. The service persists
   * the embeds and publishes `message.embeds_updated` on the mutation bus, which
   * this gateway's own bus subscriber fans out to the channel. The WS path is the
   * PRIMARY send path (desktop), so without this desktop messages get no
   * previews. Optional — tests that do not assert unfurl omit it.
   */
  unfurl?: UnfurlService;
  /**
   * Watch-party session state (M20, ADR 0016). Production wires the Redis store
   * so a session survives a gateway restart within its TTL; defaults to the
   * in-memory store (single process), exactly like `slowmode`. Ephemeral either
   * way — there is no DB table.
   */
  watchParty?: WatchPartyStore;
  log?: (message: string) => void;
}

export interface GatewayOptions {
  port: number;
  host?: string;
  heartbeatIntervalMs?: number;
  /**
   * Override the outbound backpressure ceiling (see MAX_BUFFERED_BYTES). An ops
   * / test knob only — production runs the default, which is sized for this
   * protocol; tests use a small value to exercise the drop path deterministically
   * instead of trying to out-write the kernel's socket buffers.
   */
  maxBufferedBytes?: number;
  /**
   * How long a user must stay offline before their OUTGOING ring is withdrawn
   * (see {@link ./dm-call-disconnect.DEFAULT_CALLER_DROP_GRACE_MS}). A test knob
   * so integration tests can assert the reap without waiting the real grace.
   */
  callerDropGraceMs?: number;
  /**
   * Override the watch-party drift heartbeat cadence (see `WATCH_HEARTBEAT_MS`).
   * A test knob so the sync/self-heal path can be asserted without waiting the
   * real 5 s; production runs the config default.
   */
  watchHeartbeatIntervalMs?: number;
  /**
   * Arm the client-identity gate: refuse any
   * handshake that carries no valid `?client=demli-<app>/<version>` mark with
   * close code {@link CLOSE_CLIENT_UPDATE_REQUIRED}.
   *
   * DEFAULTS TO FALSE, and `index.ts` only passes true when CLIENT_GATE is
   * exactly "on". The default is the safe state on purpose: this switch decides
   * whether real users can connect at all, so forgetting to pass it must mean
   * "everyone in", never "everyone out".
   */
  clientGate?: boolean;
  /**
   * Override the per-account concurrent socket cap (see
   * {@link MAX_CONNECTIONS_PER_USER}). A test knob so the eviction path can be
   * asserted with 2 sockets instead of 11; production runs the default.
   */
  maxConnectionsPerUser?: number;
  /**
   * Override the per-address handshake budget (see HANDSHAKE_BUCKET_* in
   * connection-limits.ts). A test knob only.
   */
  handshakeLimit?: { capacity: number; refillPerSecond: number };
  /**
   * How many proxy hops to trust when deriving a client's address for the
   * handshake limit (see TRUSTED_PROXY_HOPS). Production leaves this at the
   * default 1 — the single Caddy in front of this service.
   */
  trustedProxyHops?: number;
}

export interface Gateway {
  wss: WebSocketServer;
  /** Resolves with the bound port once listening. */
  ready: Promise<number>;
  close(): Promise<void>;
}

function extractToken(requestUrl: string | undefined): string | null {
  if (!requestUrl) return null;
  try {
    return new URL(requestUrl, "ws://placeholder").searchParams.get("token");
  } catch {
    return null;
  }
}

/**
 * Read the optional `platform` handshake query param (task #47). Anything not a
 * known client kind (missing, "web", garbage) yields undefined so the connection
 * simply carries no platform — never a hard failure, keeping old clients working.
 */
function extractPlatform(requestUrl: string | undefined): PresencePlatform | undefined {
  if (!requestUrl) return undefined;
  try {
    const raw = new URL(requestUrl, "ws://placeholder").searchParams.get("platform");
    const parsed = presencePlatformSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the `client` handshake query param — the WebSocket half of the
 * client-identity mark. A param and not a header
 * because a browser cannot set custom headers on a WS handshake; `platform`
 * above is the existing precedent. Returns null when absent or unparseable,
 * which the gate reads as "old client".
 */
function extractClientSignature(requestUrl: string | undefined): string | null {
  if (!requestUrl) return null;
  try {
    return new URL(requestUrl, "ws://placeholder").searchParams.get(
      CLIENT_SIGNATURE_QUERY_PARAM,
    );
  } catch {
    return null;
  }
}

/** Best-effort nonce for error feedback on malformed message.send frames. */
function extractNonce(frame: unknown): string | undefined {
  if (typeof frame !== "object" || frame === null) return undefined;
  const candidate = frame as { type?: unknown; payload?: { nonce?: unknown } };
  if (candidate.type !== CLIENT_EVENT.messageSend) return undefined;
  const nonce = candidate.payload?.nonce;
  return typeof nonce === "string" ? nonce : undefined;
}

export function createGateway(deps: GatewayDeps, options: GatewayOptions): Gateway {
  const log = deps.log ?? (() => undefined);
  const maxBufferedBytes = options.maxBufferedBytes ?? MAX_BUFFERED_BYTES;
  // Retired-build kill switch; see GatewayOptions.clientGate for why the
  // default is "everyone in".
  const clientGateEnabled = options.clientGate ?? false;
  const slowmode = deps.slowmode ?? new InMemorySlowmodeStore();
  const maxConnectionsPerUser = options.maxConnectionsPerUser ?? MAX_CONNECTIONS_PER_USER;
  // One-shot guard for the "the proxy stopped forwarding the client address"
  // warning below.
  let warnedAboutMissingForwardedFor = false;
  const handshakeLimiter = options.handshakeLimit
    ? new HandshakeLimiter(
        options.handshakeLimit.capacity,
        options.handshakeLimit.refillPerSecond,
      )
    : new HandshakeLimiter();
  const wss = new WebSocketServer({
    port: options.port,
    host: options.host ?? "127.0.0.1",
    // Cap inbound frames (see MAX_FRAME_BYTES). Without this `ws` accepts up to
    // 100 MiB per frame and allocates it before any validation runs, so one
    // socket can exhaust the heap. Oversized frames get a 1009 close.
    maxPayload: MAX_FRAME_BYTES,
    // Handshake rate limit, per client address (see connection-limits.ts).
    //
    // This runs at the HTTP UPGRADE, which is the whole point: every other limit
    // in this file is per-connection and therefore cannot exist until a
    // connection does, while ONE handshake costs ~8-10 database round trips. A
    // refusal here costs a token and no queries — the upgrade never completes, so
    // `handleConnection` (and the session lookup inside it) never runs.
    //
    // Answered with a real 429 so an honest client can tell "slow down" apart
    // from "your session is dead"; `ws` turns this into an HTTP error response
    // instead of a WebSocket close, and the client's reconnect backoff (1 s,
    // doubling to 30 s) takes it from there.
    verifyClient: (info, done) => {
      // Say it ONCE if the header the limit depends on is not arriving. In
      // production every client reaches this service through Caddy, which always
      // sets `X-Forwarded-For`; if it ever stopped, every user on the platform
      // would silently share ONE bucket keyed on Caddy's container address — a
      // platform-wide throttle that would otherwise look like "the gateway is
      // slow". Locally there is no proxy and this line is simply a statement of
      // fact. Logged from the first handshake, never per handshake.
      if (!warnedAboutMissingForwardedFor && info.req.headers["x-forwarded-for"] === undefined) {
        warnedAboutMissingForwardedFor = true;
        log(
          "no X-Forwarded-For on handshakes — keying the handshake limit on the transport address",
        );
      }
      const ip = clientIpFrom(info.req, options.trustedProxyHops);
      if (handshakeLimiter.take(ip)) {
        done(true);
        return;
      }
      log(`handshake refused: ${ip} is over the handshake budget`);
      done(false, 429, "Too Many Requests");
    },
  });
  const subscriptions = new SubscriptionRegistry<Connection>();
  const connectionsByUser = new Map<UserId, Set<Connection>>();
  // Group → connections index. Group-scoped mutations (role/access changes)
  // carry only a groupId, so this is how the resync path finds the local
  // sockets that must be re-evaluated / notified.
  const connectionsByGroup = new Map<GroupId, Set<Connection>>();
  // Voice channel → userId → how many of that user's CONNECTIONS are in it — the
  // reverse index behind "who is in each voice channel". Kept in lock-step with
  // `Connection.voiceChannelId`: a connection is counted in the `voice.join`
  // handler and uncounted in `leaveVoice` (the single chokepoint every teardown
  // path funnels through), so it needs no bespoke cleanup.
  //
  // Counted per connection because joins ARE per connection. A per-user set let
  // any one socket's leave erase a user still present on another: a reconnect
  // re-announces on the new socket while the half-dead old one is reaped up to a
  // minute later, and a second device takes over the same room while the first
  // sends its leave. Either way the user vanished from every sidebar (and the
  // watch party lost its host) while still talking. The user leaves — and
  // `voice.participant_left` goes out — only when their LAST connection does.
  // In-memory and single-instance — voice events never cross the mutation bus.
  const voiceOccupants = new Map<ChannelId, Map<UserId, number>>();
  // Withdraws a caller's OUTGOING ring shortly after their last socket goes away
  // (founder P0 — a ring nobody is behind). Accepted calls are deliberately NOT
  // touched here; see dm-call-disconnect.ts for why a WebSocket close says
  // nothing about a LiveKit session.
  const callReaper = createDmCallDisconnectReaper({
    repos: deps.repos,
    mutationBus: deps.mutationBus,
    ...(deps.notifier ? { notifier: deps.notifier } : {}),
    isOffline: async (userId) => (await deps.presence.getStatus(userId)) === "offline",
    graceMs: options.callerDropGraceMs,
    log,
  });

  // Watch party (M20, ADR 0016). All of its authorization and state handling
  // lives in the coordinator; the gateway only supplies delivery (who can see
  // the channel, who is IN the room) and server-truth occupancy, which are the
  // two things it alone knows. Sync frames only — no media (§10/§35).
  const watchParty = createWatchPartyCoordinator({
    repos: deps.repos,
    store: deps.watchParty ?? new InMemoryWatchPartyStore(),
    delivery: {
      toChannel: (channelId, event) => broadcastToChannel(channelId, event),
      toOccupants: (channelId, event) => {
        for (const subscriber of subscriptions.subscribers(channelId)) {
          if (subscriber.voiceChannelId === channelId) sendEvent(subscriber, event);
        }
      },
      occupantIds: (channelId) => [...(voiceOccupants.get(channelId)?.keys() ?? [])],
    },
    ...(options.watchHeartbeatIntervalMs !== undefined
      ? { heartbeatIntervalMs: options.watchHeartbeatIntervalMs }
      : {}),
    log,
  });

  /** One connection's identity for the watch coordinator's authority checks. */
  function watchActor(conn: Connection): WatchActor {
    return {
      userId: conn.userId,
      // Server truth: set only by this gateway's own voice.join handler.
      voiceChannelId: conn.voiceChannelId,
      send: (event) => sendEvent(conn, event),
    };
  }

  const ready = new Promise<number>((resolve, reject) => {
    wss.once("listening", () => {
      const address = wss.address();
      resolve(typeof address === "object" && address ? address.port : options.port);
    });
    wss.once("error", reject);
  });

  /**
   * Backpressure guard (see `backpressure.ts`): true when this connection's
   * unflushed write queue is over budget, in which case the socket has just been
   * dropped and the caller must not write to it.
   */
  function isOverBuffered(conn: Connection): boolean {
    return dropIfOverBuffered(conn.socket, maxBufferedBytes, (buffered) =>
      log(
        `dropping slow consumer: user ${conn.userId} conn ${conn.id} ` +
          `buffered ${buffered}B > ${maxBufferedBytes}B`,
      ),
    );
  }

  function sendEvent(conn: Connection, event: ServerToClientEvent): void {
    if (conn.socket.readyState !== conn.socket.OPEN) return;
    if (isOverBuffered(conn)) return;
    conn.seq += 1;
    conn.socket.send(JSON.stringify(makeEnvelope(event, conn.seq)));
  }

  function sendError(conn: Connection, payload: ErrorRaisedPayload): void {
    sendEvent(conn, serverEvent.errorRaised(payload));
  }

  function broadcastToChannel(
    channelId: ChannelId,
    event: ServerToClientEvent,
    except?: Connection,
  ): void {
    // Who this event is "from", for the block filter (M18). Null ⇒ the event has
    // no author (a delete, a voice/lifecycle frame) and reaches every subscriber
    // exactly as before.
    const authorId = eventAuthorId(event);
    for (const subscriber of subscriptions.subscribers(channelId)) {
      if (subscriber === except) continue;
      // Block filter (ADR 0017): a blocked user's live content never reaches this
      // socket. Server-side, so the text is not merely hidden client-side — it is
      // never sent. `blockedUserIds` is empty for almost every connection, so this
      // is a Set miss on the hot path (§27).
      if (authorId !== null && subscriber.blockedUserIds.has(authorId)) continue;
      sendEvent(subscriber, event);
    }
  }

  /**
   * The user a channel-scoped event ORIGINATES from, or null when it has none.
   *
   * Only events that carry a person's CONTENT or PRESENCE-IN-CHANNEL are filtered
   * by blocks: message create/edit (their words) and typing (their activity). A
   * delete, a reaction delta, an embed update, or a pin is deliberately NOT
   * filtered — those carry no text of the blocked user, and dropping a `deleted`
   * for a message the reader never received would only desynchronise caches.
   * The `watch.*` frames (M20) fall in the same category and stay unfiltered:
   * they describe SHARED ROOM STATE (which video, where, who is driving), a
   * block has never stopped two members sharing a voice channel, and hiding a
   * pause from one viewer would desync the very playback it describes.
   */
  function eventAuthorId(event: ServerToClientEvent): UserId | null {
    switch (event.type) {
      case SERVER_EVENT.messageCreated:
      case SERVER_EVENT.messageUpdated:
        return event.payload.authorId;
      case SERVER_EVENT.typingStarted:
      case SERVER_EVENT.typingStopped:
        return event.payload.userId;
      default:
        return null;
    }
  }

  /**
   * Who should see `userId`'s presence AS A PEER: everyone sharing at least one
   * group with them (co-members) UNION every accepted friend (ADR 0010 §4) —
   * friends see each other's status even with no shared group. Deduped, so a user
   * in both sets is notified once. Recomputed on every call, so a just-added or
   * just-removed friendship takes effect on the next presence event with no cache
   * to invalidate (the same "resync/refresh" model the rest of the gateway uses).
   *
   * NEVER contains `userId` itself. `listCoMemberUserIds` does include the user
   * (they are a member of their own groups), and until M16 that self id rode
   * through here unnoticed: every broadcast sent the user their own PEER-FACING,
   * masked presence, so someone who picked "invisible" was told by the server
   * that they were "offline", and both clients painted it on their own dot. The
   * subject's own sockets are a separate, deliberate recipient set with its own
   * payload — see {@link broadcastPresence}. Removed HERE, not in the repository,
   * so the contract holds whatever a repository (or a test stub) returns.
   */
  async function presenceAudience(userId: UserId): Promise<Set<UserId>> {
    const [coMembers, friendIds] = await Promise.all([
      deps.repos.groups.listCoMemberUserIds(userId),
      deps.repos.friendships.listAcceptedFriendIds(userId),
    ]);
    const audience = new Set<UserId>([...coMembers, ...friendIds]);
    audience.delete(userId);
    return audience;
  }

  /**
   * Project a stored presence to its PEER-FACING form: `invisible` reads as
   * `offline` (via `publicPresenceStatus`), and the platform is dropped once the
   * result is offline (an offline user reports no client kind). The single mask
   * the live broadcast AND the handshake snapshot both apply, so an invisible
   * user is indistinguishable from offline to everyone else. It is NEVER applied
   * to the payload the subject's OWN sockets receive — those get the real status
   * (see {@link broadcastPresence}); masking yourself would be telling an invisible
   * user they are offline.
   */
  function maskPresence(p: PresencePayload): PresencePayload {
    const status = publicPresenceStatus(p.status);
    const masked: PresencePayload =
      status !== "offline" && p.platform
        ? { userId: p.userId, status, platform: p.platform }
        : { userId: p.userId, status };
    // Custom status (M18) survives the mask, INCLUDING for an offline/invisible
    // user: unlike `platform` (a live-connection detail) a status line is a
    // profile field the user chose to publish, so it stays visible offline.
    // It is only carried when actually set, so no payload grows without cause.
    return p.customStatus ? { ...masked, customStatus: p.customStatus } : masked;
  }

  /**
   * The user's live custom status (M18), or null. One indexed PK read per
   * presence broadcast — presence broadcasts fire on connect / disconnect /
   * status change / status-line change, not per message, so this is nowhere near
   * a hot path (§27). Best-effort: a failed read degrades to "no status line"
   * rather than dropping the whole presence broadcast.
   */
  async function customStatusOf(userId: UserId): Promise<string | null> {
    try {
      const user = await deps.repos.users.findById(userId);
      return user?.customStatus ?? null;
    } catch (err) {
      log(`custom status read failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Fan `userId`'s presence out to the two recipient sets it has (M16 contract —
   * the same one stated on `PresencePayload` in packages/protocol):
   *
   *  1. PEERS ({@link presenceAudience}) get the MASKED account status:
   *     `invisible` reads as `offline`, and an offline user carries no platform.
   *  2. The user's OWN live sockets get the REAL account status, unmasked —
   *     `invisible` stays `invisible`. Multi-device is the reason this set exists
   *     at all: the account status is derived from EVERY live connection (ADR
   *     0020), so a status picked on the phone changes what the desktop's own dot
   *     must show (a phone `dnd` silences the account, a phone `invisible` hides
   *     it), and the desktop cannot know that from its own declaration. It is also
   *     what the originating device reconciles against after a pick — its local
   *     paint is its own declaration, the echo is the derived truth.
   *
   * `except` keeps ONE socket out of set 2: the socket whose handshake is causing
   * this broadcast. It has just received `auth.succeeded`, seeded its own dot from
   * its locally chosen status, and is about to re-assert that status — whose
   * broadcast then reaches it. Echoing the connect-time value to it would paint a
   * status derived from the store's DEFAULT declaration for the new socket
   * ("online"), i.e. flash an invisible user green on every reconnect.
   *
   * Set 2 never receives `offline`: a socket reading about its own account is by
   * definition a live connection, so an `offline` here can only be the store and
   * the in-memory socket registry momentarily disagreeing (a socket registered
   * before `presence.connect` landed). Peers still get it.
   *
   * ORDERING: Postgres first (audience, custom status), the Redis state LAST, and
   * no await between that read and the sends. Two broadcasts for the same user
   * run concurrently — `handleEvent` is not serialised per socket, and a connect
   * re-derive races the client's own re-assert — so a broadcast that read the
   * status BEFORE a slow audience query could deliver an older value after a newer
   * one, leaving every recipient (now including the user) on a stale dot. Reading
   * last means the broadcast that sends last also read last: one Redis connection
   * answers in command order, and each answer is sent synchronously.
   */
  async function broadcastPresence(userId: UserId, except?: Connection): Promise<void> {
    const [audience, customStatus] = await Promise.all([
      presenceAudience(userId),
      customStatusOf(userId),
    ]);
    const [status, platform] = await Promise.all([
      deps.presence.getStatus(userId),
      deps.presence.getPlatform(userId),
    ]);
    // `platform` is meaningful only while connected; an offline user reports none.
    const base: PresencePayload = platform
      ? { userId, status, platform }
      : { userId, status };
    const real: PresencePayload = customStatus ? { ...base, customStatus } : base;

    const peerEvent = serverEvent.presenceUpdated(maskPresence(real));
    for (const memberId of audience) {
      for (const conn of connectionsByUser.get(memberId) ?? []) {
        sendEvent(conn, peerEvent);
      }
    }

    if (status === "offline") return;
    const selfEvent = serverEvent.presenceUpdated(real);
    for (const conn of connectionsByUser.get(userId) ?? []) {
      if (conn !== except) sendEvent(conn, selfEvent);
    }
  }

  function addVoiceOccupant(channelId: ChannelId, userId: UserId): void {
    let occupants = voiceOccupants.get(channelId);
    if (!occupants) {
      occupants = new Map();
      voiceOccupants.set(channelId, occupants);
    }
    occupants.set(userId, (occupants.get(userId) ?? 0) + 1);
  }

  /** Uncount one connection; true when that was the user's last one in the room. */
  function removeVoiceOccupant(channelId: ChannelId, userId: UserId): boolean {
    const occupants = voiceOccupants.get(channelId);
    const count = occupants?.get(userId);
    if (!occupants || count === undefined) return false;
    if (count > 1) {
      occupants.set(userId, count - 1);
      return false;
    }
    occupants.delete(userId);
    if (occupants.size === 0) voiceOccupants.delete(channelId);
    return true;
  }

  /**
   * The occupancy snapshot for one connection: WHO is currently in each voice
   * channel THIS connection can SEE. Built from `conn.channelKinds` (the
   * visibility-filtered subscription set), so it inherits the exact role/access
   * boundary the deltas obey — a restricted voice channel the user cannot see
   * never appears. Empty voice channels are omitted (the client defaults them to
   * empty). `muted` is `false` for every occupant, matching the delta stream,
   * which has no mute event yet.
   */
  function voiceOccupancySnapshot(conn: Connection): VoiceChannelOccupants[] {
    const channels: VoiceChannelOccupants[] = [];
    for (const [channelId, kind] of conn.channelKinds) {
      if (kind !== "voice") continue;
      const occupants = voiceOccupants.get(channelId);
      if (!occupants || occupants.size === 0) continue;
      channels.push({
        channelId,
        occupants: [...occupants.keys()].map((userId) => ({ userId, muted: false })),
      });
    }
    return channels;
  }

  /**
   * Push an AUTHORITATIVE voice-occupancy snapshot (`voice.resync`) to one
   * connection, sourced from the media plane (LiveKit) via `deps.voiceOccupancy`.
   * Built from `conn.channelKinds` — the SAME visibility-filtered set the
   * auth.succeeded snapshot and the deltas obey — so a voice channel the user
   * cannot see never appears. Only OCCUPIED channels are included; a fully empty
   * result still sends `{ channels: [] }` so the client authoritatively clears
   * stale occupancy. Best-effort by design:
   *  - no reader configured        → skip (feature off; client uses auth.succeeded);
   *  - reader THROWS (SFU down)     → skip, DON'T fabricate an empty snapshot that
   *    would wrongly wipe the client's occupancy — it keeps its view and the HTTP
   *    endpoint / next reconnect heals it.
   * Ordering: called after `auth.succeeded` so the client already has the presence
   * + in-memory snapshot; the fire-and-forget send layers ground truth on top.
   */
  async function sendVoiceResync(conn: Connection): Promise<void> {
    if (!deps.voiceOccupancy) return;
    const voiceChannelIds: ChannelId[] = [];
    for (const [channelId, kind] of conn.channelKinds) {
      if (kind === "voice") voiceChannelIds.push(channelId);
    }

    let occupancy: Map<ChannelId, VoiceOccupant[]>;
    try {
      // An upgraded call's voice channel runs in the call's room, not its id;
      // without the override that channel always read as empty, and the client
      // REPLACES its whole map from this snapshot.
      const roomOverrides = await deps.repos.channels.livekitRoomOverrides(voiceChannelIds);
      occupancy = await deps.voiceOccupancy.read(voiceChannelIds, roomOverrides);
    } catch (err) {
      // Media plane unreachable — leave the client on its auth.succeeded snapshot.
      log(`voice.resync skipped: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }

    const channels: VoiceChannelOccupants[] = [];
    for (const channelId of voiceChannelIds) {
      const occupants = occupancy.get(channelId);
      if (occupants && occupants.length > 0) channels.push({ channelId, occupants });
    }
    sendEvent(conn, serverEvent.voiceResync({ channels }));
  }

  function leaveVoice(conn: Connection): void {
    const channelId = conn.voiceChannelId;
    if (!channelId) return;
    conn.voiceChannelId = null;
    // Another connection of the same user is still in this room: nobody left.
    if (!removeVoiceOccupant(channelId, conn.userId)) return;
    broadcastToChannel(
      channelId,
      serverEvent.voiceParticipantLeft({ channelId, userId: conn.userId, muted: false }),
    );
    // The single chokepoint every voice teardown funnels through (explicit
    // leave, socket close, kick, lost visibility, deleted channel) — so hooking
    // the watch party here is what guarantees the host handoff and the
    // "everyone left, end it" rule can never be skipped by one of those paths.
    // Runs AFTER the occupant is removed, so the coordinator sees the room as it
    // now is. Fire-and-forget; the heartbeat re-reconciles if this loses a race.
    void watchParty.onVoiceLeft(channelId, conn.userId).catch((err: unknown) =>
      log(`watch leave handling failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }

  /**
   * The channels a user can currently SEE across every group they belong to,
   * with kind — the authoritative WS subscription set. Role-visibility filtered
   * per group (ADR 0007): public channels for everyone, restricted ones only for
   * the owner or a member holding a listed role. Flat group-chat memberships are
   * included too; those channels carry no access rows, so they stay visible.
   */
  async function visibleChannelKinds(
    userId: UserId,
  ): Promise<Map<ChannelId, ChannelKind>> {
    const all = await deps.repos.channels.listForUser(userId);
    const byGroup = new Map<GroupId, Channel[]>();
    for (const channel of all) {
      const list = byGroup.get(channel.groupId);
      if (list) list.push(channel);
      else byGroup.set(channel.groupId, [channel]);
    }
    const visible = new Map<ChannelId, ChannelKind>();
    for (const [groupId, groupChannels] of byGroup) {
      const visibleIds = new Set(
        await deps.repos.channelAccess.visibleChannelIdsForUser(groupId, userId),
      );
      for (const channel of groupChannels) {
        if (visibleIds.has(channel.id)) visible.set(channel.id, channel.kind);
      }
    }
    return visible;
  }

  /**
   * Drop one channel from a connection's visible set: force-leave it if it is the
   * socket's voice room, forget the kind, unsubscribe.
   *
   * The teardown half of `resyncConnectionVisibility`, factored out because the
   * fresh authorization check below needs exactly it. When a write/join is
   * refused because the user can no longer SEE the channel, the connection's
   * cache is provably stale — the bus event was lost, or lost the race — so the
   * refusal also HEALS it. That is what closes the "still listening" half of the
   * same hole: without this the socket would keep receiving the channel's
   * messages until it reconnected, having just been told it is not a member.
   */
  function dropChannelVisibility(conn: Connection, channelId: ChannelId): void {
    if (!conn.channelKinds.has(channelId)) return;
    if (conn.voiceChannelId === channelId) leaveVoice(conn);
    conn.channelKinds.delete(channelId);
    subscriptions.remove(conn, [channelId]);
    log(`user ${conn.userId} lost stale visibility of channel ${channelId}`);
  }

  /**
   * Fresh, authoritative visibility check for a WRITE/JOIN decision, plus the
   * cache self-heal on refusal. See channel-visibility.ts for why the
   * per-connection cache may not decide this. Throws only if the database does;
   * every caller answers that with its own "failed, try again" error.
   */
  async function stillVisible(
    conn: Connection,
    groupId: GroupId,
    channelId: ChannelId,
  ): Promise<boolean> {
    const visible = await canSeeChannelFresh(deps.repos, groupId, channelId, conn.userId);
    if (!visible) dropChannelVisibility(conn, channelId);
    return visible;
  }

  function indexConnectionByGroup(conn: Connection, groupId: GroupId): void {
    let conns = connectionsByGroup.get(groupId);
    if (!conns) {
      conns = new Set();
      connectionsByGroup.set(groupId, conns);
    }
    conns.add(conn);
  }

  function deindexConnectionFromGroup(conn: Connection, groupId: GroupId): void {
    const conns = connectionsByGroup.get(groupId);
    conns?.delete(conn);
    if (conns && conns.size === 0) connectionsByGroup.delete(groupId);
  }

  async function handleEvent(conn: Connection, event: ClientToServerEvent): Promise<void> {
    switch (event.type) {
      case CLIENT_EVENT.messageSend:
        await handleMessageSend(conn, event.payload);
        return;

      case CLIENT_EVENT.typingStart:
      case CLIENT_EVENT.typingStop: {
        // Budget check FIRST, before the validation branches below: those answer
        // with an error frame, so gating them too keeps a flood of malformed
        // typing frames from being reflected back one-for-one.
        //
        // Over budget the frame is dropped SILENTLY — typing is fire-and-forget,
        // and replying to every rejected frame would turn an inbound flood into
        // an equal OUTBOUND flood, which is the amplification this limit closes.
        // An honest composer cannot reach the budget (see TYPING_BUCKET_*).
        if (!conn.typingBucket.take()) return;
        const { channelId, userId } = event.payload;
        if (userId !== conn.userId) {
          sendError(conn, {
            code: "INVALID_PAYLOAD",
            message: "userId must match the authenticated user.",
          });
          return;
        }
        if (!conn.channelKinds.has(channelId)) {
          sendError(conn, {
            code: "NOT_A_MEMBER",
            message: "You are not a member of this channel.",
          });
          return;
        }
        const typingEvent =
          event.type === CLIENT_EVENT.typingStart
            ? serverEvent.typingStarted(event.payload)
            : serverEvent.typingStopped(event.payload);
        broadcastToChannel(channelId, typingEvent, conn);
        return;
      }

      case CLIENT_EVENT.presenceUpdate: {
        // Budget first (see PRESENCE_BUCKET_*): each accepted frame costs a
        // status write plus 4 reads and a fan-out to every co-member and friend
        // connection, so this is the most expensive non-message client frame.
        // Silent drop for the same reason as typing — the reply would be the
        // amplification. Well above any human's status-toggling rate.
        if (!conn.presenceBucket.take()) return;
        if (event.payload.userId !== conn.userId) {
          sendError(conn, {
            code: "INVALID_PAYLOAD",
            message: "userId must match the authenticated user.",
          });
          return;
        }
        // Recorded against THIS socket (ADR 0020), never as one status for the
        // whole account: the frame is that device's declaration, and the account's
        // status is derived from every live connection. Same contract as before on
        // the wire — a pre-ADR client sends the identical frame — but a desktop
        // that goes idle and then away no longer speaks for the user's phone. The
        // gateway uses the authenticated socket's own id, never a client-supplied
        // one (the payload's `userId` is checked above and carries no connection).
        await deps.presence.setStatus(conn.userId, conn.id, event.payload.status);
        await broadcastPresence(conn.userId);
        return;
      }

      case CLIENT_EVENT.presenceAppState: {
        // Record THIS socket's foreground/background state for the push gate
        // (#110). Deliberately NOT broadcast: app state is a transport concern for
        // OS-push suppression only — it is never shown as presence to peers (a
        // backgrounded phone still reads "online"), so this fires no
        // presence.updated and cannot cause a render storm (§27). The gateway uses
        // the authenticated socket's own id, never a client-supplied one.
        //
        // Shares the generous control budget (see CONTROL_BUCKET_*): the frame is
        // one Redis hset, and dropping a real one would desync the push gate, so
        // the cap sits far above any app's foreground/background cadence and only
        // exists to stop an unbounded write loop.
        if (!conn.controlBucket.take()) return;
        await deps.presence.setAppState(conn.userId, conn.id, event.payload.state);
        return;
      }

      case CLIENT_EVENT.voiceJoin: {
        // Budget first (see CONTROL_BUCKET_*): join/leave is in-memory but
        // AMPLIFIES to every subscriber of the channel, and the branches below
        // reply with error frames. A real user joins a room a few times a
        // minute, so 30 burst / 5 per second is never reached legitimately.
        if (!conn.controlBucket.take()) return;
        const { channelId } = event.payload;
        // Cheap pre-filter from the connection's cached set; the AUTHORITATIVE
        // membership + visibility read follows.
        const kind = conn.channelKinds.get(channelId);
        if (kind === undefined) {
          sendError(conn, {
            code: "NOT_A_MEMBER",
            message: "You are not a member of this channel.",
            channelId,
          });
          return;
        }
        if (kind !== "voice") {
          sendError(conn, {
            code: "INVALID_CHANNEL",
            message: "This is not a voice channel.",
            channelId,
          });
          return;
        }
        if (conn.voiceChannelId === channelId) return; // idempotent

        // Fresh authority, mirroring the REST media-token guard: joining a voice
        // room is a JOIN decision, and a restricted voice channel is a private
        // room. Deciding it from the cache alone meant a member whose role was
        // just revoked could still walk into the call — and be heard — for as
        // long as the bus resync took to arrive, or forever if it never did.
        //
        // `findWithMembership` re-reads membership and the LIVE channel kind
        // (a channel can be deleted, and the cached kind can be stale for the
        // same reason the visibility can); `stillVisible` adds the M9 role
        // filter. The pair is exactly `loadVisibleChannel` on the HTTP side, so
        // the two transports cannot disagree about who may enter a room.
        let voiceAccess;
        try {
          voiceAccess = await deps.repos.channels.findWithMembership(channelId, conn.userId);
          if (voiceAccess && !(await stillVisible(conn, voiceAccess.channel.groupId, channelId))) {
            voiceAccess = null;
          }
        } catch (err) {
          log(`voice.join lookup failed: ${err instanceof Error ? err.message : String(err)}`);
          sendError(conn, {
            code: "MESSAGE_FAILED",
            message: "Something went wrong handling that event.",
            channelId,
          });
          return;
        }
        if (!voiceAccess) {
          // Same refusal as an unknown channel — a restricted channel never
          // leaks that it exists (ADR 0007, §28).
          sendError(conn, {
            code: "NOT_A_MEMBER",
            message: "You are not a member of this channel.",
            channelId,
          });
          return;
        }
        if (voiceAccess.channel.kind !== "voice") {
          sendError(conn, {
            code: "INVALID_CHANNEL",
            message: "This is not a voice channel.",
            channelId,
          });
          return;
        }
        // The lookups above yield, so re-check what they may have raced:
        // occupancy is counted per connection, and a socket that closed while
        // its join was in flight has already run `handleClose` — counting it now
        // would leave a count nothing ever removes. A second frame for the same
        // room that landed first has already counted this socket.
        if (conn.closed || conn.voiceChannelId === channelId) return;
        leaveVoice(conn); // implicit leave of any previous room
        conn.voiceChannelId = channelId;
        addVoiceOccupant(channelId, conn.userId);
        broadcastToChannel(
          channelId,
          serverEvent.voiceParticipantJoined({
            channelId,
            userId: conn.userId,
            muted: false,
          }),
        );
        // Now an occupant: push the running watch session (if any) so this
        // socket starts playing at the right place. Fire-and-forget — a failed
        // sync must never fail the voice join, and the 5 s heartbeat re-states it.
        void watchParty.onVoiceJoined(watchActor(conn)).catch((err: unknown) =>
          log(`watch join sync failed: ${err instanceof Error ? err.message : String(err)}`),
        );
        return;
      }

      case CLIENT_EVENT.voiceLeave: {
        // Same shared control budget as voice.join — the pair is one user action
        // and must not be spammable into an unbounded fan-out loop.
        if (!conn.controlBucket.take()) return;
        if (conn.voiceChannelId === event.payload.channelId) leaveVoice(conn);
        return;
      }

      // Playback controls and QUEUE frames (M20 wave 2) share ONE budget rather
      // than getting a bucket each: they are the same cost shape (one fresh
      // membership read, one fan-out to the room) driven by the same user
      // pressing the same panel, so two buckets would only let a client spend
      // twice as much by alternating between them.
      case CLIENT_EVENT.watchStart:
      case CLIENT_EVENT.watchControl:
      case CLIENT_EVENT.watchSetVideo:
      case CLIENT_EVENT.watchTransferHost:
      case CLIENT_EVENT.watchStop:
      case CLIENT_EVENT.watchQueueAdd:
      case CLIENT_EVENT.watchQueueRemove:
      case CLIENT_EVENT.watchQueueReorder:
      case CLIENT_EVENT.watchQueuePlay:
      case CLIENT_EVENT.watchEnded: {
        // Budget first (see WATCH_BUCKET_*): every one of these costs a fresh
        // membership read plus a fan-out to the room, and the authority branches
        // below answer with error frames. Refused loudly, unlike typing — a
        // dropped pause is a failure the user has to see.
        if (!conn.watchBucket.take()) {
          sendError(conn, {
            code: "RATE_LIMITED",
            message: "You are changing playback too quickly.",
          });
          return;
        }
        // Everything else — occupancy, membership, timeout, host/owner, video-id
        // normalization — is enforced inside the coordinator.
        await watchParty.handle(watchActor(conn), event satisfies WatchClientEvent);
        return;
      }

      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  }

  async function handleMessageSend(
    conn: Connection,
    payload: SendMessagePayload,
  ): Promise<void> {
    // `attachmentIds` (ADR 0008): already-uploaded, ready, uploader-owned rows
    // to link to the new message. The shared `sendMessagePayloadSchema` has
    // already enforced content-OR-attachments (both empty never reaches here —
    // the frame fails validation and errors with the nonce) and the per-message
    // cap, mirroring the REST create body.
    // `replyToMessageId` (ADR 0011 §2): the quoted target, validated below to
    // exist in THIS channel before the insert. Optional/additive — non-reply
    // sends omit it, so pre-M14 clients behave exactly as before.
    const { channelId, content, nonce, attachmentIds = [], replyToMessageId } = payload;

    if (!conn.messageBucket.take()) {
      sendError(conn, {
        code: "RATE_LIMITED",
        message: "You are sending messages too quickly.",
        nonce,
      });
      return;
    }
    // Cheap pre-filter from the connection-time snapshot; the authoritative
    // check (fresh membership/kind/slowmode) follows below.
    const cachedKind = conn.channelKinds.get(channelId);
    if (cachedKind === undefined) {
      sendError(conn, {
        code: "NOT_A_MEMBER",
        message: "You are not a member of this channel.",
        nonce,
      });
      return;
    }
    // Voice channels carry a text chat since M20. Widened via
    // the SHARED `isChatCapableChannel` predicate rather than a second inline
    // comparison, so this transport and the REST twin can never disagree about
    // which kinds accept a write — the desktop client sends over this socket and
    // the same user's phone over HTTP, so a gate that differed would be a gate
    // you could pick your way around by switching device.
    if (!isChatCapableChannel(cachedKind)) {
      sendError(conn, {
        code: "INVALID_CHANNEL",
        message: "Messages cannot be sent to this channel.",
        nonce,
      });
      return;
    }

    // Fresh lookup: slowmode settings, membership, and roles change at runtime
    // through the HTTP API, so the snapshot cannot be trusted for enforcement.
    // Same per-message query the REST send path already performs.
    let access;
    try {
      access = await deps.repos.channels.findWithMembership(channelId, conn.userId);
    } catch (err) {
      log(`message.send lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      sendError(conn, {
        code: "MESSAGE_FAILED",
        message: "Message failed to send. Please try again.",
        nonce,
      });
      return;
    }
    if (!access || !isChatCapableChannel(access.channel.kind)) {
      sendError(conn, {
        code: !access ? "NOT_A_MEMBER" : "INVALID_CHANNEL",
        message: !access
          ? "You are not a member of this channel."
          : "Messages cannot be sent to this channel.",
        nonce,
      });
      return;
    }

    // ROLE VISIBILITY — the second half of the REST guard `loadVisibleChannel`,
    // and the half this path used to be missing. `findWithMembership` above only
    // proves the user is in the GROUP; a restricted channel (ADR 0007) is
    // additionally gated on holding a granting role, and that gate lived nowhere
    // on this transport except the connection's bus-refreshed cache.
    //
    // Concretely: revoke a member's role over HTTP, and until the fire-and-forget
    // resync landed (or forever, if its bus message was dropped) their socket
    // could still post into the restricted channel — a private conversation.
    // Runs BEFORE the timeout gate and before the write, matching the REST order.
    let visible: boolean;
    try {
      visible = await stillVisible(conn, access.channel.groupId, channelId);
    } catch (err) {
      log(
        `message.send visibility check failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      sendError(conn, {
        code: "MESSAGE_FAILED",
        message: "Message failed to send. Please try again.",
        nonce,
      });
      return;
    }
    if (!visible) {
      // Indistinguishable from "not a member", exactly like the REST 404.
      sendError(conn, {
        code: "NOT_A_MEMBER",
        message: "You are not a member of this channel.",
        nonce,
      });
      return;
    }

    // Timeout gate (migration 0020, ADR 0019) — the WS half. `timedOutUntil`
    // rides on the membership row `findWithMembership` already read above, so
    // this is a clock comparison, not a query, and it runs BEFORE the write and
    // before slowmode exactly like the REST twin.
    //
    // This gate existing on both transports is the whole point: the desktop
    // client sends over the socket and the mobile client over HTTP, so a mute
    // enforced on only one of them would be no mute at all. Same code, same
    // copy — mirroring how the block gate is duplicated here deliberately.
    if (isTimedOut(access.timedOutUntil)) {
      sendError(conn, {
        // Copy kept identical to the API's `TIMED_OUT_MESSAGE` (lib/timeout.ts).
        // Inlined here rather than imported for the same reason the block message
        // is: the gateway does not depend on the API package, and this string is
        // the last English fallback before the client localizes off the CODE.
        code: "TIMED_OUT",
        message: "You are timed out in this server and cannot do that until it expires.",
        nonce,
      });
      return;
    }

    // DM block gate (M18, ADR 0017). `dms.findById` is kind-filtered, so it
    // resolves the DM (participant = the OTHER member) ONLY when this channel's
    // group is a DM — it doubles as the DM detector. This lookup used to run
    // AFTER the broadcast (in `handleInboundSideEffects`); hoisting it here makes
    // the block check pre-write and costs NO extra query, because the result is
    // handed to that function instead of being re-read. Symmetric: the send is
    // refused whichever side blocked. Mirrors the REST create path exactly, so a
    // client cannot bypass the block by switching transport.
    let dm: Awaited<ReturnType<Repositories["dms"]["findById"]>> = null;
    try {
      dm = await deps.repos.dms.findById(access.channel.groupId, conn.userId);
      if (dm && (await deps.repos.userBlocks.existsBetween(conn.userId, dm.participant.id))) {
        sendError(conn, {
          code: "BLOCKED",
          message: "You can't do that because of a block between you and this user.",
          nonce,
        });
        return;
      }
    } catch (err) {
      log(`message.send block check failed: ${err instanceof Error ? err.message : String(err)}`);
      sendError(conn, {
        code: "MESSAGE_FAILED",
        message: "Message failed to send. Please try again.",
        nonce,
      });
      return;
    }

    // Slowmode: one message per `slowmodeSeconds` per non-owner member. The
    // Redis-backed slot is shared with the HTTP API, so switching transports
    // cannot bypass the limit.
    const slowmodeSeconds = access.channel.slowmodeSeconds ?? 0;
    if (slowmodeSeconds > 0 && access.role !== "owner") {
      const verdict = await slowmode.check(channelId, conn.userId, slowmodeSeconds);
      if (!verdict.ok) {
        sendError(conn, {
          code: "SLOWMODE",
          message: `Slowmode is on. Try again in ${verdict.retryAfterSeconds}s.`,
          nonce,
          retryAfterSeconds: verdict.retryAfterSeconds,
        });
        return;
      }
    }

    // Reply target validation (ADR 0011 §2): a reply may only quote a message in
    // the SAME channel. Reject a missing target or a cross-channel quote with a
    // nonce'd INVALID_PAYLOAD, mirroring the REST create path — you cannot quote
    // a message from a channel you may not even see. Only runs for reply sends,
    // so a normal send pays nothing. A soft-deleted target is still a VALID quote
    // (row present, rendered as a "deleted" stub by the preview builder); only a
    // genuinely absent id or a foreign channel is refused.
    if (replyToMessageId !== undefined) {
      let target;
      try {
        target = await deps.repos.messages.findById(replyToMessageId);
      } catch (err) {
        log(
          `message.send reply lookup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
        sendError(conn, {
          code: "MESSAGE_FAILED",
          message: "Message failed to send. Please try again.",
          nonce,
        });
        return;
      }
      if (!target || target.channelId !== channelId) {
        sendError(conn, {
          code: "INVALID_PAYLOAD",
          message: "The message you are replying to could not be found in this channel.",
          nonce,
        });
        return;
      }
    }

    let message;
    try {
      // `nonce` makes this insert idempotent: a retried send (lost echo)
      // resolves to the original row rather than duplicating it.
      message = await deps.repos.messages.create({
        channelId,
        authorId: conn.userId,
        content,
        nonce,
        replyToMessageId,
      });
    } catch (err) {
      log(`message.send persist failed: ${err instanceof Error ? err.message : String(err)}`);
      sendError(conn, {
        code: "MESSAGE_FAILED",
        message: "Message failed to send. Please try again.",
        nonce,
      });
      return;
    }

    // Link attachments AFTER the nonce upsert, mirroring the REST create:
    // atomic (a bad id links none) and idempotent (ids already linked to THIS
    // message — a retried send — are accepted as no-ops). On AttachmentLinkError
    // the message row stays as an orphan, exactly like the REST path: it carries
    // valid text or is swept, and a nonce retry with corrected ids still
    // resolves to it.
    if (attachmentIds.length > 0) {
      try {
        await deps.repos.attachments.attachToMessage(attachmentIds, message.id, conn.userId);
      } catch (err) {
        if (err instanceof AttachmentLinkError) {
          sendError(conn, linkErrorToErrorRaised(err, nonce));
          return;
        }
        log(`message.send attach failed: ${err instanceof Error ? err.message : String(err)}`);
        sendError(conn, {
          code: "MESSAGE_FAILED",
          message: "Message failed to send. Please try again.",
          nonce,
        });
        return;
      }
    }

    // Persist first, then broadcast; the sender reconciles via the nonce.
    // On a deduped retry `message` is the canonical original row, so this
    // re-broadcasts the SAME message.created (same id) — clients upsert by id.
    // Attachment-carrying messages are enriched with METADATA only (AttachmentDTO
    // projection — never `storagePath`, never signed URLs; ADR 0008 §2); replies
    // carry a lightweight quote preview (ADR 0011 §2). Both graft off the SAME
    // persisted row, so the sender's echo and every peer copy cache identically.
    let dto: MessageDTO = { ...message, nonce };
    try {
      if (attachmentIds.length > 0) {
        dto = { ...(await enrichMessageWithAttachments(deps.repos, message)), nonce };
      }
      // No-op for a non-reply (returns `dto` unchanged); one batched lookup for a
      // reply. Builds the preview from `message.replyToMessageId`, so a deduped
      // retry and a since-deleted target both render correctly.
      dto = await enrichMessageWithReplyPreview(deps.repos, dto);
    } catch (err) {
      // Message + links ARE persisted; broadcasting it bare would make clients
      // cache it without its attachments/reply preview. Report failure instead —
      // a nonce retry dedupes to the same row and re-enriches idempotently.
      log(`message.send enrich failed: ${err instanceof Error ? err.message : String(err)}`);
      sendError(conn, {
        code: "MESSAGE_FAILED",
        message: "Message failed to send. Please try again.",
        nonce,
      });
      return;
    }
    broadcastToChannel(channelId, serverEvent.messageCreated(dto));

    // Link preview (M17): unfurl http(s) URLs in the content ASYNCHRONOUSLY. The
    // WS send is the PRIMARY path (desktop), so this is where desktop messages get
    // their previews. Fire-and-forget — the message is already broadcast; embeds
    // arrive later via `message.embeds_updated` (published on the bus by the
    // service, fanned out by this gateway's own subscriber). Only for text sends.
    if (deps.unfurl && message.content.length > 0) {
      void deps.unfurl
        .unfurlMessage({
          messageId: message.id,
          channelId,
          authorId: conn.userId,
          content: message.content,
        })
        .catch((err: unknown) =>
          log(`unfurl failed: ${err instanceof Error ? err.message : String(err)}`),
        );
    }

    // Post-broadcast inbound side effects — DM re-open + offline push — mirroring
    // the REST create path in the api messages module. Fire-and-forget best-
    // effort: the message is already delivered, so a single DM lookup + its
    // unhide/subscribe/push must never delay or fail the send. A DM message and a
    // server-channel fan-out are mutually exclusive here (one DM lookup decides),
    // so a message never double-notifies.
    void handleInboundSideEffects(
      access.channel.groupId,
      conn.userId,
      channelId,
      access.channel.name,
      message.id,
      message.content,
      dm,
    ).catch((err: unknown) =>
      log(`inbound side effects failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }


  function handleFrame(conn: Connection, raw: unknown, isBinary: boolean): void {
    // Proof of life for the eviction ordering (see Connection.lastSeenAt).
    // Recorded for EVERY inbound frame, including ones about to be rejected: a
    // socket sending garbage is still demonstrably alive, and the cap's job is to
    // shed dead weight, not to referee content.
    conn.lastSeenAt = Date.now();
    if (isBinary) {
      // Media frames are WebRTC/LiveKit territory — never this socket.
      conn.socket.close(1003, "binary frames not allowed");
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      conn.socket.close(1003, "invalid json");
      return;
    }

    const result = clientToServerEventSchema.safeParse(parsed);
    if (!result.success) {
      const type = (parsed as { type?: unknown })?.type;
      const known =
        typeof type === "string" &&
        clientToServerEventSchema.options.some((o) => o.shape.type.value === type);
      if (!known) {
        conn.socket.close(1008, "unknown event type");
        return;
      }
      sendError(conn, {
        code: "INVALID_PAYLOAD",
        message: "Event payload failed validation.",
        nonce: extractNonce(parsed),
      });
      return;
    }

    void handleEvent(conn, result.data).catch((err) => {
      log(`event handling failed: ${err instanceof Error ? err.message : String(err)}`);
      sendError(conn, {
        code: "MESSAGE_FAILED",
        message: "Something went wrong handling that event.",
      });
    });
  }

  async function handleConnection(socket: WebSocket, request: IncomingMessage): Promise<void> {
    // Client-identity gate FIRST — ahead of the token read and the session
    // lookup. A retired client must be refused on identity alone: whether its
    // session is still valid is irrelevant, and asking the database about it
    // would only hand an app we have decided to shut out a free query per
    // reconnect attempt. No-op unless the gate is armed (default: off).
    if (clientGateEnabled && !isValidClientSignature(extractClientSignature(request.url))) {
      socket.close(CLOSE_CLIENT_UPDATE_REQUIRED, CLIENT_UPDATE_REQUIRED_CODE);
      return;
    }

    const token = extractToken(request.url);
    if (!token) {
      socket.close(CLOSE_UNAUTHORIZED, "missing token");
      return;
    }
    // Client kind for this socket (task #47); undefined for pre-platform clients.
    const platform = extractPlatform(request.url);

    let active: Awaited<ReturnType<Repositories["sessions"]["findActiveByTokenHash"]>>;
    try {
      active = await deps.repos.sessions.findActiveByTokenHash(hashSessionToken(token));
    } catch (err) {
      log(`session lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      socket.close(1011, "auth backend unavailable");
      return;
    }
    if (!active) {
      socket.close(CLOSE_UNAUTHORIZED, "invalid or expired session");
      return;
    }

    const userId = active.user.id;

    // Concurrent-socket cap for this ACCOUNT (see MAX_CONNECTIONS_PER_USER).
    // Enforced HERE — after the session lookup (it is per-account, so it needs
    // the account) but BEFORE the ~8 visibility/membership/presence queries
    // below, so an over-cap connection costs one query rather than ten.
    //
    // EVICT THE STALEST, DO NOT REFUSE THE NEW ONE. Refusing is the tempting
    // choice, and it is wrong here: the sockets that push an account to its cap
    // are overwhelmingly ZOMBIES — a laptop that slept, a phone that changed
    // networks without a FIN — which linger until the 30 s heartbeat reaps them.
    // Refusing would mean the user is locked out of their own account for up to
    // a heartbeat every time their network flaps, i.e. exactly when they most
    // need to reconnect. Evicting cannot lock anyone out: the newest, definitely
    // live socket always wins.
    //
    // The cost of evicting is a silent drop, which is why the victim is the
    // LEAST RECENTLY ACTIVE connection (`lastSeenAt`) and not the oldest: a live
    // app answers a heartbeat ping every 30 s, so a real session is only ever
    // chosen when the account genuinely has 10 live sockets — and then the one
    // that has been quiet longest is the least painful to drop. The evicted
    // client reconnects on its own (4429 falls through to the backoff reconnect),
    // and that reconnect is itself bounded by the per-address handshake limit,
    // so an attacker cannot turn eviction into a churn amplifier.
    const existingConns = connectionsByUser.get(userId);
    if (existingConns) {
      while (existingConns.size >= maxConnectionsPerUser) {
        let victim: Connection | null = null;
        for (const candidate of existingConns) {
          if (!victim || candidate.lastSeenAt < victim.lastSeenAt) victim = candidate;
        }
        if (!victim) break;
        // Deregister EAGERLY: `close()` only starts the closing handshake, so
        // waiting for the `close` event would let a fast loop blow past the cap.
        existingConns.delete(victim);
        victim.socket.close(CLOSE_TOO_MANY_CONNECTIONS, "too many connections");
        // Runs the full teardown now (presence, subscriptions, voice). Guarded by
        // `conn.closed`, so the socket's own `close` event is a no-op later.
        await handleClose(victim);
        log(`evicted stale connection for user ${userId} (connection cap)`);
      }
    }

    // Visibility-filtered subscription set (ADR 0007) — a restricted channel the
    // user cannot see is never subscribed, so no frame of it ever reaches this
    // socket. Memberships are indexed separately so group-scoped mutations can
    // reach this connection even for a channel the user cannot currently see.
    //
    // ALL kinds (servers, flat group chats, dms), not `groups.listForUser`
    // (server-only): the group index is what `member.left` / `group.deleted`
    // surgery keys off, and a group chat missing from it meant a kicked member's
    // subscription was never dropped.
    const channelKinds = await visibleChannelKinds(userId);
    const memberGroupIds = await deps.repos.groups.listMemberGroupIds(userId);
    // Block set (M18, ADR 0017): everyone with a block against this user in
    // either direction. Read ONCE per connection and kept fresh by the
    // `user.blocks_updated` resync, so the per-message fan-out filter is a
    // pure in-memory Set lookup and costs no query (§27).
    const blockedUserIds = await deps.repos.userBlocks.relatedIds(userId);
    const conn: Connection = {
      id: randomUUID(),
      socket,
      userId,
      // The authenticated session — the token lookup already resolved it, so a
      // `session.revoked` for this session can target this exact socket (#98).
      sessionId: active.session.id,
      seq: 0,
      channelKinds,
      groupIds: new Set(memberGroupIds),
      blockedUserIds,
      voiceChannelId: null,
      messageBucket: new TokenBucket(
        MESSAGE_BUCKET_CAPACITY,
        MESSAGE_BUCKET_REFILL_PER_SECOND,
      ),
      // Separate budgets per event class, so a chatty composer can never eat the
      // allowance a voice join or a status change needs (and vice versa).
      typingBucket: new TokenBucket(TYPING_BUCKET_CAPACITY, TYPING_BUCKET_REFILL_PER_SECOND),
      presenceBucket: new TokenBucket(
        PRESENCE_BUCKET_CAPACITY,
        PRESENCE_BUCKET_REFILL_PER_SECOND,
      ),
      controlBucket: new TokenBucket(CONTROL_BUCKET_CAPACITY, CONTROL_BUCKET_REFILL_PER_SECOND),
      watchBucket: new TokenBucket(WATCH_BUCKET_CAPACITY, WATCH_BUCKET_REFILL_PER_SECOND),
      isAlive: true,
      lastSeenAt: Date.now(),
      closed: false,
    };

    subscriptions.add(conn, conn.channelKinds.keys());
    let userConns = connectionsByUser.get(userId);
    if (!userConns) {
      userConns = new Set();
      connectionsByUser.set(userId, userConns);
    }
    userConns.add(conn);
    for (const groupId of conn.groupIds) indexConnectionByGroup(conn, groupId);
    // Dominant platform AND derived status BEFORE this socket registers, so we can
    // tell whether this connection flips either (e.g. a desktop joining a
    // mobile-only presence, or a fresh socket making an all-idle account available
    // again). See the re-broadcast decision after the snapshot below.
    const [platformBefore, statusBefore] = await Promise.all([
      deps.presence.getPlatform(userId),
      deps.presence.getStatus(userId),
    ]);
    const cameOnline = await deps.presence.connect(userId, conn.id, platform);

    socket.on("message", (raw, isBinary) => handleFrame(conn, raw, isBinary));
    socket.on("pong", () => {
      conn.isAlive = true;
      conn.lastSeenAt = Date.now();
    });
    socket.on("close", () => {
      // Fire-and-forget, but never leak a rejection: on shutdown the presence
      // fan-out query can lose its pool mid-flight.
      void handleClose(conn).catch((err) =>
        log(`close handling failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    });
    socket.on("error", () => {
      // `ws` reports its own PROTOCOL errors — an over-`maxPayload` frame above
      // all — by first sending the matching close frame (1009) and only then
      // emitting `error`, leaving readyState CLOSING. Destroying the socket here
      // would discard that frame and the client would see an opaque 1006 instead
      // of the real reason, so only a transport error on a still-OPEN socket
      // gets the hard terminate; anything already closing is left to finish.
      if (socket.readyState === socket.OPEN) socket.terminate();
    });

    // Handshake presence snapshot covers the same audience presence broadcasts
    // target: group co-members UNION accepted friends (ADR 0010 §4), so a friend
    // sharing no group still shows their status dot on connect.
    //
    // PEERS ONLY — the connecting user is not in it (`presenceAudience` excludes
    // self). Their own status at this instant is derived with THIS socket's
    // default declaration ("online"), which is not what the client is about to
    // declare, so the client seeds its own dot from its locally chosen status and
    // learns the account's real status from the echo of its re-assert (see
    // `broadcastPresence`). Pre-M16 the snapshot did carry self — MASKED, so an
    // invisible user was handed "offline" for themselves on every connect.
    const audience = await presenceAudience(userId);
    // Custom statuses for the whole audience in ONE batched query (M18), so the
    // handshake snapshot carries the same `customStatus` the live
    // `presence.updated` deltas do — a client never has to special-case "the line
    // only appears after the peer's next presence change".
    const audienceStatuses = await deps.repos.users.customStatusesFor([...audience]);
    sendEvent(
      conn,
      serverEvent.authSucceeded({
        userId,
        // Mask every peer's presence (invisible → offline) so the connecting user
        // never learns a peer is secretly online.
        presence: (await deps.presence.snapshot(audience)).map((p) => {
          const customStatus = audienceStatuses.get(p.userId);
          return maskPresence(customStatus ? { ...p, customStatus } : p);
        }),
        // WHO is already in each voice channel this connection can see, so voice
        // occupancy renders immediately on connect (and re-seeds on reconnect)
        // without waiting for the next join/leave delta. Visibility-filtered via
        // `conn.channelKinds`, the same boundary the deltas obey.
        voiceOccupancy: voiceOccupancySnapshot(conn),
      }),
    );
    // Layer AUTHORITATIVE media-plane occupancy on top (STATE RESYNC): a
    // fire-and-forget `voice.resync` so a missed voice/screen-share delta
    // self-heals on every (re)connect. Never blocks or fails the handshake; a
    // no-op when no reader is configured (existing behavior preserved).
    void sendVoiceResync(conn).catch((err) =>
      log(`voice.resync failed: ${err instanceof Error ? err.message : String(err)}`),
    );
    // Same resync philosophy for watch parties (M20): re-state every live session
    // among the voice channels this connection can SEE, so a client that
    // connected mid-party — or lost its socket during one — learns about it
    // without a request event of its own. Visibility-filtered by construction:
    // only the connection's own voice channels are considered.
    const visibleVoiceChannelIds: ChannelId[] = [];
    for (const [channelId, kind] of conn.channelKinds) {
      if (kind === "voice") visibleVoiceChannelIds.push(channelId);
    }
    void watchParty
      .onConnectionReady(watchActor(conn), visibleVoiceChannelIds)
      .catch((err: unknown) =>
        log(`watch resync failed: ${err instanceof Error ? err.message : String(err)}`),
      );
    // Re-broadcast on first connection (came online) OR when this socket changed
    // the user's dominant platform without changing online-ness — e.g. opening
    // desktop while already on mobile must flip peers from the phone indicator to
    // the plain dot (task #47). Priority (desktop>mobile) lives in the store.
    //
    // The STATUS check is what ADR 0020 adds: presence is now derived from every
    // live connection, so a socket that neither brings the user online nor flips
    // the platform can still change the answer — a phone connecting to an all-idle
    // account makes it `online` again. Without this, peers would keep the amber dot
    // until some unrelated presence event happened to fire.
    const [platformAfter, statusAfter] = await Promise.all([
      deps.presence.getPlatform(userId),
      deps.presence.getStatus(userId),
    ]);
    // `conn` is excluded from the self copy: see `broadcastPresence` — this socket
    // gets the account's real status from the echo of its own re-assert instead.
    if (cameOnline || platformBefore !== platformAfter || statusBefore !== statusAfter) {
      await broadcastPresence(userId, conn);
    }
    log(`user ${userId} connected (${conn.channelKinds.size} visible channels)`);
  }

  async function handleClose(conn: Connection): Promise<void> {
    // Once only. The eviction path (connection cap) tears a connection down
    // eagerly and the socket's own `close` event fires straight after; running
    // the presence bookkeeping twice for one connection id would emit a spurious
    // offline transition for an account that is still connected elsewhere.
    if (conn.closed) return;
    conn.closed = true;
    leaveVoice(conn);
    subscriptions.remove(conn);
    const userConns = connectionsByUser.get(conn.userId);
    userConns?.delete(conn);
    if (userConns && userConns.size === 0) connectionsByUser.delete(conn.userId);
    for (const groupId of conn.groupIds) deindexConnectionFromGroup(conn, groupId);
    // Same reasoning as the connect path: broadcast when the user went offline OR
    // when losing this socket flipped their dominant platform (e.g. the last
    // desktop socket closing while a mobile one remains → peers switch to the
    // phone indicator) OR when it changed the DERIVED status (ADR 0020).
    //
    // That last case is the founder's bug in reverse, and it is the reason a
    // disconnect must re-derive at all: this socket's declared status dies with it,
    // so an idle desktop closing while an active phone remains flips the account
    // idle→online, and an active phone closing while an idle desktop remains flips
    // it online→idle. Neither changes online-ness or the dominant platform, so the
    // pre-ADR condition stayed silent and every peer kept a stale dot.
    const [platformBefore, statusBefore] = await Promise.all([
      deps.presence.getPlatform(conn.userId),
      deps.presence.getStatus(conn.userId),
    ]);
    const wentOffline = await deps.presence.disconnect(conn.userId, conn.id);
    const [platformAfter, statusAfter] = await Promise.all([
      deps.presence.getPlatform(conn.userId),
      deps.presence.getStatus(conn.userId),
    ]);
    if (wentOffline || platformBefore !== platformAfter || statusBefore !== statusAfter) {
      await broadcastPresence(conn.userId);
    }
    // Last socket gone: schedule the outgoing-ring withdrawal. The reaper waits a
    // grace period and re-checks presence, so a plain reconnect (every deploy
    // causes one) never costs the caller their own ring.
    if (wentOffline) callReaper.onUserOffline(conn.userId);
  }

  /**
   * Which connected group members a group-scoped event can change the visibility
   * of. Everyone else still gets the thin event forwarded (UI refetch) but needs
   * no subscription recompute:
   * - `member.roles_updated` → only the named member's own connections;
   * - `channel.updated` → a rename/topic/slowmode edit never moves visibility, so
   *   forward only (no recompute);
   * - `role.*` / `channel.access_changed` → any member could gain/lose a channel,
   *   so recompute all (a no-op diff when nothing moved).
   *
   * `channel.created` does NOT reach here: it is routed to {@link handleChannelCreated}
   * so its full-Channel payload is forwarded only to members who can see it.
   */
  function connectionsToResync(
    event: ServerToClientEvent,
    groupConns: Connection[],
  ): Connection[] {
    if (event.type === SERVER_EVENT.memberRolesUpdated) {
      const { userId } = event.payload;
      return groupConns.filter((c) => c.userId === userId);
    }
    // A channel rename/topic edit or a server rename/re-icon never moves channel
    // visibility — forward only, no subscription recompute. Custom-emoji
    // create/delete (M17) is the same: an emoji is a group asset that cannot
    // affect who may see which channel, so resyncing every member's
    // subscriptions on an emoji upload would be a pure waste — one DB query per
    // connected member per upload (§27).
    if (
      event.type === SERVER_EVENT.channelUpdated ||
      event.type === SERVER_EVENT.groupUpdated ||
      event.type === SERVER_EVENT.emojiCreated ||
      event.type === SERVER_EVENT.emojiDeleted
    ) {
      return [];
    }
    return groupConns;
  }

  /**
   * Re-derive one connection's visible channels for a group and reconcile its
   * subscriptions. Only THIS group's channels take part in the diff (bounded by
   * `groupUniverse`); the connection's other groups are left alone. A voice
   * channel that loses visibility triggers a forced leave before it is dropped.
   */
  async function resyncConnectionVisibility(
    conn: Connection,
    groupId: GroupId,
    groupUniverse: Map<ChannelId, ChannelKind>,
  ): Promise<void> {
    const nowVisible = new Set(
      await deps.repos.channelAccess.visibleChannelIdsForUser(groupId, conn.userId),
    );

    // Gained visibility: in the fresh set but not yet subscribed.
    const toAdd: ChannelId[] = [];
    for (const channelId of nowVisible) {
      if (!conn.channelKinds.has(channelId)) toAdd.push(channelId);
    }
    // Lost visibility: currently subscribed, belongs to this group, now gone.
    const toRemove: ChannelId[] = [];
    for (const channelId of conn.channelKinds.keys()) {
      if (groupUniverse.has(channelId) && !nowVisible.has(channelId)) {
        toRemove.push(channelId);
      }
    }
    if (toAdd.length === 0 && toRemove.length === 0) return;

    for (const channelId of toAdd) {
      const kind = groupUniverse.get(channelId);
      if (kind === undefined) continue; // channel vanished between queries
      conn.channelKinds.set(channelId, kind);
    }
    if (toAdd.length > 0) subscriptions.add(conn, toAdd);

    for (const channelId of toRemove) {
      // Force voice.leave while still subscribed, so the participant_left frame
      // reaches this socket (its cue to tear down) and its peers. LiveKit tears
      // the media session down client-side.
      if (conn.voiceChannelId === channelId) leaveVoice(conn);
      conn.channelKinds.delete(channelId);
    }
    if (toRemove.length > 0) subscriptions.remove(conn, toRemove);

    log(
      `resync user ${conn.userId} group ${groupId}: +${toAdd.length}/-${toRemove.length} channels`,
    );
  }

  /**
   * React to a group-scoped mutation published by the HTTP API. Most events
   * (role/access changes, `channel.updated`) forward the thin event group-wide
   * and reconcile the affected members' visible-channel subscriptions. Four
   * lifecycle events need bespoke connection-set surgery and are routed to
   * dedicated handlers:
   * - `channel.created` → resync visibility, then forward the (full-Channel) event
   *   ONLY to members who can see the new channel — a restricted channel never
   *   leaks its existence to a member without a granting role (task #43/#51, §28);
   * - `channel.deleted` → drop every subscription to the dead channel;
   * - `member.joined`   → index + subscribe the new member's own connections;
   * - `member.left`     → de-index + unsubscribe the removed member's connections;
   * - `group.deleted`   → drop the whole server/group from every member: full
   *   subscription resync (its channels are gone from the DB), voice teardown,
   *   de-index.
   */
  async function handleGroupMutation(mutation: RealtimeMutation): Promise<void> {
    const { groupId, event } = mutation;
    if (groupId === undefined) return;

    switch (event.type) {
      case SERVER_EVENT.channelCreated:
        await handleChannelCreated(groupId, event, event.payload.id);
        return;
      case SERVER_EVENT.channelDeleted:
        handleChannelDeleted(groupId, event, event.payload.channelId);
        return;
      case SERVER_EVENT.memberJoined:
        await handleMemberJoined(groupId, event, event.payload.user.id);
        return;
      case SERVER_EVENT.memberLeft:
        await handleMemberLeft(groupId, event, event.payload.userId);
        return;
      case SERVER_EVENT.groupDeleted:
        await handleGroupDeleted(groupId, event);
        return;
      default:
        await forwardAndResyncGroup(groupId, event);
        return;
    }
  }

  /**
   * Subscribe every live connection of `userId` to a text STREAM channel — the
   * instant-subscribe primitive behind `dm.created` delivery / WS DM re-open (ADR
   * 0010 §4) AND `group_chat.added` (ADR 0005): record the kind in the
   * connection's visible set and add the subscription so messages flow at once, no
   * reconnect. Idempotent: a connection already carrying the stream (a DM /
   * group-chat stream is always visible to its members, so it is re-derived at
   * every handshake) is skipped.
   */
  function subscribeUserToStream(userId: UserId, streamId: ChannelId): void {
    for (const conn of connectionsByUser.get(userId) ?? []) {
      if (conn.channelKinds.has(streamId)) continue;
      conn.channelKinds.set(streamId, "text");
      subscriptions.add(conn, [streamId]);
    }
  }

  /**
   * React to a user-scoped mutation (M13, ADR 0010 §4): a social event targeting
   * exactly one user regardless of channel/group — the third bus branch alongside
   * channel- and group-scoped mutations. Forward the thin `event` to that user's
   * live connections via `connectionsByUser`. Two events carry a side effect
   * beyond the forward:
   * - `dm.created` / `group_chat.added` → subscribe the user's live connections to
   *   the new DM / group-chat stream BEFORE forwarding, so a message racing in
   *   right behind the event still lands (the recipient is already on the stream);
   *   no reconnect. The API only publishes — it cannot touch these sockets.
   * - `friend.request_accepted` → the two users are now friends and each enters
   *   the other's presence audience; refresh both presences so their status dots
   *   appear live without waiting for the next connect/idle transition.
   * - `user.updated` → NOT a single-user delivery at all: the profile that changed
   *   is visible to a whole population, so the recipient set is EXPANDED to
   *   `presenceAudience(userId) ∪ {userId}` and the generic loop is skipped. See
   *   the inline note at the branch.
   *
   * `friend.request_received` and `friend.removed` need no side effect: the client
   * adds/drops the relationship (and its presence dot) from the thin event, and
   * the presence audience is recomputed per broadcast, so a removal needs no
   * invalidation (a later broadcast simply no longer targets the ex-friend).
   */
  async function handleUserMutation(mutation: RealtimeMutation): Promise<void> {
    const { userId, event } = mutation;
    if (userId === undefined) return;

    // Session revocation (#98): drop the revoked sessions' LIVE connections NOW
    // instead of waiting for their next HTTP request to notice the dead token.
    // Unlike every other user-scoped event this is NOT a blanket fan-out — it
    // must hit only the connections whose session was signed out, so it forwards
    // the typed event to each MATCHING connection and then closes it with the
    // auth-expired code (4401, the same code the WS client maps to onAuthExpired).
    // A non-revoked session of the same user (e.g. the device that pressed "sign
    // out others") is left completely untouched. Handled first + return so the
    // generic loop below never blasts session.revoked to every device.
    if (event.type === SERVER_EVENT.sessionRevoked) {
      const revoked = new Set(event.payload.sessionIds);
      // Iterate a snapshot: closing a socket schedules handleClose, which mutates
      // connectionsByUser.
      for (const conn of [...(connectionsByUser.get(userId) ?? [])]) {
        if (!revoked.has(conn.sessionId)) continue;
        // Event FIRST (socket still open), THEN close — a client that acts on the
        // event logs out at once; one that ignores it still gets the 4401 close.
        sendEvent(conn, event);
        conn.socket.close(CLOSE_UNAUTHORIZED, "session revoked");
      }
      return;
    }

    // Public profile changed (displayName/avatar/banner/bio). The ONLY user-scoped
    // event whose recipient set is WIDER than the named user: everyone who can see
    // them must repaint (member sidebar, message rows, profile card), not just their
    // own devices. Reuse `presenceAudience` verbatim — co-members of any shared
    // group (server, DM, group chat) ∪ accepted friends — because "who sees your
    // status dot" and "who sees your avatar" are the same population; a user sharing
    // no context is absent from that set and therefore never receives the event.
    // The subject is unioned in so their OWN other sessions repaint too (the set is
    // co-members/friends, which `presenceAudience` guarantees excludes self — and
    // one payload serves both here, a profile carries no mask). Handled first +
    // return so the generic single-user loop below does not also deliver it.
    if (event.type === SERVER_EVENT.userUpdated) {
      const audience = await presenceAudience(userId);
      audience.add(userId);
      for (const memberId of audience) {
        for (const conn of connectionsByUser.get(memberId) ?? []) {
          sendEvent(conn, event);
        }
      }
      return;
    }

    if (event.type === SERVER_EVENT.dmCreated) {
      subscribeUserToStream(userId, event.payload.dm.streamId);
    }
    // A DM call was upgraded to a group (ADR 0012). The API publishes the new
    // group's `member.joined`s first, but bus handlers run concurrently and
    // `member.joined` awaits the DB before it subscribes anyone — so this event
    // could reach the client first, its `voice.join` for the new group voice
    // channel then hit an empty cache and was refused, and the two people
    // talking showed as an empty channel to everyone else. Admitting the user
    // here, BEFORE forwarding, makes the order irrelevant.
    if (event.type === SERVER_EVENT.callUpgraded) {
      try {
        await admitUserToGroup(event.payload.group.id, userId);
      } catch (err) {
        log(`call.upgraded group admission failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // A member was just added to a flat group chat — subscribe their live
    // connections to its stream BEFORE forwarding so a message racing in behind
    // the event still lands (mirrors dm.created; ADR 0005 / task group-chat-add).
    if (event.type === SERVER_EVENT.groupChatAdded) {
      subscribeUserToStream(userId, event.payload.group.streamId);
    }

    // Block list changed (M18, ADR 0017) — the RESYNC branch, mirroring the M9-4
    // visibility resync: RE-DERIVE this user's block set from the DB rather than
    // patching the delta into the in-memory Set. Re-deriving is idempotent, self-
    // heals a missed event, and cannot drift; blocks change rarely, so the extra
    // query is free (§27). Done BEFORE the forward so a client that refetches on
    // the event already reads a gateway applying the new filter.
    if (event.type === SERVER_EVENT.blocksUpdated) {
      try {
        const fresh = await deps.repos.userBlocks.relatedIds(userId);
        for (const conn of connectionsByUser.get(userId) ?? []) {
          conn.blockedUserIds = fresh;
        }
      } catch (err) {
        log(`block resync failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (const conn of connectionsByUser.get(userId) ?? []) {
      sendEvent(conn, event);
    }

    // Custom status changed (M18): the thin event above told the user's OWN
    // devices; peers learn through a presence re-broadcast, which reaches exactly
    // the audience that already sees their status dot (co-members ∪ accepted
    // friends). Reusing `broadcastPresence` means no new audience computation and
    // no new client-side routing — the line rides `presence.updated`. (The own
    // devices get the re-broadcast's unmasked self copy as well; it carries the
    // same line, so the two deliveries agree.)
    if (event.type === SERVER_EVENT.customStatusUpdated) {
      await broadcastPresence(userId);
    }

    if (event.type === SERVER_EVENT.friendRequestAccepted) {
      // Both sides just gained a friend, so each now belongs to the other's
      // presence audience. Broadcast both so the new friend's dot appears on both
      // clients at once (neither is otherwise guaranteed a connect/idle event).
      await broadcastPresence(userId);
      await broadcastPresence(event.payload.friend.id);
    }
  }

  /**
   * Post-broadcast side effects for an inbound WS message (ADR 0010 §1, WS side —
   * mirrors the REST create path in the api messages module). A SINGLE DM lookup
   * drives two mutually-exclusive branches:
   *
   *  - DM channel → re-open (unhide) the recipient's hidden DM + belt-and-
   *    suspenders re-subscribe their live connections to the stream (a reconnected
   *    recipient is already subscribed — the DM stream is in every member's visible
   *    set at handshake — so a no-op in the common case), then fire an offline push
   *    at the recipient (the OTHER member).
   *  - server/group channel → fan the "all messages" offline push (#94) out to
   *    every member who can SEE the channel: @mentioned members get the mention
   *    push, everyone else the plain channel push, all mute-gated
   *    (`dispatchChannelMessagePush`).
   *
   * `dms.findById(groupId, sender)` resolves the DM (participant = the OTHER
   * member) ONLY when this channel's group is a DM and the sender is a member, so
   * it doubles as a cheap DM detector — null for every server/group channel (one
   * kind-filtered lookup). Because the branches are exclusive, a DM message never
   * ALSO fires a channel push: a message in a DM (whose 2-member roster overlaps
   * the fan-out) is not double-notified, exactly like REST. Best-effort
   * throughout; `notifier.notify` is itself offline-gated and swallows its own
   * errors (§10: control metadata only — title/body preview, no secrets).
   */
  async function handleInboundSideEffects(
    groupId: GroupId,
    senderId: UserId,
    channelId: ChannelId,
    channelName: string,
    messageId: string,
    content: string,
    /**
     * The DM this channel belongs to (participant = the OTHER member), or null
     * for a server/group channel. Resolved by the caller BEFORE the write (it is
     * what the M18 block gate needs) and handed down here, so the lookup happens
     * exactly once per send rather than twice.
     */
    dm: Awaited<ReturnType<Repositories["dms"]["findById"]>>,
  ): Promise<void> {
    if (dm) {
      // Re-surface the DM for the recipient if hidden, and re-subscribe their live
      // connections (runs regardless of a notifier — it is a delivery concern).
      await deps.repos.dms.unhide(dm.id, dm.participant.id);
      subscribeUserToStream(dm.participant.id, dm.streamId);
      // DM push at the recipient (the OTHER member); offline-gated by the notifier.
      // Body + data match the REST DM push so a notification reads identically
      // regardless of transport. A DM mute (0013) silences it — mode="all" drops
      // it, mode="mentions" keeps it only when the message directly @mentions the
      // recipient (mirrors the REST path).
      if (deps.notifier) {
        const dmRecipients = await filterMutedRecipients(
          deps.repos.notificationMutes,
          [dm.participant.id],
          {
            channelId,
            groupId,
            isMention: contentMentionsUser(content, dm.participant.id),
          },
          log,
        );
        // Ignore filter (migration 0020, ADR 0019 §4) — the WS twin of the REST
        // DM branch. A DM audience is one person, so this is a single membership
        // test rather than the batched form. The message is already written and
        // delivered; only the push stops, and the sender learns nothing.
        const ignoring = await deps.repos.userIgnores.isIgnoring(
          dm.participant.id,
          senderId,
        );
        if (dmRecipients.length > 0 && !ignoring) {
          const author = await deps.repos.users.findById(senderId);
          await deps.notifier.notify(dmRecipients, {
            title: author?.displayName ?? "New message",
            body: mentionPushBody(content),
            data: { type: "dm_message", dmId: dm.id, channelId, messageId },
          });
        }
      }
      return;
    }
    // Non-DM (server/group) channel: fan out the "all messages" offline push
    // (#94) — mention + plain channel push, mute-gated, visibility-scoped. Shares
    // the exact dispatcher the REST create path uses, so the two cannot drift.
    await dispatchChannelMessagePush(
      { repos: deps.repos, notifier: deps.notifier, log },
      { channelId, groupId, channelName, authorId: senderId, content, messageId },
    );
  }

  /**
   * Forward `event` to every connected group member, then reconcile the visible-
   * channel subscriptions of the members it can affect (see
   * {@link connectionsToResync}). This is the role/access path (`role.*`,
   * `channel.access_changed`, `channel.updated`). `channel.created` is handled
   * separately by {@link handleChannelCreated} — its full-Channel payload is
   * forwarded only to members who can see the new channel.
   */
  async function forwardAndResyncGroup(
    groupId: GroupId,
    event: ServerToClientEvent,
  ): Promise<void> {
    const groupConns = connectionsByGroup.get(groupId);
    if (!groupConns || groupConns.size === 0) return;

    const targets = [...groupConns];
    for (const conn of targets) sendEvent(conn, event);

    const affected = connectionsToResync(event, targets);
    if (affected.length === 0) return;

    // The group's channel universe (id → kind) bounds the per-connection diff to
    // this group's channels and supplies the kind for newly visible ones.
    const groupUniverse = new Map<ChannelId, ChannelKind>(
      (await deps.repos.channels.listForGroup(groupId)).map((c) => [c.id, c.kind]),
    );
    for (const conn of affected) {
      await resyncConnectionVisibility(conn, groupId, groupUniverse);
    }
  }

  /**
   * A channel was created. Resync every connected member's visibility first so
   * those who CAN see the new channel are subscribed (a message racing in behind
   * the create still lands — the task #43 fix), then forward the thin
   * `channel.created` — which carries the FULL Channel row — ONLY to those
   * members. A channel created already restricted (roleIds set at creation, task
   * #51) therefore never reveals its name or existence to a member lacking a
   * granting role (§28); a public channel still reaches everyone, exactly as
   * before. Ordering mirrors the role/access resync: subscribe, then deliver.
   */
  async function handleChannelCreated(
    groupId: GroupId,
    event: ServerToClientEvent,
    channelId: ChannelId,
  ): Promise<void> {
    const groupConns = connectionsByGroup.get(groupId);
    if (!groupConns || groupConns.size === 0) return;

    const groupUniverse = new Map<ChannelId, ChannelKind>(
      (await deps.repos.channels.listForGroup(groupId)).map((c) => [c.id, c.kind]),
    );
    for (const conn of [...groupConns]) {
      await resyncConnectionVisibility(conn, groupId, groupUniverse);
      // `channelKinds.has` is now true iff this member may see the new channel.
      if (conn.channelKinds.has(channelId)) sendEvent(conn, event);
    }
  }

  /**
   * A channel was deleted. Every group member subscribed to it must be dropped so
   * no late frame slips through, and anyone sitting in its voice room is forced
   * out (the participant_left frame is emitted while still subscribed, matching
   * the roles-resync forced-leave ordering). The thin event is forwarded last so
   * the client refetches its now-shorter channel list AFTER delivery has stopped.
   */
  function handleChannelDeleted(
    groupId: GroupId,
    event: ServerToClientEvent,
    channelId: ChannelId,
  ): void {
    const groupConns = connectionsByGroup.get(groupId);
    if (!groupConns || groupConns.size === 0) return;
    for (const conn of [...groupConns]) {
      if (conn.channelKinds.has(channelId)) {
        if (conn.voiceChannelId === channelId) leaveVoice(conn);
        conn.channelKinds.delete(channelId);
        subscriptions.remove(conn, [channelId]);
      }
      sendEvent(conn, event);
    }
  }

  /**
   * A member joined the server. Existing members get the thin event (roster
   * refresh). The joined user's OWN connections were not indexed under this group
   * at their handshake (they were not a member yet), so index them and subscribe
   * them to the group's visible channels now — a second device sees the server
   * without needing a manual reconnect (task #43).
   */
  async function handleMemberJoined(
    groupId: GroupId,
    event: ServerToClientEvent,
    joinedUserId: UserId,
  ): Promise<void> {
    const notified = new Set(connectionsByGroup.get(groupId) ?? []);
    for (const conn of notified) sendEvent(conn, event);

    await admitUserToGroup(groupId, joinedUserId);
    // The joiner's connections that were not indexed under the group when the
    // event went out above have not seen it yet — whether this handler indexed
    // them or a concurrent `call.upgraded` did while it was awaiting the DB.
    for (const conn of connectionsByUser.get(joinedUserId) ?? []) {
      if (conn.groupIds.has(groupId) && !notified.has(conn)) sendEvent(conn, event);
    }
  }

  /**
   * Index `userId`'s live connections under `groupId` and subscribe them to the
   * group's channels they can see — no reconnect needed (task #43). Idempotent:
   * a connection that already carries the group or a channel is left as it is,
   * so `member.joined` and `call.upgraded` can both run it in either order.
   */
  async function admitUserToGroup(groupId: GroupId, userId: UserId): Promise<void> {
    const userConns = connectionsByUser.get(userId);
    if (!userConns || userConns.size === 0) return;
    const groupUniverse = new Map<ChannelId, ChannelKind>(
      (await deps.repos.channels.listForGroup(groupId)).map((c) => [c.id, c.kind]),
    );
    const visibleIds = new Set(
      await deps.repos.channelAccess.visibleChannelIdsForUser(groupId, userId),
    );
    for (const conn of [...(connectionsByUser.get(userId) ?? [])]) {
      if (!conn.groupIds.has(groupId)) {
        conn.groupIds.add(groupId);
        indexConnectionByGroup(conn, groupId);
      }
      const toAdd: ChannelId[] = [];
      for (const cid of visibleIds) {
        if (conn.channelKinds.has(cid)) continue;
        const kind = groupUniverse.get(cid);
        if (kind === undefined) continue;
        conn.channelKinds.set(cid, kind);
        toAdd.push(cid);
      }
      if (toAdd.length > 0) subscriptions.add(conn, toAdd);
    }
  }

  /**
   * A member left / was kicked. Everyone currently in the group (including the
   * leaver's own connections, whose UI should react) gets the thin event BEFORE
   * we mutate the index. The leaver lost access to every channel of this group,
   * so their own connections are unsubscribed from them, forced out of any of its
   * voice rooms, and de-indexed from the group (task #43).
   */
  async function handleMemberLeft(
    groupId: GroupId,
    event: ServerToClientEvent,
    leftUserId: UserId,
  ): Promise<void> {
    const groupConns = connectionsByGroup.get(groupId);
    if (groupConns) {
      for (const conn of [...groupConns]) sendEvent(conn, event);
    }

    const userConns = connectionsByUser.get(leftUserId);
    if (!userConns || userConns.size === 0) return;
    const groupChannelIds = (await deps.repos.channels.listForGroup(groupId)).map((c) => c.id);
    for (const conn of [...userConns]) {
      if (!conn.groupIds.has(groupId)) continue;
      const toRemove = groupChannelIds.filter((id) => conn.channelKinds.has(id));
      for (const channelId of toRemove) {
        if (conn.voiceChannelId === channelId) leaveVoice(conn);
        conn.channelKinds.delete(channelId);
      }
      if (toRemove.length > 0) subscriptions.remove(conn, toRemove);
      conn.groupIds.delete(groupId);
      deindexConnectionFromGroup(conn, groupId);
    }
  }

  /**
   * A whole server / flat group chat was deleted (owner delete OR auto-deleted
   * when its last member left — task #50). Its row and everything it owned
   * (channels, messages, memberships, invites) are already gone from the DB, so
   * — unlike `member.left`, which can still list the group's channels — the group
   * id no longer resolves to any channels. Every connected member therefore gets:
   *   1. the thin `group.deleted` event first (UI drops the group + routes away);
   *   2. a FULL visibility resync (re-derived from the DB, which no longer
   *      contains the deleted group's channels) so their subscriptions to those
   *      channels are dropped and anyone sitting in one of its voice rooms is
   *      forced out;
   *   3. de-indexed from the group.
   */
  async function handleGroupDeleted(
    groupId: GroupId,
    event: ServerToClientEvent,
  ): Promise<void> {
    const groupConns = connectionsByGroup.get(groupId);
    if (!groupConns || groupConns.size === 0) return;
    for (const conn of [...groupConns]) {
      sendEvent(conn, event);
      await resyncConnectionFull(conn);
      if (conn.groupIds.has(groupId)) {
        conn.groupIds.delete(groupId);
        deindexConnectionFromGroup(conn, groupId);
      }
    }
  }

  /**
   * Reconcile one connection's ENTIRE subscription set against a fresh read of
   * the channels it can currently see (across all its groups). Used by
   * `group.deleted`, where the affected channels can no longer be enumerated from
   * the deleted group id: anything the connection is subscribed to that is no
   * longer visible (the deleted group's channels) is dropped, and any voice room
   * among them is force-left first (so its `participant_left` still reaches peers,
   * matching the `channel.deleted` ordering). Bounded DB work, but group deletion
   * is rare — same "recompute" philosophy as the role/access resync.
   */
  async function resyncConnectionFull(conn: Connection): Promise<void> {
    const fresh = await visibleChannelKinds(conn.userId);

    const toRemove: ChannelId[] = [];
    for (const channelId of conn.channelKinds.keys()) {
      if (!fresh.has(channelId)) toRemove.push(channelId);
    }
    const toAdd: ChannelId[] = [];
    for (const [channelId, kind] of fresh) {
      if (!conn.channelKinds.has(channelId)) {
        conn.channelKinds.set(channelId, kind);
        toAdd.push(channelId);
      }
    }
    if (toAdd.length > 0) subscriptions.add(conn, toAdd);

    for (const channelId of toRemove) {
      if (conn.voiceChannelId === channelId) leaveVoice(conn);
      conn.channelKinds.delete(channelId);
    }
    if (toRemove.length > 0) subscriptions.remove(conn, toRemove);
  }

  wss.on("connection", (socket, request) => {
    handleConnection(socket, request).catch((err) => {
      log(`connection setup failed: ${err instanceof Error ? err.message : String(err)}`);
      socket.close(1011, "internal error");
    });
  });

  // Fan API-originated mutations (message.updated/deleted, message.reaction_added/
  // removed, published over Redis by the HTTP API) out to local subscribers of
  // the affected channel. Uses the same enveloped, sequenced send path as
  // WS-originated broadcasts.
  if (deps.mutationBus) {
    deps.mutationBus
      .subscribe((mutation) => {
        // Channel-scoped mutations fan out to that channel's local subscribers.
        // `subscriptions.subscribers(channelId)` is exactly the visibility-filtered
        // set (a restricted channel a user cannot see was never subscribed at
        // handshake), so the reaction deltas (ADR 0011 §3) inherit the channel
        // access filter for free — they need no bespoke gateway code, just this
        // existing branch (see the reaction fan-out int test).
        if (mutation.channelId !== undefined) {
          broadcastToChannel(mutation.channelId, mutation.event);
          return;
        }
        // User-scoped mutations (M13 social events, ADR 0010 §4) forward to the
        // target user's live connections; dm.created also subscribes them to the
        // new stream. Fire-and-forget for the same reason as the group path.
        if (mutation.userId !== undefined) {
          void handleUserMutation(mutation).catch((err) =>
            log(
              `user mutation fan-out failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
          return;
        }
        // Group-scoped mutations (M9 role/access changes) resync the affected
        // connections' visibility and forward the thin event. Fire-and-forget:
        // the DB write is already the source of truth, so a failed fan-out must
        // not crash the subscriber — clients recover on the next refetch.
        void handleGroupMutation(mutation).catch((err) =>
          log(
            `group mutation resync failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
      })
      .catch((err) =>
        log(`mutation subscribe failed: ${err instanceof Error ? err.message : String(err)}`),
      );
  }

  // Heartbeat: reap dead connections so presence does not go stale.
  const heartbeat = setInterval(() => {
    for (const conns of connectionsByUser.values()) {
      for (const conn of conns) {
        if (!conn.isAlive) {
          conn.socket.terminate();
          continue;
        }
        // A socket can also go quiet WITH a full queue: it answered the last
        // ping, then stopped draining, and no broadcast has happened since to
        // route it through `sendEvent`. Re-checking here reaps that backlog on
        // the same 30 s cadence instead of waiting for the next event.
        if (isOverBuffered(conn)) continue;
        conn.isAlive = false;
        conn.socket.ping();
      }
    }
  }, options.heartbeatIntervalMs ?? 30_000);
  wss.on("close", () => clearInterval(heartbeat));

  return {
    wss,
    ready,
    async close(): Promise<void> {
      clearInterval(heartbeat);
      callReaper.stop();
      watchParty.stop();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
