/**
 * Role VISIBILITY on the gateway's write/join paths (ADR 0007) — real Postgres +
 * real WebSockets. Auto-skipped (with a notice) when the database is unreachable.
 *
 * ## What this suite is actually about
 *
 * A restricted channel is a private conversation. Who may write into it, join its
 * voice room, or drive its watch party is an AUTHORIZATION decision, and until
 * this change the gateway decided it from `Connection.channelKinds` — a
 * per-connection cache refreshed by fire-and-forget Redis bus messages. The HTTP
 * API has always used the real thing (`loadVisibleChannel` = membership AND
 * `canUserSeeChannel`), so the two transports disagreed: the same user, on the
 * same account, was refused on their phone and allowed on their desktop.
 *
 * Every test here revokes a role by writing DIRECTLY to the database and
 * publishing NOTHING on the mutation bus. That is not a shortcut — it is the
 * exact failure being closed: a dropped/failed bus message, or a frame that beat
 * the async resync. Under the old code the connection's cache stays stale
 * forever in this setup, which is why these tests fail loudly if the fresh check
 * is removed.
 *
 * Covered:
 *  1. positive control — while the role IS held, sending and voice-joining work
 *     (so a later refusal cannot be "everything is broken");
 *  2. `message.send` into a restricted channel after a silent revoke is refused
 *     with NOT_A_MEMBER and persists nothing;
 *  3. the refusal SELF-HEALS the stale subscription: the revoked member stops
 *     receiving the channel's messages, closing the "still listening" half;
 *  4. `voice.join` on a restricted voice channel after a silent revoke is
 *     refused, and no peer sees a participant join;
 *  5. `watch.*` from someone already sitting in the room when their role was
 *     revoked is refused (the watch coordinator's own fresh check);
 *  6. an unrestricted (public) channel is unaffected — the gate must cost
 *     ordinary members nothing.
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
import { clientEvent, SERVER_EVENT } from "@demli/protocol";
import type { ChannelId, GroupId, RoleId, UserId } from "@demli/types";
import { createGateway, type Gateway } from "../gateway.js";
import { InMemoryPresenceStore } from "../presence.js";
import { DATABASE_URL, isDbUp, TestClient } from "./harness.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

interface Actor {
  id: UserId;
  token: string;
}

async function makeActor(repos: Repositories, label: string): Promise<Actor> {
  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const user = await repos.users.create({
    username: `${label}_${suffix}`,
    displayName: label,
    passwordHash: "not-used-in-this-test",
  });
  const token = generateSessionToken();
  await repos.sessions.create({
    userId: user.id,
    tokenHash: hashSessionToken(token),
    expiresAt: sessionExpiresAt(new Date(), 1),
  });
  return { id: user.id, token };
}

/** Give the gateway a beat to deliver (or deliberately NOT deliver) a frame. */
async function settle(ms = 400): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn(
    "[gateway.channel-visibility.int.test] DATABASE unreachable — skipping integration tests",
  );
}

