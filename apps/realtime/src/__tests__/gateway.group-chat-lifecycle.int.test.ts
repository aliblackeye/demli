/**
 * Group-chat / DM membership lifecycle — real Postgres + real WebSockets.
 * Skipped automatically (with a console notice) when the database is down.
 *
 * The regression these tests exist for (P0 privacy leak, 2026-07-31): the
 * gateway seeded `conn.groupIds` from `groups.listForUser(userId)`, whose `kind`
 * defaults to `"server"`. Flat group chats and DMs were therefore absent from
 * the group index, so `member.left` surgery hit `if (!conn.groupIds.has(groupId))
 * continue` and did nothing: a member KICKED from a private group chat kept
 * receiving every later message on its stream until they happened to reconnect
 * — and the remaining members never saw the roster event either. `group.deleted`
 * had the same hole.
 *
 * `gateway.int.test.ts` already covered both paths, but only for `kind="server"`
 * groups — exactly the gap the bug lived in. These cases pin the group-chat and
 * DM kinds so the server-only regression cannot come back.
 */

import { randomUUID } from "node:crypto";
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
import { clientEvent, serverEvent, SERVER_EVENT, type ServerEventOf } from "@demli/protocol";
import { createGateway, type Gateway } from "../gateway.js";
import { InMemoryPresenceStore } from "../presence.js";
import { DATABASE_URL, isDbUp, TestClient } from "./harness.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[gateway.group-chat-lifecycle] DATABASE unreachable — skipping");
}

