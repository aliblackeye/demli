/**
 * DM calls — API lifecycle + token-minting integration tests (ADR 0012 / plan
 * Wave 2). Real Postgres from docker-compose; auto-skipped (with a notice) when
 * the database is unreachable. Run `pnpm db:migrate` ONCE before `pnpm test`.
 *
 * Covers: start → call.invite fan-out + caller token for `dmcall:<id>`; accept →
 * active + callee token + call.accepted; reject / cancel / hangup → the right
 * call.ended{reason} + a DM system message; the mutual-friend gate on every
 * endpoint (non-participant 403, unfriended-but-DM-exists 403); second-start 409;
 * accept-after-expiry 409; single-session eviction on accept; and the seamless
 * group upgrade (member.joined ×3 + call.upgraded + call.invite{group}, voice
 * channel bound to the call room, DM stream untouched).
 *
 * The InMemoryMutationBus round-trips every event through the wire codec, so the
 * user-scoped fan-out and the `caller` friendCode strip are asserted for real.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { TokenVerifier } from "livekit-server-sdk";
import {
  applyMigrations,
  createDb,
  createRepositories,
  generateSessionToken,
  hashSessionToken,
  InMemoryMutationBus,
  InMemoryPresenceReader,
  sessionExpiresAt,
  type DbClient,
  type RealtimeMutation,
  type RedisClient,
  type Repositories,
} from "@demli/db";
import {
  createOfflineNotifier,
  type PushNotification,
  type PushService,
} from "@demli/notifications";
import type { DmCallActiveResponse } from "@demli/protocol";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import { RING_TIMEOUT_SECONDS, START_COOLDOWN_MS } from "../modules/dm-calls/index.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/demli";
const LIVEKIT_API_KEY = "devkey";
const LIVEKIT_API_SECRET = "devsecret";

async function isDbUp(): Promise<boolean> {
  const { sql, close } = createDb(DATABASE_URL, { max: 1 });
  try {
    await sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await close();
  }
}

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[dm-calls.int.test] DATABASE unreachable — skipping integration tests");
}

/** In-memory stand-in for the single-session Redis (only get/set are used). */
function createFakeRedis(): { redis: RedisClient; store: Map<string, string> } {
  const store = new Map<string, string>();
  const redis = {
    async get(key: string): Promise<string | null> {
      return store.get(key) ?? null;
    },
    async set(key: string, value: string): Promise<"OK"> {
      store.set(key, value);
      return "OK";
    },
  } as unknown as RedisClient;
  return { redis, store };
}

interface TestUser {
  token: string;
  id: string;
  username: string;
}

interface DmCallDto {
  id: string;
  dmId: string;
  roomName: string;
  callerId: string;
  calleeId: string;
  media: string;
  status: string;
  startedAt: string | null;
  endedAt: string | null;
  expiresAt: string | null;
}

interface TokenBody {
  call: DmCallDto;
  url: string;
  token: string;
  roomName: string;
  identity: string;
  expiresAt: string;
}

