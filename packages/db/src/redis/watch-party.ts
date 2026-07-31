import { WATCH_QUEUE_MAX_ITEMS } from "@demli/config";
import type { WatchQueueItem, WatchSource } from "@demli/protocol";
import type { RedisClient } from "./client.js";

/**
 * Watch-party session state (M20, ADR 0016).
 *
 * Lives in @demli/db beside the slowmode store and the mutation bus because
 * it is Redis plumbing, not schema: a watch party is EPHEMERAL by decision —
 * one live session per voice channel, TTL'd, **no table and no migration in the
 * MVP**. A session that survives a restart of the room it belongs to is not a
 * feature; the room is what gives it meaning.
 *
 *   watch:session:<channelId> = <json>   (EX WATCH_SESSION_TTL_SECONDS)
 *   watch:active              = SET of channelIds with a live session
 *
 * The SET exists so the drift heartbeat can enumerate live sessions without
 * scanning the keyspace. It is pruned lazily by {@link WatchPartyStore.activeChannelIds}:
 * a member whose session key has expired (or was dropped by a crash between the
 * two writes) is removed on the next read, so the index self-heals instead of
 * accumulating ghosts.
 *
 * Authority is NOT here. This store answers "what is the session", never "may
 * this user change it" — the host/owner/occupancy/timeout gates live at the
 * gateway boundary (`apps/realtime/src/watch-party.ts`), which is the only
 * writer.
 */

/**
 * The stored session. Positions are kept as "`positionSec` as of
 * `updatedAtMs`", never as a live value: a record read 30 s after the last
 * control must still yield the right position, so the projection to "now"
 * happens at read time in the gateway rather than being written every tick.
 */
export interface WatchSessionRecord {
  channelId: string;
  /** The member who currently controls playback. */
  hostId: string;
  source: WatchSource;
  /** ALWAYS a normalized 11-character YouTube id (never a client's raw ref). */
  videoId: string;
  /** Playback position at `updatedAtMs`, in seconds. */
  positionSec: number;
  playing: boolean;
  /** Epoch ms of the control that set `positionSec`/`playing`. */
  updatedAtMs: number;
  /** Epoch ms the session began (survives a video change). */
  startedAtMs: number;
  /**
   * What plays next, in order (M20 wave 2). Stored INSIDE the session — same
   * key, same TTL — because a queue whose party has ended is a list of videos
   * belonging to nobody. Capped at `WATCH_QUEUE_MAX_ITEMS` by the gateway, and
   * re-capped on read here so a hand-edited or pre-cap record cannot make the
   * process hold more than the contract allows.
   */
  queue: WatchQueueItem[];
}

export interface WatchPartyStore {
  /** The live session for a voice channel, or null when none is running. */
  get(channelId: string): Promise<WatchSessionRecord | null>;
  /** Create or replace the session and (re)arm its TTL. */
  save(session: WatchSessionRecord): Promise<void>;
  /** End the session and drop it from the active index. */
  delete(channelId: string): Promise<void>;
  /** Channels with a live session, pruning index entries whose record is gone. */
  activeChannelIds(): Promise<string[]>;
}

/**
 * Guard one queue row read back from Redis. A row that is not exactly the shape
 * the contract promises is DROPPED rather than repaired — this list is
 * broadcast verbatim to every occupant, so a half-valid row would be a payload
 * the protocol schema itself would reject.
 */
function parseQueueItem(value: unknown): WatchQueueItem | null {
  if (typeof value !== "object" || value === null) return null;
  const item = value as Partial<WatchQueueItem>;
  if (
    typeof item.itemId !== "string" ||
    typeof item.videoId !== "string" ||
    typeof item.addedBy !== "string" ||
    typeof item.addedAt !== "string"
  ) {
    return null;
  }
  const title = typeof item.title === "string" ? item.title : null;
  const durationSeconds =
    typeof item.durationSeconds === "number" && Number.isFinite(item.durationSeconds)
      ? item.durationSeconds
      : null;
  return {
    itemId: item.itemId,
    videoId: item.videoId,
    addedBy: item.addedBy,
    addedAt: item.addedAt,
    title,
    durationSeconds,
  };
}

