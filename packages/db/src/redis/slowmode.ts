import type { RedisClient } from "./client.js";

/**
 * Slowmode enforcement — "one message per N seconds per user per channel".
 *
 * Lives in @demli/db (like the mutation bus) because BOTH message write
 * paths need it: the HTTP API (`POST /channels/:id/messages`) and the realtime
 * gateway (`message.send`). Redis keys are shared, so the limit holds across
 * processes and transports:
 *
 *   slowmode:<channelId>:<userId> = <last send, epoch ms>  (EX <seconds>)
 *
 * Callers are responsible for the policy (only text channels, owners exempt,
 * seconds comes from `channels.slowmode_seconds`); this store only answers
 * "may this user send now, and if not, how long until they can?".
 */

export type SlowmodeVerdict =
  | { ok: true }
  | { ok: false; retryAfterSeconds: number };

export interface SlowmodeStore {
  /**
   * Try to consume the user's send slot for this channel. On success the slot
   * is taken for `seconds`; on failure nothing changes and `retryAfterSeconds`
   * (>= 1, computed against the CURRENT setting so lowering slowmode takes
   * effect immediately) says when to retry.
   */
  check(channelId: string, userId: string, seconds: number): Promise<SlowmodeVerdict>;
}

function remainingSeconds(lastSentMs: number, seconds: number, nowMs: number): number {
  const elapsed = (nowMs - lastSentMs) / 1000;
  return seconds - elapsed;
}

/**
 * Redis-backed store (production). `SET NX EX` claims a free slot atomically;
 * when the key exists, the remaining wait is recomputed from the stored
 * timestamp with the CURRENT `seconds` so a lowered slowmode is honored at
 * once (an old, longer TTL cannot lock users out).
 */
export class RedisSlowmodeStore implements SlowmodeStore {
  constructor(
    private readonly redis: RedisClient,
    private readonly prefix = "slowmode",
  ) {}

  private key(channelId: string, userId: string): string {
    return `${this.prefix}:${channelId}:${userId}`;
  }

  async check(channelId: string, userId: string, seconds: number): Promise<SlowmodeVerdict> {
    if (seconds <= 0) return { ok: true };
    const key = this.key(channelId, userId);
    const now = Date.now();

    const claimed = await this.redis.set(key, String(now), "EX", seconds, "NX");
    if (claimed === "OK") return { ok: true };

    const stored = await this.redis.get(key);
    const lastSent = stored === null ? null : Number(stored);
    if (lastSent !== null && Number.isFinite(lastSent)) {
      const remaining = remainingSeconds(lastSent, seconds, now);
      if (remaining > 0) {
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(remaining)) };
      }
    }
    // Key held a stale/garbage value (e.g. slowmode was lowered): take the slot.
    await this.redis.set(key, String(now), "EX", seconds);
    return { ok: true };
  }
}

/** Single-process fallback for tests and buildApp/gateway defaults. */
export class InMemorySlowmodeStore implements SlowmodeStore {
  private readonly lastSentMs = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  async check(channelId: string, userId: string, seconds: number): Promise<SlowmodeVerdict> {
    if (seconds <= 0) return { ok: true };
    const key = `${channelId}:${userId}`;
    const nowMs = this.now();
    const lastSent = this.lastSentMs.get(key);
    if (lastSent !== undefined) {
      const remaining = remainingSeconds(lastSent, seconds, nowMs);
      if (remaining > 0) {
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(remaining)) };
      }
    }
    this.lastSentMs.set(key, nowMs);
    return { ok: true };
  }
}
