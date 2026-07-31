/**
 * Task #46 — device-token endpoints + offline push triggers (integration).
 * Real Postgres from docker-compose (auto-skips when unreachable). Presence and
 * the Expo push send are stubbed (`InMemoryPresenceReader` + a spy push
 * service), so this asserts the full wiring — endpoints persist tokens, and a
 * friend request / DM message fires a push ONLY to an offline recipient —
 * without a live gateway or Expo network.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  applyMigrations,
  createDb,
  createRepositories,
  generateSessionToken,
  hashSessionToken,
  InMemoryPresenceReader,
  sessionExpiresAt,
  type DbClient,
  type Repositories,
} from "@demli/db";
import { createOfflineNotifier } from "@demli/notifications";
import type { PushNotification, PushService } from "@demli/notifications";
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
  console.warn("[devices-push.int.test] DATABASE unreachable — skipping");
}

interface PushCall {
  ids: string[];
  n: PushNotification;
}

describe.skipIf(!dbUp)("device tokens + offline push (task #46)", () => {
  let client: DbClient;
  let repos: Repositories;
  let app: FastifyInstance;

  // Test doubles the notifier reads from. `presence` toggles who is "online";
  // `pushCalls` records every send so triggers can be asserted.
  const presence = new InMemoryPresenceReader();
  const pushCalls: PushCall[] = [];
  const push: PushService = {
    async sendToUsers(userIds, n) {
      pushCalls.push({ ids: [...userIds], n });
    },
  };

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let seq = 0;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });
  const validToken = (n: string) => `ExponentPushToken[${n}]`;

  interface TestUser {
    token: string;
    id: string;
  }

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
    return { token, id: user.id };
  }

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

  /** Open a DM A→B and return its stream channel id (where messages are POSTed). */
  async function openDm(a: TestUser, b: TestUser): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/dms",
      headers: auth(a.token),
      payload: { userId: b.id },
    });
    expect([200, 201]).toContain(res.statusCode);
    return (res.json() as { dm: { streamId: string } }).dm.streamId;
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    app = await buildApp({
      repos,
      env: loadEnv({ DATABASE_URL }),
      notifier: createOfflineNotifier({ presence, push }),
      logger: false,
    });
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  beforeEach(() => {
    pushCalls.length = 0;
  });

  // ---------------------------------------------------------------- endpoints
  describe("POST/DELETE /devices/token", () => {
    it("requires authentication", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/devices/token",
        payload: { token: validToken("noauth"), platform: "ios" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("registers the caller's token (persisted to device_tokens)", async () => {
      const u = await newUser("reg");
      const token = validToken(`reg_${u.id.slice(0, 8)}`);
      const res = await app.inject({
        method: "POST",
        url: "/devices/token",
        headers: auth(u.token),
        payload: { token, platform: "android" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ registered: true });

      const rows = await repos.deviceTokens.listForUser(u.id);
      expect(rows.map((r) => r.token)).toEqual([token]);
      expect(rows[0]?.platform).toBe("android");
    });

    it("rejects a malformed push token with 400", async () => {
      const u = await newUser("bad");
      const res = await app.inject({
        method: "POST",
        url: "/devices/token",
        headers: auth(u.token),
        payload: { token: "not-an-expo-token", platform: "ios" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects an unknown platform with 400", async () => {
      const u = await newUser("plat");
      const res = await app.inject({
        method: "POST",
        url: "/devices/token",
        headers: auth(u.token),
        payload: { token: validToken("plat"), platform: "windows" },
      });
      expect(res.statusCode).toBe(400);
    });

    it("re-registering the same token re-binds it to the new caller", async () => {
      const a = await newUser("rb_a");
      const b = await newUser("rb_b");
      const token = validToken(`rebind_${suffix}`);
      await app.inject({
        method: "POST",
        url: "/devices/token",
        headers: auth(a.token),
        payload: { token, platform: "ios" },
      });
      await app.inject({
        method: "POST",
        url: "/devices/token",
        headers: auth(b.token),
        payload: { token, platform: "android" },
      });
      expect(await repos.deviceTokens.listForUser(a.id)).toHaveLength(0);
      expect((await repos.deviceTokens.listForUser(b.id)).map((r) => r.token)).toEqual([token]);
    });

    it("unregisters only the caller's own token (204, scoped)", async () => {
      const owner = await newUser("del_o");
      const other = await newUser("del_x");
      const token = validToken(`del_${suffix}`);
      await app.inject({
        method: "POST",
        url: "/devices/token",
        headers: auth(owner.token),
        payload: { token, platform: "ios" },
      });

      // A different user cannot delete it (still 204 — nothing leaked — but the row stays).
      const foreign = await app.inject({
        method: "DELETE",
        url: "/devices/token",
        headers: auth(other.token),
        payload: { token },
      });
      expect(foreign.statusCode).toBe(204);
      expect(await repos.deviceTokens.listForUser(owner.id)).toHaveLength(1);

      const own = await app.inject({
        method: "DELETE",
        url: "/devices/token",
        headers: auth(owner.token),
        payload: { token },
      });
      expect(own.statusCode).toBe(204);
      expect(await repos.deviceTokens.listForUser(owner.id)).toHaveLength(0);
    });
  });

  // --------------------------------------------------------- friend-request push
  describe("friend request push", () => {
    it("pushes to an OFFLINE addressee with friend_request data", async () => {
      const requester = await newUser("fr_a");
      const addressee = await newUser("fr_b");
      presence.setOffline(addressee.id); // ensure offline

      const res = await app.inject({
        method: "POST",
        url: "/friends/requests",
        headers: auth(requester.token),
        payload: { userId: addressee.id },
      });
      expect(res.statusCode).toBe(201);

      expect(pushCalls).toHaveLength(1);
      expect(pushCalls[0]!.ids).toEqual([addressee.id]);
      expect(pushCalls[0]!.n.data).toEqual({
        type: "friend_request",
        userId: requester.id,
      });
    });

    it("does NOT push when the addressee is online", async () => {
      const requester = await newUser("fon_a");
      const addressee = await newUser("fon_b");
      presence.setOnline(addressee.id);

      const res = await app.inject({
        method: "POST",
        url: "/friends/requests",
        headers: auth(requester.token),
        payload: { userId: addressee.id },
      });
      expect(res.statusCode).toBe(201);
      expect(pushCalls).toEqual([]);
    });
  });

  // --------------------------------------------------------- friend-accept push
  // GAP 1: accepting a request must push the ORIGINAL requester (offline), so the
  // person who asked learns they were accepted even with the app closed. The WS
  // event covers the online (in-app) case; this covers the offline case.
  describe("friend accept push", () => {
    it("pushes the OFFLINE requester when their request is accepted", async () => {
      const requester = await newUser("fac_req");
      const accepter = await newUser("fac_acc");
      const sent = await app.inject({
        method: "POST",
        url: "/friends/requests",
        headers: auth(requester.token),
        payload: { userId: accepter.id },
      });
      expect(sent.statusCode).toBe(201);

      presence.setOffline(requester.id);
      pushCalls.length = 0; // ignore the request-sent push above

      const accepted = await app.inject({
        method: "POST",
        url: `/friends/requests/${requester.id}/accept`,
        headers: auth(accepter.token),
      });
      expect(accepted.statusCode).toBe(200);

      // Exactly one push, to the requester (never the accepter), routing to friends.
      expect(pushCalls).toHaveLength(1);
      expect(pushCalls[0]!.ids).toEqual([requester.id]);
      expect(pushCalls[0]!.n.data).toEqual({ type: "friend", userId: accepter.id });
      expect(pushCalls[0]!.n.body).toContain("accepted");
    });

    it("does NOT push when the requester is online", async () => {
      const requester = await newUser("faon_req");
      const accepter = await newUser("faon_acc");
      await app.inject({
        method: "POST",
        url: "/friends/requests",
        headers: auth(requester.token),
        payload: { userId: accepter.id },
      });

      presence.setOnline(requester.id);
      pushCalls.length = 0;

      const accepted = await app.inject({
        method: "POST",
        url: `/friends/requests/${requester.id}/accept`,
        headers: auth(accepter.token),
      });
      expect(accepted.statusCode).toBe(200);
      expect(pushCalls).toEqual([]);
    });

    it("auto-accept (reverse pending) pushes the OFFLINE original requester", async () => {
      const first = await newUser("faa_1");
      const second = await newUser("faa_2");
      // first asks second (pending)
      await app.inject({
        method: "POST",
        url: "/friends/requests",
        headers: auth(first.token),
        payload: { userId: second.id },
      });

      presence.setOffline(first.id);
      pushCalls.length = 0;

      // second asks first back → mutual consent → auto-accept
      const res = await app.inject({
        method: "POST",
        url: "/friends/requests",
        headers: auth(second.token),
        payload: { userId: first.id },
      });
      expect(res.statusCode).toBe(200);
      expect((res.json() as { outcome: string }).outcome).toBe("auto_accepted");

      // The original requester (first) is pushed that second accepted; no double.
      expect(pushCalls).toHaveLength(1);
      expect(pushCalls[0]!.ids).toEqual([first.id]);
      expect(pushCalls[0]!.n.data).toEqual({ type: "friend", userId: second.id });
    });
  });

  // ------------------------------------------------------------- DM message push
  describe("DM message push", () => {
    it("pushes to an OFFLINE DM recipient with dm_message data + body preview", async () => {
      const a = await newUser("dm_a");
      const b = await newUser("dm_b");
      await befriend(a, b);
      const streamId = await openDm(a, b);
      presence.setOffline(b.id);
      pushCalls.length = 0; // ignore any events from befriend/openDm

      const res = await app.inject({
        method: "POST",
        url: `/channels/${streamId}/messages`,
        headers: auth(a.token),
        payload: { content: "  hello   there  " },
      });
      expect(res.statusCode).toBe(201);

      expect(pushCalls).toHaveLength(1);
      expect(pushCalls[0]!.ids).toEqual([b.id]);
      expect(pushCalls[0]!.n.body).toBe("hello there"); // normalized preview
      expect(pushCalls[0]!.n.data).toMatchObject({ type: "dm_message", channelId: streamId });
    });

    it("does NOT push when the DM recipient is online", async () => {
      const a = await newUser("dmon_a");
      const b = await newUser("dmon_b");
      await befriend(a, b);
      const streamId = await openDm(a, b);
      presence.setOnline(b.id);
      pushCalls.length = 0;

      const res = await app.inject({
        method: "POST",
        url: `/channels/${streamId}/messages`,
        headers: auth(a.token),
        payload: { content: "hi" },
      });
      expect(res.statusCode).toBe(201);
      expect(pushCalls).toEqual([]);
    });
  });
});
