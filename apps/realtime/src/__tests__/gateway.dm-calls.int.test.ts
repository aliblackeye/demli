/**
 * DM-calls gateway integration tests (ADR 0012 / plan Wave 3) — real Postgres +
 * real WebSockets. Skipped automatically (with a console notice) when the
 * database is down.
 *
 * Wave 3 is deliberately "no routing code": every `call.*` event is user-scoped
 * and already rides the generic `handleUserMutation` fan-out, and the seamless
 * upgrade re-uses the existing group-scoped `member.joined` wiring. These tests
 * VERIFY that contract end-to-end rather than exercise new gateway code:
 *
 *  1. every `call.*` event (invite / accepted / ended / upgraded) reaches ALL of
 *     the target user's live connections and NO other user's;
 *  2. the upgrade sequence the API publishes — `member.joined`×3 (group-scoped)
 *     BEFORE `call.upgraded`×2 + `call.invite{target:group}` — wires all three
 *     participants' connections into the brand-new group, so the two originals
 *     get `call.upgraded` AND are subscribed to the new voice channel, and the
 *     invitee gets `call.invite{target:group}` and, on `voice.join`, shows up in
 *     that channel's occupancy (seen by the originals and by a fresh handshake).
 *
 * Media never crosses this socket (ADR 0012 §10/§35) — the LiveKit room is bound
 * by the API/DB layer; the gateway only carries the thin control events.
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
import { clientEvent, serverEvent, SERVER_EVENT } from "@demli/protocol";
import type { User } from "@demli/types";
import { createGateway, type Gateway } from "../gateway.js";
import { InMemoryPresenceStore } from "../presence.js";
import { DATABASE_URL, isDbUp, TestClient } from "./harness.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

interface Actor {
  id: string;
  token: string;
  user: User;
}

/** Create a user + a live session token, ready to open a gateway socket. */
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
  return { id: user.id, token, user };
}

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[gateway.dm-calls.int.test] DATABASE unreachable — skipping integration tests");
}