describe.skipIf(!dbUp)("gateway group-chat & dm membership lifecycle", () => {
  let client: DbClient;
  let repos: Repositories;
  let gateway: Gateway;
  let mutationBus: InMemoryMutationBus;
  let port: number;

  let ownerId: string;
  let tokenOwner: string;
  let memberId: string;
  let tokenMember: string;

  /** The group chat the member gets kicked from. */
  let kickedGroupId: string;
  let kickedStreamId: string;
  /** A voice channel in that group chat — the kick's resync barrier. */
  let kickedVoiceId: string;
  /** A group chat both users keep — the ordered delivery barrier. */
  let survivorStreamId: string;
  /** A group chat that gets deleted whole. */
  let doomedGroupId: string;
  let doomedStreamId: string;
  /** A voice channel in the doomed group chat — the resync barrier (see below). */
  let doomedVoiceId: string;
  /** The DM between the two users (a `friend_groups` row of kind `"dm"`). */
  let dmGroupId: string;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);

    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const owner = await repos.users.create({
      username: `gc_o_${suffix}`,
      displayName: "GC Owner",
      passwordHash: "not-used",
    });
    const member = await repos.users.create({
      username: `gc_m_${suffix}`,
      displayName: "GC Member",
      passwordHash: "not-used",
    });
    ownerId = owner.id;
    memberId = member.id;

    tokenOwner = generateSessionToken();
    tokenMember = generateSessionToken();
    const expiresAt = sessionExpiresAt(new Date(), 1);
    await repos.sessions.create({
      userId: ownerId,
      tokenHash: hashSessionToken(tokenOwner),
      expiresAt,
    });
    await repos.sessions.create({
      userId: memberId,
      tokenHash: hashSessionToken(tokenMember),
      expiresAt,
    });

    // Flat group chats (`kind="group"`), created through the same repository the
    // API uses: friend_groups row + memberships + ONE hidden "stream" channel.
    const kicked = await repos.groupChats.create({ name: "Kick Crew", ownerId });
    await repos.groupChats.addMember(kicked.id, memberId);
    kickedGroupId = kicked.id;
    kickedStreamId = kicked.streamId;
    const kickedVoice = await repos.channels.create({
      groupId: kickedGroupId,
      kind: "voice",
      name: "k-lobby",
    });
    kickedVoiceId = kickedVoice.id;

    const survivor = await repos.groupChats.create({ name: "Survivor Crew", ownerId });
    await repos.groupChats.addMember(survivor.id, memberId);
    survivorStreamId = survivor.streamId;

    const doomed = await repos.groupChats.create({ name: "Doomed Crew", ownerId });
    await repos.groupChats.addMember(doomed.id, memberId);
    doomedGroupId = doomed.id;
    doomedStreamId = doomed.streamId;
    // A voice channel in the doomed group (as a group-DM call creates). Both
    // sockets sit in it so `group.deleted`'s forced leave gives each connection a
    // deterministic "my full resync ran" barrier — the bus fan-out is
    // fire-and-forget, so `publish()` returning proves nothing about the resync.
    const doomedVoice = await repos.channels.create({
      groupId: doomedGroupId,
      kind: "voice",
      name: "d-lobby",
    });
    doomedVoiceId = doomedVoice.id;

    const { dm } = await repos.dms.getOrCreate(ownerId, memberId);
    dmGroupId = dm.id;

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

  /** Persist + fan a channel-scoped message.created (exactly as the API does). */
  async function fanMessage(channelId: string, content: string): Promise<void> {
    const message = await repos.messages.create({ channelId, authorId: ownerId, content });
    await mutationBus.publish({ channelId, event: serverEvent.messageCreated(message) });
  }

  /**
   * Fan an EPHEMERAL message.created without touching the DB — for a stream whose
   * channel row (and FK target) is already gone with its deleted group.
   */
  async function fanEphemeral(channelId: string, content: string): Promise<void> {
    await mutationBus.publish({
      channelId,
      event: serverEvent.messageCreated({
        id: randomUUID(),
        channelId,
        authorId: ownerId,
        content,
        kind: "user",
        createdAt: new Date().toISOString(),
        updatedAt: null,
        deletedAt: null,
      }),
    });
  }

  /** Re-fan until `target` receives it — the deterministic "subscribed" barrier. */
  async function fanUntilReceived(
    channelId: string,
    content: string,
    target: TestClient,
  ): Promise<ServerEventOf<"message.created">> {
    const deadline = Date.now() + 4000;
    for (;;) {
      await fanMessage(channelId, content);
      try {
        return await target.waitFor(
          SERVER_EVENT.messageCreated,
          (e) => e.payload.content === content,
          250,
        );
      } catch (err) {
        if (Date.now() > deadline) throw err;
      }
    }
  }

  /**
   * Assert `target` never received `absentContent`, using a message on the
   * survivor group chat — which the target still belongs to no matter what the
   * test did — as an ordered delivery barrier: the absent frame, if it were
   * coming, lands on the same socket BEFORE the marker does.
   */
  async function assertNotDelivered(
    target: TestClient,
    absentContent: string,
  ): Promise<void> {
    const marker = `barrier-${Date.now()}-${Math.random()}`;
    await fanUntilReceived(survivorStreamId, marker, target);
    const leaked = target.envelopes.some(
      (env) =>
        env.event.type === SERVER_EVENT.messageCreated &&
        env.event.payload.content === absentContent,
    );
    expect(leaked).toBe(false);
  }

  it("stops group-chat stream frames to a KICKED member (privacy regression)", async () => {
    const owner = await TestClient.connect(port, tokenOwner);
    const m = await TestClient.connect(port, tokenMember);
    await owner.waitFor(SERVER_EVENT.authSucceeded);
    await m.waitFor(SERVER_EVENT.authSucceeded);

    // Baseline: the member IS reading the private group chat before the kick.
    await fanUntilReceived(kickedStreamId, `pre-kick-${Date.now()}`, m);

    // …and sitting in its voice room, which gives the kick a deterministic
    // barrier: the forced leave is emitted inside the same synchronous step that
    // drops this connection's subscriptions, whereas the thin `member.left` is
    // sent BEFORE any of that (bus fan-out is fire-and-forget).
    m.send(clientEvent.voiceJoin({ channelId: kickedVoiceId }));
    await m.waitFor(
      SERVER_EVENT.voiceParticipantJoined,
      (e) => e.payload.userId === memberId && e.payload.channelId === kickedVoiceId,
    );

    // Kick (DB) then fan member.left (bus) — exactly what DELETE
    // /group-chats/:id/members/:userId does.
    expect(await repos.groupChats.removeMember(kickedGroupId, memberId)).toBe(true);
    await mutationBus.publish({
      groupId: kickedGroupId,
      event: serverEvent.memberLeft({ groupId: kickedGroupId, userId: memberId }),
    });

    // The thin event reaches the remaining member (roster refresh) AND the
    // kicked member's own socket (their UI drops the group) — both are only
    // possible because a group chat is in the gateway's group index at all.
    await owner.waitFor(
      SERVER_EVENT.memberLeft,
      (e) => e.payload.groupId === kickedGroupId && e.payload.userId === memberId,
    );
    await m.waitFor(
      SERVER_EVENT.memberLeft,
      (e) => e.payload.groupId === kickedGroupId && e.payload.userId === memberId,
    );

    // Barrier: the kicked member is forced out of the group chat's voice room —
    // the step that immediately precedes dropping their stream subscription.
    await m.waitFor(
      SERVER_EVENT.voiceParticipantLeft,
      (e) => e.payload.userId === memberId && e.payload.channelId === kickedVoiceId,
    );

    // THE ACTUAL LEAK: a message posted after the kick must not reach them.
    const absent = `post-kick-secret-${Date.now()}`;
    await fanMessage(kickedStreamId, absent);
    // The owner is still on the stream — proof the fan-out really happened and
    // the member's silence is an unsubscribe, not a dead publish.
    await owner.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.content === absent);
    await assertNotDelivered(m, absent);

    owner.close();
    m.close();
  });

  it("delivers group.deleted to group-chat members and stops their frames", async () => {
    const owner = await TestClient.connect(port, tokenOwner);
    const m = await TestClient.connect(port, tokenMember);
    await owner.waitFor(SERVER_EVENT.authSucceeded);
    await m.waitFor(SERVER_EVENT.authSucceeded);

    await fanUntilReceived(doomedStreamId, `pre-delete-${Date.now()}`, m);

    // Both sit in the doomed group's voice room (the forced-leave barrier).
    owner.send(clientEvent.voiceJoin({ channelId: doomedVoiceId }));
    m.send(clientEvent.voiceJoin({ channelId: doomedVoiceId }));
    await owner.waitFor(
      SERVER_EVENT.voiceParticipantJoined,
      (e) => e.payload.userId === ownerId && e.payload.channelId === doomedVoiceId,
    );
    await m.waitFor(
      SERVER_EVENT.voiceParticipantJoined,
      (e) => e.payload.userId === memberId && e.payload.channelId === doomedVoiceId,
    );

    // Delete the whole group chat (DB cascade over its stream + messages +
    // memberships), then fan group.deleted — the DELETE /group-chats/:id path.
    await repos.groups.delete(doomedGroupId);
    await mutationBus.publish({
      groupId: doomedGroupId,
      event: serverEvent.groupDeleted({ groupId: doomedGroupId }),
    });

    await m.waitFor(SERVER_EVENT.groupDeleted, (e) => e.payload.groupId === doomedGroupId);
    await owner.waitFor(
      SERVER_EVENT.groupDeleted,
      (e) => e.payload.groupId === doomedGroupId,
    );

    // Each socket's own forced voice-leave is emitted INSIDE its full resync,
    // one synchronous step before its subscriptions are dropped — so seeing it
    // is the proof that this connection's resync actually ran (the thin event
    // above is sent before the resync and proves nothing about it).
    await owner.waitFor(
      SERVER_EVENT.voiceParticipantLeft,
      (e) => e.payload.userId === ownerId && e.payload.channelId === doomedVoiceId,
    );
    await m.waitFor(
      SERVER_EVENT.voiceParticipantLeft,
      (e) => e.payload.userId === memberId && e.payload.channelId === doomedVoiceId,
    );

    // The dead stream's frames no longer reach either member (ephemeral fan: the
    // channel row is gone, so nothing can be persisted to it).
    const absent = `post-delete-${Date.now()}`;
    await fanEphemeral(doomedStreamId, absent);
    await assertNotDelivered(m, absent);
    await assertNotDelivered(owner, absent);

    owner.close();
    m.close();
  });

  it("indexes DMs too, so a group-scoped dm event reaches both participants", async () => {
    // A DM has no kick path at all (leaving a DM is `hide`, a user-scoped
    // no-op on membership), so the leak above cannot exist here. What CAN
    // happen is the mirror-image bug: custom emoji are deliberately group-scoped
    // for DMs as well (apps/api custom-emojis `loadMembership`, not
    // `loadServer`), and a dm missing from the group index would drop that
    // event on the floor. Both participants must get it.
    const owner = await TestClient.connect(port, tokenOwner);
    const m = await TestClient.connect(port, tokenMember);
    await owner.waitFor(SERVER_EVENT.authSucceeded);
    await m.waitFor(SERVER_EVENT.authSucceeded);

    const emojiId = randomUUID();
    await mutationBus.publish({
      groupId: dmGroupId,
      event: serverEvent.emojiCreated({
        groupId: dmGroupId,
        emoji: {
          id: emojiId,
          groupId: dmGroupId,
          name: "demli",
          mime: "image/png",
          sizeBytes: 1024,
          createdBy: ownerId,
          createdAt: new Date().toISOString(),
        },
      }),
    });

    await m.waitFor(SERVER_EVENT.emojiCreated, (e) => e.payload.emoji.id === emojiId);
    await owner.waitFor(SERVER_EVENT.emojiCreated, (e) => e.payload.emoji.id === emojiId);

    owner.close();
    m.close();
  });
});
