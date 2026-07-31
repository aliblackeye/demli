/**
 * #98 — the gateway side of "sign out drops the device NOW". Real Postgres + real
 * WebSockets (auto-skips when the DB is down).
 *
 * A user-scoped `session.revoked` published on the mutation bus must:
 *  1. forward the typed event to each live connection whose session id is named,
 *     then close it with the auth-expired code (4401) — the same code the WS
 *     client maps to onAuthExpired; and
 *  2. leave the same user's OTHER (unnamed) sessions fully connected.
 *
 * This is what makes "sign out this device" / "sign out everywhere else" take
 * effect on a live socket at once instead of at its next HTTP request.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createDb,
  createRepositories,
  generateSessionToken,
  hashSessionToken,
  InMemoryMutationBus,
  sessionExpiresAt,
  type DbClient,
  type Repositories,
} from "@demli/db";
import { serverEvent, SERVER_EVENT } from "@demli/protocol";
import type { User } from "@demli/types";
import { CLOSE_UNAUTHORIZED, createGateway, type Gateway } from "../gateway.js";
import { InMemoryPresenceStore } from "../presence.js";
import { DATABASE_URL, isDbUp, TestClient } from "./harness.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[gateway.session-kick.int.test] DATABASE unreachable — skipping");
}

describe.skipIf(!dbUp)("gateway session kick (#98)", () => {
  let client: DbClient;
  let repos: Repositories;
  let gateway: Gateway;
  let mutationBus: InMemoryMutationBus;
  let port: number;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    mutationBus = new InMemoryMutationBus();
    gateway = createGateway(
      { repos, presence: new InMemoryPresenceStore(), mutationBus },
      { port: 0 },
    );
    port = await gateway.ready;
  });

  afterAll(async () => {
    await gateway?.close();
    await client?.close();
  });

  async function makeUser(label: string): Promise<User> {
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    return repos.users.create({
      username: `${label}_${suffix}`,
      displayName: label,
      passwordHash: "not-used-in-this-test",
    });
  }

  /** A fresh session (its own token + id) for an existing user. */
  async function addSession(userId: string): Promise<{ token: string; sessionId: string }> {
    const token = generateSessionToken();
    const session = await repos.sessions.create({
      userId,
      tokenHash: hashSessionToken(token),
      expiresAt: sessionExpiresAt(new Date(), 1),
    });
    return { token, sessionId: session.id };
  }

  it("kicks the revoked session's socket (event then 4401) and leaves the other session connected", async () => {
    const user = await makeUser("kick");
    const s1 = await addSession(user.id);
    const s2 = await addSession(user.id);
    const c1 = await TestClient.connect(port, s1.token);
    const c2 = await TestClient.connect(port, s2.token);
    await c1.waitFor(SERVER_EVENT.authSucceeded);
    await c2.waitFor(SERVER_EVENT.authSucceeded);

    // Sign out session 1 only.
    await mutationBus.publish({
      userId: user.id,
      event: serverEvent.sessionRevoked({ sessionIds: [s1.sessionId] }),
    });

    // c1 hears the typed signal FIRST, then the socket closes with 4401.
    await c1.waitFor(
      SERVER_EVENT.sessionRevoked,
      (e) => e.payload.sessionIds.includes(s1.sessionId),
    );
    expect(await c1.closed).toBe(CLOSE_UNAUTHORIZED);

    // c2 is untouched. Barrier: a distinct user-scoped event still reaches it, so
    // the socket is alive; and it never saw a session.revoked frame.
    await mutationBus.publish({
      userId: user.id,
      event: serverEvent.friendRemoved({ userId: user.id }),
    });
    await c2.waitFor(SERVER_EVENT.friendRemoved);
    expect(c2.envelopes.some((e) => e.event.type === SERVER_EVENT.sessionRevoked)).toBe(false);

    c2.close();
  });

  it("kicks EVERY named session and keeps the unnamed (current) one — 'sign out everywhere else'", async () => {
    const user = await makeUser("others");
    const current = await addSession(user.id);
    const a = await addSession(user.id);
    const b = await addSession(user.id);
    const cCur = await TestClient.connect(port, current.token);
    const cA = await TestClient.connect(port, a.token);
    const cB = await TestClient.connect(port, b.token);
    await cCur.waitFor(SERVER_EVENT.authSucceeded);
    await cA.waitFor(SERVER_EVENT.authSucceeded);
    await cB.waitFor(SERVER_EVENT.authSucceeded);

    // Revoke both non-current sessions in one event (the /sessions/others shape).
    await mutationBus.publish({
      userId: user.id,
      event: serverEvent.sessionRevoked({ sessionIds: [a.sessionId, b.sessionId] }),
    });

    expect(await cA.closed).toBe(CLOSE_UNAUTHORIZED);
    expect(await cB.closed).toBe(CLOSE_UNAUTHORIZED);

    // The current session survives.
    await mutationBus.publish({
      userId: user.id,
      event: serverEvent.friendRemoved({ userId: user.id }),
    });
    await cCur.waitFor(SERVER_EVENT.friendRemoved);
    expect(cCur.envelopes.some((e) => e.event.type === SERVER_EVENT.sessionRevoked)).toBe(false);

    cCur.close();
  });

  it("ignores a session.revoked for a session that has no live connection", async () => {
    const user = await makeUser("ghost");
    const live = await addSession(user.id);
    const ghost = await addSession(user.id); // never connects a socket
    const cLive = await TestClient.connect(port, live.token);
    await cLive.waitFor(SERVER_EVENT.authSucceeded);

    // Revoking the never-connected session must not disturb the live one.
    await mutationBus.publish({
      userId: user.id,
      event: serverEvent.sessionRevoked({ sessionIds: [ghost.sessionId] }),
    });
    await mutationBus.publish({
      userId: user.id,
      event: serverEvent.friendRemoved({ userId: user.id }),
    });
    await cLive.waitFor(SERVER_EVENT.friendRemoved);
    expect(cLive.envelopes.some((e) => e.event.type === SERVER_EVENT.sessionRevoked)).toBe(false);

    cLive.close();
  });
});