describe.skipIf(!dbUp)("gateway DM calls — call.* fan-out & seamless upgrade wiring", () => {
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

  it("forwards every call.* event to all of the target's connections and no one else", async () => {
    const caller = await makeActor(repos, "callFwdCaller");
    const callee = await makeActor(repos, "callFwdCallee");
    const bystander = await makeActor(repos, "callFwdBystander");

    // A DM (its id is the CallTarget's dmId) and a group + voice channel to build
    // a schema-valid call.upgraded payload. None of this drives the gateway — the
    // test only asserts the thin control events fan out to the right sockets.
    const { dm } = await repos.dms.getOrCreate(caller.id, callee.id);
    const group = await repos.groupChats.create({ name: "Fwd Crew", ownerId: caller.id });
    const voice = await repos.channels.create({
      groupId: group.id,
      kind: "voice",
      name: "voice",
    });

    // Callee is on two devices; both must receive every call.* event.
    const c1 = await TestClient.connect(port, callee.token);
    const c2 = await TestClient.connect(port, callee.token);
    const bSock = await TestClient.connect(port, bystander.token);
    await c1.waitFor(SERVER_EVENT.authSucceeded);
    await c2.waitFor(SERVER_EVENT.authSucceeded);
    await bSock.waitFor(SERVER_EVENT.authSucceeded);

    const callId = randomUUID();
    const events = [
      serverEvent.callInvite({
        callId,
        target: { kind: "dm", dmId: dm.id },
        caller: caller.user,
        media: "audio",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      }),
      serverEvent.callAccepted({
        callId,
        target: { kind: "dm", dmId: dm.id },
        callee: callee.user,
      }),
      serverEvent.callEnded({ callId, reason: "hung_up" }),
      serverEvent.callUpgraded({ callId, group, voiceChannelId: voice.id }),
    ] as const;

    for (const event of events) {
      await mutationBus.publish({ userId: callee.id, event });
    }

    // Every call.* event reaches BOTH of the callee's connections.
    for (const sock of [c1, c2]) {
      await sock.waitFor(SERVER_EVENT.callInvite, (e) => e.payload.callId === callId);
      await sock.waitFor(SERVER_EVENT.callAccepted, (e) => e.payload.callId === callId);
      await sock.waitFor(SERVER_EVENT.callEnded, (e) => e.payload.callId === callId);
      await sock.waitFor(SERVER_EVENT.callUpgraded, (e) => e.payload.callId === callId);
    }

    // Leak barrier: a distinct call.ended (different callId) to the bystander. The
    // bystander socket is ordered, so once this arrives, any leaked callee event
    // would already have landed.
    const barrierCallId = randomUUID();
    await mutationBus.publish({
      userId: bystander.id,
      event: serverEvent.callEnded({ callId: barrierCallId, reason: "declined" }),
    });
    await bSock.waitFor(SERVER_EVENT.callEnded, (e) => e.payload.callId === barrierCallId);

    const leaked = bSock.envelopes.some(
      (env) =>
        typeof (env.event.payload as { callId?: unknown }).callId === "string" &&
        (env.event.payload as { callId?: unknown }).callId === callId,
    );
    expect(leaked).toBe(false);

    c1.close();
    c2.close();
    bSock.close();
  });

  it("seamless upgrade wires all three into the new group; invitee joins the call room and appears in occupancy", async () => {
    const caller = await makeActor(repos, "upCaller");
    const callee = await makeActor(repos, "upCallee");
    const invitee = await makeActor(repos, "upInvitee");

    // A live (active) DM call between the two originals — the upgrade source.
    const { dm } = await repos.dms.getOrCreate(caller.id, callee.id);
    const call = await repos.calls.create({
      dmId: dm.id,
      callerId: caller.id,
      calleeId: callee.id,
      media: "audio",
    });
    await repos.calls.setStatus(call.id, "active", { startedAt: new Date() });

    // All three are connected BEFORE the upgrade (as in a real call): the two
    // originals are in the DM call; the invitee is idle. None of their sockets is
    // indexed under the new group yet — that is exactly what the wiring must add.
    const callerSock = await TestClient.connect(port, caller.token);
    const calleeSock = await TestClient.connect(port, callee.token);
    const inviteeSock = await TestClient.connect(port, invitee.token);
    await callerSock.waitFor(SERVER_EVENT.authSucceeded);
    await calleeSock.waitFor(SERVER_EVENT.authSucceeded);
    await inviteeSock.waitFor(SERVER_EVENT.authSucceeded);

    // Atomic upgrade (Wave 1 tx): new group + 3 memberships + hidden text stream +
    // a voice channel bound to the ongoing call's LiveKit room.
    const { group, voiceChannelId } = await repos.callUpgrade.upgradeDmToGroup({
      callId: call.id,
      name: "Upgraded Crew",
      ownerId: caller.id,
      memberIds: [callee.id, invitee.id],
    });

    // Replicate the API's publish ORDER (dm-calls module): member.joined×3 FIRST
    // (group-scoped — the gateway indexes + subscribes each user's connections
    // into the new group off these), THEN call.upgraded×2 to the originals and
    // call.invite{target:group} to the invitee.
    for (const u of [caller.user, callee.user, invitee.user]) {
      const member = await repos.groups.getMembership(group.id, u.id);
      if (!member) throw new Error(`expected membership for ${u.id}`);
      await mutationBus.publish({
        groupId: group.id,
        event: serverEvent.memberJoined({ groupId: group.id, member, user: u }),
      });
    }
    for (const originalId of [caller.id, callee.id]) {
      await mutationBus.publish({
        userId: originalId,
        event: serverEvent.callUpgraded({ callId: call.id, group, voiceChannelId }),
      });
    }
    await mutationBus.publish({
      userId: invitee.id,
      event: serverEvent.callInvite({
        callId: call.id,
        target: { kind: "group", groupId: group.id, voiceChannelId },
        caller: caller.user,
        media: "audio",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
      }),
    });

    // The two originals get call.upgraded pointing at the new group + voice channel.
    const upCaller = await callerSock.waitFor(
      SERVER_EVENT.callUpgraded,
      (e) => e.payload.callId === call.id,
    );
    expect(upCaller.payload.group.id).toBe(group.id);
    expect(upCaller.payload.voiceChannelId).toBe(voiceChannelId);
    await calleeSock.waitFor(SERVER_EVENT.callUpgraded, (e) => e.payload.callId === call.id);

    // The invitee gets call.invite carrying the GROUP target (its voice channel's
    // LiveKit room IS the live call, so accepting lands them in the ongoing call).
    const invite = await inviteeSock.waitFor(
      SERVER_EVENT.callInvite,
      (e) => e.payload.callId === call.id,
    );
    expect(invite.payload.target).toEqual({
      kind: "group",
      groupId: group.id,
      voiceChannelId,
    });

    // Barrier: each connection receives its OWN member.joined. handleMemberJoined
    // subscribes the connection to the group's visible channels in the SAME
    // synchronous block that emits this frame, so its arrival proves the
    // subscription is live — no reliance on timing between the fire-and-forget
    // group- and user-scoped handlers.
    await callerSock.waitFor(
      SERVER_EVENT.memberJoined,
      (e) => e.payload.groupId === group.id && e.payload.user.id === caller.id,
    );
    await calleeSock.waitFor(
      SERVER_EVENT.memberJoined,
      (e) => e.payload.groupId === group.id && e.payload.user.id === callee.id,
    );
    await inviteeSock.waitFor(
      SERVER_EVENT.memberJoined,
      (e) => e.payload.groupId === group.id && e.payload.user.id === invitee.id,
    );

    // The invitee joins the new group's voice channel (whose room is the call
    // room). Their own echo confirms the join was accepted (subscribed, not
    // NOT_A_MEMBER); the two originals receiving the delta proves THEY are
    // subscribed to the new channel too.
    inviteeSock.send(clientEvent.voiceJoin({ channelId: voiceChannelId }));
    await inviteeSock.waitFor(
      SERVER_EVENT.voiceParticipantJoined,
      (e) => e.payload.channelId === voiceChannelId && e.payload.userId === invitee.id,
    );
    await callerSock.waitFor(
      SERVER_EVENT.voiceParticipantJoined,
      (e) => e.payload.channelId === voiceChannelId && e.payload.userId === invitee.id,
    );
    await calleeSock.waitFor(
      SERVER_EVENT.voiceParticipantJoined,
      (e) => e.payload.channelId === voiceChannelId && e.payload.userId === invitee.id,
    );

    // A fresh handshake for an original sees the invitee already in occupancy for
    // the new voice channel — the snapshot reflects the live call room.
    const freshCaller = await TestClient.connect(port, caller.token);
    const freshAuth = await freshCaller.waitFor(SERVER_EVENT.authSucceeded);
    expect(freshAuth.payload.voiceOccupancy).toEqual([
      { channelId: voiceChannelId, occupants: [{ userId: invitee.id, muted: false }] },
    ]);

    // And an original can actively join the call room too: the invitee sees it,
    // confirming the originals are full participants of the upgraded channel.
    callerSock.send(clientEvent.voiceJoin({ channelId: voiceChannelId }));
    await inviteeSock.waitFor(
      SERVER_EVENT.voiceParticipantJoined,
      (e) => e.payload.channelId === voiceChannelId && e.payload.userId === caller.id,
    );

    callerSock.close();
    calleeSock.close();
    inviteeSock.close();
    freshCaller.close();
  });
});