describe.skipIf(!dbUp)("gateway — fresh role visibility on write/join paths", () => {
  let client: DbClient;
  let repos: Repositories;
  let gateway: Gateway;
  let port: number;

  interface Restricted {
    groupId: GroupId;
    channelId: ChannelId;
    roleId: RoleId;
    owner: Actor;
    member: Actor;
  }

  /**
   * A server whose one channel is RESTRICTED to a single role, with a member who
   * currently holds that role. `kind` picks a text or voice channel.
   */
  async function makeRestricted(
    label: string,
    kind: "text" | "voice",
  ): Promise<Restricted> {
    const owner = await makeActor(repos, `${label}O`);
    const member = await makeActor(repos, `${label}M`);
    const group = await repos.groups.create({ name: `Vis ${label}`, ownerId: owner.id });
    await repos.groups.addMember(group.id, member.id, "member");
    const channel = await repos.channels.create({
      groupId: group.id,
      kind,
      name: kind === "voice" ? "war-room" : "staff",
    });
    const role = await repos.roles.create({ groupId: group.id, name: `${label}-staff` });
    await repos.roles.assign(group.id, member.id, role.id);
    await repos.channelAccess.setChannelRoles(group.id, channel.id, [role.id]);
    return {
      groupId: group.id,
      channelId: channel.id,
      roleId: role.id,
      owner,
      member,
    };
  }

  /**
   * Revoke the granting role with NO bus event — the gateway's cached visibility
   * for any live socket is now stale, and nothing will ever tell it.
   */
  async function revokeSilently(scene: Restricted): Promise<void> {
    await repos.roles.unassign(scene.member.id, scene.roleId);
    // Sanity: the DB agrees the member can no longer see it. Without this the
    // whole suite could pass against a broken fixture.
    expect(
      await repos.channelAccess.canUserSeeChannel(
        scene.groupId,
        scene.channelId,
        scene.member.id,
      ),
    ).toBe(false);
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    gateway = createGateway(
      {
        repos,
        presence: new InMemoryPresenceStore(),
        mutationBus: new InMemoryMutationBus(),
      },
      { port: 0 },
    );
    port = await gateway.ready;
  });

  afterAll(async () => {
    await gateway?.close();
    await client?.close();
  });

  it("positive control: a role holder can send and join voice in a restricted channel", async () => {
    const text = await makeRestricted("pcT", "text");
    const voice = await makeRestricted("pcV", "voice");

    const memberSock = await TestClient.connect(port, text.member.token);
    const ownerSock = await TestClient.connect(port, text.owner.token);
    await memberSock.waitFor(SERVER_EVENT.authSucceeded);
    await ownerSock.waitFor(SERVER_EVENT.authSucceeded);

    const content = "role holders may speak";
    memberSock.send(
      clientEvent.messageSend({
        channelId: text.channelId,
        content,
        nonce: `pc-${Date.now()}`,
      }),
    );
    await ownerSock.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.content === content);

    const voiceSock = await TestClient.connect(port, voice.member.token);
    await voiceSock.waitFor(SERVER_EVENT.authSucceeded);
    voiceSock.send(clientEvent.voiceJoin({ channelId: voice.channelId }));
    await voiceSock.waitFor(
      SERVER_EVENT.voiceParticipantJoined,
      (e) => e.payload.channelId === voice.channelId && e.payload.userId === voice.member.id,
    );

    memberSock.close();
    ownerSock.close();
    voiceSock.close();
  });

  it("refuses message.send after a silent revoke, and persists nothing", async () => {
    const scene = await makeRestricted("wr", "text");

    const memberSock = await TestClient.connect(port, scene.member.token);
    const ownerSock = await TestClient.connect(port, scene.owner.token);
    await memberSock.waitFor(SERVER_EVENT.authSucceeded);
    await ownerSock.waitFor(SERVER_EVENT.authSucceeded);

    // Baseline: the socket works, and its cache holds the channel.
    const allowed = "while I still had the role";
    memberSock.send(
      clientEvent.messageSend({
        channelId: scene.channelId,
        content: allowed,
        nonce: `wr-ok-${Date.now()}`,
      }),
    );
    await ownerSock.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.content === allowed);

    await revokeSilently(scene);

    const refused = "after the role was taken away";
    const nonce = `wr-no-${Date.now()}`;
    memberSock.send(
      clientEvent.messageSend({ channelId: scene.channelId, content: refused, nonce }),
    );

    const err = await memberSock.waitFor(
      SERVER_EVENT.errorRaised,
      (e) => e.payload.nonce === nonce,
    );
    // Deliberately the same refusal a non-member gets: a restricted channel must
    // not confirm its own existence (§28).
    expect(err.payload.code).toBe("NOT_A_MEMBER");

    await settle();
    expect(
      ownerSock.envelopes.some(
        (e) =>
          e.event.type === SERVER_EVENT.messageCreated &&
          e.event.payload.content === refused,
      ),
    ).toBe(false);
    const stored = (await repos.messages.listPage({ channelId: scene.channelId })).items.map(
      (m) => m.content,
    );
    expect(stored).toContain(allowed);
    expect(stored).not.toContain(refused);

    memberSock.close();
    ownerSock.close();
  });

  it("self-heals the stale subscription, so the revoked member stops receiving", async () => {
    const scene = await makeRestricted("sh", "text");

    const memberSock = await TestClient.connect(port, scene.member.token);
    const ownerSock = await TestClient.connect(port, scene.owner.token);
    await memberSock.waitFor(SERVER_EVENT.authSucceeded);
    await ownerSock.waitFor(SERVER_EVENT.authSucceeded);

    // Proof the member IS subscribed before anything else happens.
    const before = "everyone can read this";
    ownerSock.send(
      clientEvent.messageSend({
        channelId: scene.channelId,
        content: before,
        nonce: `sh-a-${Date.now()}`,
      }),
    );
    await memberSock.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.content === before);

    await revokeSilently(scene);

    // One refused write is what teaches the connection its cache is stale.
    const nonce = `sh-no-${Date.now()}`;
    memberSock.send(
      clientEvent.messageSend({ channelId: scene.channelId, content: "denied", nonce }),
    );
    await memberSock.waitFor(SERVER_EVENT.errorRaised, (e) => e.payload.nonce === nonce);

    const after = "this must not reach the revoked member";
    ownerSock.send(
      clientEvent.messageSend({
        channelId: scene.channelId,
        content: after,
        nonce: `sh-b-${Date.now()}`,
      }),
    );
    await ownerSock.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.content === after);
    await settle();

    expect(
      memberSock.envelopes.some(
        (e) =>
          e.event.type === SERVER_EVENT.messageCreated && e.event.payload.content === after,
      ),
    ).toBe(false);

    memberSock.close();
    ownerSock.close();
  });

  it("refuses voice.join into a restricted room after a silent revoke", async () => {
    const scene = await makeRestricted("vj", "voice");

    const memberSock = await TestClient.connect(port, scene.member.token);
    const ownerSock = await TestClient.connect(port, scene.owner.token);
    await memberSock.waitFor(SERVER_EVENT.authSucceeded);
    await ownerSock.waitFor(SERVER_EVENT.authSucceeded);

    await revokeSilently(scene);

    memberSock.send(clientEvent.voiceJoin({ channelId: scene.channelId }));
    const err = await memberSock.waitFor(SERVER_EVENT.errorRaised);
    expect(err.payload.code).toBe("NOT_A_MEMBER");

    await settle();
    // Nobody in the room saw them arrive — the join was refused before any
    // broadcast, so a revoked member cannot even announce themselves.
    expect(
      ownerSock.envelopes.some((e) => e.event.type === SERVER_EVENT.voiceParticipantJoined),
    ).toBe(false);

    memberSock.close();
    ownerSock.close();
  });

  it("refuses watch.* from an occupant whose role was revoked mid-party", async () => {
    const scene = await makeRestricted("wp", "voice");

    const memberSock = await TestClient.connect(port, scene.member.token);
    await memberSock.waitFor(SERVER_EVENT.authSucceeded);

    // Joined legitimately, while the role was still held.
    memberSock.send(clientEvent.voiceJoin({ channelId: scene.channelId }));
    await memberSock.waitFor(
      SERVER_EVENT.voiceParticipantJoined,
      (e) => e.payload.userId === scene.member.id,
    );

    await revokeSilently(scene);

    // Still sitting in the room (occupancy is gateway state), so this reaches the
    // coordinator's own authority chain — which must now refuse it.
    memberSock.send(
      clientEvent.watchStart({
        channelId: scene.channelId,
        source: "youtube",
        videoRef: "dQw4w9WgXcQ",
      }),
    );
    const err = await memberSock.waitFor(SERVER_EVENT.errorRaised);
    expect(err.payload.code).toBe("NOT_A_MEMBER");

    await settle();
    expect(memberSock.envelopes.some((e) => e.event.type === SERVER_EVENT.watchStarted)).toBe(
      false,
    );

    memberSock.close();
  });

  it("leaves a public channel alone — an ordinary member keeps writing", async () => {
    const owner = await makeActor(repos, "pubO");
    const member = await makeActor(repos, "pubM");
    const group = await repos.groups.create({ name: "Public Crew", ownerId: owner.id });
    await repos.groups.addMember(group.id, member.id, "member");
    const channel = await repos.channels.create({
      groupId: group.id,
      kind: "text",
      name: "general",
    });

    const memberSock = await TestClient.connect(port, member.token);
    const ownerSock = await TestClient.connect(port, owner.token);
    await memberSock.waitFor(SERVER_EVENT.authSucceeded);
    await ownerSock.waitFor(SERVER_EVENT.authSucceeded);

    const content = "no roles, no gate";
    memberSock.send(
      clientEvent.messageSend({
        channelId: channel.id,
        content,
        nonce: `pub-${Date.now()}`,
      }),
    );
    await ownerSock.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.content === content);

    memberSock.close();
    ownerSock.close();
  });
});
