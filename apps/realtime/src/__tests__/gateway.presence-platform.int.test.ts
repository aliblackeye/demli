/**
 * Gateway integration tests for the presence PLATFORM indicator (task #47) —
 * real Postgres + real WebSockets. Skipped (with a notice) when the DB is down.
 *
 * `observer` (a stable group member) is in every connecting user's presence
 * audience, so it receives their presence.updated broadcasts. Each test spins up
 * a FRESH connecting user added to the shared group, so a lingering socket from
 * one test can never leak its platform into the next.
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
import { SERVER_EVENT } from "@demli/protocol";
import { createGateway, type Gateway } from "../gateway.js";
import { InMemoryPresenceStore } from "../presence.js";
import { DATABASE_URL, isDbUp, TestClient } from "./harness.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[gateway.presence-platform.int.test] DATABASE unreachable — skipping");
}

describe.skipIf(!dbUp)("gateway presence platform", () => {
  let client: DbClient;
  let repos: Repositories;
  let gateway: Gateway;
  let port: number;
  let groupId: string;

  let observerToken: string;

  /** Create a user, an active session, and add them to the shared group. */
  async function makeGroupUser(tag: string): Promise<{ id: string; token: string }> {
    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const user = await repos.users.create({
      username: `${tag}_${suffix}`,
      displayName: tag,
      passwordHash: "not-used",
    });
    const token = generateSessionToken();
    await repos.sessions.create({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt: sessionExpiresAt(new Date(), 1),
    });
    await repos.groups.addMember(groupId, user.id, "member");
    return { id: user.id, token };
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);

    const owner = await repos.users.create({
      username: `plowner_${Date.now().toString(36)}`,
      displayName: "Platform Owner",
      passwordHash: "not-used",
    });
    const group = await repos.groups.create({ name: "Platform Crew", ownerId: owner.id });
    groupId = group.id;

    const observer = await makeGroupUser("observer");
    observerToken = observer.token;

    gateway = createGateway(
      { repos, presence: new InMemoryPresenceStore(), mutationBus: new InMemoryMutationBus() },
      { port: 0 },
    );
    port = await gateway.ready;
  });

  afterAll(async () => {
    await gateway?.close();
    await client?.close();
  });

  it("broadcasts platform:'mobile' when the user connects from mobile", async () => {
    const a = await makeGroupUser("mob");
    const observer = await TestClient.connect(port, observerToken);
    await observer.waitFor(SERVER_EVENT.authSucceeded);

    const mobile = await TestClient.connect(port, a.token, "mobile");

    const presence = await observer.waitFor(
      SERVER_EVENT.presenceUpdated,
      (e) => e.payload.userId === a.id,
    );
    expect(presence.payload.status).toBe("online");
    expect(presence.payload.platform).toBe("mobile");

    mobile.close();
    observer.close();
    await Promise.all([mobile.closed, observer.closed]);
  });

  it("reports platform:'desktop' when desktop + mobile are connected at once", async () => {
    const a = await makeGroupUser("dom");
    const observer = await TestClient.connect(port, observerToken);
    await observer.waitFor(SERVER_EVENT.authSucceeded);

    // Mobile first — observer sees the phone indicator.
    const mobile = await TestClient.connect(port, a.token, "mobile");
    await observer.waitFor(
      SERVER_EVENT.presenceUpdated,
      (e) => e.payload.userId === a.id && e.payload.platform === "mobile",
    );

    // Desktop joins the SAME user → desktop dominates, so a fresh presence.updated
    // flips the observer from phone to the plain desktop dot.
    const desktop = await TestClient.connect(port, a.token, "desktop");
    const dominated = await observer.waitFor(
      SERVER_EVENT.presenceUpdated,
      (e) => e.payload.userId === a.id && e.payload.platform === "desktop",
    );
    expect(dominated.payload.platform).toBe("desktop");

    // Desktop drops → back to mobile-only, observer returns to the phone indicator.
    desktop.close();
    await desktop.closed;
    await observer.waitFor(
      SERVER_EVENT.presenceUpdated,
      (e) => e.payload.userId === a.id && e.payload.platform === "mobile",
    );

    mobile.close();
    observer.close();
    await Promise.all([mobile.closed, observer.closed]);
  });

  it("carries platform in the auth.succeeded snapshot for an already-connected peer", async () => {
    const a = await makeGroupUser("snap");
    // A is on mobile before the observer connects, so it learns A's platform from
    // the snapshot rather than a live broadcast.
    const mobile = await TestClient.connect(port, a.token, "mobile");
    await mobile.waitFor(SERVER_EVENT.authSucceeded);

    const observer = await TestClient.connect(port, observerToken);
    const auth = await observer.waitFor(SERVER_EVENT.authSucceeded);
    const entryA = auth.payload.presence.find((p) => p.userId === a.id);
    expect(entryA?.status).toBe("online");
    expect(entryA?.platform).toBe("mobile");

    mobile.close();
    observer.close();
    await Promise.all([mobile.closed, observer.closed]);
  });

  it("omits platform for a client that connects without one (backward compatible)", async () => {
    const a = await makeGroupUser("legacy");
    const observer = await TestClient.connect(port, observerToken);
    await observer.waitFor(SERVER_EVENT.authSucceeded);

    // No platform passed — the pre-#47 client shape.
    const legacy = await TestClient.connect(port, a.token);
    const presence = await observer.waitFor(
      SERVER_EVENT.presenceUpdated,
      (e) => e.payload.userId === a.id,
    );
    expect(presence.payload.status).toBe("online");
    expect(presence.payload.platform).toBeUndefined();

    legacy.close();
    observer.close();
    await Promise.all([legacy.closed, observer.closed]);
  });
});
