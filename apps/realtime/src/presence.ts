import type { RedisClient } from "@demli/db";
import type { AppLifecycleState, PresencePayload } from "@demli/protocol";
import { derivePresenceStatus } from "@demli/types";
import type { PresencePlatform, PresenceStatus, UserId } from "@demli/types";

/**
 * Presence tracking behind a small interface.
 *
 * The interface is async because the production implementation lives in Redis
 * (shared across processes). Each connection is identified by an opaque
 * `connectionId` so presence is a set of live sockets per user — correct even
 * with multiple gateway instances or repeated connect/disconnect.
 *
 * EVERY per-user fact here is derived from the LIVE CONNECTIONS (ADR 0020):
 * status, platform and app state are all per-connection hashes that mirror the
 * conns SET, so nothing can outlive the socket that reported it. The pre-ADR-0020
 * model kept ONE status string per user, which is how a desktop that auto-flipped
 * to "idle" and then closed left the user reading "idle" to everyone while they
 * were active on their phone (founder, 2026-07-28).
 *
 * - InMemoryPresenceStore — the test/default fallback (single process).
 * - RedisPresenceStore     — production; state is shared across processes.
 */
export interface PresenceStore {
  /**
   * Register a connection. Resolves true when the user just came online.
   * `platform` (optional) records the client kind of THIS connection so
   * {@link getPlatform} can report the user's dominant platform; a connection
   * without it contributes no platform (fully backward compatible).
   */
  connect(userId: UserId, connectionId: string, platform?: PresencePlatform): Promise<boolean>;
  /** Unregister a connection. Resolves true when the user just went offline. */
  disconnect(userId: UserId, connectionId: string): Promise<boolean>;
  /**
   * Record the status THIS connection declares (`presence.update`). Per-connection
   * (ADR 0020): the frame means "this device's status", and the account's status is
   * derived from every live connection by {@link derivePresenceStatus} — any
   * `invisible` or `dnd` wins, else any `online` wins, else `idle`. A no-op for an
   * unknown connection id (a frame that arrives after the socket closed cannot
   * resurrect a ghost status) and for `offline`, which is derived from having no
   * connections and is never settable — it resets this connection to `online`.
   */
  setStatus(userId: UserId, connectionId: string, status: PresenceStatus): Promise<void>;
  /** The account's status, derived from every live connection. */
  getStatus(userId: UserId): Promise<PresenceStatus>;
  /**
   * Record THIS connection's app lifecycle state (#110) — foreground/background
   * — so the push gate (RedisPresenceReader.filterAway, read by both the API and
   * this gateway) can suppress an OS push while any live connection is foreground
   * and send one when every connection is offline or backgrounded (WhatsApp
   * model). Per-connection: keyed by `connectionId`, so a user with a foreground
   * desktop and a backgrounded phone is still "reachable". A no-op for an unknown
   * connection id (a frame that arrives after the socket closed cannot resurrect
   * a ghost state).
   */
  setAppState(userId: UserId, connectionId: string, state: AppLifecycleState): Promise<void>;
  /**
   * The user's dominant client kind across all live connections, or undefined
   * when no connection reported one (or the user is offline). Priority: any
   * desktop connection ⇒ "desktop"; else any mobile connection ⇒ "mobile"
   * — desktop dominates, so the UI shows the phone indicator only for a
   * mobile-ONLY presence. See task #47 report for the rationale.
   */
  getPlatform(userId: UserId): Promise<PresencePlatform | undefined>;
  /** Presence snapshot for a set of users (offline users included). */
  snapshot(userIds: Iterable<UserId>): Promise<PresencePayload[]>;
  /** Optional cleanup of this instance's own presence entries on shutdown. */
  close?(): Promise<void>;
}

/**
 * The status a freshly-registered connection declares until its client sends a
 * `presence.update`. "online" keeps a client that never sends one behaving as it
 * always has (available), and — because {@link derivePresenceStatus} ranks
 * `invisible`/`dnd` above it — a new socket can never unmask a user who is
 * invisible or dnd on another live device.
 */
