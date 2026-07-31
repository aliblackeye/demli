/**
 * #98 — the session-revoke → realtime kick fan-out (integration).
 *
 * Real Postgres (auto-skips when unreachable). Builds the app with an
 * InMemoryMutationBus and captures everything published, then asserts that the
 * two revoke routes emit a USER-scoped `session.revoked` naming exactly the
 * sessions they closed. The gateway-side kick (forward + 4401 close) is proven
 * separately in apps/realtime; here we only assert the API's publish contract.
 *
 * Unique `x-forwarded-for` per auth request so the per-IP register/login rate
 * limits never collapse the suite into one bucket (trustProxy on).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  applyMigrations,
  createDb,
  createRepositories,
  InMemoryMutationBus,
  type DbClient,
  type RealtimeMutation,
} from "@demli/db";
import { SERVER_EVENT } from "@demli/protocol";
import { refuseToSkipIfRequired } from "@demli/db/testing";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/demli";

async function isDbUp(): Promise<boolean> {
  const { sql, close } = createDb(DATABASE_URL, { max: 1 });
  try {
    await sql`select 1`;
    return true;
  } finally {
    await close().catch(() => undefined);
  }
}

let dbUp = false;
try {
  dbUp = await isDbUp();
} catch {
  dbUp = false;
}
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[session-kick.int.test] DATABASE unreachable — skipping");
}

interface SessionSummaryDTO {
  id: string;
  current: boolean;
}

describe.skipIf(!dbUp)("session revoke → realtime kick fan-out (#98)", () => {
  let client: DbClient;
  let app: FastifyInstance;
  const bus = new InMemoryMutationBus();
  const published: RealtimeMutation[] = [];

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let seq = 0;
  let ipSeq = 0;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const nextIp = () => {
    ipSeq += 1;
    return `10.${(ipSeq >> 16) & 0xff}.${(ipSeq >> 8) & 0xff}.${ipSeq & 0xff}`;
  };

  async function register(): Promise<{ token: string; id: string; username: string }> {
    seq += 1;
    const username = `kick${seq}_${suffix}`;
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      headers: { "x-forwarded-for": nextIp() },
      payload: { username, password: "password123" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { token: string; user: { id: string } };
    return { token: body.token, id: body.user.id, username };
  }

  async function login(username: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "x-forwarded-for": nextIp() },
      payload: { username, password: "password123" },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { token: string }).token;
  }

  async function listSessions(token: string): Promise<SessionSummaryDTO[]> {
    const res = await app.inject({ method: "GET", url: "/sessions", headers: auth(token) });
    expect(res.statusCode).toBe(200);
    return (res.json() as { sessions: SessionSummaryDTO[] }).sessions;
  }

  /** The `session.revoked` mutations captured for one user, newest last. */
  function revokedFor(userId: string): string[][] {
    return published
      .filter((m) => m.userId === userId && m.event.type === SERVER_EVENT.sessionRevoked)
      .map((m) =>
        m.event.type === SERVER_EVENT.sessionRevoked ? m.event.payload.sessionIds : [],
      );
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    await bus.subscribe((m) => published.push(m));
    app = await buildApp({
      repos: createRepositories(client.db),
      env: loadEnv({ DATABASE_URL }),
      mutationBus: bus,
      logger: false,
    });
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("DELETE /sessions/:id publishes a user-scoped session.revoked naming that session", async () => {
    const user = await register();
    const secondToken = await login(user.username);

    // From the second session, close the OTHER (non-current) session.
    const before = await listSessions(secondToken);
    const other = before.find((s) => !s.current)!;

    const del = await app.inject({
      method: "DELETE",
      url: `/sessions/${other.id}`,
      headers: auth(secondToken),
    });
    expect(del.statusCode).toBe(204);

    // Exactly one kick event, user-scoped, naming exactly the closed session.
    const kicks = revokedFor(user.id);
    expect(kicks).toHaveLength(1);
    expect(kicks[0]).toEqual([other.id]);
  });

  it("DELETE /sessions/others publishes session.revoked naming every OTHER session", async () => {
    const user = await register();
    const secondToken = await login(user.username);
    const thirdToken = await login(user.username);

    const before = await listSessions(thirdToken);
    const others = before.filter((s) => !s.current).map((s) => s.id);
    expect(others).toHaveLength(2);

    const startCount = revokedFor(user.id).length;
    const res = await app.inject({
      method: "DELETE",
      url: "/sessions/others",
      headers: auth(thirdToken),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { revoked: number }).revoked).toBe(2);

    const kicks = revokedFor(user.id);
    expect(kicks).toHaveLength(startCount + 1);
    // Same set of ids (order not guaranteed — listForUser orders by last_seen).
    expect([...kicks.at(-1)!].sort()).toEqual([...others].sort());
    // The surviving current session is NEVER named (it must stay connected).
    const current = before.find((s) => s.current)!;
    expect(kicks.at(-1)).not.toContain(current.id);

    // Tokens are dead too (the DB delete is the source of truth).
    expect(
      (await app.inject({ method: "GET", url: "/sessions", headers: auth(secondToken) })).statusCode,
    ).toBe(401);
  });

  it("DELETE /sessions/others with only the current session publishes nothing", async () => {
    const user = await register();
    const startCount = revokedFor(user.id).length;

    const res = await app.inject({
      method: "DELETE",
      url: "/sessions/others",
      headers: auth(user.token),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { revoked: number }).revoked).toBe(0);

    // No sessions to kick → no event (the gateway is never woken pointlessly).
    expect(revokedFor(user.id)).toHaveLength(startCount);
  });
});
