/**
 * M14 W3 — message enrichment API integration tests (ADR 0011): emoji reactions
 * (add/remove/toggle, the M17-widened key gate — any unicode emoji OR a group
 * `:name:` custom emoji, arbitrary text rejected — channel-visibility
 * authorization, per-viewer `reactedByMe`, channel-scoped fan-out) and replies
 * (create-response + list-page preview, cross-channel rejection, soft-deleted
 * target stub).
 *
 * Real Postgres from docker-compose; an InMemoryMutationBus captures the
 * channel-scoped events the gateway (W4) will fan out. Skipped (with a notice)
 * when the database is down. Usernames carry a per-file random suffix to dodge
 * the shared-Postgres `users_username_unique` trap.
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
import type { GroupId, UserId } from "@demli/types";
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
  console.warn("[message-enrichment.int.test] DATABASE unreachable — skipping integration tests");
}

interface ReactionSummary {
  emoji: string;
  count: number;
  reactedByMe: boolean;
}
interface ReplyPreview {
  id: string;
  authorId: string;
  content: string;
  kind: string;
  deleted: boolean;
}
interface MessageDTO {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  reactions?: ReactionSummary[];
  replyTo?: ReplyPreview | null;
}

describe.skipIf(!dbUp)("M14 W3 message enrichment API", () => {
  let client: DbClient;
  let app: FastifyInstance;
  const bus = new InMemoryMutationBus();
  const published: RealtimeMutation[] = [];

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const password = "correct-horse-9";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  let ownerToken: string;
  let ownerId: string;
  let memberToken: string;
  let memberId: string;
  let strangerToken: string;

  // A text channel both owner and member can see; a second owner channel for the
  // cross-channel reply test; a stranger's channel neither owner nor member sees.
  let groupId: string;
  let channelId: string;
  let secondChannelId: string;
  let strangerChannelId: string;

  async function register(username: string): Promise<{ token: string; id: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username, password, displayName: username },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { token: string; user: { id: string } };
    return { token: body.token, id: body.user.id };
  }

  async function createGroup(token: string, name: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(token),
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().group.id as string;
  }

  async function createTextChannel(token: string, groupId: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/groups/${groupId}/channels`,
      headers: auth(token),
      payload: { name: `chan-${Math.random().toString(36).slice(2, 6)}`, kind: "text" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().channel.id as string;
  }

  async function join(groupId: string, token: string): Promise<void> {
    const invite = await app.inject({
      method: "POST",
      url: `/groups/${groupId}/invites`,
      headers: auth(ownerToken),
      payload: {},
    });
    expect(invite.statusCode).toBe(201);
    const redeem = await app.inject({
      method: "POST",
      url: `/invites/${invite.json().invite.code}/redeem`,
      headers: auth(token),
    });
    expect(redeem.statusCode).toBe(200);
  }

  async function send(
    token: string,
    chan: string,
    payload: Record<string, unknown>,
  ): Promise<{ status: number; message: MessageDTO }> {
    const res = await app.inject({
      method: "POST",
      url: `/channels/${chan}/messages`,
      headers: auth(token),
      payload,
    });
    return { status: res.statusCode, message: res.json().message as MessageDTO };
  }

  async function react(
    method: "PUT" | "DELETE",
    token: string,
    messageId: string,
    emoji: string,
  ) {
    return app.inject({
      method,
      url: `/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`,
      headers: auth(token),
    });
  }

  async function list(token: string, chan: string): Promise<MessageDTO[]> {
    const res = await app.inject({
      method: "GET",
      url: `/channels/${chan}/messages`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().messages as MessageDTO[];
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    await bus.subscribe((m) => published.push(m));
    app = await buildApp({
      repos: createRepositories(client.db),
      env: loadEnv({ DATABASE_URL }),
      mutationBus: bus,
      logger: false,
    });

    const owner = await register(`enr_own_${suffix}`);
    const member = await register(`enr_mem_${suffix}`);
    const stranger = await register(`enr_str_${suffix}`);
    ownerToken = owner.token;
    ownerId = owner.id;
    memberToken = member.token;
    memberId = member.id;
    strangerToken = stranger.token;

    groupId = await createGroup(ownerToken, "Enrich Crew");
    channelId = await createTextChannel(ownerToken, groupId);
    secondChannelId = await createTextChannel(ownerToken, groupId);
    await join(groupId, memberToken);

    const strangerGroup = await createGroup(strangerToken, "Stranger Crew");
    strangerChannelId = await createTextChannel(strangerToken, strangerGroup);
  });

  afterAll(async () => {
    await app?.close();
    await bus.close();
    await client?.close();
  });

  // ---- Reactions ----------------------------------------------------------

  it("adds a reaction, echoes the summary, and publishes channel-scoped reaction_added", async () => {
    const { message } = await send(ownerToken, channelId, { content: "react to me" });
    published.length = 0;

    const res = await react("PUT", memberToken, message.id, "👍");
    expect(res.statusCode).toBe(200);
    const reactions = res.json().reactions as ReactionSummary[];
    expect(reactions).toEqual([{ emoji: "👍", count: 1, reactedByMe: true }]);

    const event = published.find(
      (m) => m.channelId === channelId && m.event.type === SERVER_EVENT.messageReactionAdded,
    );
    expect(event).toBeDefined();
    // Channel-scoped envelope (no groupId/userId on the mutation itself).
    expect(event?.groupId).toBeUndefined();
    expect(event?.userId).toBeUndefined();
    const payload = event?.event.payload as {
      channelId: string;
      messageId: string;
      emoji: string;
      userId: string;
    };
    expect(payload).toMatchObject({
      channelId,
      messageId: message.id,
      emoji: "👍",
      userId: memberId,
    });
  });

  it("is idempotent on a repeat add — count stays 1 and no second broadcast", async () => {
    const { message } = await send(ownerToken, channelId, { content: "double add" });
    expect((await react("PUT", memberToken, message.id, "🔥")).statusCode).toBe(200);
    published.length = 0;

    const second = await react("PUT", memberToken, message.id, "🔥");
    expect(second.statusCode).toBe(200);
    expect(second.json().reactions).toEqual([{ emoji: "🔥", count: 1, reactedByMe: true }]);
    // Duplicate add wrote no row ⇒ no redundant fan-out.
    expect(
      published.filter((m) => m.event.type === SERVER_EVENT.messageReactionAdded),
    ).toHaveLength(0);
  });

  it("removes a reaction (idempotent) and publishes reaction_removed only on a real delete", async () => {
    const { message } = await send(ownerToken, channelId, { content: "remove me" });
    expect((await react("PUT", memberToken, message.id, "🎉")).statusCode).toBe(200);
    published.length = 0;

    const removed = await react("DELETE", memberToken, message.id, "🎉");
    expect(removed.statusCode).toBe(200);
    expect(removed.json().reactions).toEqual([]);
    expect(
      published.filter((m) => m.event.type === SERVER_EVENT.messageReactionRemoved),
    ).toHaveLength(1);

    published.length = 0;
    const again = await react("DELETE", memberToken, message.id, "🎉");
    expect(again.statusCode).toBe(200);
    expect(again.json().reactions).toEqual([]);
    // Nothing was there to remove ⇒ no broadcast.
    expect(
      published.filter((m) => m.event.type === SERVER_EVENT.messageReactionRemoved),
    ).toHaveLength(0);
  });

  it("accepts any single unicode emoji, not just the quick palette (M17 widening)", async () => {
    const { message } = await send(ownerToken, channelId, { content: "unicorn target" });
    const res = await react("PUT", memberToken, message.id, "🦄");
    expect(res.statusCode).toBe(200);
    expect(res.json().reactions).toEqual([{ emoji: "🦄", count: 1, reactedByMe: true }]);
  });

  it("rejects a reaction key that is neither an emoji nor a shortcode (400 INVALID_REACTION)", async () => {
    const { message } = await send(ownerToken, channelId, { content: "bad key target" });
    for (const bad of ["hello", "5", "abc"]) {
      const res = await react("PUT", memberToken, message.id, bad);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("INVALID_REACTION");
    }
  });

  it("accepts a group custom `:name:` emoji reaction and echoes the shortcode key (M17)", async () => {
    // Seed a custom emoji directly (bypassing the multipart upload path) into the
    // SAME database the app reads from, then react with its `:name:` shortcode.
    const seedRepos = createRepositories(client.db);
    const { error } = await seedRepos.customEmojis.create({
      groupId: groupId as GroupId,
      name: "party",
      mime: "image/png",
      sizeBytes: 128,
      storagePath: `test/${suffix}/party.png`,
      createdBy: ownerId as UserId,
    });
    expect(error).toBeNull();

    const { message } = await send(ownerToken, channelId, { content: "custom react target" });
    const res = await react("PUT", memberToken, message.id, ":party:");
    expect(res.statusCode).toBe(200);
    expect(res.json().reactions).toEqual([{ emoji: ":party:", count: 1, reactedByMe: true }]);
  });

  it("rejects a `:name:` custom emoji that does not exist in the group (400)", async () => {
    const { message } = await send(ownerToken, channelId, { content: "missing custom target" });
    const res = await react("PUT", memberToken, message.id, ":nope_not_here:");
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_REACTION");
  });

  it("rejects a reaction on a channel the caller cannot see (404, no leak)", async () => {
    // Stranger's message lives in a channel the owner is not a member of.
    const { message } = await send(strangerToken, strangerChannelId, { content: "private" });
    const res = await react("PUT", ownerToken, message.id, "👍");
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("rejects a reaction on a soft-deleted message (404)", async () => {
    const { message } = await send(ownerToken, channelId, { content: "will be deleted" });
    expect((await app.inject({
      method: "DELETE",
      url: `/messages/${message.id}`,
      headers: auth(ownerToken),
    })).statusCode).toBe(204);

    const res = await react("PUT", memberToken, message.id, "👍");
    expect(res.statusCode).toBe(404);
  });

  it("computes reactedByMe per-viewer in the message list", async () => {
    const { message } = await send(ownerToken, channelId, { content: "viewer-relative" });
    // Owner reacts 🙏, member reacts ❤️. Each viewer sees only their own flag.
    expect((await react("PUT", ownerToken, message.id, "🙏")).statusCode).toBe(200);
    expect((await react("PUT", memberToken, message.id, "❤️")).statusCode).toBe(200);

    const ownerView = (await list(ownerToken, channelId)).find((m) => m.id === message.id);
    const memberView = (await list(memberToken, channelId)).find((m) => m.id === message.id);

    const byEmoji = (dto: MessageDTO | undefined) =>
      new Map((dto?.reactions ?? []).map((r) => [r.emoji, r]));
    const ownerR = byEmoji(ownerView);
    const memberR = byEmoji(memberView);

    expect(ownerR.get("🙏")).toEqual({ emoji: "🙏", count: 1, reactedByMe: true });
    expect(ownerR.get("❤️")).toEqual({ emoji: "❤️", count: 1, reactedByMe: false });
    expect(memberR.get("🙏")).toEqual({ emoji: "🙏", count: 1, reactedByMe: false });
    expect(memberR.get("❤️")).toEqual({ emoji: "❤️", count: 1, reactedByMe: true });
  });

  it("leaves a message with no reactions free of a reactions field", async () => {
    const { message } = await send(ownerToken, channelId, { content: "no reactions" });
    const dto = (await list(ownerToken, channelId)).find((m) => m.id === message.id);
    expect(dto?.reactions).toBeUndefined();
  });

  // ---- Replies ------------------------------------------------------------

  it("carries a reply preview in the create response and the list page", async () => {
    const parent = await send(ownerToken, channelId, { content: "the original message" });
    expect(parent.status).toBe(201);

    const reply = await send(memberToken, channelId, {
      content: "quoting you",
      replyToMessageId: parent.message.id,
    });
    expect(reply.status).toBe(201);
    expect(reply.message.replyTo).toMatchObject({
      id: parent.message.id,
      authorId: ownerId,
      content: "the original message",
      deleted: false,
    });

    const listed = (await list(memberToken, channelId)).find((m) => m.id === reply.message.id);
    expect(listed?.replyTo).toMatchObject({
      id: parent.message.id,
      authorId: ownerId,
      content: "the original message",
      deleted: false,
    });
  });

  it("rejects a reply whose target is in another channel (400 INVALID_PAYLOAD)", async () => {
    const foreign = await send(ownerToken, secondChannelId, { content: "in channel two" });
    expect(foreign.status).toBe(201);

    const res = await app.inject({
      method: "POST",
      url: `/channels/${channelId}/messages`,
      headers: auth(memberToken),
      payload: { content: "cross-channel reply", replyToMessageId: foreign.message.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_PAYLOAD");
  });

  it("rejects a reply to a non-existent target (400 INVALID_PAYLOAD)", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/channels/${channelId}/messages`,
      headers: auth(memberToken),
      payload: {
        content: "reply to nothing",
        replyToMessageId: "00000000-0000-0000-0000-000000000000",
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("INVALID_PAYLOAD");
  });

  it("allows a reply to a soft-deleted target, previewed as deleted", async () => {
    const parent = await send(ownerToken, channelId, { content: "soon deleted" });
    expect((await app.inject({
      method: "DELETE",
      url: `/messages/${parent.message.id}`,
      headers: auth(ownerToken),
    })).statusCode).toBe(204);

    const reply = await send(memberToken, channelId, {
      content: "replying to a ghost",
      replyToMessageId: parent.message.id,
    });
    expect(reply.status).toBe(201);
    expect(reply.message.replyTo).toMatchObject({
      id: parent.message.id,
      deleted: true,
      content: "",
    });
  });

  it("flips a live reply's preview to deleted after the target is removed (list path)", async () => {
    const parent = await send(ownerToken, channelId, { content: "delete me later" });
    const reply = await send(memberToken, channelId, {
      content: "still here",
      replyToMessageId: parent.message.id,
    });
    expect(reply.status).toBe(201);
    expect(reply.message.replyTo?.deleted).toBe(false);

    expect((await app.inject({
      method: "DELETE",
      url: `/messages/${parent.message.id}`,
      headers: auth(ownerToken),
    })).statusCode).toBe(204);

    const listed = (await list(memberToken, channelId)).find((m) => m.id === reply.message.id);
    expect(listed?.replyTo).toMatchObject({ id: parent.message.id, deleted: true, content: "" });
  });

  // ---- Rate limit ---------------------------------------------------------

  it("rate-limits reaction toggling (~30 / 10s per session)", async () => {
    // A dedicated user with its own session key, so the budget is isolated from
    // the functional tests above (which share the owner/member tokens). Joined to
    // the group so under-limit requests are genuine 200s, not auth rejections.
    const spammer = await register(`enr_spam_${suffix}`);
    await join(groupId, spammer.token);
    const { message } = await send(ownerToken, channelId, { content: "rate-limit target" });

    const statuses: number[] = [];
    for (let i = 0; i < 31; i++) {
      const r = await react("PUT", spammer.token, message.id, "👍");
      statuses.push(r.statusCode);
    }
    // The limiter runs on onRequest (before the handler), so all 31 count. The
    // 31st exceeds max:30 and is refused; the first 30 are idempotent 200s.
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});
