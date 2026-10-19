import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import {
  InMemorySlowmodeStore,
  InMemoryWatchSearchQuotaStore,
  RedisWatchSearchQuotaStore,
  type PublicOnlineCounter,
  type RealtimeMutationPublisher,
  type RedisClient,
  type Repositories,
  type SlowmodeStore,
  type WatchSearchQuotaStore,
} from "@demli/db";
import type { OfflineNotifier } from "@demli/notifications";
import type { UnfurlService } from "@demli/unfurl";
import type { ApiEnv } from "./env.js";
import { ApiError, errorBody } from "./errors.js";
import {
  createAttachmentStorage,
  createAvatarStorage,
  type AttachmentStorage,
  type AvatarStorage,
} from "./lib/storage.js";
import { createMediaModerator, type MediaModerator } from "./lib/media-moderation.js";
import { startAccountPurge } from "./lib/account-purge.js";
import {
  createDmCallSweeper,
  createLiveKitCallLiveness,
  type CallRoomLivenessReader,
} from "./lib/dm-call-sweeper.js";
import { registerAuthDecorations } from "./plugins/auth.js";
import { registerClientGate } from "./plugins/client-gate.js";
import {
  registerAttachmentsModule,
  startAttachmentSweep,
} from "./modules/attachments/index.js";
import { registerAuthModule } from "./modules/auth/index.js";
import { registerBlocksModule } from "./modules/blocks/index.js";
import { registerIgnoresModule } from "./modules/ignores/index.js";
import { registerMembersModule } from "./modules/members/index.js";
import { registerUserNotesModule } from "./modules/user-notes/index.js";
import { registerChannelCategoriesModule } from "./modules/channel-categories/index.js";
import { registerChannelsModule } from "./modules/channels/index.js";
import { registerCustomEmojisModule } from "./modules/custom-emojis/index.js";
import { registerDevicesModule } from "./modules/devices/index.js";
import { registerDmCallsModule, RING_TIMEOUT_SECONDS } from "./modules/dm-calls/index.js";
import { registerDmsModule } from "./modules/dms/index.js";
import { registerFriendsModule } from "./modules/friends/index.js";
import { registerGroupChatsModule } from "./modules/group-chats/index.js";
import { registerGroupsModule } from "./modules/groups/index.js";
import { registerHealthModule } from "./modules/health/index.js";
import { registerHooksModule, type HooksModuleOptions } from "./modules/hooks/index.js";
import { registerInvitesModule } from "./modules/invites/index.js";
import { createVoiceSessions, registerMediaModule } from "./modules/media/index.js";
import { registerMessagesModule } from "./modules/messages/index.js";
import {
  createVoiceModerator,
  registerModerationModule,
  type VoiceModerator,
} from "./modules/moderation/index.js";
import { registerMobileVersionModule } from "./modules/mobile-version/index.js";
import { registerNotificationMutesModule } from "./modules/notification-mutes/index.js";
import { registerPinsModule } from "./modules/pins/index.js";
import { registerRolesModule } from "./modules/roles/index.js";
import { registerSessionsModule } from "./modules/sessions/index.js";
import { registerUsersModule } from "./modules/users/index.js";
import { registerLivekitWebhookModule } from "./modules/livekit-webhook/index.js";
import {
  createVoiceOccupancyReader,
  registerVoiceModule,
  type VoiceOccupancyReader,
} from "./modules/voice/index.js";
import { registerWatchModule, type YouTubeFetchJson } from "./modules/watch/index.js";

