import {
  parseYouTubeVideoId,
  WATCH_HEARTBEAT_MS,
  WATCH_POSITION_MAX_SECONDS,
  WATCH_QUEUE_MAX_ITEMS,
} from "@demli/config";
import type { Repositories, WatchPartyStore, WatchSessionRecord } from "@demli/db";
import {
  serverEvent,
  type ClientToServerEvent,
  type RealtimeErrorCode,
  type ServerToClientEvent,
  type WatchQueueItem,
  type WatchSessionStatePayload,
  type WatchStoppedReason,
} from "@demli/protocol";
import { isTimedOut, type ChannelId, type UserId } from "@demli/types";
import { canSeeChannelFresh } from "./channel-visibility.js";

/**
 * Watch-party coordinator (M20, ADR 0016) — the server half of "watch a YouTube
 * video together in a voice channel".
 *
 * What it syncs: which video, the position, playing/paused, and who is driving.
 * What it never touches: video bytes. Every member plays the video from YouTube
 * themselves, so nothing media-shaped rides this protocol (§10/§35) and the
 * feature costs no bandwidth, no SFU capacity, and no API key.
 *
 * It lives beside the gateway rather than inside it for two reasons: gateway.ts
 * is already the largest file in the app (§23), and every authorization decision
 * for this feature is then in ONE readable place instead of scattered through a
 * 60-case switch.
 *
 * ## Authority (the part that must not be got wrong)
 *
 * Every mutating frame passes {@link authorize}, in this order:
 *
 *  1. **Occupancy** — the acting SOCKET must be in that voice channel. Read from
 *     gateway state (set only by the gateway's own `voice.join` handler), never
 *     from the payload: a client saying "I am in channel X" proves nothing.
 *  2. **Membership + channel kind + role visibility** — a FRESH
 *     `findWithMembership` read AND a fresh `canSeeChannelFresh`, not the
 *     handshake snapshot, because roles and membership change over HTTP mid-
 *     session. Also re-asserts the channel is a voice channel.
 *  3. **Timeout** (ADR 0019) — a timed-out member cannot control playback, for
 *     the same reason they cannot send a message on either transport: a mute
 *     that only covers some surfaces is not a mute.
 *  4. **Host or server owner** — for every control (start-over, play, pause,
 *     seek, set_video, transfer_host, stop) AND for every queue mutation (add,
 *     remove, reorder, play-this-one, ended). The owner override exists so a room
 *     is never held hostage by a host who wandered off.
 *
 * The queue deliberately reuses that fourth gate rather than inventing a softer
 * one. The founder's rule for this feature is "whoever opened the watch party
 * queues, reorders and plays", and the host IS that person; a jukebox where any
 * occupant can enqueue is a different product decision, and it would arrive as a
 * change to `mayControl` alone.
 *
 * Blocking (ADR 0017) is deliberately NOT a gate here, matching the voice plane:
 * a block never stopped two members sharing a voice channel, these frames carry
 * no authored content of anyone, and dropping them per-recipient would desync
 * the very playback they describe — the same reasoning that leaves
 * `message.deleted` and reaction deltas unfiltered (ADR 0017 §3).
 *
 * ## Consistency
 *
 * The store is a plain read-modify-write with no lock. This deployment runs ONE
 * gateway and Node is single-threaded, so two controls can only interleave at an
 * `await`, and the worst outcome is last-writer-wins on a playback position —
 * which is what a shared remote does anyway. The 5 s heartbeat re-states the
 * winner to everyone, so any disagreement lasts one tick.
 */

/** The client→server frames this coordinator owns. */
export type WatchClientEvent = Extract<ClientToServerEvent, { type: `watch.${string}` }>;

/** Who is acting, and how to answer them. One live socket. */
export interface WatchActor {
  userId: UserId;
  /**
   * The voice channel THIS socket is currently in, as tracked by the gateway
   * (`Connection.voiceChannelId`), or null. The occupancy gate reads this and
   * nothing else.
   */
  voiceChannelId: ChannelId | null;
  /** Send one event to this actor's own socket. */
  send(event: ServerToClientEvent): void;
}

