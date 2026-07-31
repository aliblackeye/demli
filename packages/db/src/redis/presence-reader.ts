import { derivePresenceStatus, publicPresenceStatus, type UserId } from "@demli/types";
import type { RedisClient } from "./client.js";

/**
 * READ-ONLY presence lookup for the API (task #46 — offline push).
 *
 * The realtime gateway's `RedisPresenceStore` (apps/realtime/src/presence.ts) is
 * the sole WRITER of presence state; it stores a user's live socket ids as
 *   `presence:conns:{userId}`      — a Redis SET (online ⇔ non-empty),
 *   `presence:appstate:{userId}`   — a Redis HASH connectionId → "foreground"/
 *                                    "background" (#110), mirroring the conns SET,
 *   `presence:connstatus:{userId}` — a Redis HASH connectionId → the status THAT
 *                                    connection declared (ADR 0020), also
 *                                    mirroring the conns SET.
 * The push gate reads these here rather than importing the gateway.
 *
 * The key conventions below MUST stay in lock-step with that store's `connKey` /
 * `appstateKey` / `connstatusKey`. Both default to the `"presence"` prefix. If the
 * gateway ever prefixes its store, pass the same prefix here. A shared key-builder constant
 * would remove the duplication; that refactor spans apps/realtime and is tracked
 * as a follow-up in .claude/reports/fcm-backend.md.
 */

/** Default key prefix — matches `RedisPresenceStore`'s constructor default. */
export const PRESENCE_KEY_PREFIX = "presence";

/**
 * The one app-lifecycle value that means "actively listening" (#110). MUST match
 * the `"foreground"` literal the gateway's `RedisPresenceStore` writes and the
 * protocol `AppLifecycleState`. A user with ANY foreground connection is
 * reachable in-app (they get an in-app banner), so a push is suppressed; the
 * apps/realtime presence round-trip test pins that the writer and this reader
 * agree on the literal.
 */
const APP_STATE_FOREGROUND = "foreground";

export interface PresenceReader {
  /** True when the user has at least one live gateway (WS) connection. */
  isOnline(userId: UserId): Promise<boolean>;
  /**
   * The subset of `userIds` that are currently OFFLINE (no live connection) —
   * the strict "no socket at all" audience. Order is not guaranteed; duplicates
   * in the input are preserved (callers dedupe upstream). Retained as a primitive
   * (presence display, tests); the push gate uses {@link filterAway} instead.
   */
  filterOffline(userIds: readonly UserId[]): Promise<UserId[]>;
  /**
   * The subset of `userIds` that are "AWAY" for push purposes (#110) — the
   * WhatsApp model: a user is away when NONE of their live connections is
   * foreground, i.e. they are offline OR every live connection is backgrounded.
   * This is the audience a message/mention/friend-request OS push should target:
   * a user with ≥1 foreground connection is actively listening (they get an
   * in-app banner) and is excluded, while a backgrounded-but-connected phone —
   * the exact gap behind "desktop→phone message, no notification" — is INCLUDED.
   *
   * A superset of {@link filterOffline}: every offline user is away; away also
   * adds the all-backgrounded users. Order is not guaranteed; duplicates in the
   * input are preserved (callers dedupe upstream).
   */
  filterAway(userIds: readonly UserId[]): Promise<UserId[]>;
}

/**
 * PUBLIC online counting (invite preview card). Kept as a SEPARATE interface —
 * not a new `PresenceReader` member — so existing structural fakes keep
 * compiling; both readers below implement it.
 */
export interface PublicOnlineCounter {
  /**
   * How many of `userIds` are PUBLICLY online: at least one live connection AND
   * not masked by `invisible` (the {@link publicPresenceStatus} rule — a user
   * who appears offline to peers is not counted). Duplicates in the input are
   * counted twice; callers pass a de-duplicated member list.
   */
  countPublicOnline(userIds: readonly UserId[]): Promise<number>;
}

/** Production reader over the shared Redis presence keys. */
export class RedisPresenceReader implements PresenceReader, PublicOnlineCounter {
  constructor(
    private readonly redis: RedisClient,
    private readonly prefix = PRESENCE_KEY_PREFIX,
  ) {}

  private connKey(userId: UserId): string {
    return `${this.prefix}:conns:${userId}`;
  }

  private appstateKey(userId: UserId): string {
    return `${this.prefix}:appstate:${userId}`;
  }

  /**
   * Matches `RedisPresenceStore.connstatusKey` — the HASH of connectionId → the
   * status THAT connection declared (ADR 0020). The account's status is
   * {@link derivePresenceStatus} over its values, the same reduction the gateway
   * applies, so the invite card and the presence dot can never disagree. Replaced
   * the pre-ADR per-USER `:status:` STRING; the name differs deliberately so a
   * leftover legacy key cannot WRONGTYPE this read.
   */
  private connstatusKey(userId: UserId): string {
    return `${this.prefix}:connstatus:${userId}`;
  }

  async isOnline(userId: UserId): Promise<boolean> {
    return (await this.redis.scard(this.connKey(userId))) > 0;
  }