const DEFAULT_CONNECTION_STATUS = "online";

/**
 * Reduce a bag of per-connection platform values to the user's dominant one.
 * Desktop wins over mobile; anything unrecognized (or an empty bag) yields
 * undefined. Shared by both store implementations so the rule lives in one place.
 */
function dominantPlatform(values: Iterable<string | null | undefined>): PresencePlatform | undefined {
  let hasMobile = false;
  for (const value of values) {
    if (value === "desktop") return "desktop";
    if (value === "mobile") hasMobile = true;
  }
  return hasMobile ? "mobile" : undefined;
}

/** Attach `platform` to a presence payload only when it is defined (keeps the
 * wire/object minimal and unchanged for platform-less users). */
function withPlatform(
  base: { userId: UserId; status: PresenceStatus },
  platform: PresencePlatform | undefined,
): PresencePayload {
  return platform ? { ...base, platform } : base;
}

export class InMemoryPresenceStore implements PresenceStore {
  private readonly connections = new Map<UserId, Set<string>>();
  /**
   * Per-user map of connectionId → the status THAT connection declared (ADR 0020).
   * Seeded {@link DEFAULT_CONNECTION_STATUS} on connect so it mirrors the
   * connections set exactly — the single-process analogue of the Redis
   * `connstatus` hash.
   */
  private readonly statuses = new Map<UserId, Map<string, PresenceStatus>>();
  /** Per-user map of connectionId → the platform that connection reported. */
  private readonly platforms = new Map<UserId, Map<string, PresencePlatform>>();
  /**
   * Per-user map of connectionId → its app lifecycle state (#110). Every live
   * connection has an entry (seeded "foreground" on connect), so this mirrors the
   * connections set exactly and is the single-process analogue of the Redis
   * `appstate` hash the reader consults.
   */
  private readonly appStates = new Map<UserId, Map<string, AppLifecycleState>>();

  async connect(
    userId: UserId,
    connectionId: string,
    platform?: PresencePlatform,
  ): Promise<boolean> {
    let set = this.connections.get(userId);
    const cameOnline = !set || set.size === 0;
    if (!set) {
      set = new Set();
      this.connections.set(userId, set);
    }
    set.add(connectionId);
    // Seed this connection's declared status so the map mirrors the conns set;
    // the client overwrites it with its own `presence.update` right after auth.
    let byStatus = this.statuses.get(userId);
    if (!byStatus) {
      byStatus = new Map();
      this.statuses.set(userId, byStatus);
    }
    byStatus.set(connectionId, DEFAULT_CONNECTION_STATUS);
    if (platform) {
      let byConn = this.platforms.get(userId);
      if (!byConn) {
        byConn = new Map();
        this.platforms.set(userId, byConn);
      }
      byConn.set(connectionId, platform);
    }
    // Seed foreground so a connection that never reports app state behaves as
    // before (its user stays "reachable" ⇒ no push while connected).
    let states = this.appStates.get(userId);
    if (!states) {
      states = new Map();
      this.appStates.set(userId, states);
    }
    states.set(connectionId, "foreground");
    return cameOnline;
  }

  async disconnect(userId: UserId, connectionId: string): Promise<boolean> {
    const set = this.connections.get(userId);
    if (!set || !set.delete(connectionId)) return false;
    // This connection's status dies with it (ADR 0020) — the same per-connection
    // cleanup platform/appstate already did. A device that went idle and then away
    // must stop speaking for the user the moment its socket is gone.
    const byStatus = this.statuses.get(userId);
    if (byStatus) {
      byStatus.delete(connectionId);
      if (byStatus.size === 0) this.statuses.delete(userId);
    }
    const byConn = this.platforms.get(userId);
    if (byConn) {
      byConn.delete(connectionId);
      if (byConn.size === 0) this.platforms.delete(userId);
    }
    const states = this.appStates.get(userId);
    if (states) {
      states.delete(connectionId);
      if (states.size === 0) this.appStates.delete(userId);
    }
    if (set.size === 0) {
      this.connections.delete(userId);
      this.statuses.delete(userId);
      this.platforms.delete(userId);
      this.appStates.delete(userId);
      return true;
    }
    return false;
  }

