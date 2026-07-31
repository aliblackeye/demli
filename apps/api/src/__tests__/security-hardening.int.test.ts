/**
 * Security-hardening integration tests (Phase F) — run against the real
 * Postgres from docker-compose. Skipped (with a notice) when the DB is down.
 *
 * Covers:
 *   H1 — trustProxy keys rate limits on the real client IP (X-Forwarded-For),
 *        so two clients behind Caddy get independent buckets; plus the
 *        per-username login throttle that blocks one account across many IPs.
 *   M2 — POST /auth/logout-all revokes every session for the user.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { applyMigrations, createDb, createRepositories, type DbClient } from "@demli/db";
import { buildApp } from "../app.js";
import { loadEnv } from "../env.js";
import { LOGIN_MAX_FAILURES } from "../lib/login-rate-limiter.js";
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
  console.warn("[security-hardening.int.test] DATABASE unreachable — skipping integration tests");
}

describe.skipIf(!dbUp)("security hardening — rate limiting (H1)", () => {
  let client: DbClient;
  let app: FastifyInstance;
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

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

  const login = (username: string, forwardedFor: string) =>
    app.inject({
      method: "POST",
      url: "/auth/login",
      headers: { "x-forwarded-for": forwardedFor },
      payload: { username, password: "nope-nope-nope" },
    });

  // The per-IP login limit is 10 / 5min (auth module). With trustProxy on,
  // request.ip is taken from X-Forwarded-For, so each client IP gets its own
  // bucket. If trustProxy were off, every request would share Caddy's IP and
  // the second client below would also be throttled.
  it("keys the per-IP login limit on the forwarded client IP (independent buckets)", async () => {
    const ipA = "203.0.113.7";
    const ipB = "203.0.113.8";

    // 10 allowed attempts from ipA (distinct usernames so the per-username
    // throttle never fires), then the 11th is blocked for ipA.
    for (let i = 0; i < 10; i++) {
      const res = await login(`ipkey_${suffix}_${i}`, ipA);
      expect(res.statusCode).toBe(401);
    }
    const blocked = await login(`ipkey_${suffix}_last`, ipA);
    expect(blocked.statusCode).toBe(429);

    // A different client IP still has a fresh bucket -> not throttled.
    const other = await login(`ipkey_${suffix}_other`, ipB);
    expect(other.statusCode).toBe(401);
  });

  // Second dimension: the same username hammered from many different IPs is
  // throttled even though no single IP trips the per-IP limit.
  it("throttles one username brute-forced across many IPs", async () => {
    const username = `unamekey_${suffix}`;

    for (let i = 0; i < LOGIN_MAX_FAILURES; i++) {
      // A unique IP per attempt so the per-IP limiter never fires here.
      const res = await login(username, `198.51.100.${i + 1}`);
      expect(res.statusCode).toBe(401);
    }
    const blocked = await login(username, "198.51.100.200");
    expect(blocked.statusCode).toBe(429);
  });
});

describe.skipIf(!dbUp)("security hardening — revoke all sessions (M2)", () => {
  let client: DbClient;
  let app: FastifyInstance;
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const username = `revoke_${suffix}`;
  const password = "correct-horse-9";

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

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  it("POST /auth/logout-all revokes every session for the user", async () => {
    const token1 = (
      await app.inject({
        method: "POST",
        url: "/auth/register",
        payload: { username, password, displayName: "Revoke" },
      })
    ).json().token as string;

    // A second, independent session for the same user.
    const token2 = (
      await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { username, password },
      })
    ).json().token as string;

    // Both sessions are live.
    expect((await app.inject({ method: "GET", url: "/users/me", headers: auth(token1) })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/users/me", headers: auth(token2) })).statusCode).toBe(200);

    // Revoke everything using one of them.
    const revoke = await app.inject({
      method: "POST",
      url: "/auth/logout-all",
      headers: auth(token1),
    });
    expect(revoke.statusCode).toBe(204);

    // Every session — including the caller's own — is now invalid.
    expect((await app.inject({ method: "GET", url: "/users/me", headers: auth(token1) })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/users/me", headers: auth(token2) })).statusCode).toBe(401);
  });
});
