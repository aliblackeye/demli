/**
 * ADR 0020 — presence is PER CONNECTION, and the account's status is derived from
 * every live connection. Real Postgres + real Redis + real WebSockets, so this
 * exercises the production path end to end (RedisPresenceStore, not the in-memory
 * fallback). Skipped with a notice when either service is down.
 *
 * The bug being pinned (founder, 2026-07-28): the desktop auto-flips to "idle" and
 * then closes while the phone stays connected and active. Pre-ADR the status was
 * ONE per-user Redis key with no TTL, deleted only when the user's LAST connection
 * went away — so the dead desktop's "idle" kept ruling and the user appeared away
 * to every friend while typing on their phone.
 *
 * `observer` (a stable group member) sits in every connecting user's presence
 * audience, so it receives their `presence.updated` broadcasts. Each test uses a
 * FRESH user so a lingering socket from one test cannot leak into the next.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createDb,
  createRedisClient,
  createRepositories,
  generateSessionToken,
  hashSessionToken,
  InMemoryMutationBus,
  sessionExpiresAt,
  type DbClient,
  type RedisClient,
  type Repositories,
} from "@demli/db";
import { clientEvent, SERVER_EVENT } from "@demli/protocol";
import type { PresenceStatus } from "@demli/types";
import { createGateway, type Gateway } from "../gateway.js";
import { RedisPresenceStore } from "../presence.js";
import { DATABASE_URL, isDbUp, TestClient } from "./harness.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

const REDIS_URL = process.env["REDIS_URL"] ?? "redis://localhost:6379";

async function isRedisUp(): Promise<boolean> {
  const client = createRedisClient(REDIS_URL, { lazyConnect: true });
  client.on("error", () => undefined);
  try {
    await client.connect();
    await client.ping();
    return true;
  } catch {
    return false;
  } finally {
    await client.quit().catch(() => undefined);
  }
}

const dbUp = await isDbUp();
const redisUp = await isRedisUp();
if (!dbUp || !redisUp) {
  refuseToSkipIfRequired(!dbUp ? "postgres" : "redis");
  console.warn(
    `[gateway.presence-derivation.int.test] ${!dbUp ? "DATABASE" : "REDIS"} unreachable — skipping`,
  );
}

describe.skipIf(!dbUp || !redisUp)("gateway presence derivation (ADR 0020)", () => {
  let client: DbClient;
  let redis: RedisClient;
  let repos: Repositories;
  let gateway: Gateway;
  let port: number;
  let groupId: string;
  let observerToken: string;

  const prefix = `test:presence:derive:${Date.now().toString(36)}:${Math.random()
    .toString(36)
    .slice(2, 8)}`;

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

  /** Every `presence.updated` the observer has seen about `userId`, in order. */
  function presenceFrames(observer: TestClient, userId: string): PresenceStatus[] {
    return observer.envelopes.flatMap((envelope) =>
      envelope.event.type === SERVER_EVENT.presenceUpdated &&
      envelope.event.payload.userId === userId
        ? [envelope.event.payload.status]
        : [],
    );
  }

  /**
   * Assert that the action taken since `mark` (an `envelopes.length` snapshot)
   * settles the observer's view of `userId` on `status`.
   *
   * Two conditions, both required: at least one NEW presence frame arrived after
   * `mark` (so an assertion can never pass vacuously on a value that was already
   * showing), and the LATEST frame equals `status`. Asserting the latest rather
   * than the first-after-mark is deliberate — a connect broadcast for a socket
   * opened just before `mark` can still be in flight, and what matters is the
   * state the observer is left in, not the order two independent fan-outs raced in.
   */
  async function expectPresence(
    observer: TestClient,
    mark: number,
    userId: string,
    status: PresenceStatus,
    timeoutMs = 4000,
  ): Promise<void> {
    const started = Date.now();
    for (;;) {
      const seenNewFrame = observer.envelopes
        .slice(mark)
        .some(
          (e) =>
            e.event.type === SERVER_EVENT.presenceUpdated && e.event.payload.userId === userId,
        );
      const frames = presenceFrames(observer, userId);
      if (seenNewFrame && frames.at(-1) === status) return;
      if (Date.now() - started > timeoutMs) {
        expect(
          { newFrame: seenNewFrame, latest: frames.at(-1), all: frames },
          `presence for ${userId} never settled on "${status}"`,
        ).toEqual({ newFrame: true, latest: status, all: frames });
        throw new Error(`presence for ${userId} never settled on "${status}"`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
  }

  /**
   * Wait until the observer has actually SEEN the connect broadcast for
   * `userId`, before any `mark` is taken.
   *
   * `handleConnection` sends `auth.succeeded` to the connecting socket and only
   * THEN re-derives and broadcasts presence, so a test that proceeds the instant
   * it sees `auth.succeeded` is racing a fan-out that is still in flight. Under
   * load (the full workspace run) that fan-out can land AFTER the frame the test
   * went on to trigger, leaving the observer's last frame on "online" when the
   * assertion wanted "offline" — a failure that says nothing about the code.
   *
   * Only valid for a user's FIRST socket, which is the only one guaranteed to
   * broadcast (it is the one that brings the account online); a second device
   * that changes neither the dominant platform nor the derived status
   * deliberately broadcasts nothing.
   */
  async function awaitConnectBroadcast(observer: TestClient, userId: string): Promise<void> {
    await observer.waitFor(
      SERVER_EVENT.presenceUpdated,
      (event) => event.payload.userId === userId,
    );
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    redis = createRedisClient(REDIS_URL);
    redis.on("error", () => undefined);

    const owner = await repos.users.create({
      username: `derowner_${Date.now().toString(36)}`,
      displayName: "Derivation Owner",
      passwordHash: "not-used",
    });
    const group = await repos.groups.create({ name: "Derivation Crew", ownerId: owner.id });
    groupId = group.id;

    const observer = await makeGroupUser("observer");
    observerToken = observer.token;

    gateway = createGateway(
      {
        repos,
        // The REAL production store over real Redis — the whole point of this suite.
        presence: new RedisPresenceStore(redis, prefix),
        mutationBus: new InMemoryMutationBus(),
      },
      { port: 0 },
    );
    port = await gateway.ready;
  });

  afterAll(async () => {
    await gateway?.close();
    // The gateway's socket-close handlers run fire-and-forget, so closing the
    // server leaves presence writes in flight. Let them drain before quitting the
    // client — ioredis rejects every queued command with "Connection is closed."
    // on quit, and those rejections would fail the suite after it already passed.
    await new Promise((r) => setTimeout(r, 250));
    const keys = await redis?.keys(`${prefix}:*`);
    if (keys && keys.length > 0) await redis.del(...keys);
    await redis?.quit().catch(() => undefined);
    await client?.close();
  });

  it("one idle + one active connection ⇒ online, and the idle one leaving keeps it online", async () => {
    const a = await makeGroupUser("mix");
    const observer = await TestClient.connect(port, observerToken);
    await observer.waitFor(SERVER_EVENT.authSucceeded);

    const desktop = await TestClient.connect(port, a.token, "desktop");
    await desktop.waitFor(SERVER_EVENT.authSucceeded);
    await awaitConnectBroadcast(observer, a.id);
    const phone = await TestClient.connect(port, a.token, "mobile");
    await phone.waitFor(SERVER_EVENT.authSucceeded);

    // The desktop's inactivity timer fires: THIS DEVICE is idle.
    let mark = observer.envelopes.length;
    desktop.send(clientEvent.presenceUpdate({ userId: a.id, status: "idle" }));
    // The phone is still active, so the ACCOUNT is still online.
    await expectPresence(observer, mark, a.id, "online");

    // The idle desktop closes — the exact founder scenario. Its "idle" dies with
    // its socket instead of outliving it, so the account stays online.
    mark = observer.envelopes.length;
    desktop.close();
    await desktop.closed;
    await expectPresence(observer, mark, a.id, "online");

    phone.close();
    observer.close();
    await Promise.all([phone.closed, observer.closed]);
  });

  it("every connection idle ⇒ idle", async () => {
    const a = await makeGroupUser("allidle");
    const observer = await TestClient.connect(port, observerToken);
    await observer.waitFor(SERVER_EVENT.authSucceeded);

    const desktop = await TestClient.connect(port, a.token, "desktop");
    await desktop.waitFor(SERVER_EVENT.authSucceeded);
    await awaitConnectBroadcast(observer, a.id);
    const phone = await TestClient.connect(port, a.token, "mobile");
    await phone.waitFor(SERVER_EVENT.authSucceeded);

    let mark = observer.envelopes.length;
    desktop.send(clientEvent.presenceUpdate({ userId: a.id, status: "idle" }));
    await expectPresence(observer, mark, a.id, "online");

    mark = observer.envelopes.length;
    phone.send(clientEvent.presenceUpdate({ userId: a.id, status: "idle" }));
    await expectPresence(observer, mark, a.id, "idle");

    desktop.close();
    phone.close();
    observer.close();
    await Promise.all([desktop.closed, phone.closed, observer.closed]);
  });

  it("the ACTIVE connection leaving falls back to the remaining idle one ⇒ idle, then offline", async () => {
    const a = await makeGroupUser("drop");
    const observer = await TestClient.connect(port, observerToken);
    await observer.waitFor(SERVER_EVENT.authSucceeded);

    const desktop = await TestClient.connect(port, a.token, "desktop");
    await desktop.waitFor(SERVER_EVENT.authSucceeded);
    await awaitConnectBroadcast(observer, a.id);
    const phone = await TestClient.connect(port, a.token, "mobile");
    await phone.waitFor(SERVER_EVENT.authSucceeded);

    let mark = observer.envelopes.length;
    desktop.send(clientEvent.presenceUpdate({ userId: a.id, status: "idle" }));
    await expectPresence(observer, mark, a.id, "online");

    // The active phone goes away; only the idle desktop is left.
    mark = observer.envelopes.length;
    phone.close();
    await phone.closed;
    await expectPresence(observer, mark, a.id, "idle");

    // Last socket leaves ⇒ offline (derived from having no connections).
    mark = observer.envelopes.length;
    desktop.close();
    await desktop.closed;
    await expectPresence(observer, mark, a.id, "offline");

    observer.close();
    await observer.closed;
  });

  it("dnd declared on ONE device holds for the account and survives another device's online", async () => {
    const a = await makeGroupUser("dnd");
    const observer = await TestClient.connect(port, observerToken);
    await observer.waitFor(SERVER_EVENT.authSucceeded);

    const phone = await TestClient.connect(port, a.token, "mobile");
    await phone.waitFor(SERVER_EVENT.authSucceeded);
    await awaitConnectBroadcast(observer, a.id);

    let mark = observer.envelopes.length;
    phone.send(clientEvent.presenceUpdate({ userId: a.id, status: "dnd" }));
    await expectPresence(observer, mark, a.id, "dnd");

    // A desktop connects and re-asserts its own locally-remembered "online" (the
    // 574537c client patch). Pre-ADR that last write stomped the phone's dnd;
    // intent now outranks a derived availability, so the red dot holds.
    const desktop = await TestClient.connect(port, a.token, "desktop");
    await desktop.waitFor(SERVER_EVENT.authSucceeded);
    mark = observer.envelopes.length;
    desktop.send(clientEvent.presenceUpdate({ userId: a.id, status: "online" }));
    await expectPresence(observer, mark, a.id, "dnd");

    // Turning dnd off on the phone releases the account to the derived availability.
    mark = observer.envelopes.length;
    phone.send(clientEvent.presenceUpdate({ userId: a.id, status: "online" }));
    await expectPresence(observer, mark, a.id, "online");

    desktop.close();
    phone.close();
    observer.close();
    await Promise.all([desktop.closed, phone.closed, observer.closed]);
  });

  it("invisible is still masked to offline for peers, and a second online device cannot unmask it", async () => {
    const a = await makeGroupUser("invis");
    const observer = await TestClient.connect(port, observerToken);
    await observer.waitFor(SERVER_EVENT.authSucceeded);

    const desktop = await TestClient.connect(port, a.token, "desktop");
    await desktop.waitFor(SERVER_EVENT.authSucceeded);
    await awaitConnectBroadcast(observer, a.id);

    let mark = observer.envelopes.length;
    desktop.send(clientEvent.presenceUpdate({ userId: a.id, status: "invisible" }));
    await expectPresence(observer, mark, a.id, "offline"); // masked

    // A phone connects (seeded "online") and even declares online explicitly.
    // Revealing a deliberately hidden user is the one thing derivation must never do.
    const phone = await TestClient.connect(port, a.token, "mobile");
    await phone.waitFor(SERVER_EVENT.authSucceeded);
    mark = observer.envelopes.length;
    phone.send(clientEvent.presenceUpdate({ userId: a.id, status: "online" }));
    await expectPresence(observer, mark, a.id, "offline");

    // The masked payload carries no platform either (an "offline" user reports none).
    const masked = observer.envelopes
      .map((e) => e.event)
      .filter((e) => e.type === SERVER_EVENT.presenceUpdated && e.payload.userId === a.id)
      .at(-1);
    expect(masked?.type === SERVER_EVENT.presenceUpdated && masked.payload.platform).toBeFalsy();

    desktop.close();
    phone.close();
    observer.close();
    await Promise.all([desktop.closed, phone.closed, observer.closed]);
  });

  // -------------------------------------------------------------------------
  // M16 — presence about the user THEMSELVES. `expectPresence` / `presenceFrames`
  // take any client, so here the "observer" is also the user's own device.
  // -------------------------------------------------------------------------

  it("an invisible user's OWN devices get the real status — never offline — while peers get offline", async () => {
    const a = await makeGroupUser("selfinvis");
    const observer = await TestClient.connect(port, observerToken);
    await observer.waitFor(SERVER_EVENT.authSucceeded);

    const desktop = await TestClient.connect(port, a.token, "desktop");
    await desktop.waitFor(SERVER_EVENT.authSucceeded);
    await awaitConnectBroadcast(observer, a.id);
    const phone = await TestClient.connect(port, a.token, "mobile");
    await phone.waitFor(SERVER_EVENT.authSucceeded);

    // The desktop goes invisible: peers see offline, BOTH own devices see invisible.
    let peerMark = observer.envelopes.length;
    let deskMark = desktop.envelopes.length;
    let phoneMark = phone.envelopes.length;
    desktop.send(clientEvent.presenceUpdate({ userId: a.id, status: "invisible" }));
    await expectPresence(observer, peerMark, a.id, "offline");
    await expectPresence(desktop, deskMark, a.id, "invisible");
    await expectPresence(phone, phoneMark, a.id, "invisible");

    // The phone declares dnd; invisible still outranks it for the account.
    peerMark = observer.envelopes.length;
    phoneMark = phone.envelopes.length;
    phone.send(clientEvent.presenceUpdate({ userId: a.id, status: "dnd" }));
    await expectPresence(phone, phoneMark, a.id, "invisible");
    await expectPresence(observer, peerMark, a.id, "offline");

    // The desktop leaves invisible: the phone's dnd now rules the account, and the
    // desktop — the device that just picked "online" — is told so.
    peerMark = observer.envelopes.length;
    deskMark = desktop.envelopes.length;
    phoneMark = phone.envelopes.length;
    desktop.send(clientEvent.presenceUpdate({ userId: a.id, status: "online" }));
    await expectPresence(observer, peerMark, a.id, "dnd");
    await expectPresence(desktop, deskMark, a.id, "dnd");
    await expectPresence(phone, phoneMark, a.id, "dnd");

    // Over the whole run, neither own device was ever told it was offline.
    expect(presenceFrames(desktop, a.id)).not.toContain("offline");
    expect(presenceFrames(phone, a.id)).not.toContain("offline");

    desktop.close();
    phone.close();
    observer.close();
    await Promise.all([desktop.closed, phone.closed, observer.closed]);
  });

  it("the handshake snapshot never carries the connecting user, although the real co-member query does", async () => {
    const a = await makeGroupUser("selfsnap");
    // The premise of the M16 bug, pinned against the REAL repository: the user is
    // a member of their own group, so the co-member list includes them. The
    // gateway, not the repository, is what keeps them out of their own audience.
    expect(await repos.groups.listCoMemberUserIds(a.id)).toContain(a.id);

    const observer = await TestClient.connect(port, observerToken);
    await observer.waitFor(SERVER_EVENT.authSucceeded);
    const desktop = await TestClient.connect(port, a.token, "desktop");
    await desktop.waitFor(SERVER_EVENT.authSucceeded);
    await awaitConnectBroadcast(observer, a.id);
    const mark = observer.envelopes.length;
    desktop.send(clientEvent.presenceUpdate({ userId: a.id, status: "invisible" }));
    await expectPresence(observer, mark, a.id, "offline");

    // A second device's handshake: peers only. Pre-M16 this carried `a` MASKED,
    // i.e. told an invisible user they were offline on every (re)connect.
    const phone = await TestClient.connect(port, a.token, "mobile");
    const snapshot = (await phone.waitFor(SERVER_EVENT.authSucceeded)).payload.presence;
    expect(snapshot.map((p) => p.userId)).not.toContain(a.id);
    expect(snapshot.map((p) => p.userId)).toContain(
      (await observer.waitFor(SERVER_EVENT.authSucceeded)).payload.userId,
    );

    // A PEER's handshake does carry `a` — masked.
    const observer2 = await TestClient.connect(port, observerToken);
    const peerSnapshot = (await observer2.waitFor(SERVER_EVENT.authSucceeded)).payload.presence;
    expect(peerSnapshot.find((p) => p.userId === a.id)).toEqual({ userId: a.id, status: "offline" });

    desktop.close();
    phone.close();
    observer.close();
    observer2.close();
    await Promise.all([desktop.closed, phone.closed, observer.closed, observer2.closed]);
  });

  it("a leftover pre-ADR-0020 per-user status STRING neither crashes nor leaks into the broadcast", async () => {
    const a = await makeGroupUser("legacy");
    // Exactly what live Redis holds at the moment this version deploys: a TTL-less
    // per-USER status STRING stuck at "idle". The new key name is `:connstatus:`,
    // so this can neither WRONGTYPE a read nor be adopted as the user's status.
    await redis.set(`${prefix}:status:${a.id}`, "idle");

    const observer = await TestClient.connect(port, observerToken);
    await observer.waitFor(SERVER_EVENT.authSucceeded);

    const mark = observer.envelopes.length;
    const desktop = await TestClient.connect(port, a.token, "desktop");
    await desktop.waitFor(SERVER_EVENT.authSucceeded);
    await expectPresence(observer, mark, a.id, "online");

    desktop.close();
    observer.close();
    await Promise.all([desktop.closed, observer.closed]);
  });
});