  async setAppState(
    userId: UserId,
    connectionId: string,
    state: AppLifecycleState,
  ): Promise<void> {
    // Only record for a live connection — a frame arriving after close must not
    // resurrect a ghost state (mirrors the Redis store's `sismember` guard).
    if (!this.connections.get(userId)?.has(connectionId)) return;
    let states = this.appStates.get(userId);
    if (!states) {
      states = new Map();
      this.appStates.set(userId, states);
    }
    states.set(connectionId, state);
  }

  async getPlatform(userId: UserId): Promise<PresencePlatform | undefined> {
    if (!this.connections.has(userId)) return undefined;
    return dominantPlatform(this.platforms.get(userId)?.values() ?? []);
  }

  async setStatus(
    userId: UserId,
    connectionId: string,
    status: PresenceStatus,
  ): Promise<void> {
    // Only record for a live connection — mirrors setAppState's guard so a frame
    // that races the socket close cannot leave a status behind with no socket.
    if (!this.connections.get(userId)?.has(connectionId)) return;
    // "offline" is derived from having no connections, never settable: reset this
    // connection to the default instead of recording an impossible declaration.
    const declared = status === "offline" ? DEFAULT_CONNECTION_STATUS : status;
    let byStatus = this.statuses.get(userId);
    if (!byStatus) {
      byStatus = new Map();
      this.statuses.set(userId, byStatus);
    }
    byStatus.set(connectionId, declared);
  }

  async getStatus(userId: UserId): Promise<PresenceStatus> {
    if (!this.connections.has(userId)) return "offline";
    return derivePresenceStatus(this.statuses.get(userId)?.values() ?? []);
  }

  async snapshot(userIds: Iterable<UserId>): Promise<PresencePayload[]> {
    const result: PresencePayload[] = [];
    for (const userId of userIds) {
      const status = await this.getStatus(userId);
      const platform = status === "offline" ? undefined : await this.getPlatform(userId);
      result.push(withPlatform({ userId, status }, platform));
    }
    return result;
  }
}

/**
 * Redis-backed presence: state is shared across processes so any gateway
 * instance (or the API) sees a consistent online set.
 *
 * - `presence:conns:{userId}` — SET of live connectionIds (online = non-empty).
 * - `presence:connstatus:{userId}` — HASH connectionId → the status THAT connection
 *   declared (ADR 0020); mirrors the conns SET (seeded "online" on connect). The
 *   account's status is `derivePresenceStatus` over the values.
 * - `presence:platform:{userId}` — HASH connectionId → platform ("desktop"/
 *   "mobile"); the dominant value (desktop wins) is the user's reported platform.
 * - `presence:appstate:{userId}` — HASH connectionId → app lifecycle state
 *   ("foreground"/"background", #110); mirrors the conns SET (seeded "foreground"
 *   on connect). The push reader treats the user as "away" — and pushes — only
 *   when NO field is "foreground" (offline or every connection backgrounded).
 *
 * The passed-in client is owned by the caller (not quit here). `close()` removes
 * only this instance's own connection ids, so a graceful shutdown does not leave
 * users falsely "online".
 *
 * LEGACY KEY: pre-ADR-0020 deployments wrote a per-USER `presence:status:{userId}`
 * STRING. This store no longer reads or writes it, and the deliberately DIFFERENT
 * key name means a leftover string can never collide with the new HASH (no
 * WRONGTYPE, even if an old and a new process briefly overlap). `resetAll()` runs
 * at gateway startup and its `presence:*` scan deletes those leftovers, so the
 * old keys are gone the moment this code boots.
 */
export class RedisPresenceStore implements PresenceStore {
  private readonly owned = new Set<string>();

  constructor(
    private readonly redis: RedisClient,
    private readonly prefix = "presence",
  ) {}

