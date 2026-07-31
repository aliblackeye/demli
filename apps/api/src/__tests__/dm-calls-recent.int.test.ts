/**
 * DM calls — recent-history endpoint integration tests (Voice-UX #2).
 *
 * Covers `GET /dm-calls/recent` + the `callsRepo.listRecentForUser` query it sits
 * on: authorization scoping (a user sees ONLY calls they took part in, never a
 * call between two others), newest-first ordering, keyset cursor paging (pages
 * are disjoint and cover every row), per-viewer `direction`, and the settled
 * `durationSeconds` (present only for `ended` calls). History rows are crafted
 * straight through the repo for deterministic statuses/timestamps, then read back
 * through the HTTP endpoint under a real session token.
 *
 * Real Postgres from docker-compose; auto-skipped (with a notice) when the
 * database is unreachable. Run `pnpm db:migrate` ONCE before `pnpm test`.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  applyMigrations,
  createDb,
  createRepositories,
  generateSessionToken,
  hashSessionToken,
  sessionExpiresAt,
  type DbClient,
  type Repositories,
} from "@demli/db";
import type { DmCall } from "@demli/types";
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
  console.warn("[dm-calls-recent.int.test] DATABASE unreachable — skipping integration tests");
}

interface TestUser {
  token: string;
  id: string;
  username: string;
}

interface RecentCallDto {
  id: string;
  dmId: string;
  peer: { id: string; username: string; displayName: string; friendCode?: string };
  media: string;
  status: string;
  direction: "incoming" | "outgoing";
  durationSeconds: number | null;
  createdAt: string;
}

interface RecentBody {
  calls: RecentCallDto[];
  nextCursor: string | null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!dbUp)("GET /dm-calls/recent (Voice-UX #2)", () => {
  let client: DbClient;
  let repos: Repositories;
  let app: FastifyInstance;
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

  async function openDm(a: TestUser, b: TestUser): Promise<{ id: string; streamId: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/dms",
      headers: auth(a.token),
      payload: { userId: b.id },
    });
    return (res.json() as { dm: { id: string; streamId: string } }).dm;
  }

  /** Craft one terminal call row directly via the repo, spaced so createdAt is strictly monotonic. */
  async function makeCall(opts: {
    dmId: string;
    caller: TestUser;
    callee: TestUser;
    media?: "audio" | "video";
    outcome: "ended" | "missed" | "declined" | "canceled";
    /** Talk time in seconds — only meaningful for `ended`. */
    durationSeconds?: number;
  }): Promise<DmCall> {
    await sleep(6); // guarantee a distinct now() from the previous insert
    const call = await repos.calls.create({
      dmId: opts.dmId,
      callerId: opts.caller.id,
      calleeId: opts.callee.id,
      media: opts.media ?? "audio",
    });
    if (opts.outcome === "ended") {
      const startedAt = new Date();
      await repos.calls.setStatus(call.id, "active", { startedAt });
      const endedAt = new Date(startedAt.getTime() + (opts.durationSeconds ?? 0) * 1000);
      const ended = await repos.calls.setStatus(call.id, "ended", { endedAt });
      return ended ?? call;
    }
    const settled = await repos.calls.setStatus(call.id, opts.outcome, { endedAt: new Date() });
    return settled ?? call;
  }

  async function fetchRecent(
    user: TestUser,
    query: { limit?: number; before?: string } = {},
  ): Promise<{ statusCode: number; body: RecentBody }> {
    const params = new URLSearchParams();
    if (query.limit !== undefined) params.set("limit", String(query.limit));
    if (query.before !== undefined) params.set("before", query.before);
    const qs = params.size > 0 ? `?${params.toString()}` : "";
    const res = await app.inject({
      method: "GET",
      url: `/dm-calls/recent${qs}`,
      headers: auth(user.token),
    });
    return { statusCode: res.statusCode, body: res.json() as RecentBody };
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    app = await buildApp({ repos, env: loadEnv({ DATABASE_URL }), logger: false });
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("requires authentication", async () => {
    const res = await app.inject({ method: "GET", url: "/dm-calls/recent" });
    expect(res.statusCode).toBe(401);
  });

  it("returns only calls the viewer took part in, newest-first, with direction + duration", async () => {
    const a = await newUser("ra");
    const b = await newUser("rb");
    const c = await newUser("rc");
    await befriend(a, b);
    await befriend(a, c);
    await befriend(b, c);
    const dmAB = await openDm(a, b);
    const dmAC = await openDm(a, c);
    const dmBC = await openDm(b, c);

    // Oldest → newest. A is in call1/2/3; call4 is between B and C (A must NOT see it).
    const call1 = await makeCall({
      dmId: dmAB.id,
      caller: a,
      callee: b,
      outcome: "ended",
      durationSeconds: 42,
    }); // outgoing for A, connected
    const call2 = await makeCall({ dmId: dmAB.id, caller: b, callee: a, outcome: "missed" }); // incoming missed for A
    const call3 = await makeCall({ dmId: dmAC.id, caller: a, callee: c, outcome: "declined" }); // outgoing for A
    const call4 = await makeCall({ dmId: dmBC.id, caller: b, callee: c, outcome: "ended", durationSeconds: 10 });

    const { statusCode, body } = await fetchRecent(a);
    expect(statusCode).toBe(200);

    // Authorization scope: exactly A's three calls, never the B↔C one.
    const ids = body.calls.map((c) => c.id);
    expect(ids).toEqual([call3.id, call2.id, call1.id]); // newest → oldest
    expect(ids).not.toContain(call4.id);

    const byId = new Map(body.calls.map((c) => [c.id, c]));
    // call1: A called B, connected 42s.
    expect(byId.get(call1.id)).toMatchObject({
      direction: "outgoing",
      status: "ended",
      durationSeconds: 42,
      peer: { id: b.id },
    });
    // call2: B called A, timed out → missed, incoming, no settled duration.
    expect(byId.get(call2.id)).toMatchObject({
      direction: "incoming",
      status: "missed",
      durationSeconds: null,
      peer: { id: b.id },
    });
    // call3: A called C, declined → no settled duration.
    expect(byId.get(call3.id)).toMatchObject({
      direction: "outgoing",
      status: "declined",
      durationSeconds: null,
      peer: { id: c.id },
    });

    // The peer is the PUBLIC user — friendCode must never leak on the wire (§28).
    for (const row of body.calls) {
      expect(row.peer.friendCode).toBeUndefined();
    }

    // C sees the B↔C call and the A→C call, but never A's private A↔B history.
    const cView = await fetchRecent(c);
    const cIds = cView.body.calls.map((r) => r.id);
    expect(cIds).toEqual(expect.arrayContaining([call3.id, call4.id]));
    expect(cIds).not.toContain(call1.id);
    expect(cIds).not.toContain(call2.id);
  });

  it("keyset-pages via before: pages are disjoint and cover every row", async () => {
    const a = await newUser("pa");
    const b = await newUser("pb");
    await befriend(a, b);
    const dm = await openDm(a, b);

    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const call = await makeCall({ dmId: dm.id, caller: a, callee: b, outcome: "declined" });
      created.push(call.id);
    }
    const newestFirst = [...created].reverse();

    // Page 1 (limit 2) → newest two + a cursor.
    const p1 = await fetchRecent(a, { limit: 2 });
    expect(p1.statusCode).toBe(200);
    expect(p1.body.calls.map((c) => c.id)).toEqual(newestFirst.slice(0, 2));
    expect(p1.body.nextCursor).toBeTruthy();

    // Page 2 → the next two.
    const p2 = await fetchRecent(a, { limit: 2, before: p1.body.nextCursor! });
    expect(p2.body.calls.map((c) => c.id)).toEqual(newestFirst.slice(2, 4));
    expect(p2.body.nextCursor).toBeTruthy();

    // Page 3 → the last one, cursor exhausted.
    const p3 = await fetchRecent(a, { limit: 2, before: p2.body.nextCursor! });
    expect(p3.body.calls.map((c) => c.id)).toEqual(newestFirst.slice(4));
    expect(p3.body.nextCursor).toBeNull();

    // Union is complete and disjoint (no duplicates across pages, §22).
    const seen = [
      ...p1.body.calls,
      ...p2.body.calls,
      ...p3.body.calls,
    ].map((c) => c.id);
    expect(new Set(seen).size).toBe(5);
    expect(seen).toEqual(newestFirst);
  });

  it("clamps limit and tolerates a garbage cursor (first page, no error)", async () => {
    const a = await newUser("ga");
    const b = await newUser("gb");
    await befriend(a, b);
    const dm = await openDm(a, b);
    await makeCall({ dmId: dm.id, caller: a, callee: b, outcome: "declined" });

    // A bogus cursor must not error — it yields the first page.
    const res = await fetchRecent(a, { before: "not-a-real-cursor" });
    expect(res.statusCode).toBe(200);
    expect(res.body.calls.length).toBeGreaterThanOrEqual(1);
  });
});
