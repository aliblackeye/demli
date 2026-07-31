/**
 * M7b API integration tests — real Postgres from docker-compose.
 * Skipped automatically (with a console notice) when the database is down.
 *
 * Covers: system channel assignment + owner re-pointing, system messages on
 * invite redeem / member leave (persist AND mutation-bus broadcast), slowmode
 * enforcement (owner exempt), and audioBitrateKbps voice-only validation.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  applyMigrations,
  createDb,
  createRepositories,
  InMemoryMutationBus,
  type DbClient,
  type RealtimeMutation,
} from "@demli/db";
import { SERVER_EVENT } from "@demli/protocol";
import type { Message } from "@demli/types";
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
  console.warn("[m7-system.int.test] DATABASE unreachable — skipping integration tests");
}

describe.skipIf(!dbUp)("m7 system channel, system messages, slowmode", () => {
  let client: DbClient;
  let app: FastifyInstance;
  let mutationBus: InMemoryMutationBus;
  const published: RealtimeMutation[] = [];

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const ownerName = `m7own_${suffix}`;
  const memberName = `m7mem_${suffix}`;
  const slowName = `m7slw_${suffix}`;
  const password = "correct-horse-9";

  let ownerToken: string;
  let memberToken: string;
  let slowToken: string;
  let memberId: string;

  let serverId: string;
  let generalId: string;
  let secondTextId: string;
  let voiceId: string;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  async function register(username: string, displayName: string) {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username, password, displayName },
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { token: string; user: { id: string; displayName: string } };
  }

  async function listMessages(channelId: string, token: string): Promise<Message[]> {
    const res = await app.inject({
      method: "GET",
      url: `/channels/${channelId}/messages`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { messages: Message[] }).messages;
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    mutationBus = new InMemoryMutationBus();
    await mutationBus.subscribe((mutation) => published.push(mutation));
    app = await buildApp({
      repos: createRepositories(client.db),
      env: loadEnv({ DATABASE_URL }),
      mutationBus,
      logger: false,
    });

    const owner = await register(ownerName, "M7 Owner");
    const member = await register(memberName, "M7 Member");
    const slow = await register(slowName, "M7 Slow");
    ownerToken = owner.token;
    memberToken = member.token;
    slowToken = slow.token;
    memberId = member.user.id;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("assigns the server's first TEXT channel as its system channel", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(ownerToken),
      payload: { name: "M7 System Crew", textChannelName: "general", voiceChannelName: "lobby" },
    });
    expect(created.statusCode).toBe(201);
    serverId = created.json().group.id;

    // A new server is born with a text + a voice channel in one transaction
    // (founder request: never open empty). The TEXT one is the system channel —
    // the voice channel provisioned beside it must not win.
    const starters = created.json().channels as Array<{ id: string; kind: string }>;
    expect(starters.map((c) => c.kind)).toEqual(["text", "voice"]);
    generalId = starters[0]!.id;
    voiceId = starters[1]!.id;
    expect(created.json().group.systemChannelId).toBe(generalId);

    // A LATER text channel does not steal the system channel from the first one.
    const second = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/channels`,
      headers: auth(ownerToken),
      payload: { name: "games", kind: "text" },
    });
    expect(second.statusCode).toBe(201);
    secondTextId = second.json().channel.id;

    const details = await app.inject({
      method: "GET",
      url: `/groups/${serverId}`,
      headers: auth(ownerToken),
    });
    expect(details.json().group.systemChannelId).toBe(generalId);
  });

  it("lets only the owner re-point systemChannelId to a text channel of THIS server", async () => {
    // Voice channel is rejected.
    const toVoice = await app.inject({
      method: "PATCH",
      url: `/groups/${serverId}`,
      headers: auth(ownerToken),
      payload: { systemChannelId: voiceId },
    });
    expect(toVoice.statusCode).toBe(400);
    expect(toVoice.json().error.code).toBe("INVALID_CHANNEL");

    // A channel of another server is rejected.
    const other = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(ownerToken),
      payload: { name: "M7 Other" },
    });
    const otherChannel = await app.inject({
      method: "POST",
      url: `/groups/${other.json().group.id}/channels`,
      headers: auth(ownerToken),
      payload: { name: "general", kind: "text" },
    });
    const foreign = await app.inject({
      method: "PATCH",
      url: `/groups/${serverId}`,
      headers: auth(ownerToken),
      payload: { systemChannelId: otherChannel.json().channel.id },
    });
    expect(foreign.statusCode).toBe(400);
    expect(foreign.json().error.code).toBe("INVALID_CHANNEL");

    // Re-point to another text channel of this server.
    const repoint = await app.inject({
      method: "PATCH",
      url: `/groups/${serverId}`,
      headers: auth(ownerToken),
      payload: { systemChannelId: secondTextId },
    });
    expect(repoint.statusCode).toBe(200);
    expect(repoint.json().group.systemChannelId).toBe(secondTextId);

    // null disables the feature.
    const cleared = await app.inject({
      method: "PATCH",
      url: `/groups/${serverId}`,
      headers: auth(ownerToken),
      payload: { systemChannelId: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().group.systemChannelId).toBeNull();

    // Restore #general for the system-message tests below.
    const restored = await app.inject({
      method: "PATCH",
      url: `/groups/${serverId}`,
      headers: auth(ownerToken),
      payload: { systemChannelId: generalId },
    });
    expect(restored.json().group.systemChannelId).toBe(generalId);
  });

  it("writes + broadcasts a system 'joined' message on invite redeem", async () => {
    const invite = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/invites`,
      headers: auth(ownerToken),
      payload: {},
    });
    expect(invite.statusCode).toBe(201);
    const code = invite.json().invite.code as string;

    published.length = 0;
    const redeem = await app.inject({
      method: "POST",
      url: `/invites/${code}/redeem`,
      headers: auth(memberToken),
    });
    expect(redeem.statusCode).toBe(200);

    const messages = await listMessages(generalId, ownerToken);
    const joined = messages.find((m) => m.kind === "system" && m.authorId === memberId);
    expect(joined).toBeDefined();
    // Content is a stable, language-neutral token (ADR 0009 §5) — no display
    // name baked in; the client resolves the name + translates at render time.
    expect(joined?.content).toBe("@sys:member_joined");

    // Broadcast went through the normal message pipeline (mutation bus).
    const broadcast = published.find(
      (m) =>
        m.channelId === generalId &&
        m.event.type === SERVER_EVENT.messageCreated &&
        m.event.payload.kind === "system",
    );
    expect(broadcast).toBeDefined();
  });

  it("writes a system 'left' message when a member leaves; owner cannot leave while members remain", async () => {
    // A non-member cannot remove anyone (membership is not leaked -> 404).
    const byNonMember = await app.inject({
      method: "DELETE",
      url: `/groups/${serverId}/members/${memberId}`,
      headers: auth(slowToken), // not a member yet -> 404
    });
    expect(byNonMember.statusCode).toBe(404);

    // The owner cannot leave while another member is still present — they must
    // delete the server instead (task #50; a solo owner leaving auto-deletes it,
    // covered in group-lifecycle.int.test.ts). Checked here BEFORE the member
    // leaves so the owner is genuinely not the last member.
    const owner = await app.inject({
      method: "GET",
      url: `/groups/${serverId}`,
      headers: auth(ownerToken),
    });
    const ownerId = owner.json().group.ownerId as string;
    const ownerLeaveBlocked = await app.inject({
      method: "DELETE",
      url: `/groups/${serverId}/members/${ownerId}`,
      headers: auth(ownerToken),
    });
    expect(ownerLeaveBlocked.statusCode).toBe(400);

    published.length = 0;
    const leave = await app.inject({
      method: "DELETE",
      url: `/groups/${serverId}/members/${memberId}`,
      headers: auth(memberToken),
    });
    expect(leave.statusCode).toBe(204);

    const messages = await listMessages(generalId, ownerToken);
    const left = messages.find(
      (m) => m.kind === "system" && m.content === "@sys:member_left" && m.authorId === memberId,
    );
    expect(left).toBeDefined();
    expect(left?.authorId).toBe(memberId);
    expect(
      published.some(
        (m) =>
          m.channelId === generalId &&
          m.event.type === SERVER_EVENT.messageCreated &&
          m.event.payload.kind === "system",
      ),
    ).toBe(true);
  });

  it("does NOT write system messages for flat group chats", async () => {
    const chat = await app.inject({
      method: "POST",
      url: "/group-chats",
      headers: auth(ownerToken),
      payload: { name: "M7 Flat" },
    });
    expect(chat.statusCode).toBe(201);
    const { id: chatId, streamId } = chat.json().group as { id: string; streamId: string };

    const added = await app.inject({
      method: "POST",
      url: `/group-chats/${chatId}/members`,
      headers: auth(ownerToken),
      payload: { username: memberName },
    });
    expect(added.statusCode).toBe(201);
    const removed = await app.inject({
      method: "DELETE",
      url: `/group-chats/${chatId}/members/${memberId}`,
      headers: auth(ownerToken),
    });
    expect(removed.statusCode).toBe(204);

    const messages = await listMessages(streamId, ownerToken);
    expect(messages.filter((m) => m.kind === "system")).toHaveLength(0);
  });

  it("enforces slowmode on non-owners and returns retryAfterSeconds", async () => {
    // Bring the slowmode test user into the server.
    const invite = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/invites`,
      headers: auth(ownerToken),
      payload: {},
    });
    const redeem = await app.inject({
      method: "POST",
      url: `/invites/${invite.json().invite.code}/redeem`,
      headers: auth(slowToken),
    });
    expect(redeem.statusCode).toBe(200);

    // M20: slowmode follows the CHAT, so a voice channel (which now has one)
    // accepts it. Previously a 400 INVALID_CHANNEL.
    const onVoice = await app.inject({
      method: "PATCH",
      url: `/channels/${voiceId}`,
      headers: auth(ownerToken),
      payload: { slowmodeSeconds: 5 },
    });
    expect(onVoice.statusCode).toBe(200);
    expect(onVoice.json().channel.slowmodeSeconds).toBe(5);
    // Reset so the rest of this suite's voice assertions are unaffected.
    await app.inject({
      method: "PATCH",
      url: `/channels/${voiceId}`,
      headers: auth(ownerToken),
      payload: { slowmodeSeconds: 0 },
    });

    const enable = await app.inject({
      method: "PATCH",
      url: `/channels/${generalId}`,
      headers: auth(ownerToken),
      payload: { slowmodeSeconds: 30 },
    });
    expect(enable.statusCode).toBe(200);
    expect(enable.json().channel.slowmodeSeconds).toBe(30);

    // Range is validated at the boundary.
    const outOfRange = await app.inject({
      method: "PATCH",
      url: `/channels/${generalId}`,
      headers: auth(ownerToken),
      payload: { slowmodeSeconds: 30_000 },
    });
    expect(outOfRange.statusCode).toBe(400);

    // Non-owner: first message lands, the second hits slowmode.
    const first = await app.inject({
      method: "POST",
      url: `/channels/${generalId}/messages`,
      headers: auth(slowToken),
      payload: { content: "first under slowmode" },
    });
    expect(first.statusCode).toBe(201);
    expect(first.json().message.kind).toBe("user");

    const second = await app.inject({
      method: "POST",
      url: `/channels/${generalId}/messages`,
      headers: auth(slowToken),
      payload: { content: "second under slowmode" },
    });
    expect(second.statusCode).toBe(429);
    expect(second.json().error.code).toBe("SLOWMODE");
    expect(second.json().error.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(second.json().error.retryAfterSeconds).toBeLessThanOrEqual(30);

    // The owner is exempt.
    for (const content of ["owner one", "owner two"]) {
      const res = await app.inject({
        method: "POST",
        url: `/channels/${generalId}/messages`,
        headers: auth(ownerToken),
        payload: { content },
      });
      expect(res.statusCode).toBe(201);
    }

    // Turning slowmode off unblocks immediately... after the window; use 0 and
    // a fresh check: with slowmode 0 the store is bypassed entirely.
    const disable = await app.inject({
      method: "PATCH",
      url: `/channels/${generalId}`,
      headers: auth(ownerToken),
      payload: { slowmodeSeconds: 0 },
    });
    expect(disable.statusCode).toBe(200);
    const afterOff = await app.inject({
      method: "POST",
      url: `/channels/${generalId}/messages`,
      headers: auth(slowToken),
      payload: { content: "slowmode off" },
    });
    expect(afterOff.statusCode).toBe(201);
  });

  it("accepts audioBitrateKbps on voice channels only", async () => {
    const onText = await app.inject({
      method: "PATCH",
      url: `/channels/${generalId}`,
      headers: auth(ownerToken),
      payload: { audioBitrateKbps: 96 },
    });
    expect(onText.statusCode).toBe(400);
    expect(onText.json().error.code).toBe("INVALID_CHANNEL");

    const onVoice = await app.inject({
      method: "PATCH",
      url: `/channels/${voiceId}`,
      headers: auth(ownerToken),
      payload: { audioBitrateKbps: 96 },
    });
    expect(onVoice.statusCode).toBe(200);
    expect(onVoice.json().channel.audioBitrateKbps).toBe(96);

    const outOfRange = await app.inject({
      method: "PATCH",
      url: `/channels/${voiceId}`,
      headers: auth(ownerToken),
      payload: { audioBitrateKbps: 1_000 },
    });
    expect(outOfRange.statusCode).toBe(400);

    const cleared = await app.inject({
      method: "PATCH",
      url: `/channels/${voiceId}`,
      headers: auth(ownerToken),
      payload: { audioBitrateKbps: null },
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().channel.audioBitrateKbps).toBeNull();
  });
});
