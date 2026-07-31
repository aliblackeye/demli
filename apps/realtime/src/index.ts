import { WATCH_SESSION_TTL_SECONDS } from "@demli/config";
import {
  createDb,
  createRedisClient,
  createRepositories,
  RedisMutationBus,
  RedisPresenceReader,
  RedisSlowmodeStore,
  RedisWatchPartyStore,
} from "@demli/db";
import { createExpoPushService, createOfflineNotifier } from "@demli/notifications";
import { createUnfurlService } from "@demli/unfurl";
import { loadEnv } from "./env.js";
import { createGateway } from "./gateway.js";
import { RedisPresenceStore } from "./presence.js";
import { createGatewayVoiceOccupancyReader } from "./voice-occupancy.js";

/**
 * Realtime gateway entrypoint. Typed protocol events only — no media frames
 * (CLAUDE.md §10/§35).
 *
 * Presence is Redis-backed (shared across processes) and the gateway subscribes
 * to the Redis mutation bus so HTTP-originated edits/deletes reach connected
 * clients (the API and this gateway are separate processes).
 */

// Last-resort crash logging: tag the reason in docker logs before exiting so
// an ops `docker logs realtime | grep FATAL` explains every container restart.
process.on("unhandledRejection", (reason) => {
  console.error("[realtime] FATAL unhandledRejection:", reason);
  process.exit(1);
});
process.on("uncaughtException", (err) => {
  console.error("[realtime] FATAL uncaughtException:", err);
  process.exit(1);
});

const env = loadEnv();
const { db, close } = createDb(env.databaseUrl);
const log = (message: string): void => console.log(`[realtime] ${message}`);

const redis = createRedisClient(env.redisUrl);
redis.on("error", (err) => log(`redis error: ${err.message}`));
const repos = createRepositories(db);
const presence = new RedisPresenceStore(redis);
const mutationBus = new RedisMutationBus(env.redisUrl, log);

// Offline mobile push for chat mentions on the WS send path (the PRIMARY path —
// desktop + mobile both send here). Mirrors the HTTP API's construction: the
// presence READER reads the very Redis keys `presence` (the writer) sets, so the
// same offline gate applies; device tokens fan out through the Expo push service.
const notifier = createOfflineNotifier({
  presence: new RedisPresenceReader(redis),
  push: createExpoPushService({ tokens: repos.deviceTokens, log }),
  log,
});

// Authoritative voice occupancy (STATE RESYNC): when LiveKit admin creds are
// configured for the realtime service, the gateway reads media-plane truth and
// pushes `voice.resync` on every (re)connect. Null (unset) ⇒ the feature no-ops
// and clients fall back to the auth.succeeded snapshot + GET /voice/occupancy.
const voiceOccupancy = createGatewayVoiceOccupancyReader(
  {
    livekitUrl: env.livekitUrl,
    livekitApiKey: env.livekitApiKey,
    livekitApiSecret: env.livekitApiSecret,
  },
  log,
);
if (!voiceOccupancy) {
  log("voice.resync disabled — set LIVEKIT_URL/API_KEY/API_SECRET to enable media-plane occupancy");
}

// Startup presence wipe: a fresh (single-instance) gateway means every socket
// recorded in Redis is dead — a hard-killed predecessor (deploy timeout, crash)
// skips close() and the conn SETs have no TTL, so ghosts would stay "online"
// forever. Real connections re-register right after this.
await presence.resetAll();

// Link preview / unfurl (M17): the SSRF-guarded fetcher + OG parser. The WS send
// is the PRIMARY path (desktop), so this instance unfurls those messages and
// publishes `message.embeds_updated` on the mutation bus — fanned out by this
// gateway's own bus subscriber below.
const unfurl = createUnfurlService({ repos, mutationBus, log });

const gateway = createGateway(
  {
    repos,
    presence,
    mutationBus,
    // Slowmode slots live in Redis so the limit is shared with the HTTP API.
    slowmode: new RedisSlowmodeStore(redis),
    // Watch-party sessions (M20, ADR 0016): ephemeral, TTL'd Redis state — no DB
    // table. Redis rather than process memory so a deploy restart mid-party does
    // not silently drop everyone's session.
    watchParty: new RedisWatchPartyStore(redis, WATCH_SESSION_TTL_SECONDS),
    notifier,
    unfurl,
    ...(voiceOccupancy ? { voiceOccupancy } : {}),
    log,
  },
  // clientGate: the retired-build kill switch. False unless
  // CLIENT_GATE is exactly "on" — see env.ts. Arm it in the SAME deploy as the
  // API's, never one without the other.
  { port: env.port, host: env.host, clientGate: env.clientGate },
);

const port = await gateway.ready;
console.log(`[realtime] listening on ws://${env.host}:${port}`);

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("[realtime] shutting down");
  await gateway.close();
  await presence.close?.();
  await mutationBus.close();
  await redis.quit();
  await close();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