/**
 * How the coordinator reaches an audience. Two audiences, deliberately (§27):
 * lifecycle goes channel-wide so a member who can merely SEE the voice channel
 * can show "a watch party is running", while the 5 s drift `watch.state` goes
 * only to the people actually in the room.
 */
export interface WatchDelivery {
  /** Every visibility-filtered subscriber of the channel. */
  toChannel(channelId: ChannelId, event: ServerToClientEvent): void;
  /** Only the sockets currently sitting in that voice room. */
  toOccupants(channelId: ChannelId, event: ServerToClientEvent): void;
  /**
   * Server-truth occupants of the voice channel, in join order (the gateway's
   * own `voiceOccupants` index). Join order is what makes the automatic host
   * handoff deterministic: the longest-present occupant takes over.
   */
  occupantIds(channelId: ChannelId): UserId[];
}

export interface WatchPartyDeps {
  repos: Repositories;
  store: WatchPartyStore;
  delivery: WatchDelivery;
  log?: (message: string) => void;
  /** Injectable clock; tests drive drift without waiting for real seconds. */
  now?: () => number;
  /** Drift-heartbeat cadence. Tests shorten it; production uses the config value. */
  heartbeatIntervalMs?: number;
}

export interface WatchPartyCoordinator {
  /** Handle one authenticated `watch.*` frame (already schema-validated). */
  handle(actor: WatchActor, event: WatchClientEvent): Promise<void>;
  /**
   * A socket just joined a voice channel: push it the running session's state so
   * it starts playing at the right place, with no request event of its own —
   * the same server-push resync model as `voice.resync`.
   */
  onVoiceJoined(actor: WatchActor): Promise<void>;
  /**
   * A user left a voice channel (leave, disconnect, kick, lost visibility — the
   * gateway funnels every teardown through one place). Hands the host role on,
   * or ends the session when the room is empty.
   */
  onVoiceLeft(channelId: ChannelId, userId: UserId): Promise<void>;
  /**
   * A connection (re)connected: re-state every live session among the voice
   * channels it can SEE, so a client that missed the `watch.started` — or lost
   * the socket mid-party — re-seats on server truth exactly like `voice.resync`.
   */
  onConnectionReady(actor: WatchActor, visibleVoiceChannelIds: Iterable<ChannelId>): Promise<void>;
  /** Stop the drift heartbeat (gateway shutdown). */
  stop(): void;
}

/** Keep positions to millisecond precision; float noise helps nobody. */
function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Where the video is NOW. Stored state is "`positionSec` as of `updatedAtMs`",
 * so a playing session is projected forward from its last control and a paused
 * one is frozen. Clamped to the same bound the wire schema enforces, so a
 * session left playing for a week cannot emit an out-of-contract payload.
 */
export function projectedPositionSec(session: WatchSessionRecord, nowMs: number): number {
  if (!session.playing) return round3(Math.min(session.positionSec, WATCH_POSITION_MAX_SECONDS));
  const elapsedSec = Math.max(0, (nowMs - session.updatedAtMs) / 1000);
  return round3(Math.min(session.positionSec + elapsedSec, WATCH_POSITION_MAX_SECONDS));
}

/** The wire snapshot of a session at `nowMs` (shared by `started` and `state`). */
export function watchStatePayload(
  session: WatchSessionRecord,
  nowMs: number,
): WatchSessionStatePayload {
  return {
    channelId: session.channelId as ChannelId,
    hostId: session.hostId as UserId,
    source: session.source,
    videoId: session.videoId,
    positionSec: projectedPositionSec(session, nowMs),
    playing: session.playing,
    serverTime: new Date(nowMs).toISOString(),
  };
}

