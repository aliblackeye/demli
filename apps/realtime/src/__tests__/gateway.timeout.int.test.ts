/**
 * Timeout at the GATEWAY (migration 0020, ADR 0019 §3) — real Postgres + real
 * WebSockets. Auto-skipped (with a notice) when the database is unreachable.
 *
 * The HTTP suite (`apps/api/.../member-context-menu.int.test.ts`) proves the
 * REST paths. This suite exists because a timeout enforced on only ONE transport
 * is a timeout enforced on neither: the desktop client sends over this socket
 * while the mobile client posts over HTTP, so a muted member who can still speak
 * here would make the whole feature theatre.
 *
 * It proves three things:
 *
 *  1. a timed-out member's `message.send` is REFUSED with a nonce'd `TIMED_OUT`
 *     error and NOTHING is persisted;
 *  2. the mute is per-member — everyone else in the channel keeps talking, and
 *     their messages still reach the muted member (a timeout silences, it does
 *     not disconnect);
 *  3. expiry is evaluated per attempt, so a lapsed timeout starts working again
 *     mid-session with no reconnect and no sweeper having run.
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

/** Give the gateway a beat to deliver (or deliberately NOT deliver) a frame. */
async function settle(ms = 400): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[gateway.timeout.int.test] DATABASE unreachable — skipping integration tests");
}

describe.skipIf(!dbUp)("gateway timeout — the WS half of the mute", () => {
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

  it("refuses a timed-out member's message.send and persists nothing", async () => {
    const owner = await makeActor(repos, "toO");
    const muted = await makeActor(repos, "toM");
    const group = await repos.groups.create({ name: "Timeout Crew", ownerId: owner.id });
    await repos.groups.addMember(group.id, muted.id, "member");
    const channel = await repos.channels.create({
      groupId: group.id,
      kind: "text",
      name: "general",
    });

    const mutedSock = await TestClient.connect(port, muted.token);
    const ownerSock = await TestClient.connect(port, owner.token);
    await mutedSock.waitFor(SERVER_EVENT.authSucceeded);
    await ownerSock.waitFor(SERVER_EVENT.authSucceeded);

    // Baseline: the socket works before the mute.
    const beforeText = "before the timeout";
    mutedSock.send(
      clientEvent.messageSend({
        channelId: channel.id,
        content: beforeText,
        nonce: `to-before-${Date.now()}`,
      }),
    );
    await ownerSock.waitFor(
      SERVER_EVENT.messageCreated,
      (e) => e.payload.content === beforeText,
    );

    // Mute them. Note the connection STAYS OPEN and is not re-handshaked — the
    // gate is re-evaluated per send from the membership row, so a mute applied
    // mid-session takes effect on the very next frame.
    await repos.groups.setMemberTimeout(
      group.id,
      muted.id,
      new Date(Date.now() + 60 * 60 * 1000),
    );

    const blockedText = "after the timeout";
    const nonce = `to-after-${Date.now()}`;
    mutedSock.send(
      clientEvent.messageSend({ channelId: channel.id, content: blockedText, nonce }),
    );

    // The refusal comes back on the sender's own socket, carrying the nonce so
    // the client can fail exactly the optimistic row it created (§22 — an
    // optimistic failure must not corrupt the list).
    const err = await mutedSock.waitFor(
      SERVER_EVENT.errorRaised,
      (e) => e.payload.nonce === nonce,
    );
    expect(err.payload.code).toBe("TIMED_OUT");

    await settle();

    // Nobody received the message, and nothing was written — the gate runs
    // before the persist, exactly like the REST twin.
    expect(
      ownerSock.envelopes.some(
        (e) =>
          e.event.type === SERVER_EVENT.messageCreated &&
          e.event.payload.content === blockedText,
      ),
    ).toBe(false);
    const page = await repos.messages.listPage({ channelId: channel.id });
    const stored = page.items.map((m) => m.content);
    expect(stored).toContain(beforeText);
    expect(stored).not.toContain(blockedText);

    mutedSock.close();
    ownerSock.close();
  });

  it("silences only the muted member, and still delivers others' messages to them", async () => {
    const owner = await makeActor(repos, "tosO");
    const muted = await makeActor(repos, "tosM");
    const group = await repos.groups.create({ name: "Scoped Crew", ownerId: owner.id });
    await repos.groups.addMember(group.id, muted.id, "member");
    const channel = await repos.channels.create({
      groupId: group.id,
      kind: "text",
      name: "general",
    });
    await repos.groups.setMemberTimeout(
      group.id,
      muted.id,
      new Date(Date.now() + 60 * 60 * 1000),
    );

    const mutedSock = await TestClient.connect(port, muted.token);
    const ownerSock = await TestClient.connect(port, owner.token);
    await mutedSock.waitFor(SERVER_EVENT.authSucceeded);
    await ownerSock.waitFor(SERVER_EVENT.authSucceeded);

    // The un-muted owner still talks…
    const text = "the room carries on";
    ownerSock.send(
      clientEvent.messageSend({
        channelId: channel.id,
        content: text,
        nonce: `tos-${Date.now()}`,
      }),
    );

    // …and the MUTED member still receives it. A timeout takes away speech, not
    // presence — they stay in the room and keep reading, which is what makes it
    // a cool-off rather than a kick.
    await mutedSock.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.content === text);

    mutedSock.close();
    ownerSock.close();
  });

  it("lets a LAPSED timeout speak again mid-session, with no sweeper and no reconnect", async () => {
    const owner = await makeActor(repos, "toeO");
    const muted = await makeActor(repos, "toeM");
    const group = await repos.groups.create({ name: "Expiry Crew", ownerId: owner.id });
    await repos.groups.addMember(group.id, muted.id, "member");
    const channel = await repos.channels.create({
      groupId: group.id,
      kind: "text",
      name: "general",
    });

    // An ALREADY-EXPIRED timeout. Written directly so the suite need not sleep:
    // the claim under test is that expiry is a query-time comparison, so a past
    // instant must be indistinguishable from no timeout with nothing having run.
    await repos.groups.setMemberTimeout(group.id, muted.id, new Date(Date.now() - 1000));

    const mutedSock = await TestClient.connect(port, muted.token);
    const ownerSock = await TestClient.connect(port, owner.token);
    await mutedSock.waitFor(SERVER_EVENT.authSucceeded);
    await ownerSock.waitFor(SERVER_EVENT.authSucceeded);

    const text = "the mute has lapsed";
    mutedSock.send(
      clientEvent.messageSend({
        channelId: channel.id,
        content: text,
        nonce: `toe-${Date.now()}`,
      }),
    );
    await ownerSock.waitFor(SERVER_EVENT.messageCreated, (e) => e.payload.content === text);

    mutedSock.close();
    ownerSock.close();
  });
});