export interface BuildAppOptions {
  repos: Repositories;
  env: ApiEnv;
  /**
   * Publishes message.created/updated/deleted onto the realtime bus so
   * HTTP-originated mutations (including system messages) reach connected WS
   * clients. Omitted in tests that do not assert broadcast (mutations still
   * persist).
   */
  mutationBus?: RealtimeMutationPublisher;
  /**
   * Slowmode enforcement backend. Production wires the Redis store (shared
   * with the realtime gateway); defaults to in-memory (single process).
   */
  slowmode?: SlowmodeStore;
  /**
   * Shared Redis client. Production wires it so the media module can track each
   * user's single active voice session (cross-device eviction). Omitted in tests
   * that do not exercise eviction — the /media/token route then just mints tokens.
   */
  redis?: RedisClient;
  /**
   * Presence read seam for the invite preview card's online count (production:
   * the RedisPresenceReader over the gateway's presence keys — the same
   * instance the offline notifier uses). Absent ⇒ the preview answers
   * `onlineCount: null` instead of inventing a number.
   */
  presence?: PublicOnlineCounter;
  /**
   * Media-attachment storage backend (ADR 0008). Tests inject a mock; when
   * omitted it is built from `env` (Supabase), and is `null` — feature disabled
   * — when Supabase is not configured.
   */
  storage?: AttachmentStorage | null;
  /**
   * Public avatar-bucket storage (profile photos). Tests inject a mock; when
   * omitted it is built from `env` (SUPABASE_AVATAR_BUCKET), and is `null` —
   * uploads disabled — when that bucket is not configured. Separate from
   * `storage` because avatars use a PUBLIC bucket, not the signed attachment one.
   */
  avatarStorage?: AvatarStorage | null;
  /**
   * Server-side NSFW media seam (M15) — screens avatars, banners, and non-NSFW
   * channel image attachments. Tests inject a stub to assert allow/reject; when
   * omitted it is built from `env` (MEDIA_MODERATION_MODE) and defaults to a no-op
   * `skipped` moderator (fail-open) until the founder flips the flag on.
   */
  mediaModerator?: MediaModerator;
  /**
   * YouTube daily-quota accounting for watch-party search (M20 wave 2). Tests
   * inject a store to drive the budget deterministically; production picks Redis
   * when a client is wired and the in-memory fallback otherwise.
   */
  watchSearchQuota?: WatchSearchQuotaStore;
  /**
   * The upstream HTTP seam for watch-party search. Tests inject a stub so every
   * layer ABOVE the network (authorization, normalization, cache, budget) runs
   * for real against canned upstream answers. Production leaves it undefined and
   * gets the real `fetch` implementation, which has its own test against a local
   * HTTP server — a seam that is only ever mocked proves nothing.
   */
  watchFetchJson?: YouTubeFetchJson;
  /**
   * Start the periodic attachment orphan sweep (ADR 0008 §3). Off by default so
   * tests never spin a real timer; `index.ts` enables it in the long-running
   * server. No-op when storage is disabled.
   */
  startSweepJob?: boolean;
  /**
   * Start the hourly account-purge job (M15) that anonymizes accounts whose
   * 14-day freeze window has elapsed. Off by default so tests never spin a real
   * timer; `index.ts` enables it in the long-running server.
   */
  startPurgeJob?: boolean;
  /**
   * Start the periodic DM-call liveness sweep (founder P0: `dm_calls` rows stuck
   * `active` forever → an endless ring on every reconnect). Off by default so
   * tests never spin a real timer; `index.ts` enables it in the long-running
   * server. The first tick also performs the post-restart reconciliation that
   * clears ghost calls a deploy left behind.
   */
  startCallSweepJob?: boolean;
  /**
   * Media-plane liveness probe, shared by the sweep and by the DM-call resync
   * read's `inRoom` answer (ADR 0023 §3) — ONE implementation of "who is in this
   * room", so the sweeper and the client's auto-join gate can never disagree.
   * Tests inject a fake so no live SFU is needed; when omitted it is built from
   * `env` (LiveKit admin API, same creds as the token endpoint). Pass `null` to
   * force it off — accepted calls are then never swept (only expired rings are)
   * and `inRoom` answers `null`, which is the conservative degradation on both
   * sides: without media-plane evidence we end nothing and join nothing.
   */
  callLiveness?: CallRoomLivenessReader | null;
  /**
   * EAS Build webhook wiring (task #39). Tests inject a stub downloader to
   * assert scheduling without network/fs; production omits it (real streamer).
   */
  hooks?: HooksModuleOptions;
  /**
   * Offline mobile-push dispatcher (task #46). When present, a friend request /
   * DM message to a recipient with no live WS connection triggers an Expo push.
   * Omitted in tests that do not assert push (the flows still persist + fan out
   * over the mutation bus). Always best-effort — a push failure never fails the
   * request.
   */
  notifier?: OfflineNotifier;
  /**
   * Authoritative voice-occupancy reader for `GET /voice/occupancy` (STATE
   * RESYNC). Tests inject a fake so no live LiveKit is needed; when omitted it is
   * built from `env` (LiveKit admin API). Pass `null` to force the feature off
   * (endpoint answers 503).
   */
  voiceOccupancy?: VoiceOccupancyReader | null;
  /**
   * SFU admin for the voice-disconnect moderation endpoint (migration 0017).
   * Tests inject a fake `{ removeParticipant }`; when omitted it is built from
   * `env` (LiveKit admin API). Pass `null` to force the feature off (the endpoint
   * then relies on the `voice.disconnected` event alone, no SFU force-remove).
   */
  voiceModerator?: VoiceModerator | null;
  /**
   * Link-preview (unfurl) service (M17). When present, the messages module
   * unfurls created messages asynchronously. `index.ts` wires the real service
   * (SSRF-guarded fetcher + Redis mutation-bus publish); omitted in tests that do
   * not assert unfurl, so the default full test run makes no network calls.
   */
  unfurl?: UnfurlService;
  logger?: boolean;
}