/**
 * Arrange `queue` into the order named by `itemIds`.
 *
 * The reorder frame carries a desired FULL ORDER, not a move, and this is why:
 * two people may drive one queue (host and server owner) and the auto-advance
 * mutates it from the server's side, so the list a client was looking at when it
 * built the frame may already be stale. Reconciling against what the server
 * actually holds makes every outcome a valid permutation of the real queue —
 *
 *  - ids the server does not know (already played, already removed) are ignored;
 *  - items the client never mentioned (added by the other controller, or exposed
 *    by an auto-advance) survive, in their existing relative order, at the end;
 *  - no id can appear twice, because the source of truth for membership is the
 *    server's list and each item is emitted at most once.
 *
 * So two racing reorders leave a queue containing exactly the server's items,
 * each exactly once; the later frame simply wins the arrangement. An index-based
 * "move item 3 to position 1" under the same race silently moves a different row.
 */
export function reorderQueue(
  queue: readonly WatchQueueItem[],
  itemIds: readonly string[],
): WatchQueueItem[] {
  const byId = new Map(queue.map((item) => [item.itemId, item]));
  const ordered: WatchQueueItem[] = [];
  const taken = new Set<string>();
  for (const itemId of itemIds) {
    const item = byId.get(itemId);
    if (!item || taken.has(itemId)) continue;
    taken.add(itemId);
    ordered.push(item);
  }
  for (const item of queue) {
    if (!taken.has(item.itemId)) ordered.push(item);
  }
  return ordered;
}

