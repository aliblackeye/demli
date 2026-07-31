/**
 * @demli/db — PostgreSQL access layer (Drizzle ORM + postgres-js).
 *
 * Exposes:
 * - createDb(connectionString)  — typed Postgres client factory
 * - createRepositories(db)      — repository-style query helpers
 * - schema                      — drizzle table definitions
 * - createRedisClient(url)      — Redis client factory
 * - RealtimeMutationBus         — api↔realtime pub/sub bridge (typed protocol events)
 * - SlowmodeStore               — per-channel/user send throttle (api + realtime)
 * - pure helpers: cursor pagination, invite rules, session tokens
 *
 * Schema/migration ownership: database agent. Apps consume this API only.
 */

export * from "./client.js";
export * from "./migrations.js";
export * as schema from "./schema.js";
export * from "./mappers.js";
export * from "./pagination.js";
export * from "./invite-rules.js";
export * from "./session-tokens.js";
export * from "./repositories/index.js";
export * from "./redis/client.js";
export * from "./redis/mutation-bus.js";
export * from "./redis/slowmode.js";
export * from "./redis/presence-reader.js";
export * from "./redis/watch-party.js";
export * from "./redis/watch-search-quota.js";