describe.skipIf(!dbUp)("DM calls (Wave 2)", () => {
  let client: DbClient;
  let repos: Repositories;
  let app: FastifyInstance;
  let bus: InMemoryMutationBus;
  const published: RealtimeMutation[] = [];
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let seq = 0;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function newUser(label = "u"): Promise<TestUser> {
    seq += 1;
    const username = `${label}${seq}_${suffix}`;
    const user = await repos.users.create({
      username,
      displayName: username,
      passwordHash: "not-used",
    });
    const token = generateSessionToken();
    await repos.sessions.create({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt: sessionExpiresAt(new Date(), 24),
    });
    return { token, id: user.id, username };
  }

  /** Make A and B accepted friends (A requests, B accepts). */
  async function befriend(a: TestUser, b: TestUser): Promise<void> {
    await app.inject({
      method: "POST",
      url: "/friends/requests",
      headers: auth(a.token),
      payload: { userId: b.id },
    });
    await app.inject({
      method: "POST",
      url: `/friends/requests/${a.id}/accept`,
      headers: auth(b.token),
    });
  }

  async function unfriend(a: TestUser, b: TestUser): Promise<void> {
    await app.inject({ method: "DELETE", url: `/friends/${b.id}`, headers: auth(a.token) });
  }

  /** Open the DM between A and B (A is the opener) → { id, streamId }. */
  async function openDm(a: TestUser, b: TestUser): Promise<{ id: string; streamId: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/dms",
      headers: auth(a.token),
      payload: { userId: b.id },
    });
    return (res.json() as { dm: { id: string; streamId: string } }).dm;
  }

  function eventsFor(userId: string, type: string): RealtimeMutation[] {
    return published.filter((m) => m.userId === userId && m.event.type === type);
  }
  function eventsForGroup(groupId: string, type: string): RealtimeMutation[] {
    return published.filter((m) => m.groupId === groupId && m.event.type === type);
  }
  function eventsForChannel(channelId: string, type: string): RealtimeMutation[] {
    return published.filter((m) => m.channelId === channelId && m.event.type === type);
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    bus = new InMemoryMutationBus();
    await bus.subscribe((m) => published.push(m));
    app = await buildApp({ repos, env: loadEnv({ DATABASE_URL }), mutationBus: bus, logger: false });
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  // =========================================================================
  // Start
  // =========================================================================
  describe("start", () => {
    it("mints a caller token for dmcall:<id> and rings the callee", async () => {
      const a = await newUser("sa");
      const b = await newUser("sb");
      await befriend(a, b);
      const dm = await openDm(a, b);
      published.length = 0;

      const res = await app.inject({
        method: "POST",
        url: "/dm-calls",
        headers: auth(a.token),
        payload: { dmId: dm.id, media: "audio" },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as TokenBody;
      expect(body.call.status).toBe("ringing");
      expect(body.call.callerId).toBe(a.id);
      expect(body.call.calleeId).toBe(b.id);
      expect(body.call.expiresAt).toBeTruthy();
      expect(body.roomName).toBe(`dmcall:${body.call.id}`);
      expect(body.identity).toBe(a.id);

      // The ring deadline is PERSISTED, not just echoed in the response — read the
      // row back from Postgres. (A production snapshot showing `expires_at` NULL
      // everywhere is not a missing write: any transition off `ringing` clears the
      // column by contract, and live rows are `active`/terminal, never ringing.)
      const persisted = await repos.calls.findById(body.call.id);
      expect(persisted?.expiresAt).toBeTruthy();
      const deadline = new Date(persisted!.expiresAt!).getTime();
      const created = new Date(persisted!.createdAt).getTime();
      expect(deadline - created).toBeGreaterThan(0);
      expect(deadline - created).toBeLessThanOrEqual(RING_TIMEOUT_SECONDS * 1000 + 1_000);

      // The JWT is a real, signed LiveKit token scoped to the call room.
      const grants = await new TokenVerifier(LIVEKIT_API_KEY, LIVEKIT_API_SECRET).verify(body.token);
      expect(grants.video).toMatchObject({ room: `dmcall:${body.call.id}`, roomJoin: true });

      // call.invite → callee only, with the call target + hydrated caller.
      const invites = eventsFor(b.id, "call.invite");
      expect(invites).toHaveLength(1);
      const payload = invites[0]!.event.payload as {
        callId: string;
        target: { kind: string; dmId?: string };
        caller: { id: string; friendCode?: string };
        media: string;
      };
      expect(payload.callId).toBe(body.call.id);
      expect(payload.target).toEqual({ kind: "dm", dmId: dm.id });
      expect(payload.caller.id).toBe(a.id);
      expect(payload.caller.friendCode).toBeUndefined(); // wire leak guard
      expect(payload.media).toBe("audio");
      // Nothing fanned out to the caller.
      expect(eventsFor(a.id, "call.invite")).toHaveLength(0);
    });

    it("requires an accepted friendship (unfriended-but-DM-exists → 403)", async () => {
      const a = await newUser("ua");
      const b = await newUser("ub");
      await befriend(a, b);
      const dm = await openDm(a, b);
      await unfriend(a, b);

      const res = await app.inject({
        method: "POST",
        url: "/dm-calls",
        headers: auth(a.token),
        payload: { dmId: dm.id, media: "audio" },
      });
      expect(res.statusCode).toBe(403);
    });

    it("second start on a live DM → 409 carrying the existing call", async () => {
      const a = await newUser("ca");
      const b = await newUser("cb");
      await befriend(a, b);
      const dm = await openDm(a, b);

      const first = await app.inject({
        method: "POST",
        url: "/dm-calls",
        headers: auth(a.token),
        payload: { dmId: dm.id, media: "audio" },
      });
      const firstId = (first.json() as TokenBody).call.id;

      const second = await app.inject({
        method: "POST",
        url: "/dm-calls",
        headers: auth(a.token),
        payload: { dmId: dm.id, media: "video" },
      });
      expect(second.statusCode).toBe(409);
      const body = second.json() as { error: { code: string }; call: DmCallDto };
      expect(body.error.code).toBe("CONFLICT");
      expect(body.call.id).toBe(firstId);
    });

    it("rejects an unknown / non-member DM with 404", async () => {
      const a = await newUser("na");
      const res = await app.inject({
        method: "POST",
        url: "/dm-calls",
        headers: auth(a.token),
        payload: { dmId: "00000000-0000-4000-8000-000000000000", media: "audio" },
      });
      expect(res.statusCode).toBe(404);
    });

    it("requires authentication and validates the body", async () => {
      const noAuth = await app.inject({
        method: "POST",
        url: "/dm-calls",
        payload: { dmId: "00000000-0000-4000-8000-000000000000", media: "audio" },
      });
      expect(noAuth.statusCode).toBe(401);

      const a = await newUser("va");
      const bad = await app.inject({
        method: "POST",
        url: "/dm-calls",
        headers: auth(a.token),
        payload: { dmId: "not-a-uuid", media: "audio" },
      });
      expect(bad.statusCode).toBe(400);
    });
  });

  // =========================================================================
  // Ring hardening (security F2) — per-DM start cooldown + stale-ring sweep
  // =========================================================================
  describe("ring hardening", () => {
    async function start(a: TestUser, dmId: string, media = "audio") {
      return app.inject({
        method: "POST",
        url: "/dm-calls",
        headers: auth(a.token),
        payload: { dmId, media },
      });
    }

    it("cooldown: a re-start within the window after a canceled call → 429 RATE_LIMITED", async () => {
      const a = await newUser("cda");
      const b = await newUser("cdb");
      await befriend(a, b);
      const dm = await openDm(a, b);

      const first = await start(a, dm.id);
      expect(first.statusCode).toBe(201);
      const firstId = (first.json() as TokenBody).call.id;

      // Caller withdraws → `canceled` (a terminal, un-answered outcome).
      const cancel = await app.inject({
        method: "POST",
        url: `/dm-calls/${firstId}/cancel`,
        headers: auth(a.token),
      });
      expect(cancel.statusCode).toBe(200);

      // Immediately re-ringing the same friend is throttled by the per-DM cooldown
      // (NOT the per-session rate limit — only two starts happened).
      const second = await start(a, dm.id);
      expect(second.statusCode).toBe(429);
      expect((second.json() as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
    });

    it("cooldown: a re-start after the window elapses → 201", async () => {
      const a = await newUser("cea");
      const b = await newUser("ceb");
      await befriend(a, b);
      const dm = await openDm(a, b);

      const first = await start(a, dm.id);
      const firstId = (first.json() as TokenBody).call.id;
      await app.inject({
        method: "POST",
        url: `/dm-calls/${firstId}/cancel`,
        headers: auth(a.token),
      });

      // Age the canceled attempt past the cooldown window so a real wait is not
      // needed — the cooldown keys on the attempt's `created_at`. Pass an ISO
      // string with an explicit cast (postgres-js will not bind a bare Date here).
      const backdated = new Date(Date.now() - START_COOLDOWN_MS - 60_000).toISOString();
      await client.sql`update dm_calls set created_at = ${backdated}::timestamptz where id = ${firstId}`;

      const second = await start(a, dm.id);
      expect(second.statusCode).toBe(201);
      expect((second.json() as TokenBody).call.id).not.toBe(firstId);
    });

    it("cooldown does not block an immediate call-back after a real (answered) call", async () => {
      const a = await newUser("cba");
      const b = await newUser("cbb");
      await befriend(a, b);
      const dm = await openDm(a, b);

      const first = await start(a, dm.id);
      const firstId = (first.json() as TokenBody).call.id;
      await app.inject({
        method: "POST",
        url: `/dm-calls/${firstId}/accept`,
        headers: auth(b.token),
      });
      await app.inject({
        method: "POST",
        url: `/dm-calls/${firstId}/hangup`,
        headers: auth(a.token),
      });

      // `ended` (answered → hung up) is NOT the churn surface, so call-back is
      // instant even inside the cooldown window.
      const again = await start(a, dm.id);
      expect(again.statusCode).toBe(201);
    });

    it("stale ring: an expired `ringing` row is swept to `missed` and a fresh start succeeds", async () => {
      const a = await newUser("sra");
      const b = await newUser("srb");
      await befriend(a, b);
      const dm = await openDm(a, b);

      // Forge an already-expired ringing row (a dead caller-client whose deadline
      // passed but whose row is still `ringing`) — this would otherwise block the
      // DM's calls forever via the one-live-per-DM index.
      const stale = await repos.calls.create({
        dmId: dm.id,
        callerId: a.id,
        calleeId: b.id,
        media: "audio",
        expiresAt: new Date(Date.now() - 1000),
      });

      // A fresh start reaps the stale ring and opens a new call: no 409 (the stale
      // row no longer counts as live) and no 429 (the swept ring is not counted
      // against the cooldown — it was `ringing`, not a terminal outcome).
      const res = await start(a, dm.id);
      expect(res.statusCode).toBe(201);
      const body = res.json() as TokenBody;
      expect(body.call.id).not.toBe(stale.id);
      expect(body.call.status).toBe("ringing");

      // The stale row is now terminal `missed`, stamped `endedAt`.
      const swept = await repos.calls.findById(stale.id);
      expect(swept?.status).toBe("missed");
      expect(swept?.endedAt).toBeTruthy();
    });
  });

  // =========================================================================
  // Accept
  // =========================================================================
  describe("accept", () => {
    async function ringing(a: TestUser, b: TestUser, dmId: string): Promise<string> {
      const res = await app.inject({
        method: "POST",
        url: "/dm-calls",
        headers: auth(a.token),
        payload: { dmId, media: "audio" },
      });
      return (res.json() as TokenBody).call.id;
    }

    it("callee accept → active + callee token + call.accepted to caller", async () => {
      const a = await newUser("aa");
      const b = await newUser("ab");
      await befriend(a, b);
      const dm = await openDm(a, b);
      const callId = await ringing(a, b, dm.id);
      published.length = 0;

      const res = await app.inject({
        method: "POST",
        url: `/dm-calls/${callId}/accept`,
        headers: auth(b.token),
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as TokenBody;
      expect(body.call.status).toBe("active");
      expect(body.call.startedAt).toBeTruthy();
      expect(body.roomName).toBe(`dmcall:${callId}`);
      expect(body.identity).toBe(b.id);

      const accepted = eventsFor(a.id, "call.accepted");
      expect(accepted).toHaveLength(1);
      const payload = accepted[0]!.event.payload as { callId: string; callee: { id: string } };
      expect(payload.callId).toBe(callId);
      expect(payload.callee.id).toBe(b.id);
    });

    it("a non-callee cannot accept (403)", async () => {
      const a = await newUser("nca");
      const b = await newUser("ncb");
      const c = await newUser("ncc");
      await befriend(a, b);
      const dm = await openDm(a, b);
      const callId = await ringing(a, b, dm.id);

      // The caller cannot accept their own call, and a stranger cannot either.
      const byCaller = await app.inject({
        method: "POST",
        url: `/dm-calls/${callId}/accept`,
        headers: auth(a.token),
      });
      expect(byCaller.statusCode).toBe(403);
      const byStranger = await app.inject({
        method: "POST",
        url: `/dm-calls/${callId}/accept`,
        headers: auth(c.token),
      });
      expect(byStranger.statusCode).toBe(403);
    });

    it("accept after the friendship is gone → 403", async () => {
      const a = await newUser("afa");
      const b = await newUser("afb");
      await befriend(a, b);
      const dm = await openDm(a, b);
      const callId = await ringing(a, b, dm.id);
      await unfriend(a, b);

      const res = await app.inject({
        method: "POST",
        url: `/dm-calls/${callId}/accept`,
        headers: auth(b.token),
      });
      expect(res.statusCode).toBe(403);
    });

    it("accept after expiry → 409", async () => {
      const a = await newUser("xa");
      const b = await newUser("xb");
      await befriend(a, b);
      const dm = await openDm(a, b);
      // Forge an already-expired ringing call directly through the repo.
      const call = await repos.calls.create({
        dmId: dm.id,
        callerId: a.id,
        calleeId: b.id,
        media: "audio",
        expiresAt: new Date(Date.now() - 1000),
      });
      const res = await app.inject({
        method: "POST",
        url: `/dm-calls/${call.id}/accept`,
        headers: auth(b.token),
      });
      expect(res.statusCode).toBe(409);
    });
  });

  // =========================================================================
  // Reject / cancel / hangup — terminal outcomes + DM system messages
  // =========================================================================
  describe("terminal outcomes", () => {
    async function start(a: TestUser, dmId: string): Promise<string> {
      const res = await app.inject({
        method: "POST",
        url: "/dm-calls",
        headers: auth(a.token),
        payload: { dmId, media: "audio" },
      });
      return (res.json() as TokenBody).call.id;
    }
    async function accept(b: TestUser, callId: string): Promise<void> {
      await app.inject({ method: "POST", url: `/dm-calls/${callId}/accept`, headers: auth(b.token) });
    }
    function systemContents(streamId: string): string[] {
      return eventsForChannel(streamId, "message.created").map(
        (m) => (m.event.payload as { content: string; kind?: string }).content,
      );
    }

    it("reject → declined + call.ended{declined} + '@sys:call_declined'", async () => {
      const a = await newUser("ra");
      const b = await newUser("rb");
      await befriend(a, b);
      const dm = await openDm(a, b);
      const callId = await start(a, dm.id);
      published.length = 0;

      const res = await app.inject({
        method: "POST",
        url: `/dm-calls/${callId}/reject`,
        headers: auth(b.token),
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { call: DmCallDto }).call.status).toBe("declined");

      const ended = eventsFor(a.id, "call.ended");
      expect(ended).toHaveLength(1);
      expect((ended[0]!.event.payload as { reason: string }).reason).toBe("declined");
      expect(systemContents(dm.streamId)).toContain("@sys:call_declined");
    });

    it("cancel {timeout} → missed + call.ended{timeout} + '@sys:call_missed'", async () => {
      const a = await newUser("ta");
      const b = await newUser("tb");
      await befriend(a, b);
      const dm = await openDm(a, b);
      const callId = await start(a, dm.id);
      published.length = 0;

      const res = await app.inject({
        method: "POST",
        url: `/dm-calls/${callId}/cancel`,
        headers: auth(a.token),
        payload: { reason: "timeout" },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { call: DmCallDto }).call.status).toBe("missed");

      const ended = eventsFor(b.id, "call.ended");
      expect(ended).toHaveLength(1);
      expect((ended[0]!.event.payload as { reason: string }).reason).toBe("timeout");
      expect(systemContents(dm.streamId)).toContain("@sys:call_missed");
    });

    it("cancel {} (manual) → canceled + call.ended{canceled} + '@sys:call_canceled'", async () => {
      const a = await newUser("mca");
      const b = await newUser("mcb");
      await befriend(a, b);
      const dm = await openDm(a, b);
      const callId = await start(a, dm.id);
      published.length = 0;

      const res = await app.inject({
        method: "POST",
        url: `/dm-calls/${callId}/cancel`,
        headers: auth(a.token),
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { call: DmCallDto }).call.status).toBe("canceled");
      expect((eventsFor(b.id, "call.ended")[0]!.event.payload as { reason: string }).reason).toBe(
        "canceled",
      );
      expect(systemContents(dm.streamId)).toContain("@sys:call_canceled");
    });

    it("only the caller can cancel (403)", async () => {
      const a = await newUser("cxa");
      const b = await newUser("cxb");
      await befriend(a, b);
      const dm = await openDm(a, b);
      const callId = await start(a, dm.id);
      const res = await app.inject({
        method: "POST",
        url: `/dm-calls/${callId}/cancel`,
        headers: auth(b.token),
      });
      expect(res.statusCode).toBe(403);
    });

    it("hangup → ended + call.ended{hung_up} to the other + '@sys:call_ended:<s>'", async () => {
      const a = await newUser("ha");
      const b = await newUser("hb");
      await befriend(a, b);
      const dm = await openDm(a, b);
      const callId = await start(a, dm.id);
      await accept(b, callId);
      published.length = 0;

      const res = await app.inject({
        method: "POST",
        url: `/dm-calls/${callId}/hangup`,
        headers: auth(a.token),
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { call: DmCallDto }).call.status).toBe("ended");

      // BOTH participants are told (ADR 0023 §4) — including the actor, whose
      // OTHER devices are sitting on an "in a call elsewhere" band that nothing
      // else would ever clear. Its own echo is a no-op in the client reducer.
      for (const actor of [a, b]) {
        const ended = eventsFor(actor.id, "call.ended");
        expect(ended).toHaveLength(1);
        expect((ended[0]!.event.payload as { reason: string }).reason).toBe("hung_up");
      }
      expect(systemContents(dm.streamId).some((c) => /^@sys:call_ended:\d+$/.test(c))).toBe(true);
    });

    it("a non-participant cannot hang up (403)", async () => {
      const a = await newUser("hpa");
      const b = await newUser("hpb");
      const c = await newUser("hpc");
      await befriend(a, b);
      const dm = await openDm(a, b);
      const callId = await start(a, dm.id);
      const res = await app.inject({
        method: "POST",
        url: `/dm-calls/${callId}/hangup`,
        headers: auth(c.token),
      });
      expect(res.statusCode).toBe(403);
    });

    it("hangup still works after the friendship is gone (security F1: never strand a live call)", async () => {
      const a = await newUser("hfa");
      const b = await newUser("hfb");
      await befriend(a, b);
      const dm = await openDm(a, b);
      const callId = await start(a, dm.id);
      await accept(b, callId);
      await unfriend(a, b);
      // Terminal endpoints deliberately skip the friendship re-check: a mid-call
      // unfriend must not leave the row `active` (which would block this DM's
      // calls forever via the one-live-call partial index). Participant identity
      // is sufficient authority to END a call.
      const res = await app.inject({
        method: "POST",
        url: `/dm-calls/${callId}/hangup`,
        headers: auth(a.token),
      });
      expect(res.statusCode).toBe(200);
      // The row is truly terminal: a fresh call on this DM is not blocked (it
      // 403s only because the pair are no longer friends, not 409-conflict).
      const again = await app.inject({
        method: "POST",
        url: "/dm-calls",
        headers: auth(a.token),
        payload: { dmId: dm.id, media: "audio" },
      });
      expect(again.statusCode).toBe(403);
    });
  });

  // =========================================================================
  // Single-session — accepting a call evicts a prior group voice session
  // =========================================================================
  describe("single-session", () => {
    let app2: FastifyInstance;
    let bus2: InMemoryMutationBus;
    const published2: RealtimeMutation[] = [];
    let fake: { redis: RedisClient; store: Map<string, string> };

    beforeAll(async () => {
      fake = createFakeRedis();
      bus2 = new InMemoryMutationBus();
      await bus2.subscribe((m) => published2.push(m));
      app2 = await buildApp({
        repos,
        env: loadEnv({ DATABASE_URL }),
        mutationBus: bus2,
        redis: fake.redis,
        logger: false,
      });
    });
    afterAll(async () => {
      await app2?.close();
    });

    it("accept while in a group voice room evicts it (voice.session_replaced)", async () => {
      const a = await newUser("ssa");
      const b = await newUser("ssb");
      await befriend(a, b);
      const dm = await openDm(a, b);
      // b is already in a group voice room on another device.
      const priorRoom = "group-voice-room-x";
      fake.store.set(`voice:session:${b.id}`, priorRoom);

      const start = await app2.inject({
        method: "POST",
        url: "/dm-calls",
        headers: auth(a.token),
        payload: { dmId: dm.id, media: "audio" },
      });
      const callId = (start.json() as TokenBody).call.id;
      published2.length = 0;

      const accept = await app2.inject({
        method: "POST",
        url: `/dm-calls/${callId}/accept`,
        headers: auth(b.token),
      });
      expect(accept.statusCode).toBe(200);

      // Wait for the fire-and-forget recordAndEvict publish to land.
      await new Promise((r) => setTimeout(r, 50));
      const replaced = published2.filter(
        (m) => m.userId === b.id && m.event.type === "voice.session_replaced",
      );
      expect(replaced).toHaveLength(1);
      expect((replaced[0]!.event.payload as { roomId: string }).roomId).toBe(priorRoom);
      // b's active session is now the call room.
      expect(fake.store.get(`voice:session:${b.id}`)).toBe(`dmcall:${callId}`);
    });
  });

  // =========================================================================
  // Upgrade — seamless move into a fresh group
  // =========================================================================
  describe("upgrade", () => {
    it("creates a group + voice channel on the call room, wires 3 members, leaves the DM stream untouched", async () => {
      const a = await newUser("upa"); // caller / inviter
      const b = await newUser("upb"); // callee (other original)
      const c = await newUser("upc"); // invitee (third person)
      await befriend(a, b);
      await befriend(a, c); // inviter⇄invitee friendship is the only one required
      const dm = await openDm(a, b);

      const startRes = await app.inject({
        method: "POST",
        url: "/dm-calls",
        headers: auth(a.token),
        payload: { dmId: dm.id, media: "audio" },
      });
      const callId = (startRes.json() as TokenBody).call.id;
      await app.inject({ method: "POST", url: `/dm-calls/${callId}/accept`, headers: auth(b.token) });
      published.length = 0;

      const res = await app.inject({
        method: "POST",
        url: `/dm-calls/${callId}/upgrade`,
        headers: auth(a.token),
        payload: { inviteeUserId: c.id },
      });
      expect(res.statusCode).toBe(200);
      const { group, voiceChannelId } = res.json() as {
        group: { id: string; streamId: string };
        voiceChannelId: string;
      };
      expect(group.id).toBeTruthy();
      expect(group.streamId).not.toBe(dm.streamId); // a FRESH text stream

      // member.joined ×3 (group-scoped), one per participant.
      const joins = eventsForGroup(group.id, "member.joined");
      expect(joins).toHaveLength(3);
      const joinedIds = joins.map((m) => (m.event.payload as { user: { id: string } }).user.id);
      expect(new Set(joinedIds)).toEqual(new Set([a.id, b.id, c.id]));

      // call.upgraded → the two originals only.
      expect(eventsFor(a.id, "call.upgraded")).toHaveLength(1);
      expect(eventsFor(b.id, "call.upgraded")).toHaveLength(1);
      expect(eventsFor(c.id, "call.upgraded")).toHaveLength(0);
      const up = eventsFor(a.id, "call.upgraded")[0]!.event.payload as {
        group: { id: string };
        voiceChannelId: string;
      };
      expect(up.group.id).toBe(group.id);
      expect(up.voiceChannelId).toBe(voiceChannelId);

      // call.invite{target:group} → the invitee only.
      const invite = eventsFor(c.id, "call.invite");
      expect(invite).toHaveLength(1);
      expect((invite[0]!.event.payload as { target: CallTargetGroup }).target).toEqual({
        kind: "group",
        groupId: group.id,
        voiceChannelId,
      });

      // The DM stream got NO system message from the upgrade (history stays put).
      expect(eventsForChannel(dm.streamId, "message.created")).toHaveLength(0);

      // The call log closed as `upgraded`, linked to the group.
      const settled = await repos.calls.findById(callId);
      expect(settled?.status).toBe("upgraded");
      expect(settled?.upgradedToGroupId).toBe(group.id);

      // The new voice channel's token resolves to the ONGOING call room, so the
      // invitee's join lands in the live call (zero-gap rebind).
      const token = await app.inject({
        method: "POST",
        url: "/media/token",
        headers: auth(c.token),
        payload: { channelId: voiceChannelId },
      });
      expect(token.statusCode).toBe(200);
      expect((token.json() as { roomName: string }).roomName).toBe(`dmcall:${callId}`);
    });

    it("upgrade requires the inviter to be friends with the invitee (403)", async () => {
      const a = await newUser("nfa2");
      const b = await newUser("nfb2");
      const c = await newUser("nfc2"); // NOT a friend of a
      await befriend(a, b);
      const dm = await openDm(a, b);
      const startRes = await app.inject({
        method: "POST",
        url: "/dm-calls",
        headers: auth(a.token),
        payload: { dmId: dm.id, media: "audio" },
      });
      const callId = (startRes.json() as TokenBody).call.id;
      await app.inject({ method: "POST", url: `/dm-calls/${callId}/accept`, headers: auth(b.token) });

      const res = await app.inject({
        method: "POST",
        url: `/dm-calls/${callId}/upgrade`,
        headers: auth(a.token),
        payload: { inviteeUserId: c.id },
      });
      expect(res.statusCode).toBe(403);
    });
  });

  // =========================================================================
  // Call push (#103) — the ring must reach the callee even when they are ONLINE
  // (a backgrounded app holds a live WS yet shows no on-screen ring), and a
  // cancel must retract that ring via the same collapse tag.
  // =========================================================================
  describe("call push", () => {
    let app3: FastifyInstance;
    let bus3: InMemoryMutationBus;
    const presence = new InMemoryPresenceReader();
    const pushCalls: { ids: string[]; n: PushNotification }[] = [];
    const push: PushService = {
      async sendToUsers(ids, n) {
        pushCalls.push({ ids: [...ids], n });
      },
    };
    const pushOfType = (type: string) =>
      pushCalls.find((p) => (p.n.data as { type?: string } | undefined)?.type === type);
    /**
     * Call pushes are dispatched FIRE-AND-FORGET (K2.1) — the lifecycle response
     * no longer waits for them — so an assertion made the instant `inject`
     * resolves is racing a microtask. Poll instead; a real regression (the push
     * never dispatched) still fails, just after the budget.
     */
    async function waitForPush(type: string, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = pushOfType(type);
        if (found) return found;
        if (Date.now() > deadline) throw new Error(`no ${type} push within ${timeoutMs}ms`);
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
    }

    beforeAll(async () => {
      bus3 = new InMemoryMutationBus();
      app3 = await buildApp({
        repos,
        env: loadEnv({ DATABASE_URL }),
        mutationBus: bus3,
        notifier: createOfflineNotifier({ presence, push }),
        logger: false,
      });
    });
    afterAll(async () => {
      await app3?.close();
    });

    it("dispatches the call.invite push even when the callee is ONLINE (offline-gate bypass)", async () => {
      const a = await newUser("cpa");
      const b = await newUser("cpb");
      await befriend(a, b);
      const dm = await openDm(a, b);
      presence.setOnline(b.id); // a live WS would gate a plain notify()
      pushCalls.length = 0;

      const res = await app3.inject({
        method: "POST",
        url: "/dm-calls",
        headers: auth(a.token),
        payload: { dmId: dm.id, media: "audio" },
      });
      expect(res.statusCode).toBe(201);
      const callId = (res.json() as TokenBody).call.id;

      // The ring reached the ONLINE callee anyway, tagged for later retraction.
      const ring = await waitForPush("call_invite");
      expect(ring.ids).toContain(b.id);
      expect(ring.n.collapseKey).toBe(`call:${callId}`);
      expect(ring.n.data).toMatchObject({ callId, dmId: dm.id });
    });

    it("cancel retracts the ring with a same-tag push to the callee", async () => {
      const a = await newUser("cxa2");
      const b = await newUser("cxb2");
      await befriend(a, b);
      const dm = await openDm(a, b);
      presence.setOnline(b.id);

      const start = await app3.inject({
        method: "POST",
        url: "/dm-calls",
        headers: auth(a.token),
        payload: { dmId: dm.id, media: "audio" },
      });
      const callId = (start.json() as TokenBody).call.id;
      pushCalls.length = 0;

      const cancel = await app3.inject({
        method: "POST",
        url: `/dm-calls/${callId}/cancel`,
        headers: auth(a.token),
      });
      expect(cancel.statusCode).toBe(200);

      // A `call_ended` push with the SAME collapse tag reaps the ring on the
      // (still "online") callee's device rather than leaving a stale ring.
      const retract = await waitForPush("call_ended");
      expect(retract.ids).toContain(b.id);
      expect(retract.n.collapseKey).toBe(`call:${callId}`);
      expect(retract.n.data).toMatchObject({ callId, reason: "canceled" });
    });
  });

  // =========================================================================
  // Connection reliability (call-UX plan 2026-07-30, K2) — the founder's
  // "the other side accepted but it never connected, I had to leave the room
  // and call again". Everything here is about a control message that CROSSED
  // its counterpart: the row must never be left live with nobody in it.
  // =========================================================================
  describe("connection reliability (K2)", () => {
    async function start(a: TestUser, dmId: string): Promise<string> {
      const res = await app.inject({
        method: "POST",
        url: "/dm-calls",
        headers: auth(a.token),
        payload: { dmId, media: "audio" },
      });
      expect(res.statusCode).toBe(201);
      return (res.json() as TokenBody).call.id;
    }
    const post = (u: TestUser, path: string, payload?: unknown) =>
      app.inject({ method: "POST", url: path, headers: auth(u.token), payload: payload ?? {} });
    const active = (u: TestUser) =>
      app.inject({ method: "GET", url: "/dm-calls/active", headers: auth(u.token) });
    const activeBody = async (u: TestUser): Promise<DmCallActiveResponse> => {
      const res = await active(u);
      expect(res.statusCode).toBe(200);
      return res.json() as DmCallActiveResponse;
    };

    // -----------------------------------------------------------------------
    // K2.3 — a teardown for an already-ACCEPTED call closes it (no 409 lock)
    // -----------------------------------------------------------------------
    it("cancel AFTER accept closes the call as a hangup instead of locking it `active`", async () => {
      const a = await newUser("k2ca");
      const b = await newUser("k2cb");
      await befriend(a, b);
      const dm = await openDm(a, b);
      const callId = await start(a, dm.id);
      // The callee accepts — and only THEN does the caller's teardown arrive
      // (its media failed / its ring timer fired), which is the production race.
      expect((await post(b, `/dm-calls/${callId}/accept`)).statusCode).toBe(200);
      published.length = 0;

      const cancel = await post(a, `/dm-calls/${callId}/cancel`);
      expect(cancel.statusCode).toBe(200);
      const closed = (cancel.json() as { call: DmCallDto }).call;
      // Closed as a hangup — an accepted call's outcome is `ended`, never
      // `canceled`, so the call log keeps telling the truth.
      expect(closed.status).toBe("ended");
      expect(closed.endedAt).toBeTruthy();

      // The row is NOT stuck live: the DB agrees and the DM is immediately
      // callable again (no waiting for the 3-6 minute sweeper).
      expect((await repos.calls.findById(callId))?.status).toBe("ended");
      expect(await repos.calls.findLiveForDm(dm.id)).toBeNull();
      const restart = await post(a, "/dm-calls", { dmId: dm.id, media: "audio" });
      expect(restart.statusCode).toBe(201);
      await post(a, `/dm-calls/${(restart.json() as TokenBody).call.id}/hangup`);

      // The callee is told, with the hangup reason, exactly once.
      const ended = eventsFor(b.id, "call.ended").filter(
        (m) => (m.event.payload as { callId: string }).callId === callId,
      );
      expect(ended).toHaveLength(1);
      expect((ended[0]!.event.payload as { reason: string }).reason).toBe("hung_up");
    });

    it("cancel on an already-terminal call is idempotent (200, no second fan-out)", async () => {
      const a = await newUser("k2ia");
      const b = await newUser("k2ib");
      await befriend(a, b);
      const dm = await openDm(a, b);
      const callId = await start(a, dm.id);
      expect((await post(b, `/dm-calls/${callId}/reject`)).statusCode).toBe(200);
      published.length = 0;

      const cancel = await post(a, `/dm-calls/${callId}/cancel`);
      expect(cancel.statusCode).toBe(200);
      // The row is reported AS IT STANDS — a late cancel never rewrites the
      // outcome the callee already produced.
      expect((cancel.json() as { call: DmCallDto }).call.status).toBe("declined");
      // …and nothing was announced or written a second time.
      expect(eventsFor(b.id, "call.ended")).toHaveLength(0);
      expect(eventsForChannel(dm.streamId, "message.created")).toHaveLength(0);
    });

    it("a second hangup is idempotent (200, one call.ended in total)", async () => {
      const a = await newUser("k2ha");
      const b = await newUser("k2hb");
      await befriend(a, b);
      const dm = await openDm(a, b);
      const callId = await start(a, dm.id);
      await post(b, `/dm-calls/${callId}/accept`);
      published.length = 0;

      const first = await post(a, `/dm-calls/${callId}/hangup`);
      const second = await post(b, `/dm-calls/${callId}/hangup`);
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect((second.json() as { call: DmCallDto }).call.status).toBe("ended");
      // Both participants hanging up on one goodbye must not double-announce or
      // write two call-history lines. The terminal reaches both sides now
      // (ADR 0023 §4), so "one each" is the assertion — the SQL-guarded
      // `closeIfIn` is what keeps the loser of the race from announcing again.
      expect(eventsFor(b.id, "call.ended")).toHaveLength(1);
      expect(eventsFor(a.id, "call.ended")).toHaveLength(1);
      const sysLines = eventsForChannel(dm.streamId, "message.created").filter((m) =>
        (m.event.payload as { content: string }).content.startsWith("@sys:call_ended"),
      );
      expect(sysLines).toHaveLength(1);
    });

    it("accept AFTER cancel cannot resurrect the call (409, row stays terminal)", async () => {
      const a = await newUser("k2ra");
      const b = await newUser("k2rb");
      await befriend(a, b);
      const dm = await openDm(a, b);
      const callId = await start(a, dm.id);
      await post(a, `/dm-calls/${callId}/cancel`);

      const late = await post(b, `/dm-calls/${callId}/accept`);
      expect(late.statusCode).toBe(409);
      expect((await repos.calls.findById(callId))?.status).toBe("canceled");
      expect(await repos.calls.findLiveForDm(dm.id)).toBeNull();
    });

    // -----------------------------------------------------------------------
    // K2.2 — GET /dm-calls/active, the call-plane resync
    // -----------------------------------------------------------------------
    it("resync: no live call → an all-null body, not an error", async () => {
      const a = await newUser("k2na");
      const body = await activeBody(a);
      // `inRoom` is null here for the same reason everything else is: with no
      // call there is no room to be in (ADR 0023 §3).
      expect(body).toEqual({ call: null, peer: null, side: null, media: null, inRoom: null });
    });

    it("resync: requires authentication", async () => {
      const res = await app.inject({ method: "GET", url: "/dm-calls/active" });
      expect(res.statusCode).toBe(401);
    });

    it("resync: while ringing the CALLER gets join credentials, the CALLEE does not", async () => {
      const a = await newUser("k2sa");
      const b = await newUser("k2sb");
      await befriend(a, b);
      const dm = await openDm(a, b);
      const callId = await start(a, dm.id);

      const callerView = await activeBody(a);
      expect(callerView.call?.id).toBe(callId);
      expect(callerView.call?.status).toBe("ringing");
      expect(callerView.side).toBe("caller");
      expect(callerView.peer?.id).toBe(b.id);
      // Wire-leak guard: the peer is the PUBLIC user shape.
      expect((callerView.peer as { friendCode?: string } | null)?.friendCode).toBeUndefined();
      // The caller is already in the room, so a resync can hand back credentials
      // — and they are real, signed and scoped to this call's room.
      expect(callerView.media?.roomName).toBe(`dmcall:${callId}`);
      expect(callerView.media?.identity).toBe(a.id);
      const grants = await new TokenVerifier(LIVEKIT_API_KEY, LIVEKIT_API_SECRET).verify(
        callerView.media!.token,
      );
      expect(grants.video).toMatchObject({ room: `dmcall:${callId}`, roomJoin: true });

      const calleeView = await activeBody(b);
      expect(calleeView.call?.id).toBe(callId);
      expect(calleeView.side).toBe("callee");
      expect(calleeView.peer?.id).toBe(a.id);
      // A ringing callee gets NO token: /accept is the only path allowed to flip
      // the row and mint theirs, and resync must not be a back door around it.
      expect(calleeView.media).toBeNull();

      await post(a, `/dm-calls/${callId}/cancel`);
    });

    it("resync: after accept BOTH sides can rejoin, and after hangup neither has a call", async () => {
      const a = await newUser("k2aa");
      const b = await newUser("k2ab");
      await befriend(a, b);
      const dm = await openDm(a, b);
      const callId = await start(a, dm.id);
      await post(b, `/dm-calls/${callId}/accept`);

      for (const [user, side] of [
        [a, "caller"],
        [b, "callee"],
      ] as const) {
        const view = await activeBody(user);
        expect(view.call?.id).toBe(callId);
        expect(view.call?.status).toBe("active");
        expect(view.side).toBe(side);
        expect(view.media?.roomName).toBe(`dmcall:${callId}`);
        expect(view.media?.identity).toBe(user.id);
      }

      await post(a, `/dm-calls/${callId}/hangup`);
      expect((await activeBody(a)).call).toBeNull();
      expect((await activeBody(b)).call).toBeNull();
    });

    it("resync: an expired ring is reaped, not handed back as live", async () => {
      const a = await newUser("k2ea");
      const b = await newUser("k2eb");
      await befriend(a, b);
      const dm = await openDm(a, b);
      const callId = await start(a, dm.id);
      // Age the ring past its deadline exactly the way the sweeper suite does.
      await client.sql`
        update dm_calls
        set created_at = now() - interval '10 minutes',
            expires_at = now() - interval '9 minutes'
        where id = ${callId}::uuid`;

      expect((await activeBody(a)).call).toBeNull();
      expect((await activeBody(b)).call).toBeNull();
      // Reaped inline, so the DM is unblocked immediately.
      expect((await repos.calls.findById(callId))?.status).toBe("missed");
    });

    it("resync: prefers an ACTIVE call over a ring in another DM", async () => {
      // A user can hold two live rows at once (the one-live index is per DM, not
      // per user): ringing out to one friend while a third rings them. A resync
      // must return the call their media is actually in.
      const a = await newUser("k2pa");
      const b = await newUser("k2pb");
      const c = await newUser("k2pc");
      await befriend(a, b);
      await befriend(a, c);
      const dmAB = await openDm(a, b);
      const dmCA = await openDm(c, a);

      const answered = await start(a, dmAB.id);
      await post(b, `/dm-calls/${answered}/accept`);
      const ringingIn = await post(c, "/dm-calls", { dmId: dmCA.id, media: "audio" });
      expect(ringingIn.statusCode).toBe(201);

      const view = await activeBody(a);
      expect(view.call?.id).toBe(answered);
      expect(view.call?.status).toBe("active");

      await post(a, `/dm-calls/${answered}/hangup`);
      await post(c, `/dm-calls/${(ringingIn.json() as TokenBody).call.id}/cancel`);
    });
  });

  // =========================================================================
  // K2.1 — a slow or broken push must not touch the call at all
  // =========================================================================
  describe("push independence (K2.1)", () => {
    let app4: FastifyInstance;
    let mode: "hang" | "throw" = "hang";
    /**
     * A push held open on purpose. `release` is null until a push is dispatched,
     * `settled` flips only once it completes — so a test can assert the response
     * arrived WHILE the push was still in flight. Held in one object rather than
     * two `let`s so the assignments inside the closure are visible to the tests.
     */
    const gate: { release: (() => void) | null; settled: boolean } = {
      release: null,
      settled: false,
    };

    const push: PushService = {
      async sendToUsers() {
        if (mode === "throw") throw new Error("expo is down");
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        gate.settled = true;
      },
    };

    /**
     * Read/act through functions, never through `gate.x` directly: TypeScript
     * narrows a property after `gate.release = null` and keeps that narrowing
     * across `await`s, so a direct read would be typed `null` even though the
     * push closure has since filled it in.
     */
    const pushDispatched = (): boolean => gate.release !== null;
    const pushCompleted = (): boolean => gate.settled;
    const releasePush = (): void => {
      const resolve = gate.release;
      gate.release = null;
      resolve?.();
    };

    beforeAll(async () => {
      app4 = await buildApp({
        repos,
        env: loadEnv({ DATABASE_URL }),
        mutationBus: new InMemoryMutationBus(),
        notifier: createOfflineNotifier({ presence: new InMemoryPresenceReader(), push }),
        logger: false,
      });
    });
    afterAll(async () => {
      releasePush();
      await app4?.close();
    });

    it("returns 201 while the ring push is STILL PENDING (no round-trip in the response path)", async () => {
      const a = await newUser("k2ha2");
      const b = await newUser("k2hb2");
      await befriend(a, b);
      const dm = await openDm(a, b);
      mode = "hang";
      gate.release = null;
      gate.settled = false;

      const res = await app4.inject({
        method: "POST",
        url: "/dm-calls",
        headers: auth(a.token),
        payload: { dmId: dm.id, media: "audio" },
      });

      // The assertion that actually proves the fix: the response is here, the
      // push was dispatched, and it has NOT finished. Before K2.1 the handler
      // awaited it, so this state was unreachable — the caller could not learn
      // its own call id until the provider answered, which is the window where
      // the callee accepted first.
      expect(res.statusCode).toBe(201);
      expect(pushDispatched()).toBe(true);
      expect(pushCompleted()).toBe(false);

      const callId = (res.json() as TokenBody).call.id;
      expect((await repos.calls.findById(callId))?.status).toBe("ringing");

      releasePush();
      await app4.inject({
        method: "POST",
        url: `/dm-calls/${callId}/cancel`,
        headers: auth(a.token),
      });
    });

    it("a push that THROWS does not fail the call", async () => {
      const a = await newUser("k2ta");
      const b = await newUser("k2tb");
      await befriend(a, b);
      const dm = await openDm(a, b);
      mode = "throw";

      const res = await app4.inject({
        method: "POST",
        url: "/dm-calls",
        headers: auth(a.token),
        payload: { dmId: dm.id, media: "audio" },
      });
      expect(res.statusCode).toBe(201);
      const callId = (res.json() as TokenBody).call.id;

      // The ring is fully usable: the callee can still accept a call whose push
      // never left the building (the WS invite is what drives the UI).
      const accept = await app4.inject({
        method: "POST",
        url: `/dm-calls/${callId}/accept`,
        headers: auth(b.token),
      });
      expect(accept.statusCode).toBe(200);
      expect((await repos.calls.findById(callId))?.status).toBe("active");

      await app4.inject({
        method: "POST",
        url: `/dm-calls/${callId}/hangup`,
        headers: auth(a.token),
      });
      mode = "hang";
    });
  });
});

interface CallTargetGroup {
  kind: "group";
  groupId: string;
  voiceChannelId: string;
}
