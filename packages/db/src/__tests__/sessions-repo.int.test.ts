/**
 * M15-A — sessions repo metadata + active-session management (integration).
 *
 * Real Postgres from docker-compose (auto-skips when unreachable). A green run
 * also proves migration 0014 (device_name / platform / last_seen_at) applies
 * cleanly, since `applyMigrations` runs in beforeAll.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createDb,
  createRepositories,
  hashSessionToken,
  sessionExpiresAt,
  type DbClient,
  type Repositories,
} from "../index.js";
import { refuseToSkipIfRequired } from "../testing.js";

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

/** Unique per row so parallel suites never collide. */
function uniq(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[sessions-repo.int.test] DATABASE unreachable — skipping");
}

describe.skipIf(!dbUp)("sessionsRepo (live Postgres, M15-A)", () => {
  let client: DbClient;
  let repos: Repositories;

  async function newUser(prefix: string): Promise<string> {
    const u = await repos.users.create({
      username: uniq(prefix),
      displayName: prefix,
      passwordHash: "not-used",
    });
    return u.id;
  }

  /** Create a session for `userId`; returns its row plus the raw token. */
  async function newSession(
    userId: string,
    opts: { deviceName?: string | null; platform?: "desktop" | "mobile" | null; ttlHours?: number } = {},
  ) {
    const token = uniq("tok");
    const session = await repos.sessions.create({
      userId,
      tokenHash: hashSessionToken(token),
      expiresAt: sessionExpiresAt(new Date(), opts.ttlHours ?? 24),
      deviceName: opts.deviceName,
      platform: opts.platform,
    });
    return { session, token };
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
  });

  afterAll(async () => {
    await client?.close();
  });

  it("persists device metadata on create and defaults it to null", async () => {
    const userId = await newUser("meta");

    const withMeta = await newSession(userId, { deviceName: "Pixel 7", platform: "mobile" });
    expect(withMeta.session.deviceName).toBe("Pixel 7");
    expect(withMeta.session.platform).toBe("mobile");
    expect(withMeta.session.lastSeenAt).toBeTruthy();

    const bare = await newSession(userId);
    expect(bare.session.deviceName).toBeNull();
    expect(bare.session.platform).toBeNull();
  });

  it("listForUser returns only the caller's active sessions, newest-active first", async () => {
    const userId = await newUser("list");
    const other = await newUser("list_other");

    const a = await newSession(userId, { deviceName: "A" });
    const b = await newSession(userId, { deviceName: "B" });
    await newSession(other, { deviceName: "not-mine" });

    // Stamp both from the SAME clock so ordering is deterministic (avoids any
    // JS-vs-Postgres clock skew between `create`'s default now() and a touch).
    const base = Date.now();
    await repos.sessions.touchLastSeen(b.session.id, new Date(base + 1000));
    await repos.sessions.touchLastSeen(a.session.id, new Date(base + 2000));

    const list = await repos.sessions.listForUser(userId);
    expect(list.map((s) => s.id)).toEqual([a.session.id, b.session.id]);
    // The other user's session never appears.
    expect(list.some((s) => s.userId === other)).toBe(false);
  });

  it("listForUser excludes expired sessions", async () => {
    const userId = await newUser("exp");
    const live = await newSession(userId, { deviceName: "live" });
    // Directly seed an already-expired session (create clamps expiresAt forward).
    const expiredToken = uniq("tok");
    await repos.sessions.create({
      userId,
      tokenHash: hashSessionToken(expiredToken),
      expiresAt: new Date(Date.now() - 60_000),
    });

    const list = await repos.sessions.listForUser(userId);
    expect(list.map((s) => s.id)).toEqual([live.session.id]);
  });

  it("touchLastSeen bumps the timestamp and reports unknown ids", async () => {
    const userId = await newUser("touch");
    const { session } = await newSession(userId);

    // Derived from the row's OWN timestamp, not from `Date.now()`.
    //
    // `lastSeenAt` is written by Postgres, so it carries the DATABASE clock,
    // while `Date.now()` carries this process's. Those are different machines
    // under Docker: a freshly started Docker Desktop VM sits seconds ahead of the
    // host (measured: +10s right after a reboot), which is exactly the offset
    // this test used to add — so "later than before" came down to which clock
    // drifted further, and the assertion was a coin flip rather than a check of
    // `touchLastSeen`. Basing the future on the value the database itself
    // produced removes the second clock from the comparison entirely.
    const future = new Date(new Date(session.lastSeenAt).getTime() + 10_000);
    expect(await repos.sessions.touchLastSeen(session.id, future)).toBe(true);

    const [after] = await repos.sessions.listForUser(userId);
    expect(new Date(after!.lastSeenAt).getTime()).toBeGreaterThan(
      new Date(session.lastSeenAt).getTime(),
    );

    // A non-existent session id touches nothing.
    expect(await repos.sessions.touchLastSeen(crypto.randomUUID())).toBe(false);
  });

  it("revoke is scoped to the owner — a foreign id removes nothing", async () => {
    const owner = await newUser("rev_own");
    const attacker = await newUser("rev_atk");
    const { session } = await newSession(owner);

    // Attacker cannot close the owner's session.
    expect(await repos.sessions.revoke(session.id, attacker)).toBe(false);
    expect((await repos.sessions.listForUser(owner)).map((s) => s.id)).toContain(session.id);

    // The owner can.
    expect(await repos.sessions.revoke(session.id, owner)).toBe(true);
    expect((await repos.sessions.listForUser(owner)).map((s) => s.id)).not.toContain(session.id);
    // Idempotent: revoking again is a no-op false.
    expect(await repos.sessions.revoke(session.id, owner)).toBe(false);
  });

  it("a revoked session's token no longer resolves", async () => {
    const userId = await newUser("rev_tok");
    const { session, token } = await newSession(userId);

    expect(await repos.sessions.findActiveByTokenHash(hashSessionToken(token))).not.toBeNull();
    await repos.sessions.revoke(session.id, userId);
    expect(await repos.sessions.findActiveByTokenHash(hashSessionToken(token))).toBeNull();
  });

  it("revokeOthers keeps the current session and removes the rest", async () => {
    const userId = await newUser("rev_others");
    const current = await newSession(userId, { deviceName: "current" });
    await newSession(userId, { deviceName: "b" });
    await newSession(userId, { deviceName: "c" });

    const removed = await repos.sessions.revokeOthers(userId, current.session.id);
    expect(removed).toBe(2);

    const list = await repos.sessions.listForUser(userId);
    expect(list.map((s) => s.id)).toEqual([current.session.id]);
  });
});
