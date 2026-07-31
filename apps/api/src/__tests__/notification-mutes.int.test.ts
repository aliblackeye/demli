/**
 * Migration 0013 — notification-mute endpoints + offline-push filter
 * (integration). Real Postgres from docker-compose (auto-skips when
 * unreachable). Presence + the Expo push send are stubbed (`InMemoryPresenceReader`
 * + a spy push service) and the mutation bus is in-memory, so this asserts the
 * full wiring WITHOUT a live gateway or Expo network:
 *   - PUT/DELETE/GET /notification-mutes (auth, visibility, idempotency, fan-out)
 *   - a channel/group mute suppresses the DM + mention push per `mode`
 *   - an EXPIRED mute is ignored (push fires)
 *   - a DM-call ring (`call_invite`) is NEVER filtered — a call always rings.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  applyMigrations,
  createDb,
  createRepositories,
  generateSessionToken,
  hashSessionToken,
  InMemoryMutationBus,
  InMemoryPresenceReader,
  sessionExpiresAt,
  type DbClient,
  type RealtimeMutation,
  type Repositories,
} from "@demli/db";
import { createOfflineNotifier } from "@demli/notifications";
import type { PushNotification, PushService } from "@demli/notifications";
import { encodeMention } from "@demli/protocol";
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
  console.warn("[notification-mutes.int.test] DATABASE unreachable — skipping");
}

interface PushCall {
  ids: string[];
  n: PushNotification;
}

describe.skipIf(!dbUp)("notification mutes (migration 0013)", () => {
  let client: DbClient;
  let repos: Repositories;
  let app: FastifyInstance;

  const presence = new InMemoryPresenceReader();
  const pushCalls: PushCall[] = [];
  const push: PushService = {
    async sendToUsers(userIds, n) {
      pushCalls.push({ ids: [...userIds], n });
    },
  };
  const bus = new InMemoryMutationBus();
  const busEvents: RealtimeMutation[] = [];

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let seq = 0;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

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

  /** Open DM A→B; returns its group id (`dmId`) and stream channel id. */
  async function openDm(a: TestUser, b: TestUser): Promise<{ dmId: string; streamId: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/dms",
      headers: auth(a.token),
      payload: { userId: b.id },
    });
    expect([200, 201]).toContain(res.statusCode);
    const dm = (res.json() as { dm: { id: string; streamId: string } }).dm;
    return { dmId: dm.id, streamId: dm.streamId };
  }

  async function makeServer(owner: TestUser): Promise<{ serverId: string; generalId: string }> {
    const created = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(owner.token),
      payload: { name: `srv_${suffix}_${seq}` },
    });
    expect(created.statusCode).toBe(201);
    const serverId = created.json().group.id as string;
    const general = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/channels`,
      headers: auth(owner.token),
      payload: { name: "general", kind: "text" },
    });
    expect(general.statusCode).toBe(201);
    return { serverId, generalId: general.json().channel.id as string };
  }

  async function join(serverId: string, owner: TestUser, member: TestUser): Promise<void> {
    const invite = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/invites`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(invite.statusCode).toBe(201);
    const redeem = await app.inject({
      method: "POST",
      url: `/invites/${invite.json().invite.code}/redeem`,
      headers: auth(member.token),
    });
    expect(redeem.statusCode).toBe(200);
  }

  function sendMessage(channelId: string, sender: TestUser, content: string) {
    return app.inject({
      method: "POST",
      url: `/channels/${channelId}/messages`,
      headers: auth(sender.token),
      payload: { content },
    });
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    await bus.subscribe((m) => busEvents.push(m));
    app = await buildApp({
      repos,
      env: loadEnv({ DATABASE_URL }),
      notifier: createOfflineNotifier({ presence, push }),
      mutationBus: bus,
      logger: false,
    });
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
    await bus.close();
  });

  beforeEach(() => {
    pushCalls.length = 0;
    busEvents.length = 0;
  });

  // ------------------------------------------------------------------ endpoints
  describe("endpoints", () => {
    it("requires authentication on every route", async () => {
      const put = await app.inject({
        method: "PUT",
        url: "/notification-mutes",
        payload: { scope: "group", targetId: randomUUID(), mode: "all" },
      });
      expect(put.statusCode).toBe(401);
      const get = await app.inject({ method: "GET", url: "/notification-mutes" });
      expect(get.statusCode).toBe(401);
      const del = await app.inject({
        method: "DELETE",
        url: `/notification-mutes/group/${randomUUID()}`,
      });
      expect(del.statusCode).toBe(401);
    });

    it("mutes a channel the caller can see, lists it, and fans out the event", async () => {
      const owner = await newUser("ep_o");
      const { generalId } = await makeServer(owner);

      const put = await app.inject({
        method: "PUT",
        url: "/notification-mutes",
        headers: auth(owner.token),
        payload: { scope: "channel", targetId: generalId, mode: "mentions" },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json().mute).toMatchObject({
        scope: "channel",
        targetId: generalId,
        mode: "mentions",
        until: null,
      });

      // Fanned out to the caller's own connections (cross-device sync).
      const evt = busEvents.find(
        (e) => e.userId === owner.id && e.event.type === "notification_mute.updated",
      );
      expect(evt).toBeDefined();

      const list = await app.inject({
        method: "GET",
        url: "/notification-mutes",
        headers: auth(owner.token),
      });
      expect(list.statusCode).toBe(200);
      expect(list.json().mutes).toHaveLength(1);
      expect(list.json().mutes[0]).toMatchObject({ targetId: generalId, mode: "mentions" });
    });

    it("re-muting the same target updates the mode (upsert, not duplicate)", async () => {
      const owner = await newUser("ep_up");
      const { serverId } = await makeServer(owner);
      const base = { scope: "group", targetId: serverId } as const;
      await app.inject({
        method: "PUT",
        url: "/notification-mutes",
        headers: auth(owner.token),
        payload: { ...base, mode: "all" },
      });
      const second = await app.inject({
        method: "PUT",
        url: "/notification-mutes",
        headers: auth(owner.token),
        payload: { ...base, mode: "mentions" },
      });
      expect(second.json().mute.mode).toBe("mentions");
      const list = await app.inject({
        method: "GET",
        url: "/notification-mutes",
        headers: auth(owner.token),
      });
      expect(list.json().mutes.filter((m: { targetId: string }) => m.targetId === serverId)).toHaveLength(1);
    });

    it("unmute is idempotent (204) and removes the row", async () => {
      const owner = await newUser("ep_del");
      const { generalId } = await makeServer(owner);
      await app.inject({
        method: "PUT",
        url: "/notification-mutes",
        headers: auth(owner.token),
        payload: { scope: "channel", targetId: generalId, mode: "all" },
      });
      const first = await app.inject({
        method: "DELETE",
        url: `/notification-mutes/channel/${generalId}`,
        headers: auth(owner.token),
      });
      expect(first.statusCode).toBe(204);
      const second = await app.inject({
        method: "DELETE",
        url: `/notification-mutes/channel/${generalId}`,
        headers: auth(owner.token),
      });
      expect(second.statusCode).toBe(204);
      const list = await app.inject({
        method: "GET",
        url: "/notification-mutes",
        headers: auth(owner.token),
      });
      expect(list.json().mutes).toHaveLength(0);
    });

    it("cannot mute a group the caller is not a member of (404, no leak)", async () => {
      const owner = await newUser("ep_v1");
      const outsider = await newUser("ep_v2");
      const { serverId, generalId } = await makeServer(owner);

      const grp = await app.inject({
        method: "PUT",
        url: "/notification-mutes",
        headers: auth(outsider.token),
        payload: { scope: "group", targetId: serverId, mode: "all" },
      });
      expect(grp.statusCode).toBe(404);

      const chan = await app.inject({
        method: "PUT",
        url: "/notification-mutes",
        headers: auth(outsider.token),
        payload: { scope: "channel", targetId: generalId, mode: "all" },
      });
      expect(chan.statusCode).toBe(404);
    });

    it("rejects a past `until` and a bad scope/mode with 400", async () => {
      const owner = await newUser("ep_val");
      const { serverId } = await makeServer(owner);
      const past = await app.inject({
        method: "PUT",
        url: "/notification-mutes",
        headers: auth(owner.token),
        payload: {
          scope: "group",
          targetId: serverId,
          mode: "all",
          until: new Date(Date.now() - 1000).toISOString(),
        },
      });
      expect(past.statusCode).toBe(400);

      const badMode = await app.inject({
        method: "PUT",
        url: "/notification-mutes",
        headers: auth(owner.token),
        payload: { scope: "group", targetId: serverId, mode: "loud" },
      });
      expect(badMode.statusCode).toBe(400);
    });
  });

  // --------------------------------------------------------------- DM push gate
  describe("DM message push filter", () => {
    it("mode=all silences the DM push to an offline recipient", async () => {
      const a = await newUser("dma_a");
      const b = await newUser("dma_b");
      await befriend(a, b);
      const { streamId } = await openDm(a, b);
      // B mutes the DM channel entirely.
      const mute = await app.inject({
        method: "PUT",
        url: "/notification-mutes",
        headers: auth(b.token),
        payload: { scope: "channel", targetId: streamId, mode: "all" },
      });
      expect(mute.statusCode).toBe(200);
      presence.setOffline(b.id);
      pushCalls.length = 0;

      expect((await sendMessage(streamId, a, "hello")).statusCode).toBe(201);
      expect(pushCalls).toEqual([]);
    });

    it("mode=mentions silences a plain DM but passes a direct @mention", async () => {
      const a = await newUser("dmm_a");
      const b = await newUser("dmm_b");
      await befriend(a, b);
      const { streamId } = await openDm(a, b);
      await app.inject({
        method: "PUT",
        url: "/notification-mutes",
        headers: auth(b.token),
        payload: { scope: "channel", targetId: streamId, mode: "mentions" },
      });
      presence.setOffline(b.id);

      pushCalls.length = 0;
      expect((await sendMessage(streamId, a, "just a plain hi")).statusCode).toBe(201);
      expect(pushCalls).toEqual([]);

      pushCalls.length = 0;
      const mention = `${encodeMention(b.id)} you around?`;
      expect((await sendMessage(streamId, a, mention)).statusCode).toBe(201);
      expect(pushCalls).toHaveLength(1);
      expect(pushCalls[0]!.ids).toEqual([b.id]);
    });

    it("an EXPIRED mute is ignored — the DM push fires", async () => {
      const a = await newUser("dme_a");
      const b = await newUser("dme_b");
      await befriend(a, b);
      const { streamId } = await openDm(a, b);
      // Seed an already-expired mute directly (the API rejects a past `until`).
      await repos.notificationMutes.setMute({
        userId: b.id,
        scope: "channel",
        targetId: streamId,
        mode: "all",
        until: new Date(Date.now() - 60_000),
      });
      presence.setOffline(b.id);
      pushCalls.length = 0;

      expect((await sendMessage(streamId, a, "still there?")).statusCode).toBe(201);
      expect(pushCalls).toHaveLength(1);
      expect(pushCalls[0]!.ids).toEqual([b.id]);
    });
  });

  // ---------------------------------------------------- server-channel mention gate
  describe("server channel mention push filter", () => {
    it("mode=all suppresses a mention push; clearing restores it", async () => {
      const owner = await newUser("mn_o");
      const member = await newUser("mn_m");
      const { serverId, generalId } = await makeServer(owner);
      await join(serverId, owner, member);
      presence.setOffline(member.id);

      // Baseline: mention pushes when unmuted.
      pushCalls.length = 0;
      const mention = `hey ${encodeMention(member.id)}`;
      expect((await sendMessage(generalId, owner, mention)).statusCode).toBe(201);
      expect(pushCalls).toHaveLength(1);
      expect(pushCalls[0]!.ids).toEqual([member.id]);

      // Mute the channel (all) → the same mention is silenced.
      await app.inject({
        method: "PUT",
        url: "/notification-mutes",
        headers: auth(member.token),
        payload: { scope: "channel", targetId: generalId, mode: "all" },
      });
      pushCalls.length = 0;
      expect((await sendMessage(generalId, owner, mention)).statusCode).toBe(201);
      expect(pushCalls).toEqual([]);

      // Unmute → the mention pushes again.
      await app.inject({
        method: "DELETE",
        url: `/notification-mutes/channel/${generalId}`,
        headers: auth(member.token),
      });
      pushCalls.length = 0;
      expect((await sendMessage(generalId, owner, mention)).statusCode).toBe(201);
      expect(pushCalls).toHaveLength(1);
    });

    it("a server-scope mode=all mute covers a channel under it", async () => {
      const owner = await newUser("sv_o");
      const member = await newUser("sv_m");
      const { serverId, generalId } = await makeServer(owner);
      await join(serverId, owner, member);
      await app.inject({
        method: "PUT",
        url: "/notification-mutes",
        headers: auth(member.token),
        payload: { scope: "group", targetId: serverId, mode: "all" },
      });
      presence.setOffline(member.id);
      pushCalls.length = 0;

      const mention = `ping ${encodeMention(member.id)}`;
      expect((await sendMessage(generalId, owner, mention)).statusCode).toBe(201);
      expect(pushCalls).toEqual([]);
    });
  });

  // --------------------------------------------------------- DM-call ring exempt
  describe("DM-call ring is never muted", () => {
    it("a call still rings an offline callee who muted the DM (mode=all)", async () => {
      const a = await newUser("call_a");
      const b = await newUser("call_b");
      await befriend(a, b);
      const { dmId, streamId } = await openDm(a, b);
      // B mutes the DM as hard as possible — both the channel and the group.
      await app.inject({
        method: "PUT",
        url: "/notification-mutes",
        headers: auth(b.token),
        payload: { scope: "channel", targetId: streamId, mode: "all" },
      });
      await app.inject({
        method: "PUT",
        url: "/notification-mutes",
        headers: auth(b.token),
        payload: { scope: "group", targetId: dmId, mode: "all" },
      });
      presence.setOffline(b.id);
      pushCalls.length = 0;

      const call = await app.inject({
        method: "POST",
        url: "/dm-calls",
        headers: auth(a.token),
        payload: { dmId, media: "audio" },
      });
      expect(call.statusCode).toBe(201);

      // The ring push fires despite the mute — a call always rings.
      expect(pushCalls).toHaveLength(1);
      expect(pushCalls[0]!.ids).toEqual([b.id]);
      expect(pushCalls[0]!.n.data).toMatchObject({ type: "call_invite" });
    });
  });
});