  private connKey(userId: UserId): string {
    return `${this.prefix}:conns:${userId}`;
  }

  /**
   * Per-connection declared statuses (ADR 0020). Deliberately NOT the old
   * `:status:` name — that key is a STRING in live Redis right now, and reusing
   * the name for a HASH would make every read fail with WRONGTYPE until the
   * startup wipe landed.
   */
  private connstatusKey(userId: UserId): string {
    return `${this.prefix}:connstatus:${userId}`;
  }

  private platformKey(userId: UserId): string {
    return `${this.prefix}:platform:${userId}`;
  }

  private appstateKey(userId: UserId): string {
    return `${this.prefix}:appstate:${userId}`;
  }

  private ownedKey(userId: UserId, connectionId: string): string {
    return `${userId} ${connectionId}`;
  }

  async connect(
    userId: UserId,
    connectionId: string,
    platform?: PresencePlatform,
  ): Promise<boolean> {
    const key = this.connKey(userId);
    const multi = this.redis.multi().sadd(key, connectionId).scard(key);
    // Record this connection's platform (kept per-connection so the dominant one
    // is re-derived as sockets come and go). Appended last so the sadd/scard
    // result indices below are unaffected when platform is absent.
    if (platform) multi.hset(this.platformKey(userId), connectionId, platform);
    // Seed this connection's declared status (ADR 0020) so the hash mirrors the
    // conns SET; the client overwrites it with its own `presence.update` right
    // after auth. Appended last, like the other per-connection writes.
    multi.hset(this.connstatusKey(userId), connectionId, DEFAULT_CONNECTION_STATUS);
    // Seed this connection's app state "foreground" (#110) so the hash mirrors
    // the conns SET and a client that never reports app state stays "reachable"
    // (no push while connected) — pre-#110 behavior. Also appended last.
    multi.hset(this.appstateKey(userId), connectionId, "foreground");
    const results = await multi.exec();
    const added = Number(results?.[0]?.[1] ?? 0);
    const size = Number(results?.[1]?.[1] ?? 0);
    this.owned.add(this.ownedKey(userId, connectionId));
    // Came online only when this add created the first live connection.
    return added === 1 && size === 1;
  }

  async disconnect(userId: UserId, connectionId: string): Promise<boolean> {
    const key = this.connKey(userId);
    const results = await this.redis
      .multi()
      .srem(key, connectionId)
      .scard(key)
      // This connection's declared status dies with it (ADR 0020) — the whole
      // point of the per-connection model: an idle desktop that goes away stops
      // dragging the account to "idle" while the phone is still active.
      .hdel(this.connstatusKey(userId), connectionId)
      .hdel(this.platformKey(userId), connectionId)
      .hdel(this.appstateKey(userId), connectionId)
      .exec();
    const removed = Number(results?.[0]?.[1] ?? 0);
    const size = Number(results?.[1]?.[1] ?? 0);
    this.owned.delete(this.ownedKey(userId, connectionId));
    if (removed === 1 && size === 0) {
      await this.redis.del(
        this.connstatusKey(userId),
        this.platformKey(userId),
        this.appstateKey(userId),
      );
      return true;
    }
    return false;
  }

  async setAppState(
    userId: UserId,
    connectionId: string,
    state: AppLifecycleState,
  ): Promise<void> {
    // Guard on live membership so a frame arriving after the socket closed (the
    // conn was already sremmed + hdeled) cannot resurrect a ghost hash field that
    // would linger with no TTL. The gateway only calls this for an open socket,
    // so the guard passes on the hot path.
    const isMember = await this.redis.sismember(this.connKey(userId), connectionId);
    if (isMember === 0) return;
    await this.redis.hset(this.appstateKey(userId), connectionId, state);
  }

  async getPlatform(userId: UserId): Promise<PresencePlatform | undefined> {
    const [card, platforms] = await Promise.all([
      this.redis.scard(this.connKey(userId)),
      this.redis.hvals(this.platformKey(userId)),
    ]);
    if (card === 0) return undefined;
    return dominantPlatform(platforms);
  }

