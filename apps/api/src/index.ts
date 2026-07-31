import {
  createDb,
  createRedisClient,
  createRepositories,
  RedisMutationBus,
  RedisPresenceReader,
  RedisSlowmodeStore,
} from "@demli/db";
import { createExpoPushService, createOfflineNotifier } from "@demli/notifications";
import { createUnfurlService } from "@demli/unfurl";
import { buildApp } from "./app.js";
import { loadEnv } from "./env.js";

/**
 * Demli HTTP API — Fastify modules under src/modules/, each validating
 * input at the boundary with zod (CLAUDE.md §23/§28).
 */

// Last-resort crash logging: tag the reason in docker logs before exiting so
// an ops `docker logs api | grep FATAL` explains every container restart.
// Exiting (instead of limping on with unknown state) lets the compose
// restart policy bring up a clean process.
process.on("unhandledRejection", (reason) => {
  console.error("[api] FATAL unhandledRejection:", reason);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error("[api] FATAL uncaughtException:", err);
  process.exit(1);
});

const env = loadEnv();
const { db, close } = createDb(env.databaseUrl);
const repos = createRepositories(db);

// Publishes message.created/updated/deleted so HTTP-originated mutations
// (including system messages) reach the realtime gateway (separate process)
// and its connected WS clients.
const mutationBus = new RedisMutationBus(env.redisUrl, (message) =>
  console.log(`[api] ${message}`),
);

// Slowmode slots live in Redis so the limit is shared with the WS gateway.
const redis = createRedisClient(env.redisUrl);
redis.on("error", (err) => console.log(`[api] redis error: ${err.message}`));
const slowmode = new RedisSlowmodeStore(redis);

// Offline mobile push (task #46): read gateway presence from the same Redis
// (a user is "online" iff they have a live WS connection), and send via Expo.
// The notifier only pushes to the OFFLINE subset of recipients and is fully
// best-effort — a push failure never disturbs the request that triggered it.
// The SAME reader also feeds the invite preview card's public online count.
const presence = new RedisPresenceReader(redis);
const notifier = createOfflineNotifier({
  presence,
  push: createExpoPushService({
    tokens: repos.deviceTokens,
    log: (message) => console.log(`[api] ${message}`),
  }),
  log: (message) => console.log(`[api] ${message}`),
});

// Link preview / unfurl (M17): the SSRF-guarded fetcher + OG parser, publishing
// `message.embeds_updated` on the same mutation bus so the realtime gateway fans
// it out. Covers messages created over REST (the mobile send path); the realtime
// process runs its own instance for WS sends.
const unfurl = createUnfurlService({
  repos,
  mutationBus,
  log: (message) => console.log(`[api] ${message}`),
});

const server = await buildApp({
  repos,
  env,
  mutationBus,
  slowmode,
  // Shared Redis: powers slowmode, offline-push presence reads, AND the media
  // module's single-active-voice-session tracking (cross-device eviction).
  redis,
  presence,
  notifier,
  unfurl,
  startSweepJob: true,
  startPurgeJob: true,
  startCallSweepJob: true,
});
server.addHook("onClose", async () => {
  await mutationBus.close();
  await redis.quit();
  await close();
});

try {
  await server.listen({ port: env.port, host: env.host });
} catch (err) {
  server.log.error(err);
  await close();
  process.exit(1);
}
