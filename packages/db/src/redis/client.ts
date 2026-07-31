import Redis, { type RedisOptions } from "ioredis";

/**
 * ioredis instance type, re-exported so `apps/api` and `apps/realtime` obtain
 * a Redis handle through this factory without depending on `ioredis` directly
 * (mirrors how `createDb` is the only door to Postgres).
 */
export type RedisClient = Redis;

/**
 * Create an ioredis client for the realtime pub/sub bridge and the
 * Redis-backed presence store.
 *
 * Callers should attach an `error` listener (ioredis emits `error` on
 * connection loss; an unhandled `error` event would crash the process).
 */
export function createRedisClient(url: string, options: RedisOptions = {}): RedisClient {
  return new Redis(url, {
    // Surface failures instead of buffering commands forever when Redis is down.
    maxRetriesPerRequest: 3,
    ...options,
  });
}