/** Guard a JSON blob read back from Redis; a malformed record reads as "none". */
function parseRecord(raw: string | null): WatchSessionRecord | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<WatchSessionRecord>;
  if (
    typeof record.channelId !== "string" ||
    typeof record.hostId !== "string" ||
    record.source !== "youtube" ||
    typeof record.videoId !== "string" ||
    typeof record.positionSec !== "number" ||
    !Number.isFinite(record.positionSec) ||
    typeof record.playing !== "boolean" ||
    typeof record.updatedAtMs !== "number" ||
    typeof record.startedAtMs !== "number"
  ) {
    return null;
  }
  // `queue` is deliberately NOT part of the validity test above. Sessions written
  // by the pre-queue gateway are live in production RIGHT NOW and have no such
  // field; treating that as a malformed record would silently end every watch
  // party in progress at the moment this deploy lands. A missing (or damaged)
  // queue reads as an empty one, which is exactly what those sessions have.
  const queue = Array.isArray(record.queue)
    ? record.queue
        .map(parseQueueItem)
        .filter((item): item is WatchQueueItem => item !== null)
        .slice(0, WATCH_QUEUE_MAX_ITEMS)
    : [];
  return { ...(record as WatchSessionRecord), queue };
}

/** Redis-backed store (production). */
export class RedisWatchPartyStore implements WatchPartyStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly ttlSeconds: number,
    private readonly prefix = "watch",
  ) {}

  private sessionKey(channelId: string): string {
    return `${this.prefix}:session:${channelId}`;
  }

  private get activeKey(): string {
    return `${this.prefix}:active`;
  }

  async get(channelId: string): Promise<WatchSessionRecord | null> {
    return parseRecord(await this.redis.get(this.sessionKey(channelId)));
  }

  async save(session: WatchSessionRecord): Promise<void> {
    await this.redis
      .multi()
      .set(this.sessionKey(session.channelId), JSON.stringify(session), "EX", this.ttlSeconds)
      .sadd(this.activeKey, session.channelId)
      .exec();
  }

  async delete(channelId: string): Promise<void> {
    await this.redis
      .multi()
      .del(this.sessionKey(channelId))
      .srem(this.activeKey, channelId)
      .exec();
  }

  async activeChannelIds(): Promise<string[]> {
    const members = await this.redis.smembers(this.activeKey);
    if (members.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const channelId of members) pipeline.exists(this.sessionKey(channelId));
    const results = await pipeline.exec();

    const live: string[] = [];
    const stale: string[] = [];
    members.forEach((channelId, i) => {
      if (Number(results?.[i]?.[1] ?? 0) > 0) live.push(channelId);
      else stale.push(channelId);
    });
    // Expired records leave their index entry behind; drop it now so the set
    // cannot grow without bound across restarts.
    if (stale.length > 0) await this.redis.srem(this.activeKey, ...stale);
    return live;
  }
}

/**
 * Single-process fallback — the gateway default and what the integration suites
 * run against, mirroring `InMemorySlowmodeStore`. TTL is not simulated: the TTL
 * is a crash backstop, and every test path ends its session explicitly.
 */
export class InMemoryWatchPartyStore implements WatchPartyStore {
  private readonly sessions = new Map<string, WatchSessionRecord>();

  async get(channelId: string): Promise<WatchSessionRecord | null> {
    const session = this.sessions.get(channelId);
    // Copy the queue on the way out as well as in. The Redis store hands back a
    // freshly parsed array every time, so a caller that sorts or splices what it
    // was given is harmless there; without this copy the in-memory store would
    // let the same code mutate the "stored" session in place and the two backends
    // would disagree only under test.
    return session ? { ...session, queue: [...session.queue] } : null;
  }

  async save(session: WatchSessionRecord): Promise<void> {
    this.sessions.set(session.channelId, { ...session, queue: [...session.queue] });
  }

  async delete(channelId: string): Promise<void> {
    this.sessions.delete(channelId);
  }

  async activeChannelIds(): Promise<string[]> {
    return [...this.sessions.keys()];
  }
}
