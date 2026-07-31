/**
 * M13 W2 — social API integration tests (friendships, DMs, profiles).
 * Real Postgres from docker-compose; auto-skipped (with a notice) when the
 * database is unreachable. Run `pnpm db:migrate` ONCE before `pnpm test` (a
 * new migration racing across parallel suites collides on CREATE TYPE — see
 * social-db-w1b handoff).
 *
 * Covers the W1b outcome→status mapping, the friend-code leak guard, DM
 * idempotency + friendship gate + hide/reopen + inbound-unhide, and the
 * profile role-visibility gate. The InMemoryMutationBus round-trips every
 * published event through the wire codec, so user-scoped fan-out and the
 * on-the-wire `friendCode` strip are both asserted here.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  applyMigrations,
  createDb,
  createRepositories,
  generateSessionToken,
  hashSessionToken,
  InMemoryMutationBus,
  sessionExpiresAt,
  type DbClient,
  type RealtimeMutation,
  type Repositories,
} from "@demli/db";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/demli";

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
  console.warn("[social.int.test] DATABASE unreachable — skipping integration tests");
}

interface PublicUser {
  id: string;
  username: string;
  displayName: string;
  bio?: string | null;
  friendCode?: string;
}

describe.skipIf(!dbUp)("M13 W2 social API", () => {
  let client: DbClient;
  let repos: Repositories;
  let app: FastifyInstance;
  let bus: InMemoryMutationBus;
  const published: RealtimeMutation[] = [];
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let seq = 0;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  interface TestUser {
    token: string;
    id: string;
    username: string;
  }

  /**
   * Create a user + session directly through the repo layer. The HTTP
   * `/auth/register` route is IP-rate-limited (5/15min) and this suite mints
   * dozens of users, so going through the repo keeps the friend-code minting
   * (users.create assigns one) while bypassing the register throttle. The
   * per-route social rate limits are keyed by the Bearer token, so each
   * distinct user still exercises its own bucket.
   */
  async function newUser(label = "u"): Promise<TestUser> {
    seq += 1;
    const username = `${label}${seq}_${suffix}`;
    const user = await repos.users.create({
      username,
      displayName: username,
      passwordHash: "not-used-in-these-tests",
    });
    const token = generateSessionToken();
    await repos.sessions.create({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt: sessionExpiresAt(new Date(), 24),
    });
    return { token, id: user.id, username };
  }

  async function me(token: string): Promise<PublicUser> {
    const res = await app.inject({ method: "GET", url: "/users/me", headers: auth(token) });
    expect(res.statusCode).toBe(200);
    return (res.json() as { user: PublicUser }).user;
  }

  /** User-scoped events published to `userId` of the given `type`. */
  function eventsFor(userId: string, type: string): RealtimeMutation[] {
    return published.filter((m) => m.userId === userId && m.event.type === type);
  }

  /** Make A and B accepted friends (A requests, B accepts). */
  async function befriend(a: TestUser, b: TestUser): Promise<void> {
    const sent = await app.inject({
      method: "POST",
      url: "/friends/requests",
      headers: auth(a.token),
      payload: { userId: b.id },
    });
    expect(sent.statusCode).toBe(201);
    const accepted = await app.inject({
      method: "POST",
      url: `/friends/requests/${a.id}/accept`,
      headers: auth(b.token),
    });
    expect(accepted.statusCode).toBe(200);
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    bus = new InMemoryMutationBus();
    await bus.subscribe((m) => published.push(m));
    app = await buildApp({
      repos,
      env: loadEnv({ DATABASE_URL }),
      mutationBus: bus,
      logger: false,
    });
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  // =========================================================================
  // Friendships — send outcomes
  // =========================================================================
  describe("friend requests", () => {
    it("sends by userId → 201 created + friend.request_received to the addressee", async () => {
      const a = await newUser("fa");
      const b = await newUser("fb");
      published.length = 0;

      const res = await app.inject({
        method: "POST",
        url: "/friends/requests",
        headers: auth(a.token),
        payload: { userId: b.id },
      });
      expect(res.statusCode).toBe(201);
      const body = res.json() as { outcome: string; friendship: { status: string } };
      expect(body.outcome).toBe("created");
      expect(body.friendship.status).toBe("pending");

      const received = eventsFor(b.id, "friend.request_received");
      expect(received).toHaveLength(1);
      const payload = received[0]!.event.payload as { requester: PublicUser };
      expect(payload.requester.id).toBe(a.id);
      // Leak guard on the wire: the requester User carries no friendCode.
      expect(payload.requester.friendCode).toBeUndefined();
      // Nothing was fanned out to the sender.
      expect(eventsFor(a.id, "friend.request_received")).toHaveLength(0);
    });

    it("sends by friendCode (dash/case-insensitive) → resolves the same user", async () => {
      const a = await newUser("fca");
      const b = await newUser("fcb");
      const bSelf = await me(b.token);
      expect(bSelf.friendCode).toBeTruthy();
      const grouped = `${bSelf.friendCode!.slice(0, 4)}-${bSelf.friendCode!.slice(4)}`.toLowerCase();
      published.length = 0;

      const res = await app.inject({
        method: "POST",
        url: "/friends/requests",
        headers: auth(a.token),
        payload: { friendCode: grouped },
      });
      expect(res.statusCode).toBe(201);
      expect(eventsFor(b.id, "friend.request_received")).toHaveLength(1);
    });

    it("unknown friend code → generic 404 (no enumeration)", async () => {
      const a = await newUser("fua");
      const res = await app.inject({
        method: "POST",
        url: "/friends/requests",
        headers: auth(a.token),
        payload: { friendCode: "ZZZZ9999" },
      });
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: { code: string } }).error.code).toBe("NOT_FOUND");
    });

    it("friending yourself → 400", async () => {
      const a = await newUser("fsa");
      const res = await app.inject({
        method: "POST",
        url: "/friends/requests",
        headers: auth(a.token),
        payload: { userId: a.id },
      });
      expect(res.statusCode).toBe(400);
    });

    it("duplicate outgoing request → 409 already_pending", async () => {
      const a = await newUser("fpa");
      const b = await newUser("fpb");
      await app.inject({
        method: "POST",
        url: "/friends/requests",
        headers: auth(a.token),
        payload: { userId: b.id },
      });
      const dup = await app.inject({
        method: "POST",
        url: "/friends/requests",
        headers: auth(a.token),
        payload: { userId: b.id },
      });
      expect(dup.statusCode).toBe(409);
    });

    it("reverse pending → auto-accept (200) + friend.request_accepted to the first requester", async () => {
      const a = await newUser("fra");
      const b = await newUser("frb");
      // A asks B (pending).
      await app.inject({
        method: "POST",
        url: "/friends/requests",
        headers: auth(a.token),
        payload: { userId: b.id },
      });
      published.length = 0;
      // B asks A back → mutual consent → accepted.
      const res = await app.inject({
        method: "POST",
        url: "/friends/requests",
        headers: auth(b.token),
        payload: { userId: a.id },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { outcome: string }).outcome).toBe("auto_accepted");
      // The original requester (A) is told it was accepted; `friend` is B.
      const accepted = eventsFor(a.id, "friend.request_accepted");
      expect(accepted).toHaveLength(1);
      expect((accepted[0]!.event.payload as { friend: PublicUser }).friend.id).toBe(b.id);
    });

    it("already friends → 409", async () => {
      const a = await newUser("faa");
      const b = await newUser("fab");
      await befriend(a, b);
      const res = await app.inject({
        method: "POST",
        url: "/friends/requests",
        headers: auth(a.token),
        payload: { userId: b.id },
      });
      expect(res.statusCode).toBe(409);
    });
  });

  // =========================================================================
  // Friendships — add BY USERNAME (#111, the friend-code replacement)
  //
  // Two properties, and they pull in opposite directions — read both before
  // changing anything here.
  //
  // 1. EXISTENCE IS DISCLOSED (founder directive, 2026-07-28). An unknown
  //    username answers 404 USER_NOT_FOUND. The route used to answer a uniform
  //    200 to block enumeration, and the price was that anyone who mistyped a
  //    handle was told "sent" and then waited forever for a request that was
  //    never created. With real users on the product, that stopped being a
  //    theoretical trade.
  // 2. RELATIONSHIP STATE IS NOT. `already_pending` and `already_friends` still
  //    answer the same 200 as a fresh send, and a BLOCK and a SOFT-DELETED
  //    account answer the same 404 as an unknown handle — otherwise the change
  //    would have opened a fresh oracle for "did that person block me"
  //    (ADR 0017), which is the one thing a block exists to withhold.
  //
  // Because existence is now disclosed, the strict per-session rate limit is the
  // ONLY enumeration control left. Its test below is therefore load-bearing, not
  // decoration.
  // =========================================================================
  describe("friend requests by username (#111)", () => {
    const byUsername = (token: string, username: string) =>
      app.inject({
        method: "POST",
        url: "/friends/requests/by-username",
        headers: auth(token),
        payload: { username },
      });

    it("existing username → 200 { ok: true } + friend.request_received to target", async () => {
      const a = await newUser("bua");
      const b = await newUser("bub");
      published.length = 0;

      const res = await byUsername(a.token, b.username);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });

      const received = eventsFor(b.id, "friend.request_received");
      expect(received).toHaveLength(1);
      expect((received[0]!.event.payload as { requester: PublicUser }).requester.id).toBe(a.id);
      // Leak guard on the wire: the requester User carries no friendCode.
      expect(
        (received[0]!.event.payload as { requester: PublicUser }).requester.friendCode,
      ).toBeUndefined();
    });

    it("unknown username → 404 USER_NOT_FOUND, no event fanned out", async () => {
      const a = await newUser("bunf");
      published.length = 0;

      const res = await byUsername(a.token, `ghost_${suffix}_nope`);
      expect(res.statusCode).toBe(404);
      expect((res.json() as { error: { code: string } }).error.code).toBe("USER_NOT_FOUND");
      // Nothing created, nothing fanned out.
      expect(published.filter((m) => m.event.type === "friend.request_received")).toHaveLength(0);
    });

    it("a value that cannot BE a username → the same 404, not a shape error", async () => {
      // Old installed clients still post whatever the user typed, and the wire
      // envelope still accepts up to 64 chars. Anything that fails the real
      // username rule (too short, too long, illegal character) cannot match an
      // account, so it collapses into "no such user" — a message the user can
      // act on — rather than a 400 they cannot interpret.
      const a = await newUser("buinv");
      for (const bad of ["ab", "a".repeat(40), "ali.karagoz", "ali karagoz"]) {
        const res = await byUsername(a.token, bad);
        expect(res.statusCode).toBe(404);
        expect((res.json() as { error: { code: string } }).error.code).toBe("USER_NOT_FOUND");
      }
    });

    it("case-insensitive + tolerates a leading @", async () => {
      const a = await newUser("buci");
      const b = await newUser("bucib");
      published.length = 0;

      const res = await byUsername(a.token, `@${b.username.toUpperCase()}`);
      expect(res.statusCode).toBe(200);
      expect(eventsFor(b.id, "friend.request_received")).toHaveLength(1);
    });

    it("idempotent: a duplicate send stays 200 and creates no second request", async () => {
      const a = await newUser("budup");
      const b = await newUser("budup2");

      const first = await byUsername(a.token, b.username);
      expect(first.statusCode).toBe(200);
      published.length = 0;
      const second = await byUsername(a.token, b.username);
      expect(second.statusCode).toBe(200);
      expect(second.json()).toEqual({ ok: true });
      // Already-pending is a no-op in the core → no new event.
      expect(eventsFor(b.id, "friend.request_received")).toHaveLength(0);

      // And b still has exactly one incoming request from a.
      const incoming = await app.inject({
        method: "GET",
        url: "/friends/requests?direction=incoming",
        headers: auth(b.token),
      });
      const from = (incoming.json() as { requests: { user: PublicUser }[] }).requests.filter(
        (r) => r.user.id === a.id,
      );
      expect(from).toHaveLength(1);
    });

    it("already friends → still a plain 200 (relationship state is never reported)", async () => {
      const a = await newUser("buaf");
      const b = await newUser("buaf2");
      await befriend(a, b);

      const res = await byUsername(a.token, b.username);
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    });

    it("reverse-pending auto-accepts through the shared core (200 + request_accepted)", async () => {
      const a = await newUser("burp");
      const b = await newUser("burp2");
      // A asks B first (pending).
      await byUsername(a.token, b.username);
      published.length = 0;
      // B asks A back by username → mutual consent → accepted.
      const res = await byUsername(b.token, a.username);
      expect(res.statusCode).toBe(200);
      const accepted = eventsFor(a.id, "friend.request_accepted");
      expect(accepted).toHaveLength(1);
      expect((accepted[0]!.event.payload as { friend: PublicUser }).friend.id).toBe(b.id);
    });

    it("adding yourself → 400 (the one explicit rejection; reveals nothing about others)", async () => {
      const a = await newUser("buself");
      const res = await byUsername(a.token, a.username);
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
    });

    // LOAD-BEARING. Since 2026-07-28 this route tells a caller whether a username
    // exists, which makes this limit the only thing between it and a username
    // scraper: 10 attempts per session per 5 minutes means an attacker needs
    // their own authenticated session and ~35 hours for 5,000 guesses. If this
    // test is ever "fixed" by raising max or shortening the window, the route's
    // enumeration protection is gone, not weakened.
    it("strict rate limit (the ONLY enumeration control): the 11th send → 429", async () => {
      const a = await newUser("burl");
      // 10 attempts are allowed. They are FAILED lookups on purpose: a scraper's
      // attempts are misses, so misses must be counted by the limiter too.
      for (let i = 0; i < 10; i++) {
        const attempt = await byUsername(a.token, `rl_${suffix}_${i}`);
        expect(attempt.statusCode).toBe(404);
        expect((attempt.json() as { error: { code: string } }).error.code).toBe("USER_NOT_FOUND");
      }
      const blocked = await byUsername(a.token, `rl_${suffix}_over`);
      expect(blocked.statusCode).toBe(429);
      expect((blocked.json() as { error: { code: string } }).error.code).toBe("RATE_LIMITED");
    });
  });

  // =========================================================================
  // Friendships — accept / decline / cancel / unfriend / lists
  // =========================================================================
  describe("accept / remove", () => {
    it("only the addressee may accept; the requester accepting → 403", async () => {
      const a = await newUser("aca");
      const b = await newUser("acb");
      await app.inject({
        method: "POST",
        url: "/friends/requests",
        headers: auth(a.token),
        payload: { userId: b.id },
      });
      // Requester A tries to accept their own request.
      const selfAccept = await app.inject({
        method: "POST",
        url: `/friends/requests/${b.id}/accept`,
        headers: auth(a.token),
      });
      expect(selfAccept.statusCode).toBe(403);

      // Addressee B accepts → 200 + event to requester A.
      published.length = 0;
      const ok = await app.inject({
        method: "POST",
        url: `/friends/requests/${a.id}/accept`,
        headers: auth(b.token),
      });
      expect(ok.statusCode).toBe(200);
      expect(eventsFor(a.id, "friend.request_accepted")).toHaveLength(1);
    });

    it("accepting a non-existent request → 404", async () => {
      const a = await newUser("naa");
      const b = await newUser("nab");
      const res = await app.inject({
        method: "POST",
        url: `/friends/requests/${b.id}/accept`,
        headers: auth(a.token),
      });
      expect(res.statusCode).toBe(404);
    });

    it("lists incoming and outgoing pending requests by direction", async () => {
      const a = await newUser("lia");
      const b = await newUser("lib");
      await app.inject({
        method: "POST",
        url: "/friends/requests",
        headers: auth(a.token),
        payload: { userId: b.id },
      });

      const outgoing = await app.inject({
        method: "GET",
        url: "/friends/requests?direction=outgoing",
        headers: auth(a.token),
      });
      expect(outgoing.statusCode).toBe(200);
      const outList = (outgoing.json() as { requests: { user: PublicUser }[] }).requests;
      expect(outList.map((r) => r.user.id)).toContain(b.id);

      const incoming = await app.inject({
        method: "GET",
        url: "/friends/requests?direction=incoming",
        headers: auth(b.token),
      });
      const inList = (incoming.json() as { requests: { user: PublicUser }[] }).requests;
      expect(inList.map((r) => r.user.id)).toContain(a.id);
      // A has no incoming; B has no outgoing.
      const aIncoming = await app.inject({
        method: "GET",
        url: "/friends/requests?direction=incoming",
        headers: auth(a.token),
      });
      expect((aIncoming.json() as { requests: unknown[] }).requests).toHaveLength(0);
    });

    it("decline (addressee) removes the request + emits friend.removed to the requester", async () => {
      const a = await newUser("dca");
      const b = await newUser("dcb");
      await app.inject({
        method: "POST",
        url: "/friends/requests",
        headers: auth(a.token),
        payload: { userId: b.id },
      });
      published.length = 0;
      const res = await app.inject({
        method: "DELETE",
        url: `/friends/requests/${a.id}`,
        headers: auth(b.token),
      });
      expect(res.statusCode).toBe(204);
      const removed = eventsFor(a.id, "friend.removed");
      expect(removed).toHaveLength(1);
      // Payload carries the actor's id so the requester drops B (the actor).
      expect((removed[0]!.event.payload as { userId: string }).userId).toBe(b.id);
    });

    it("unfriend removes an accepted friendship + emits friend.removed", async () => {
      const a = await newUser("una");
      const b = await newUser("unb");
      await befriend(a, b);

      const friendsBefore = await app.inject({
        method: "GET",
        url: "/friends",
        headers: auth(a.token),
      });
      expect(
        (friendsBefore.json() as { friends: { user: PublicUser }[] }).friends.map(
          (f) => f.user.id,
        ),
      ).toContain(b.id);

      published.length = 0;
      const res = await app.inject({
        method: "DELETE",
        url: `/friends/${b.id}`,
        headers: auth(a.token),
      });
      expect(res.statusCode).toBe(204);
      expect(eventsFor(b.id, "friend.removed")).toHaveLength(1);

      const friendsAfter = await app.inject({
        method: "GET",
        url: "/friends",
        headers: auth(a.token),
      });
      expect(
        (friendsAfter.json() as { friends: { user: PublicUser }[] }).friends.map(
          (f) => f.user.id,
        ),
      ).not.toContain(b.id);
    });

    it("unfriending a non-friend → 404", async () => {
      const a = await newUser("nfa");
      const b = await newUser("nfb");
      const res = await app.inject({
        method: "DELETE",
        url: `/friends/${b.id}`,
        headers: auth(a.token),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // =========================================================================
  // DMs
  // =========================================================================
  describe("dms", () => {
    it("requires an accepted friendship → 403 for a stranger", async () => {
      const a = await newUser("dsa");
      const b = await newUser("dsb");
      const res = await app.inject({
        method: "POST",
        url: "/dms",
        headers: auth(a.token),
        payload: { userId: b.id },
      });
      expect(res.statusCode).toBe(403);
    });

    it("requires accepted friendship → 403 while only pending", async () => {
      const a = await newUser("dpa");
      const b = await newUser("dpb");
      await app.inject({
        method: "POST",
        url: "/friends/requests",
        headers: auth(a.token),
        payload: { userId: b.id },
      });
      const res = await app.inject({
        method: "POST",
        url: "/dms",
        headers: auth(a.token),
        payload: { userId: b.id },
      });
      expect(res.statusCode).toBe(403);
    });

    it("opening self DM → 400", async () => {
      const a = await newUser("dslf");
      const res = await app.inject({
        method: "POST",
        url: "/dms",
        headers: auth(a.token),
        payload: { userId: a.id },
      });
      expect(res.statusCode).toBe(400);
    });

    it("create is idempotent; dm.created fires once per participant, participant-relative", async () => {
      const a = await newUser("dia");
      const b = await newUser("dib");
      await befriend(a, b);
      published.length = 0;

      const first = await app.inject({
        method: "POST",
        url: "/dms",
        headers: auth(a.token),
        payload: { userId: b.id },
      });
      expect(first.statusCode).toBe(201);
      const dm = (first.json() as { dm: { id: string; streamId: string; participant: PublicUser } })
        .dm;
      // Caller's view: participant is the OTHER user (B).
      expect(dm.participant.id).toBe(b.id);

      // dm.created to A with participant B; to B with participant A.
      const toA = eventsFor(a.id, "dm.created");
      const toB = eventsFor(b.id, "dm.created");
      expect(toA).toHaveLength(1);
      expect(toB).toHaveLength(1);
      expect((toA[0]!.event.payload as { dm: { participant: PublicUser } }).dm.participant.id).toBe(
        b.id,
      );
      expect((toB[0]!.event.payload as { dm: { participant: PublicUser } }).dm.participant.id).toBe(
        a.id,
      );

      // Second call: same DM, 200, no new dm.created.
      published.length = 0;
      const second = await app.inject({
        method: "POST",
        url: "/dms",
        headers: auth(a.token),
        payload: { userId: b.id },
      });
      expect(second.statusCode).toBe(200);
      expect((second.json() as { dm: { id: string } }).dm.id).toBe(dm.id);
      expect(eventsFor(a.id, "dm.created")).toHaveLength(0);
      expect(eventsFor(b.id, "dm.created")).toHaveLength(0);
    });

    it("hide-for-self: absent from my list, present for the counterpart, reopen re-surfaces", async () => {
      const a = await newUser("dha");
      const b = await newUser("dhb");
      await befriend(a, b);
      const opened = await app.inject({
        method: "POST",
        url: "/dms",
        headers: auth(a.token),
        payload: { userId: b.id },
      });
      const dmId = (opened.json() as { dm: { id: string } }).dm.id;

      // A hides it.
      const hidden = await app.inject({
        method: "DELETE",
        url: `/dms/${dmId}`,
        headers: auth(a.token),
      });
      expect(hidden.statusCode).toBe(204);

      const aList = await app.inject({ method: "GET", url: "/dms", headers: auth(a.token) });
      expect((aList.json() as { dms: { id: string }[] }).dms.map((d) => d.id)).not.toContain(dmId);
      // B still sees it (counterpart untouched).
      const bList = await app.inject({ method: "GET", url: "/dms", headers: auth(b.token) });
      expect((bList.json() as { dms: { id: string }[] }).dms.map((d) => d.id)).toContain(dmId);

      // A re-opens via POST /dms → re-surfaces for A, no new dm.created.
      published.length = 0;
      const reopen = await app.inject({
        method: "POST",
        url: "/dms",
        headers: auth(a.token),
        payload: { userId: b.id },
      });
      expect(reopen.statusCode).toBe(200);
      expect(eventsFor(a.id, "dm.created")).toHaveLength(0);
      const aList2 = await app.inject({ method: "GET", url: "/dms", headers: auth(a.token) });
      expect((aList2.json() as { dms: { id: string }[] }).dms.map((d) => d.id)).toContain(dmId);
    });

    it("inbound message re-surfaces a hidden DM for the recipient (API side)", async () => {
      const a = await newUser("dma");
      const b = await newUser("dmb");
      await befriend(a, b);
      const opened = await app.inject({
        method: "POST",
        url: "/dms",
        headers: auth(a.token),
        payload: { userId: b.id },
      });
      const dm = (opened.json() as { dm: { id: string; streamId: string } }).dm;

      // B closes the DM.
      await app.inject({ method: "DELETE", url: `/dms/${dm.id}`, headers: auth(b.token) });
      const bHidden = await app.inject({ method: "GET", url: "/dms", headers: auth(b.token) });
      expect((bHidden.json() as { dms: { id: string }[] }).dms.map((d) => d.id)).not.toContain(
        dm.id,
      );

      // A sends a message into the DM stream → B's copy re-surfaces.
      const sent = await app.inject({
        method: "POST",
        url: `/channels/${dm.streamId}/messages`,
        headers: auth(a.token),
        payload: { content: "hey" },
      });
      expect(sent.statusCode).toBe(201);

      const bAfter = await app.inject({ method: "GET", url: "/dms", headers: auth(b.token) });
      expect((bAfter.json() as { dms: { id: string }[] }).dms.map((d) => d.id)).toContain(dm.id);
    });

    it("lastMessagePreview: null for an empty DM, then the latest message", async () => {
      const a = await newUser("dpva");
      const b = await newUser("dpvb");
      await befriend(a, b);
      const opened = await app.inject({
        method: "POST",
        url: "/dms",
        headers: auth(a.token),
        payload: { userId: b.id },
      });
      const dm = (opened.json() as { dm: { id: string; streamId: string } }).dm;

      // Fresh DM: no messages yet → preview is null.
      const empty = await app.inject({ method: "GET", url: "/dms", headers: auth(a.token) });
      const emptyRow = (
        empty.json() as { dms: { id: string; lastMessagePreview: unknown }[] }
      ).dms.find((d) => d.id === dm.id);
      expect(emptyRow?.lastMessagePreview).toBeNull();

      // A sends into the DM stream → both sides preview the latest message.
      const sent = await app.inject({
        method: "POST",
        url: `/channels/${dm.streamId}/messages`,
        headers: auth(a.token),
        payload: { content: "ping preview" },
      });
      expect(sent.statusCode).toBe(201);

      const after = await app.inject({ method: "GET", url: "/dms", headers: auth(b.token) });
      const row = (
        after.json() as {
          dms: {
            id: string;
            lastMessagePreview: {
              content: string;
              authorId: string;
              kind: string;
              createdAt: string;
            } | null;
          }[];
        }
      ).dms.find((d) => d.id === dm.id);
      expect(row?.lastMessagePreview).toMatchObject({
        content: "ping preview",
        authorId: a.id,
        kind: "user",
      });
      expect(typeof row?.lastMessagePreview?.createdAt).toBe("string");
    });

    it("deleting a DM you are not a member of → 404", async () => {
      const a = await newUser("dna");
      const b = await newUser("dnb");
      const c = await newUser("dnc");
      await befriend(a, b);
      const opened = await app.inject({
        method: "POST",
        url: "/dms",
        headers: auth(a.token),
        payload: { userId: b.id },
      });
      const dmId = (opened.json() as { dm: { id: string } }).dm.id;
      const res = await app.inject({
        method: "DELETE",
        url: `/dms/${dmId}`,
        headers: auth(c.token),
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // =========================================================================
  // Profile + friend code
  // =========================================================================
  describe("profile & friend code", () => {
    it("friendCode is returned ONLY by /users/me (never on other reads)", async () => {
      const a = await newUser("pca");
      const b = await newUser("pcb");
      const aSelf = await me(a.token);
      expect(aSelf.friendCode).toBeTruthy();

      // Other user reads A: no friendCode.
      const asUser = await app.inject({
        method: "GET",
        url: `/users/${a.id}`,
        headers: auth(b.token),
      });
      expect((asUser.json() as { user: PublicUser }).user.friendCode).toBeUndefined();

      const asProfile = await app.inject({
        method: "GET",
        url: `/users/${a.id}/profile`,
        headers: auth(b.token),
      });
      expect(
        (asProfile.json() as { profile: { user: PublicUser } }).profile.user.friendCode,
      ).toBeUndefined();
    });

    it("regenerate mints a new code and invalidates the old one", async () => {
      const a = await newUser("rga");
      const b = await newUser("rgb");
      const before = await me(a.token);
      const oldCode = before.friendCode!;

      const regen = await app.inject({
        method: "POST",
        url: "/users/me/friend-code/regenerate",
        headers: auth(a.token),
      });
      expect(regen.statusCode).toBe(200);
      const newCode = (regen.json() as { user: PublicUser }).user.friendCode!;
      expect(newCode).not.toBe(oldCode);

      // Old code no longer resolves.
      const stale = await app.inject({
        method: "POST",
        url: "/friends/requests",
        headers: auth(b.token),
        payload: { friendCode: oldCode },
      });
      expect(stale.statusCode).toBe(404);
      // New code resolves.
      const fresh = await app.inject({
        method: "POST",
        url: "/friends/requests",
        headers: auth(b.token),
        payload: { friendCode: newCode },
      });
      expect(fresh.statusCode).toBe(201);
    });

    it("bio: updates via PATCH, shows on profile, rejects > 280 chars", async () => {
      const a = await newUser("bia");
      const b = await newUser("bib");

      const patched = await app.inject({
        method: "PATCH",
        url: "/users/me",
        headers: auth(a.token),
        payload: { bio: "gamer, coffee, and long walks" },
      });
      expect(patched.statusCode).toBe(200);
      // Self response keeps friendCode and shows the new bio.
      const self = (patched.json() as { user: PublicUser }).user;
      expect(self.bio).toBe("gamer, coffee, and long walks");
      expect(self.friendCode).toBeTruthy();

      const profile = await app.inject({
        method: "GET",
        url: `/users/${a.id}/profile`,
        headers: auth(b.token),
      });
      expect((profile.json() as { profile: { user: PublicUser } }).profile.user.bio).toBe(
        "gamer, coffee, and long walks",
      );

      const tooLong = await app.inject({
        method: "PATCH",
        url: "/users/me",
        headers: auth(a.token),
        payload: { bio: "x".repeat(281) },
      });
      expect(tooLong.statusCode).toBe(400);
    });

    it("profile friendship status reflects the viewer→target relation", async () => {
      const a = await newUser("psa");
      const b = await newUser("psb");
      // none
      const none = await app.inject({
        method: "GET",
        url: `/users/${b.id}/profile`,
        headers: auth(a.token),
      });
      expect((none.json() as { profile: { friendship: string } }).profile.friendship).toBe("none");

      await app.inject({
        method: "POST",
        url: "/friends/requests",
        headers: auth(a.token),
        payload: { userId: b.id },
      });
      // A sees outgoing; B sees incoming.
      const outgoing = await app.inject({
        method: "GET",
        url: `/users/${b.id}/profile`,
        headers: auth(a.token),
      });
      expect((outgoing.json() as { profile: { friendship: string } }).profile.friendship).toBe(
        "outgoing",
      );
      const incoming = await app.inject({
        method: "GET",
        url: `/users/${a.id}/profile`,
        headers: auth(b.token),
      });
      expect((incoming.json() as { profile: { friendship: string } }).profile.friendship).toBe(
        "incoming",
      );

      await app.inject({
        method: "POST",
        url: `/friends/requests/${a.id}/accept`,
        headers: auth(b.token),
      });
      const friends = await app.inject({
        method: "GET",
        url: `/users/${b.id}/profile`,
        headers: auth(a.token),
      });
      expect((friends.json() as { profile: { friendship: string } }).profile.friendship).toBe(
        "friends",
      );
    });

    it("roles are gated on shared-server membership", async () => {
      const owner = await newUser("rowner");
      const member = await newUser("rmember");
      const outsider = await newUser("routsider");

      // Owner creates a server; member joins via invite; outsider stays out.
      const created = await app.inject({
        method: "POST",
        url: "/groups",
        headers: auth(owner.token),
        payload: { name: "Role Server" },
      });
      const serverId = (created.json() as { group: { id: string } }).group.id;
      const invite = await app.inject({
        method: "POST",
        url: `/groups/${serverId}/invites`,
        headers: auth(owner.token),
        payload: {},
      });
      const code = (invite.json() as { invite: { code: string } }).invite.code;
      await app.inject({
        method: "POST",
        url: `/invites/${code}/redeem`,
        headers: auth(member.token),
      });

      // Both members → roles present (array, possibly empty).
      const shared = await app.inject({
        method: "GET",
        url: `/users/${member.id}/profile?groupId=${serverId}`,
        headers: auth(owner.token),
      });
      expect((shared.json() as { profile: { roles?: unknown[] } }).profile.roles).toBeDefined();

      // Viewer in server, target (outsider) not → roles omitted.
      const notShared = await app.inject({
        method: "GET",
        url: `/users/${outsider.id}/profile?groupId=${serverId}`,
        headers: auth(owner.token),
      });
      expect(
        (notShared.json() as { profile: { roles?: unknown[] } }).profile.roles,
      ).toBeUndefined();

      // No groupId → roles omitted even between members.
      const noContext = await app.inject({
        method: "GET",
        url: `/users/${member.id}/profile`,
        headers: auth(owner.token),
      });
      expect(
        (noContext.json() as { profile: { roles?: unknown[] } }).profile.roles,
      ).toBeUndefined();
    });
  });
});