/** Assembled but not listening — index.ts listens, tests inject. */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  // trustProxy: in production the API is only reachable through Caddy (api is
  // `expose`d, not published), so without this every request's `request.ip`
  // would be Caddy's internal container IP and the IP-keyed login/register rate
  // limits would collapse into one global bucket (security-review H1). With it,
  // `request.ip` reflects the client IP from Caddy's X-Forwarded-For.
  //
  // THE NUMBER IS THE SECURITY BOUNDARY. `true` means "trust every proxy in the
  // chain", and Fastify then reports the LEFTMOST X-Forwarded-For entry — which
  // the client wrote. Caddy APPENDS the real address, so an attacker sending
  // `X-Forwarded-For: <random>` gets `request.ip = <random>`: a fresh rate-limit
  // bucket on every request, and `max: 5 / 15 minutes` on register and login
  // stops meaning anything (verified by reproduction, 2026-07-31).
  //
  // `1` = trust exactly one hop, the Caddy in front of us, so `request.ip` is
  // the address Caddy appended. Raise this ONLY by counting real proxies you
  // control; every extra hop hands one more forgeable entry to the client.
  const server = Fastify({ logger: options.logger ?? true, trustProxy: 1 });

  server.decorate("repos", options.repos);
  server.decorate("apiEnv", options.env);

  await server.register(cors, {
    // Native clients (packaged Electron sends Origin `null`/`file://`, React
    // Native sends none) are not browser web apps, so CORS is not the security
    // boundary here — the Bearer session token is. That is also why PRODUCTION
    // runs `CORS_ORIGIN=*` (reflect any origin): an array allowlist would reject
    // the packaged desktop app's `Origin: null`. Read `FIRST_PARTY_WEB_ORIGINS`
    // in env.ts knowing that — it is the local/self-hosted shape, not what the
    // hosted deployment enforces.
    origin: options.env.corsOrigins.includes("*") ? true : options.env.corsOrigins,
    // NO credentials. Sessions are Bearer tokens in the Authorization header —
    // there is not one cookie in this API — so `credentials: true` bought us
    // nothing and no client has ever sent `credentials: "include"`. What it DID
    // buy was a trap: combined with reflect-any above, the first cookie anyone
    // adds (an OAuth callback, a CSRF token) becomes readable by every website
    // the user visits, with no code change to notice. Adding cookie auth means
    // pinning `origin` to a real allowlist FIRST.
    credentials: false,
  });

  // Global off; sensitive routes opt in via per-route config (§28).
  await server.register(rateLimit, {
    global: false,
    errorResponseBuilder: () => ({
      statusCode: 429,
      ...errorBody("RATE_LIMITED", "Too many requests. Please slow down."),
    }),
  });

  server.setErrorHandler((err, request, reply) => {
    if (err instanceof ApiError) {
      return reply
        .status(err.statusCode)
        .send(errorBody(err.code, err.message, err.retryAfterSeconds, err.details));
    }
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode === 429) {
      return reply
        .status(429)
        .send(errorBody("RATE_LIMITED", "Too many requests. Please slow down."));
    }
    if (statusCode === 400) {
      return reply
        .status(400)
        .send(errorBody("VALIDATION_ERROR", "Invalid request."));
    }
    // Unknown failure: log the details, hide them from the client (§26).
    request.log.error(err);
    return reply
      .status(500)
      .send(errorBody("INTERNAL", "Something went wrong on our side. Please try again."));
  });

  server.setNotFoundHandler((_request, reply) => {
    reply.status(404).send(errorBody("NOT_FOUND", "Route not found."));
  });

  // Client-identity gate. Registered BEFORE the
  // auth decorations and every module so its `onRequest` hook runs ahead of any
  // route handler — including login: a retired build must
  // not be able to open a session, not merely be unable to use one. A no-op
  // unless CLIENT_GATE is exactly "on", which is why it is wired unconditionally.
  registerClientGate(server);

  registerAuthDecorations(server);

  const slowmode = options.slowmode ?? new InMemorySlowmodeStore();

  // Attachment storage: injected (tests) or built from env. `null` ⇒ feature
  // disabled; the routes still register and answer ATTACHMENTS_DISABLED.
  const storage =
    options.storage !== undefined ? options.storage : createAttachmentStorage(options.env);

  // Avatar uploads: a SEPARATE public bucket + a server-side NSFW seam. Both are
  // injectable for tests; otherwise built from env, and `null`/no-op when the
  // founder has not turned them on (AVATAR_UPLOADS_DISABLED until then).
  const avatarStorage =
    options.avatarStorage !== undefined
      ? options.avatarStorage
      : createAvatarStorage(options.env);
  // Generalized NSFW seam (M15): screens avatars, banners, and non-NSFW-channel
  // image attachments. Default is fail-open (MEDIA_MODERATION_MODE=off) — no
  // model is bundled; the founder flips the flag to enable it later.
  const mediaModerator =
    options.mediaModerator ?? createMediaModerator(options.env);

  await registerHealthModule(server);
  await registerMobileVersionModule(server);
  await registerAuthModule(server);
  await registerSessionsModule(server, options.mutationBus);
  await registerUsersModule(server, {
    avatarStorage,
    mediaModerator,
    mutationBus: options.mutationBus,
  });
  await registerDevicesModule(server);
  // Blocking (M18) is registered BEFORE the surfaces it cuts so its routes are in
  // place whatever order Fastify resolves them in; the enforcement itself lives at
  // each surface's own boundary (see lib/blocks.ts), not here.
  await registerBlocksModule(server, options.mutationBus);
  // Ignoring (migration 0020) — the SOFT counterpart to blocking, registered
  // beside it. Unlike a block it cuts NO write path, so there is nothing to
  // enforce at other boundaries: its only server-side effect is the notification
  // filter inside `dispatchChannelMessagePush` (ADR 0019 §4).
  await registerIgnoresModule(server, options.mutationBus);
  // Private per-viewer annotations (migration 0020): the note and the PRIVATE
  // nickname. Registered before the catch-all `/users/:id` in the users module so
  // the static `/users/me/nicknames` path is never captured as an id.
  await registerUserNotesModule(server, options.mutationBus);
  await registerFriendsModule(server, options.mutationBus, options.notifier);
  await registerDmsModule(server, options.mutationBus);
  // SFU admin shared by every path that must end someone's media session: the
  // moderation endpoints, a member removed from a server or group chat, and the
  // alone-idle sweep. Injected in tests, else built from env (LiveKit admin API —
  // same creds as the media token endpoint).
  const voiceModerator =
    options.voiceModerator !== undefined
      ? options.voiceModerator
      : createVoiceModerator(server);
  // Groups take the same image-upload deps the users module does: the server
  // banner (M20) shares the profile banner's public bucket, gate and NSFW seam.
  await registerGroupsModule(server, {
    mutationBus: options.mutationBus,
    avatarStorage,
    mediaModerator,
    voiceEjector: voiceModerator,
  });
  await registerGroupChatsModule(server, options.mutationBus, { voiceEjector: voiceModerator });
  await registerChannelsModule(server, options.mutationBus);
  await registerChannelCategoriesModule(server, options.mutationBus);
  await registerMessagesModule(server, {
    mutationBus: options.mutationBus,
    slowmode,
    storage,
    notifier: options.notifier,
    unfurl: options.unfurl,
  });
  await registerPinsModule(server, options.mutationBus);
  await registerCustomEmojisModule(server, {
    storage,
    mutationBus: options.mutationBus,
  });
  await registerInvitesModule(server, options.mutationBus, {
    presence: options.presence,
  });
  // One single-active-voice-session registry shared by the media token endpoint
  // and the DM-calls module (ADR 0012 §5) so a voice-channel join and a call-room
  // join enforce ONE session per user against the same Redis key. Null when Redis
  // is not wired (tests that only assert token minting / call lifecycle).
  const voiceSessions = createVoiceSessions(server, options.redis, options.mutationBus);
  await registerMediaModule(server, { voiceSessions });
  // ONE media-plane reader for both consumers of "who is in this room": the
  // liveness sweep below and the DM-call resync read's `inRoom` gate (ADR 0023
  // §3). Constructing it here rather than inside the sweep block is what makes
  // them share it — two readers would be two answers to the same question.
  // Always constructible; a wrong host degrades to "the probe throws", which
  // both consumers already treat as "no evidence".
  const callLiveness =
    options.callLiveness !== undefined ? options.callLiveness : createLiveKitCallLiveness(server);
  await registerDmCallsModule(server, {
    mutationBus: options.mutationBus,
    notifier: options.notifier,
    voiceSessions,
    callLiveness,
  });
  await registerRolesModule(server, options.mutationBus);
  await registerNotificationMutesModule(server, options.mutationBus);
  // Authoritative voice occupancy (STATE RESYNC): injected in tests, else built
  // from env (LiveKit admin API). The gateway pushes the same snapshot as
  // `voice.resync`; this endpoint serves the on-focus pull.
  const voiceOccupancy =
    options.voiceOccupancy !== undefined
      ? options.voiceOccupancy
      : createVoiceOccupancyReader(server);
  await registerVoiceModule(server, { reader: voiceOccupancy });
  // Server moderation (migration 0017): kick / ban / unban / list bans / voice
  // disconnect. The voice moderator is built above, before the groups modules.
  await registerModerationModule(server, {
    mutationBus: options.mutationBus,
    voiceModerator,
  });
  // Server-side join check: the SFU reports every join and anyone the token
  // endpoints would refuse today is removed (a kicked member replaying a token).
  await registerLivekitWebhookModule(server, { ejector: voiceModerator });
  // Per-server member nicknames (migration 0020). Separate from moderation
  // because most calls are self-serve — a member setting their own nickname
  // needs no permission bit at all (ADR 0019 §3).
  await registerMembersModule(server, options.mutationBus);
  await registerAttachmentsModule(server, { storage, mediaModerator });
  // Watch-party search (M20 wave 2). Registered unconditionally: with no
  // YOUTUBE_API_KEY the routes still exist and answer honestly — 503 on search,
  // `searchEnabled: false` on capabilities — which is what lets a client hide the
  // search box instead of offering one that cannot work. Quota accounting is
  // Redis-backed when Redis is wired (it must survive the deploys that would
  // otherwise reset it) and process-local otherwise.
  await registerWatchModule(server, {
    apiKey: options.env.youtubeApiKey,
    quota:
      options.watchSearchQuota ??
      (options.redis
        ? new RedisWatchSearchQuotaStore(options.redis)
        : new InMemoryWatchSearchQuotaStore()),
    ...(options.watchFetchJson ? { fetchJson: options.watchFetchJson } : {}),
    log: (message) => server.log.warn(message),
  });
  await registerHooksModule(server, options.hooks);

  // Orphan-upload sweep: only in the long-running server (index.ts) and only
  // when storage is enabled. Cleared on graceful shutdown so no timer leaks.
  if (options.startSweepJob && storage) {
    const stopSweep = startAttachmentSweep({
      repos: options.repos,
      storage,
      log: (message) => server.log.info(message),
    });
    server.addHook("onClose", async () => {
      stopSweep();
    });
  }

  // Account-purge job (M15): only in the long-running server (index.ts). Hourly
  // anonymization of accounts whose freeze window elapsed. Cleared on shutdown.
  if (options.startPurgeJob) {
    const stopPurge = startAccountPurge({
      repos: options.repos,
      log: (message) => server.log.info(message),
    });
    server.addHook("onClose", async () => {
      stopPurge();
    });
  }

  // DM-call liveness sweep (founder P0). Only in the long-running server, like
  // the jobs above. Every OTHER way a call ends needs a live client to author it
  // (reject / cancel / hangup / upgrade are all HTTP), so without this a call
  // whose participants simply vanished — crash, sleep, lost network, or a DEPLOY
  // — stayed `active` with `ended_at IS NULL` forever and kept the DM blocked by
  // the one-live-call-per-DM index. The first tick doubles as the post-restart
  // reconciliation. See lib/dm-call-sweeper.ts for why the criterion is the
  // LiveKit room's occupancy and never the call's age.
  if (options.startCallSweepJob) {
    const sweeper = createDmCallSweeper({
      repos: options.repos,
      liveness: callLiveness,
      // The same SFU admin the moderation voice-disconnect uses — the alone-idle
      // pass performs exactly that action, just triggered by an idle timer instead
      // of a moderator.
      ejector: voiceModerator,
      mutationBus: options.mutationBus,
      log: server.log,
      ringWindowMs: RING_TIMEOUT_SECONDS * 1000,
    });
    // Reconcile immediately at boot rather than waiting a full interval — a ghost
    // ring left by the restart would otherwise keep a DM blocked meanwhile.
    void sweeper.sweepOnce();
    server.addHook("onClose", async () => {
      sweeper.stop();
    });
  }

  return server;
}
