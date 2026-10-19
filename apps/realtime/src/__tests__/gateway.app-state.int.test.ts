/**
 * #110 — the gateway's `presence.app_state` handler (real Postgres + real
 * WebSockets, skipped when the DB is down). Proves the gateway records the
 * socket's foreground/background state against the PRESENCE STORE using the
 * authenticated socket's OWN identity, rejects a bad payload, and stays SILENT
 * (app state drives push suppression only — it is never broadcast as presence,
 * so it cannot cause a render storm, §27).
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
import type { AppLifecycleState } from "@demli/protocol";
import { clientEvent, SERVER_EVENT } from "@demli/protocol";
import { createGateway, type Gateway } from "../gateway.js";
import { InMemoryPresenceStore } from "../presence.js";
import { DATABASE_URL, isDbUp, TestClient } from "./harness.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[gateway.app-state.int.test] DATABASE unreachable — skipping");
}

/** Wraps a real store and records every setAppState call for assertions. */
class SpyPresenceStore extends InMemoryPresenceStore {
  readonly appStateCalls: { userId: string; connectionId: string; state: AppLifecycleState }[] = [];

  override async setAppState(
    userId: string,
    connectionId: string,
    state: AppLifecycleState,
  ): Promise<void> {
    this.appStateCalls.push({ userId, connectionId, state });
    await super.setAppState(userId, connectionId, state);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!dbUp)("gateway presence.app_state (#110)", () => {
  let client: DbClient;
  let repos: Repositories;
  let gateway: Gateway;
  let port: number;
  let presence: SpyPresenceStore;

  const uniq = (): string => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  /**
   * A FRESH group per test — isolation by construction. Presence fans out to
   * co-members, so with one shared group the PREVIOUS test's actor going offline
   * (its socket-close handler runs fire-and-forget on the server, after the test
   * already moved on) lands in the next test's observation window and reads as a
   * broadcast this test caused. Disjoint groups give disjoint audiences: the only
   * presence a test's observer can receive is about its own crew.
   */
  async function makeCrew(): Promise<string> {
    const owner = await repos.users.create({
      username: `asowner_${uniq()}`,
      displayName: "AppState Owner",
      passwordHash: "not-used",
    });
    const group = await repos.groups.create({ name: "AppState Crew", ownerId: owner.id });
    return group.id;
  }

  async function makeGroupUser(groupId: string, tag: string): Promise<{ id: string; token: string }> {
    const user = await repos.users.create({
      username: `${tag}_${uniq()}`,
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

    presence = new SpyPresenceStore();
    gateway = createGateway(
      { repos, presence, mutationBus: new InMemoryMutationBus() },
      { port: 0 },
    );
    port = await gateway.ready;
  });

  afterAll(async () => {
    await gateway?.close();
    await client?.close();
  });

  it("records the socket's app state with the authenticated identity", async () => {
    const actor = await makeGroupUser(await makeCrew(), "actor");
    const conn = await TestClient.connect(port, actor.token);
    await conn.waitFor(SERVER_EVENT.authSucceeded);

    conn.send(clientEvent.presenceAppState({ state: "background" }));
    // Give the async handler a beat, then assert exactly one recorded call.
    await sleep(150);

    const calls = presence.appStateCalls.filter((c) => c.userId === actor.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.state).toBe("background");
    expect(calls[0]!.connectionId).toBeTruthy(); // the socket's own id, server-chosen

    conn.close();
    await conn.closed;
  });

  it("does NOT broadcast presence on an app-state change (silent for peers)", async () => {
    const crew = await makeCrew();
    const watcher = await makeGroupUser(crew, "observer");
    const actor = await makeGroupUser(crew, "silent");
    const observer = await TestClient.connect(port, watcher.token);
    await observer.waitFor(SERVER_EVENT.authSucceeded);

    const online = await TestClient.connect(port, actor.token);
    await online.waitFor(SERVER_EVENT.authSucceeded);
    // Drain the connect-time presence.updated the observer receives for the actor.
    await observer.waitFor(SERVER_EVENT.presenceUpdated, (e) => e.payload.userId === actor.id);
    // EVERY presence.updated counts — about anyone, the observer included. Only the
    // crew is in this observer's audience (see makeCrew), so nothing from another
    // test can land here; a frame that does is a broadcast this gateway sent.
    const presenceFrames = (c: TestClient) =>
      c.envelopes.filter((e) => e.event.type === SERVER_EVENT.presenceUpdated);
    const before = presenceFrames(observer).length;

    online.send(clientEvent.presenceAppState({ state: "background" }));
    online.send(clientEvent.presenceAppState({ state: "foreground" }));
    await sleep(200);

    const after = presenceFrames(observer).length;
    expect(after).toBe(before); // app-state changes emit no presence.updated

    // And across the WHOLE run, never presence about the observer itself: it never
    // changed its own status, and the gateway leaves the connecting socket out of
    // its own connect-time broadcast (M16). Pre-M16 the observer was sent its own
    // masked connect-time "online", and under load that frame could land inside
    // the window above — one of the two reasons this test went red.
    const aboutSelf = presenceFrames(observer).filter(
      (e) => e.event.type === SERVER_EVENT.presenceUpdated && e.event.payload.userId === watcher.id,
    );
    expect(aboutSelf).toEqual([]);

    online.close();
    observer.close();
    await Promise.all([online.closed, observer.closed]);
  });

  it("rejects an invalid app-state payload with INVALID_PAYLOAD, socket stays open", async () => {
    const actor = await makeGroupUser(await makeCrew(), "bad");
    const conn = await TestClient.connect(port, actor.token);
    await conn.waitFor(SERVER_EVENT.authSucceeded);

    conn.sendRaw(JSON.stringify({ type: "presence.app_state", payload: { state: "asleep" } }));
    const error = await conn.waitFor(SERVER_EVENT.errorRaised);
    expect(error.payload.code).toBe("INVALID_PAYLOAD");

    // A known event type with a bad payload must NOT close the socket (only an
    // UNKNOWN type does), so the client can recover — proven by the next VALID
    // frame being processed (the store records it).
    conn.send(clientEvent.presenceAppState({ state: "foreground" }));
    await sleep(150);
    const calls = presence.appStateCalls.filter((c) => c.userId === actor.id);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.state).toBe("foreground");

    conn.close();
    await conn.closed;
  });
});
