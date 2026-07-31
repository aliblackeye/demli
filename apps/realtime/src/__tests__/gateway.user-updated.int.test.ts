/**
 * `user.updated` fan-out scope — real Postgres + real WebSockets.
 * Skipped automatically (with a console notice) when the database is down.
 *
 * The founder's bug: changing your avatar left it stale in everyone else's member
 * sidebar until they reloaded. The fix publishes ONE user-scoped mutation and the
 * gateway expands it to the presence audience. These tests pin the two halves of
 * that contract:
 *
 *  1. REACH — a co-member of a shared server, a DM counterpart, an accepted friend
 *     with no shared group, and the subject's OWN second device all receive it.
 *  2. NO LEAK — a user who shares no context with the subject receives nothing.
 *
 * The leak half is the one that matters for privacy: the payload is a whole
 * profile, so an over-broad audience would hand a stranger someone's display name
 * and photo.
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
import { createGateway, type Gateway } from "../gateway.js";
import { InMemoryPresenceStore } from "../presence.js";
import { DATABASE_URL, isDbUp, TestClient } from "./harness.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

interface Actor {
  id: string;
  token: string;
  user: User;
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
  return { id: user.id, token, user };
}

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[gateway.user-updated.int.test] DATABASE unreachable — skipping integration tests");
}

describe.skipIf(!dbUp)("gateway user.updated — profile fan-out scope", () => {
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

  it("reaches co-members, DM counterparts, friends and the subject's own devices — and NOT a stranger", async () => {
    const subject = await makeActor(repos, "subj");
    const coMember = await makeActor(repos, "coMember");
    const dmPeer = await makeActor(repos, "dmPeer");
    const friend = await makeActor(repos, "friendOnly");
    const stranger = await makeActor(repos, "stranger");

    // Shared server → co-member.
    const group = await repos.groups.create({ name: "Profile Crew", ownerId: subject.id });
    await repos.groups.addMember(group.id, coMember.id, "member");

    // Shared DM → counterpart (a `friend_groups` row of kind "dm", so it lands in
    // the same co-member set).
    await repos.dms.getOrCreate(subject.id, dmPeer.id);

    // Accepted friendship with NO shared group → the audience UNION arm.
    await repos.friendships.send(subject.id, friend.id);
    const accepted = await repos.friendships.accept(friend.id, subject.id);
    expect(accepted.ok).toBe(true);

    // `stranger` shares nothing: no group, no DM, no friendship.

    const subjectDevice1 = await TestClient.connect(port, subject.token);
    const subjectDevice2 = await TestClient.connect(port, subject.token);
    const coMemberSock = await TestClient.connect(port, coMember.token);
    const dmPeerSock = await TestClient.connect(port, dmPeer.token);
    const friendSock = await TestClient.connect(port, friend.token);
    const strangerSock = await TestClient.connect(port, stranger.token);
    for (const sock of [
      subjectDevice1,
      subjectDevice2,
      coMemberSock,
      dmPeerSock,
      friendSock,
      strangerSock,
    ]) {
      await sock.waitFor(SERVER_EVENT.authSucceeded);
    }

    // The subject changes their photo + name.
    const updated = await repos.users.updateProfile(subject.id, {
      displayName: "Ali (new)",
      avatarUrl: "https://cdn.example.com/avatars/new.png",
    });
    if (!updated) throw new Error("expected the profile update to return a row");

    await mutationBus.publish({
      userId: subject.id,
      event: serverEvent.userUpdated({ user: updated }),
    });

    const sawUpdate = (e: { payload: { user: { id: string; avatarUrl: string | null } } }): boolean =>
      e.payload.user.id === subject.id &&
      e.payload.user.avatarUrl === "https://cdn.example.com/avatars/new.png";

    // 1. REACH — everyone who can see the subject repaints.
    await coMemberSock.waitFor(SERVER_EVENT.userUpdated, sawUpdate);
    await dmPeerSock.waitFor(SERVER_EVENT.userUpdated, sawUpdate);
    await friendSock.waitFor(SERVER_EVENT.userUpdated, sawUpdate);
    // The subject's OWN other session too (multi-window consistency).
    await subjectDevice1.waitFor(SERVER_EVENT.userUpdated, sawUpdate);
    await subjectDevice2.waitFor(SERVER_EVENT.userUpdated, sawUpdate);

    // 2. NO LEAK — barrier: send the stranger a distinct user-scoped event. Their
    // socket is ordered, so once THAT lands, any leaked `user.updated` would
    // already have arrived before it.
    await mutationBus.publish({
      userId: stranger.id,
      event: serverEvent.friendRemoved({ userId: subject.id }),
    });
    await strangerSock.waitFor(SERVER_EVENT.friendRemoved);

    const leaked = strangerSock.envelopes.some(
      (env) => env.event.type === SERVER_EVENT.userUpdated,
    );
    expect(leaked).toBe(false);

    for (const sock of [
      subjectDevice1,
      subjectDevice2,
      coMemberSock,
      dmPeerSock,
      friendSock,
      strangerSock,
    ]) {
      sock.close();
    }
  });

  it("never puts the me-only fields on the wire, even when handed a full self row", async () => {
    const subject = await makeActor(repos, "leakSubj");
    const viewer = await makeActor(repos, "leakViewer");
    const group = await repos.groups.create({ name: "Leak Crew", ownerId: subject.id });
    await repos.groups.addMember(group.id, viewer.id, "member");

    // Give the subject a birthdate + friend code — the account-private fields.
    await repos.users.updateProfile(subject.id, { birthdate: "1998-04-12" });
    const selfRow = await repos.users.findSelf(subject.id);
    if (!selfRow) throw new Error("expected the self row to resolve");
    expect(selfRow.friendCode).toBeTruthy();
    expect(selfRow.birthdate).toBe("1998-04-12");

    const viewerSock = await TestClient.connect(port, viewer.token);
    await viewerSock.waitFor(SERVER_EVENT.authSucceeded);

    // Deliberately publish the FULL self row — the codec must strip it.
    await mutationBus.publish({
      userId: subject.id,
      event: serverEvent.userUpdated({ user: selfRow as never }),
    });
    await viewerSock.waitFor(
      SERVER_EVENT.userUpdated,
      (e) => e.payload.user.id === subject.id,
    );

    // Assert against the RAW frames: the parsed envelope strips unknown keys, so
    // only the raw string proves nothing private crossed the socket.
    const raw = viewerSock.rawFrames.join("\n");
    expect(raw).not.toContain(selfRow.friendCode);
    expect(raw).not.toContain("1998-04-12");
    expect(raw).not.toContain("birthdate");
    expect(raw).not.toContain("friendCode");

    viewerSock.close();
  });
});