  async countPublicOnline(userIds: readonly UserId[]): Promise<number> {
    if (userIds.length === 0) return 0;
    // Two reads per user (pipelined): the conns SET decides connected-at-all; the
    // per-connection status HASH decides whether that user is publicly VISIBLE —
    // `invisible` masks to offline for peers (publicPresenceStatus), so an
    // invisible member must not inflate the invite card's online count. Deriving
    // over ALL live connections is what keeps `invisible` sticky here: it is the
    // top-priority declaration, so a second, plain-"online" device cannot silently
    // add a hidden user back to the count.
    const pipeline = this.redis.pipeline();
    for (const userId of userIds) {
      pipeline.scard(this.connKey(userId));
      pipeline.hvals(this.connstatusKey(userId));
    }
    const results = await pipeline.exec();
    let count = 0;
    userIds.forEach((_, i) => {
      const card = Number(results?.[i * 2]?.[1] ?? 0);
      const declared = (results?.[i * 2 + 1]?.[1] as string[] | null) ?? [];
      if (card === 0) return;
      if (publicPresenceStatus(derivePresenceStatus(declared)) !== "offline") count += 1;
    });
    return count;
  }

  async filterOffline(userIds: readonly UserId[]): Promise<UserId[]> {
    if (userIds.length === 0) return [];
    const pipeline = this.redis.pipeline();
    for (const userId of userIds) pipeline.scard(this.connKey(userId));
    const results = await pipeline.exec();
    const offline: UserId[] = [];
    userIds.forEach((userId, i) => {
      const card = Number(results?.[i]?.[1] ?? 0);
      if (card === 0) offline.push(userId);
    });
    return offline;
  }

  async filterAway(userIds: readonly UserId[]): Promise<UserId[]> {
    if (userIds.length === 0) return [];
    // The appstate HASH mirrors the conns SET (a "foreground" field is seeded on
    // connect), so its values alone decide reachability: NO "foreground" value
    // ⇒ the user is offline (empty hash) or every connection is backgrounded ⇒
    // away. One `hvals` per user, pipelined like `filterOffline`.
    const pipeline = this.redis.pipeline();
    for (const userId of userIds) pipeline.hvals(this.appstateKey(userId));
    const results = await pipeline.exec();
    const away: UserId[] = [];
    userIds.forEach((userId, i) => {
      const states = (results?.[i]?.[1] as string[] | null) ?? [];
      if (!states.includes(APP_STATE_FOREGROUND)) away.push(userId);
    });
    return away;
  }
}

/**
 * Single-process test/default reader. Backed by an explicit online set so unit
 * tests can drive offline-detection without Redis. Users passed to the
 * constructor (or {@link setOnline}) are FOREGROUND by default, so pre-#110 tests
 * that only distinguish online/offline keep their exact behavior; {@link
 * setBackground} marks a connected-but-backgrounded user for the away gate.
 */
export class InMemoryPresenceReader implements PresenceReader, PublicOnlineCounter {
  private readonly online: Set<UserId>;
  /** Online users whose (only) connections are backgrounded ⇒ away, not offline. */
  private readonly background = new Set<UserId>();
  /** Online users masked `invisible` ⇒ publicly offline (not counted). */
  private readonly invisible = new Set<UserId>();

  constructor(onlineUserIds: Iterable<UserId> = []) {
    this.online = new Set(onlineUserIds);
  }

  /** Mark the user online and FOREGROUND (reachable in-app ⇒ no push). */
  setOnline(userId: UserId): void {
    this.online.add(userId);
    this.background.delete(userId);
    this.invisible.delete(userId);
  }

  /** Alias of {@link setOnline} for symmetry with {@link setBackground}. */
  setForeground(userId: UserId): void {
    this.setOnline(userId);
  }

  /** Mark the user online but BACKGROUNDED ⇒ away (offline OR backgrounded push). */
  setBackground(userId: UserId): void {
    this.online.add(userId);
    this.background.add(userId);
  }

  /** Mark the user connected but INVISIBLE ⇒ publicly offline (count-excluded). */
  setInvisible(userId: UserId): void {
    this.online.add(userId);
    this.invisible.add(userId);
  }

  setOffline(userId: UserId): void {
    this.online.delete(userId);
    this.background.delete(userId);
    this.invisible.delete(userId);
  }

  async isOnline(userId: UserId): Promise<boolean> {
    return this.online.has(userId);
  }

  async countPublicOnline(userIds: readonly UserId[]): Promise<number> {
    return userIds.filter((id) => this.online.has(id) && !this.invisible.has(id)).length;
  }

  async filterOffline(userIds: readonly UserId[]): Promise<UserId[]> {
    return userIds.filter((id) => !this.online.has(id));
  }

  async filterAway(userIds: readonly UserId[]): Promise<UserId[]> {
    // Away = no foreground connection: offline, or online-but-backgrounded.
    return userIds.filter((id) => !this.online.has(id) || this.background.has(id));
  }
}