  async setStatus(
    userId: UserId,
    connectionId: string,
    status: PresenceStatus,
  ): Promise<void> {
    // Guard on live membership (same reason as setAppState): a frame that races
    // the socket close must not write a hash field with no socket behind it, which
    // — with no TTL on these keys — is exactly the ghost class ADR 0020 removes.
    const isMember = await this.redis.sismember(this.connKey(userId), connectionId);
    if (isMember === 0) return;
    // "offline" is derived from having no connections, never settable: reset this
    // connection to the default instead of recording an impossible declaration.
    const declared = status === "offline" ? DEFAULT_CONNECTION_STATUS : status;
    await this.redis.hset(this.connstatusKey(userId), connectionId, declared);
  }

  async getStatus(userId: UserId): Promise<PresenceStatus> {
    const [card, declared] = await Promise.all([
      this.redis.scard(this.connKey(userId)),
      this.redis.hvals(this.connstatusKey(userId)),
    ]);
    if (card === 0) return "offline";
    return derivePresenceStatus(declared);
  }

  async snapshot(userIds: Iterable<UserId>): Promise<PresencePayload[]> {
    const ids = [...userIds];
    if (ids.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const userId of ids) {
      pipeline.scard(this.connKey(userId));
      pipeline.hvals(this.connstatusKey(userId));
      pipeline.hvals(this.platformKey(userId));
    }
    const results = await pipeline.exec();
    return ids.map((userId, i) => {
      const card = Number(results?.[i * 3]?.[1] ?? 0);
      const declared = (results?.[i * 3 + 1]?.[1] as string[] | null) ?? [];
      const platforms = (results?.[i * 3 + 2]?.[1] as string[] | null) ?? [];
      if (card === 0) return { userId, status: "offline" };
      return withPlatform(
        { userId, status: derivePresenceStatus(declared) },
        dominantPlatform(platforms),
      );
    });
  }

  /**
   * Wipe EVERY presence key (conns/connstatus/platform/appstate, all users —
   * including the pre-ADR-0020 `:status:` STRINGS still in production Redis at the
   * moment this version deploys). Called once at
   * gateway STARTUP: this deployment runs a single gateway instance, so a fresh
   * process means every previously-recorded socket is dead by definition — any
   * state still in Redis is a ghost. A hard-killed predecessor (docker stop
   * timeout on deploy, crash) never runs close(), and the conn SETs carry no
   * TTL, so such ghosts otherwise show a user "online" forever (founder's
   * stale-presence report: yesterday's logged-out phone still online today).
   * Startup is the one moment a full wipe is safe: no live sockets exist yet,
   * and every real connection re-registers itself right after.
   */
  async resetAll(): Promise<void> {
    let cursor = "0";
    do {
      const [next, keys] = await this.redis.scan(
        cursor,
        "MATCH",
        `${this.prefix}:*`,
        "COUNT",
        200,
      );
      if (keys.length > 0) await this.redis.del(...keys);
      cursor = next;
    } while (cursor !== "0");
  }

  /** Drop this instance's own connection ids so shutdown clears its presence. */
  async close(): Promise<void> {
    if (this.owned.size === 0) return;
    const pipeline = this.redis.pipeline();
    for (const entry of this.owned) {
      const sep = entry.indexOf(" ");
      const userId = entry.slice(0, sep);
      const connectionId = entry.slice(sep + 1);
      pipeline.srem(this.connKey(userId), connectionId);
      // Drop only THIS connection's fields — status included since ADR 0020. The
      // pre-ADR version `del`'d the whole per-user status key here, so one
      // instance shutting down wiped the status of connections it did not own.
      pipeline.hdel(this.connstatusKey(userId), connectionId);
      pipeline.hdel(this.platformKey(userId), connectionId);
      pipeline.hdel(this.appstateKey(userId), connectionId);
    }
    this.owned.clear();
    await pipeline.exec();
  }
}