export function createWatchPartyCoordinator(deps: WatchPartyDeps): WatchPartyCoordinator {
  const log = deps.log ?? (() => undefined);
  const now = deps.now ?? Date.now;
  const { store, delivery, repos } = deps;

  function deny(actor: WatchActor, code: RealtimeErrorCode, message: string): void {
    actor.send(serverEvent.errorRaised({ code, message }));
  }

  /**
   * Steps 1-3 of the authority chain (occupancy → membership/kind → timeout),
   * plus the session read the caller needs anyway. Answers the actor with the
   * precise refusal and returns null when any gate fails, so every handler below
   * is a straight-line "authorize, then act".
   */
  async function authorize(
    actor: WatchActor,
    channelId: ChannelId,
  ): Promise<{ session: WatchSessionRecord | null; isOwner: boolean } | null> {
    // 1. Occupancy — server truth, never the payload's word.
    if (actor.voiceChannelId !== channelId) {
      deny(actor, "NOT_IN_VOICE", "You must be in this voice channel to do that.");
      return null;
    }

    // 2. Fresh membership + kind. Roles and membership change over HTTP while a
    // socket is open, so the handshake snapshot is not an authorization source.
    let access: Awaited<ReturnType<Repositories["channels"]["findWithMembership"]>>;
    try {
      access = await repos.channels.findWithMembership(channelId, actor.userId);
    } catch (err) {
      log(`watch access lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      deny(actor, "MESSAGE_FAILED", "Something went wrong. Please try again.");
      return null;
    }
    if (!access) {
      deny(actor, "NOT_A_MEMBER", "You are not a member of this channel.");
      return null;
    }
    if (access.channel.kind !== "voice") {
      deny(actor, "INVALID_CHANNEL", "This is not a voice channel.");
      return null;
    }

    // 2b. Role VISIBILITY (ADR 0007) — the other half of the REST guard.
    // `findWithMembership` proves group membership only; a restricted voice
    // channel additionally requires a granting role, and without this the check
    // rested on the gateway's cached visible-channel set, which is refreshed by a
    // fire-and-forget bus message. A member whose role was revoked mid-party
    // could otherwise keep driving playback in a room they can no longer see.
    let visible: boolean;
    try {
      visible = await canSeeChannelFresh(
        repos,
        access.channel.groupId,
        channelId,
        actor.userId,
      );
    } catch (err) {
      log(`watch visibility check failed: ${err instanceof Error ? err.message : String(err)}`);
      deny(actor, "MESSAGE_FAILED", "Something went wrong. Please try again.");
      return null;
    }
    if (!visible) {
      // Same refusal as a non-member: a restricted channel never leaks that it
      // exists (§28).
      deny(actor, "NOT_A_MEMBER", "You are not a member of this channel.");
      return null;
    }

    // 3. Timeout (ADR 0019) — the same gate the message paths apply, on the same
    // membership row that was just read, so it costs no extra query.
    if (isTimedOut(access.timedOutUntil)) {
      deny(
        actor,
        "TIMED_OUT",
        "You are timed out in this server and cannot do that until it expires.",
      );
      return null;
    }

    let session: WatchSessionRecord | null;
    try {
      session = await store.get(channelId);
    } catch (err) {
      log(`watch session read failed: ${err instanceof Error ? err.message : String(err)}`);
      deny(actor, "MESSAGE_FAILED", "Something went wrong. Please try again.");
      return null;
    }
    return { session, isOwner: access.role === "owner" };
  }

  /** Step 4: only the host or the server owner may move the playhead. */
  function mayControl(session: WatchSessionRecord, actor: WatchActor, isOwner: boolean): boolean {
    return isOwner || session.hostId === actor.userId;
  }

  /**
   * Require a LIVE session the actor may control. Splits the two refusals apart:
   * "nothing is running" and "someone else is driving" need different UI, and
   * conflating them would make the client guess.
   */
  function requireControllableSession(
    actor: WatchActor,
    authorized: { session: WatchSessionRecord | null; isOwner: boolean },
  ): WatchSessionRecord | null {
    const { session, isOwner } = authorized;
    if (!session) {
      deny(actor, "WATCH_NOT_ACTIVE", "There is no watch party running in this channel.");
      return null;
    }
    if (!mayControl(session, actor, isOwner)) {
      deny(actor, "NOT_HOST", "Only the watch party host can do that.");
      return null;
    }
    return session;
  }

  async function persistAndSyncRoom(session: WatchSessionRecord): Promise<void> {
    await store.save(session);
    delivery.toOccupants(
      session.channelId as ChannelId,
      serverEvent.watchState(watchStatePayload(session, now())),
    );
  }

  /**
   * Announce the queue to the ROOM only, and only when it changed.
   *
   * Deliberately its own event rather than a field on `watch.state` (§27):
   * `watch.state` is the 5 s drift heartbeat, the frame this feature sends most
   * often by a wide margin, and it exists to carry a number that changes every
   * tick. The queue changes when a human presses something — a handful of times
   * an evening — so folding it in would multiply the size of the hot frame by the
   * length of a list that is almost always identical to the one sent five seconds
   * ago. Non-occupants get nothing: a member who can merely SEE the channel has a
   * "party running" badge to render, not a playlist.
   */
  function syncQueue(session: WatchSessionRecord): void {
    delivery.toOccupants(
      session.channelId as ChannelId,
      serverEvent.watchQueueUpdated({
        channelId: session.channelId as ChannelId,
        queue: session.queue,
      }),
    );
  }

  /** Persist a change that touched BOTH the playhead and the queue, in one pair of frames. */
  async function persistAndSyncAll(session: WatchSessionRecord): Promise<void> {
    await store.save(session);
    delivery.toOccupants(
      session.channelId as ChannelId,
      serverEvent.watchState(watchStatePayload(session, now())),
    );
    syncQueue(session);
  }

  async function endSession(
    channelId: ChannelId,
    reason: WatchStoppedReason,
  ): Promise<void> {
    await store.delete(channelId);
    delivery.toChannel(channelId, serverEvent.watchStopped({ channelId, reason }));
  }

  async function handleStart(
    actor: WatchActor,
    payload: Extract<WatchClientEvent, { type: "watch.start" }>["payload"],
  ): Promise<void> {
    const channelId = payload.channelId;
    const authorized = await authorize(actor, channelId);
    if (!authorized) return;
    // Starting is open to any occupant while the room is idle; once a session is
    // running, replacing it is a CONTROL and needs the host (or the owner).
    if (authorized.session && !mayControl(authorized.session, actor, authorized.isOwner)) {
      deny(actor, "NOT_HOST", "Only the watch party host can do that.");
      return;
    }

    // Normalize again on the server even though the schema already refused an
    // unparseable ref. This is the line the whole feature's safety rests on: what
    // gets stored and broadcast is the 11-character id, never the client's string.
    const videoId = parseYouTubeVideoId(payload.videoRef);
    if (videoId === null) {
      deny(actor, "INVALID_PAYLOAD", "That is not a YouTube video link.");
      return;
    }

    const nowMs = now();
    const session: WatchSessionRecord = {
      channelId,
      hostId: actor.userId,
      source: payload.source,
      videoId,
      positionSec: 0,
      playing: true,
      updatedAtMs: nowMs,
      startedAtMs: authorized.session?.startedAtMs ?? nowMs,
      // A `watch.start` aimed at a LIVE session is a video change, not a new
      // party — the same reading that keeps `startedAtMs` — so the queue behind
      // it survives. Only a genuinely new session starts with an empty one.
      queue: authorized.session?.queue ?? [],
    };
    await store.save(session);
    // Channel-wide: the full snapshot doubles as the "a party is running" signal
    // for members who can see the channel but are not in the room.
    delivery.toChannel(channelId, serverEvent.watchStarted(watchStatePayload(session, nowMs)));
    // The room needs the queue too; a party started on top of an existing one
    // would otherwise leave every occupant showing a queue nobody re-stated.
    if (session.queue.length > 0) syncQueue(session);
  }

  async function handleControl(
    actor: WatchActor,
    payload: Extract<WatchClientEvent, { type: "watch.control" }>["payload"],
  ): Promise<void> {
    const authorized = await authorize(actor, payload.channelId);
    if (!authorized) return;
    const session = requireControllableSession(actor, authorized);
    if (!session) return;

    // The controller's own position wins for all three actions: resuming after a
    // long pause must restart everyone where the host actually is, not where the
    // server last guessed. A seek keeps the play/pause state it found.
    const playing =
      payload.action === "play" ? true : payload.action === "pause" ? false : session.playing;
    await persistAndSyncRoom({
      ...session,
      positionSec: payload.positionSec,
      playing,
      updatedAtMs: now(),
    });
  }

  async function handleSetVideo(
    actor: WatchActor,
    payload: Extract<WatchClientEvent, { type: "watch.set_video" }>["payload"],
  ): Promise<void> {
    const authorized = await authorize(actor, payload.channelId);
    if (!authorized) return;
    const session = requireControllableSession(actor, authorized);
    if (!session) return;

    const videoId = parseYouTubeVideoId(payload.videoRef);
    if (videoId === null) {
      deny(actor, "INVALID_PAYLOAD", "That is not a YouTube video link.");
      return;
    }
    await persistAndSyncRoom({
      ...session,
      videoId,
      positionSec: 0,
      playing: true,
      updatedAtMs: now(),
    });
  }

  // -------------------------------------------------------------------------
  // Queue (M20 wave 2)
  // -------------------------------------------------------------------------

  async function handleQueueAdd(
    actor: WatchActor,
    payload: Extract<WatchClientEvent, { type: "watch.queue_add" }>["payload"],
  ): Promise<void> {
    const authorized = await authorize(actor, payload.channelId);
    if (!authorized) return;
    // A queue belongs to a party. `watch.start` stays the ONLY way a session
    // comes into existence, so there is exactly one place that decides who may
    // open one — a client with nothing running calls that first and this after.
    const session = requireControllableSession(actor, authorized);
    if (!session) return;

    // Idempotent on itemId, so a client that retries an add across a reconnect
    // gets one row rather than two. Checked BEFORE the capacity gate: a retry of
    // an item that is already queued must not be refused for being "full".
    if (session.queue.some((item) => item.itemId === payload.itemId)) return;

    if (session.queue.length >= WATCH_QUEUE_MAX_ITEMS) {
      deny(
        actor,
        "WATCH_QUEUE_FULL",
        `The queue is full (${WATCH_QUEUE_MAX_ITEMS} videos). Remove one to add another.`,
      );
      return;
    }

    // Re-normalize on the server, exactly as `watch.start` does. The schema
    // already refused an unparseable ref; this is the line that guarantees what
    // gets STORED and broadcast is the 11-character id and never a client string.
    const videoId = parseYouTubeVideoId(payload.videoRef);
    if (videoId === null) {
      deny(actor, "INVALID_PAYLOAD", "That is not a YouTube video link.");
      return;
    }

    const item: WatchQueueItem = {
      itemId: payload.itemId,
      videoId,
      addedBy: actor.userId,
      // Server-stamped: a client's clock is not evidence of when we accepted it.
      addedAt: new Date(now()).toISOString(),
      title: payload.title ?? null,
      durationSeconds: payload.durationSeconds ?? null,
    };
    const next: WatchSessionRecord = { ...session, queue: [...session.queue, item] };
    await store.save(next);
    syncQueue(next);
  }

  async function handleQueueRemove(
    actor: WatchActor,
    payload: Extract<WatchClientEvent, { type: "watch.queue_remove" }>["payload"],
  ): Promise<void> {
    const authorized = await authorize(actor, payload.channelId);
    if (!authorized) return;
    const session = requireControllableSession(actor, authorized);
    if (!session) return;

    const queue = session.queue.filter((item) => item.itemId !== payload.itemId);
    // Unknown id: already gone (played, or removed by the other controller).
    // Nothing changed, so nothing is broadcast — a no-op is not an error, and
    // re-announcing an unchanged queue would be noise on every double-click.
    if (queue.length === session.queue.length) return;

    const next: WatchSessionRecord = { ...session, queue };
    await store.save(next);
    syncQueue(next);
  }

  async function handleQueueReorder(
    actor: WatchActor,
    payload: Extract<WatchClientEvent, { type: "watch.queue_reorder" }>["payload"],
  ): Promise<void> {
    const authorized = await authorize(actor, payload.channelId);
    if (!authorized) return;
    const session = requireControllableSession(actor, authorized);
    if (!session) return;

    const queue = reorderQueue(session.queue, payload.itemIds);
    // Reconciled against server truth (see `reorderQueue`), so the result is
    // always a permutation of what we hold. If it is the SAME permutation there
    // is nothing to tell the room.
    const unchanged =
      queue.length === session.queue.length &&
      queue.every((item, i) => item.itemId === session.queue[i]?.itemId);
    if (unchanged) return;

    const next: WatchSessionRecord = { ...session, queue };
    await store.save(next);
    syncQueue(next);
  }

  /**
   * Make a queued item the current video. Used by "play this one" and by the
   * automatic advance, so both take exactly the same path: the item leaves the
   * queue, playback restarts at 0, and the room gets the new state plus the new
   * queue. Items that were skipped over stay queued — "play that one next" is not
   * "throw these away".
   */
  function playFromQueue(session: WatchSessionRecord, item: WatchQueueItem): WatchSessionRecord {
    return {
      ...session,
      videoId: item.videoId,
      positionSec: 0,
      playing: true,
      updatedAtMs: now(),
      queue: session.queue.filter((queued) => queued.itemId !== item.itemId),
    };
  }

  async function handleQueuePlay(
    actor: WatchActor,
    payload: Extract<WatchClientEvent, { type: "watch.queue_play" }>["payload"],
  ): Promise<void> {
    const authorized = await authorize(actor, payload.channelId);
    if (!authorized) return;
    const session = requireControllableSession(actor, authorized);
    if (!session) return;

    const item = session.queue.find((queued) => queued.itemId === payload.itemId);
    if (!item) {
      // The row is gone — someone else played or removed it between the click
      // and this frame. Say so plainly rather than pretending; the client's next
      // `watch.queue_updated` already re-seated it on the real list.
      deny(actor, "INVALID_PAYLOAD", "That video is no longer in the queue.");
      return;
    }
    await persistAndSyncAll(playFromQueue(session, item));
  }

  /**
   * The current video finished. The HOST'S CLIENT reports it; the SERVER decides
   * what happens next.
   *
   * That split is forced by what each side knows. The gateway never calls
   * YouTube — playback needs no API key, which is the whole reason this feature
   * is free (ADR 0016) — so it never learns a video's DURATION and cannot time an
   * ending on its own. The host's player knows the instant it happens, and the
   * host's playhead is already authoritative for every other control. Keeping the
   * CONSEQUENCE on the server is what stops "what plays next" from being
   * negotiated between clients: one queue, one advance, one fan-out.
   *
   * When the queue is empty the session STAYS, paused at the end of the last
   * video. Ending it would tear the party down while the room is still sitting
   * there deciding what to watch next, and `watch.stopped` is the signal that
   * clears the channel-wide badge — a badge that should still be showing, because
   * the party is still on. The room empties, or the host stops it; those are the
   * two honest ways this ends.
   */
  async function handleEnded(
    actor: WatchActor,
    payload: Extract<WatchClientEvent, { type: "watch.ended" }>["payload"],
  ): Promise<void> {
    const authorized = await authorize(actor, payload.channelId);
    if (!authorized) return;
    const session = requireControllableSession(actor, authorized);
    if (!session) return;

    // Idempotency, not information. A player can report ENDED more than once, and
    // a late report can land after the video was already changed by hand — either
    // would otherwise eat an extra item off the queue.
    if (session.videoId !== payload.videoId) return;

    const nextItem = session.queue[0];
    if (!nextItem) {
      // Freeze exactly where it ended: paused, same video, position left alone so
      // the projection stops advancing (a session left `playing` with nothing
      // playing would drift forever against a player that has stopped).
      if (!session.playing) return;
      await persistAndSyncRoom({
        ...session,
        positionSec: projectedPositionSec(session, now()),
        playing: false,
        updatedAtMs: now(),
      });
      return;
    }
    await persistAndSyncAll(playFromQueue(session, nextItem));
  }

  async function handleTransferHost(
    actor: WatchActor,
    payload: Extract<WatchClientEvent, { type: "watch.transfer_host" }>["payload"],
  ): Promise<void> {
    const channelId = payload.channelId;
    const authorized = await authorize(actor, channelId);
    if (!authorized) return;
    const session = requireControllableSession(actor, authorized);
    if (!session) return;

    // The target must actually be in the room — server truth again. Handing
    // control to someone who is not there would strand the session until the
    // heartbeat's self-heal, which is exactly the state this feature must avoid.
    if (!delivery.occupantIds(channelId).includes(payload.toUserId)) {
      deny(actor, "INVALID_PAYLOAD", "That member is not in this voice channel.");
      return;
    }
    if (session.hostId === payload.toUserId) return; // idempotent

    await store.save({ ...session, hostId: payload.toUserId });
    delivery.toChannel(
      channelId,
      serverEvent.watchHostChanged({ channelId, hostId: payload.toUserId }),
    );
  }

  async function handleStop(
    actor: WatchActor,
    payload: Extract<WatchClientEvent, { type: "watch.stop" }>["payload"],
  ): Promise<void> {
    const authorized = await authorize(actor, payload.channelId);
    if (!authorized) return;
    if (!requireControllableSession(actor, authorized)) return;
    await endSession(payload.channelId, "host_stopped");
  }

  /**
   * Move the host on when the current one is gone, or end the session when the
   * room emptied. Shared by the leave path and the heartbeat's self-heal, so the
   * two can never disagree about who takes over.
   */
  async function reconcileHost(
    channelId: ChannelId,
    session: WatchSessionRecord,
  ): Promise<WatchSessionRecord | null> {
    const occupants = delivery.occupantIds(channelId);
    if (occupants.length === 0) {
      await endSession(channelId, "channel_empty");
      return null;
    }
    if (occupants.includes(session.hostId as UserId)) return session;

    // Longest-present occupant takes over (the index is in join order), so the
    // handoff is deterministic and lands on someone who has actually been
    // watching. `positionSec`/`updatedAtMs` are untouched — the projection stays
    // correct, so a handoff never nudges anyone's playhead.
    const nextHost = occupants[0] as UserId;
    const handed: WatchSessionRecord = { ...session, hostId: nextHost };
    await store.save(handed);
    delivery.toChannel(channelId, serverEvent.watchHostChanged({ channelId, hostId: nextHost }));
    return handed;
  }

  async function onVoiceLeft(channelId: ChannelId, userId: UserId): Promise<void> {
    const session = await store.get(channelId);
    if (!session) return;
    // Only the host leaving (or the room emptying) changes anything; an ordinary
    // viewer walking out costs one cheap read.
    if (session.hostId !== userId && delivery.occupantIds(channelId).length > 0) return;
    await reconcileHost(channelId, session);
  }

  async function onVoiceJoined(actor: WatchActor): Promise<void> {
    const channelId = actor.voiceChannelId;
    if (!channelId) return;
    const session = await store.get(channelId);
    if (!session) return;
    actor.send(serverEvent.watchState(watchStatePayload(session, now())));
    // Joining the room is the ONE moment a socket is handed the queue without
    // asking, because it is the moment it becomes part of the audience for it.
    // A reconnecting client gets here the same way — it re-sends `voice.join`
    // — so there is no separate "give me the queue" request to keep in sync.
    if (session.queue.length > 0) {
      actor.send(
        serverEvent.watchQueueUpdated({
          channelId,
          queue: session.queue,
        }),
      );
    }
  }

  async function onConnectionReady(
    actor: WatchActor,
    visibleVoiceChannelIds: Iterable<ChannelId>,
  ): Promise<void> {
    const visible = new Set(visibleVoiceChannelIds);
    if (visible.size === 0) return;
    // One cheap index read; almost always empty, in which case a handshake pays
    // a single Redis call and nothing else (§27).
    const active = await store.activeChannelIds();
    for (const channelId of active) {
      if (!visible.has(channelId as ChannelId)) continue;
      const session = await store.get(channelId);
      if (!session) continue;
      actor.send(serverEvent.watchStarted(watchStatePayload(session, now())));
    }
  }

  async function handle(actor: WatchActor, event: WatchClientEvent): Promise<void> {
    switch (event.type) {
      case "watch.start":
        await handleStart(actor, event.payload);
        return;
      case "watch.control":
        await handleControl(actor, event.payload);
        return;
      case "watch.set_video":
        await handleSetVideo(actor, event.payload);
        return;
      case "watch.transfer_host":
        await handleTransferHost(actor, event.payload);
        return;
      case "watch.stop":
        await handleStop(actor, event.payload);
        return;
      case "watch.queue_add":
        await handleQueueAdd(actor, event.payload);
        return;
      case "watch.queue_remove":
        await handleQueueRemove(actor, event.payload);
        return;
      case "watch.queue_reorder":
        await handleQueueReorder(actor, event.payload);
        return;
      case "watch.queue_play":
        await handleQueuePlay(actor, event.payload);
        return;
      case "watch.ended":
        await handleEnded(actor, event.payload);
        return;
      default: {
        const _exhaustive: never = event;
        void _exhaustive;
      }
    }
  }

  /**
   * Drift correction (ADR 0016). Ads play per-viewer and no two players tick
   * identically, so the server periodically re-states the authoritative position
   * to the room and clients that have drifted past the tolerance seek back.
   *
   * The same tick is the feature's self-heal: it ends a session whose room has
   * emptied and re-hosts one whose host vanished, so a lost `onVoiceLeft` (a
   * crash between the two) costs one interval rather than a stuck party.
   */
  const heartbeat = setInterval(() => {
    void (async () => {
      const active = await store.activeChannelIds();
      for (const channelId of active) {
        const session = await store.get(channelId);
        if (!session) continue;
        const live = await reconcileHost(channelId as ChannelId, session);
        if (!live) continue;
        delivery.toOccupants(
          channelId as ChannelId,
          serverEvent.watchState(watchStatePayload(live, now())),
        );
      }
    })().catch((err: unknown) =>
      log(`watch heartbeat failed: ${err instanceof Error ? err.message : String(err)}`),
    );
  }, deps.heartbeatIntervalMs ?? WATCH_HEARTBEAT_MS);
  // Never hold the process open for a playback tick.
  heartbeat.unref?.();

  return {
    handle,
    onVoiceJoined,
    onVoiceLeft,
    onConnectionReady,
    stop(): void {
      clearInterval(heartbeat);
    },
  };
}
