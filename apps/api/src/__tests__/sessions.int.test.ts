/**
 * M15-A — active-session endpoints + auth-metadata flow (integration).
 *
 * Real Postgres from docker-compose (auto-skips when unreachable). Exercises the
 * full HTTP path through buildApp: login/register carry optional device metadata,
 * GET /sessions lists the caller's own sessions (current flagged), and the two
 * revoke routes close sessions such that the closed token then fails auth (401).
 *
 * Each register/login uses a UNIQUE `x-forwarded-for` so the per-IP auth rate
 * limits (register 5/15m, login 10/5m) never collapse the suite into one bucket
 * (trustProxy is on, so request.ip reflects the forwarded value).
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  applyMigrations,
  createDb,
  createRepositories,
  type DbClient,
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
  console.warn("[sessions.int.test] DATABASE unreachable — skipping");
}

interface SessionSummaryDTO {
  id: string;
  deviceName: string | null;
  platform: string | null;
  lastSeenAt: string;
  createdAt: string;
  current: boolean;
}

describe.skipIf(!dbUp)("active sessions (M15-A)", () => {
  let client: DbClient;
  let app: FastifyInstance;

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let seq = 0;
  let ipSeq = 0;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  /** Fresh IP per call so each auth request lands in its own rate-limit bucket. */
  const nextIp = () => {
    ipSeq += 1;
    return `10.${(ipSeq >> 16) & 0xff}.${(ipSeq >> 8) & 0xff}.${ipSeq & 0xff}`;
  };

  interface Registered {
    token: string;
    id: string;
  }

  async function register(
    meta: { deviceName?: string; platform?: string } = {},
  ): Promise<Registered> {
    seq += 1;
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      headers: { "x-forwarded-for": nextIp() },
      payload: { username: `sess${seq}_${suffix}`, password: "password123", ...meta },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { token: string; user: { id: string } };
    return { token: body.token, id: body.user.id };
  }

  /** A second session for an already-registered user (a distinct login). */
  async function login(
    username: string,
    meta: { deviceName?: string; platform?: string } = {},
  ): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "x-forwarded-for": nextIp() },
      payload: { username, password: "password123", ...meta },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { token: string }).token;
  }

  function usernameOf(seqAtRegister: number): string {
    return `sess${seqAtRegister}_${suffix}`;
  }

  async function listSessions(token: string): Promise<SessionSummaryDTO[]> {
    const res = await app.inject({ method: "GET", url: "/sessions", headers: auth(token) });
    expect(res.statusCode).toBe(200);
    return (res.json() as { sessions: SessionSummaryDTO[] }).sessions;
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    app = await buildApp({
      repos: createRepositories(client.db),
      env: loadEnv({ DATABASE_URL }),
      logger: false,
    });
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("requires authentication on every route", async () => {
    expect((await app.inject({ method: "GET", url: "/sessions" })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "DELETE", url: "/sessions/others" })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "DELETE", url: `/sessions/${randomUUID()}` })).statusCode,
    ).toBe(401);
  });

  it("records device metadata from register and flags the current session", async () => {
    const user = await register({ deviceName: "Pixel 7", platform: "mobile" });
    const sessions = await listSessions(user.token);

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      deviceName: "Pixel 7",
      platform: "mobile",
      current: true,
    });
    expect(sessions[0]!.lastSeenAt).toBeTruthy();
    expect(sessions[0]!.createdAt).toBeTruthy();
    // The token hash is never exposed on the DTO.
    expect(sessions[0]).not.toHaveProperty("tokenHash");
  });

  it("lists multiple sessions and flags only the requesting one as current", async () => {
    await register({ deviceName: "Laptop", platform: "desktop" });
    const secondToken = await login(usernameOf(seq), { deviceName: "Phone", platform: "mobile" });

    const viaSecond = await listSessions(secondToken);
    expect(viaSecond).toHaveLength(2);
    const current = viaSecond.filter((s) => s.current);
    expect(current).toHaveLength(1);
    expect(current[0]!.deviceName).toBe("Phone");
    expect(viaSecond.map((s) => s.deviceName).sort()).toEqual(["Laptop", "Phone"]);
  });

  it("DELETE /sessions/:id closes another session; its token then fails auth (401)", async () => {
    const first = await register({ deviceName: "Old", platform: "desktop" });
    const secondToken = await login(usernameOf(seq), { deviceName: "New", platform: "mobile" });

    // From the second session, find and close the OTHER (non-current) session.
    const before = await listSessions(secondToken);
    const other = before.find((s) => !s.current)!;
    expect(other.deviceName).toBe("Old");

    const del = await app.inject({
      method: "DELETE",
      url: `/sessions/${other.id}`,
      headers: auth(secondToken),
    });
    expect(del.statusCode).toBe(204);

    // The closed session's token no longer authenticates.
    expect(
      (await app.inject({ method: "GET", url: "/sessions", headers: auth(first.token) })).statusCode,
    ).toBe(401);
    // The surviving session sees only itself.
    const after = await listSessions(secondToken);
    expect(after).toHaveLength(1);
    expect(after[0]!.current).toBe(true);
  });

  it("cannot close another user's session (404, no leak) and leaves it working", async () => {
    const victim = await register({ deviceName: "Victim" });
    const attacker = await register({ deviceName: "Attacker" });

    const victimSession = (await listSessions(victim.token))[0]!;

    const del = await app.inject({
      method: "DELETE",
      url: `/sessions/${victimSession.id}`,
      headers: auth(attacker.token),
    });
    expect(del.statusCode).toBe(404);

    // The victim's session is untouched.
    expect(
      (await app.inject({ method: "GET", url: "/sessions", headers: auth(victim.token) })).statusCode,
    ).toBe(200);
  });

  it("rejects a non-uuid session id with 400", async () => {
    const user = await register();
    const del = await app.inject({
      method: "DELETE",
      url: "/sessions/not-a-uuid",
      headers: auth(user.token),
    });
    expect(del.statusCode).toBe(400);
  });

  it("DELETE /sessions/others closes every other session and keeps the current one", async () => {
    const first = await register({ deviceName: "S1" });
    const username = usernameOf(seq);
    const secondToken = await login(username, { deviceName: "S2" });
    const thirdToken = await login(username, { deviceName: "S3" });

    // Three live sessions.
    expect(await listSessions(thirdToken)).toHaveLength(3);

    const res = await app.inject({
      method: "DELETE",
      url: "/sessions/others",
      headers: auth(thirdToken),
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { revoked: number }).revoked).toBe(2);

    // Only the caller's session survives; the other two tokens are dead.
    const after = await listSessions(thirdToken);
    expect(after).toHaveLength(1);
    expect(after[0]!.current).toBe(true);
    expect(
      (await app.inject({ method: "GET", url: "/sessions", headers: auth(first.token) })).statusCode,
    ).toBe(401);
    expect(
      (await app.inject({ method: "GET", url: "/sessions", headers: auth(secondToken) })).statusCode,
    ).toBe(401);
  });

  it("revoking the current session logs this device out", async () => {
    const user = await register();
    const session = (await listSessions(user.token))[0]!;
    expect(session.current).toBe(true);

    const del = await app.inject({
      method: "DELETE",
      url: `/sessions/${session.id}`,
      headers: auth(user.token),
    });
    expect(del.statusCode).toBe(204);
    expect(
      (await app.inject({ method: "GET", url: "/sessions", headers: auth(user.token) })).statusCode,
    ).toBe(401);
  });

  it("is backward-compatible: auth without device fields stores null metadata", async () => {
    const user = await register();
    const sessions = await listSessions(user.token);
    expect(sessions[0]).toMatchObject({ deviceName: null, platform: null });
  });

  it("does not fail auth on a blank/over-long name or an unknown platform (lenient)", async () => {
    const longName = "x".repeat(400);
    const user = await register({ deviceName: longName, platform: "web-tv" });
    const sessions = await listSessions(user.token);
    // Name truncated to the 120-char cap; unknown platform coerced to null.
    expect(sessions[0]!.deviceName!.length).toBe(120);
    expect(sessions[0]!.platform).toBeNull();
  });
});
