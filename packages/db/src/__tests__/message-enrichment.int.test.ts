/**
 * M14 message-enrichment repo-level integration tests — real Postgres.
 * Skipped automatically (with a console notice) when the database is down.
 *
 * Covers migration 0008 + messageReactionsRepo + messagesRepo reply support:
 * - reaction add/remove idempotency (double add = one row; remove-nonexistent = no error)
 * - summariesForMessages counts + reactedByMe (viewer vs other), first-occurrence
 *   ordering, no-N+1 bulk grouping, absent message → absent from map
 * - deleteForMessage reaps; softDelete reaps a message's reactions transactionally
 * - FK cascades: hard-delete message reaps reactions; delete user reaps theirs
 * - reply persistence (create replyToMessageId) + getReplyPreviews batch:
 *   normal (content sliced to REPLY_PREVIEW_MAX), soft-deleted target
 *   (deleted:true, blank content), hard-deleted target (SET NULL ⇒ absent ⇒ null)
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REPLY_PREVIEW_MAX } from "@demli/config";
import {
  applyMigrations,
  createDb,
  createRepositories,
  schema,
  type DbClient,
  type Repositories,
} from "../index.js";
import { refuseToSkipIfRequired } from "../testing.js";

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
  console.warn("[message-enrichment.int.test] DATABASE unreachable — skipping");
}

/**
 * Per-file random tag. Test files run in parallel workers against ONE shared
 * Postgres, so a fixture username must be unique across files, not just within
 * one — otherwise it collides on `users_username_unique`. This UUID tag gives
 * every username in this file its own namespace.
 */
const RUN = randomUUID().slice(0, 8);

describe.skipIf(!dbUp)("m14 message enrichment (repo level)", () => {
  let client: DbClient;
  let repos: Repositories;
  let uniq = 0;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
  });

  afterAll(async () => {
    await client?.close();
  });

  function nextSuffix(): string {
    uniq += 1;
    return `${RUN}${uniq.toString(36)}`;
  }

  async function makeUser(label: string): Promise<string> {
    const u = await repos.users.create({
      username: `${label}_${nextSuffix()}`,
      displayName: label,
      passwordHash: "not-used",
    });
    return u.id;
  }

  /** A fresh server + text channel; returns owner/group/channel ids. */
  async function makeChannel(): Promise<{ ownerId: string; channelId: string }> {
    const ownerId = await makeUser("owner");
    const group = await repos.groups.create({ name: "Enrich Test", ownerId });
    const channel = await repos.channels.create({
      groupId: group.id,
      kind: "text",
      name: "general",
    });
    return { ownerId, channelId: channel.id };
  }

  async function makeMessage(channelId: string, authorId: string, content = "hi") {
    return repos.messages.create({ channelId, authorId, content });
  }

  // ---- reactions: add / remove idempotency ---------------------------------

  it("add is idempotent — a second identical add writes no new row", async () => {
    const { channelId, ownerId } = await makeChannel();
    const msg = await makeMessage(channelId, ownerId);

    const first = await repos.messageReactions.add(msg.id, ownerId, "👍");
    const second = await repos.messageReactions.add(msg.id, ownerId, "👍");
    expect(first.added).toBe(true);
    expect(second.added).toBe(false); // ON CONFLICT DO NOTHING

    const summaries = await repos.messageReactions.summariesForMessages([msg.id], ownerId);
    expect(summaries.get(msg.id)).toEqual([{ emoji: "👍", count: 1, reactedByMe: true }]);
  });

  it("remove is keyed and idempotent — removing a missing reaction is a no-op", async () => {
    const { channelId, ownerId } = await makeChannel();
    const msg = await makeMessage(channelId, ownerId);

    // Nothing there yet.
    expect((await repos.messageReactions.remove(msg.id, ownerId, "👍")).removed).toBe(false);

    await repos.messageReactions.add(msg.id, ownerId, "👍");
    expect((await repos.messageReactions.remove(msg.id, ownerId, "👍")).removed).toBe(true);
    // Removing it again is a no-op, not an error.
    expect((await repos.messageReactions.remove(msg.id, ownerId, "👍")).removed).toBe(false);

    const summaries = await repos.messageReactions.summariesForMessages([msg.id], ownerId);
    expect(summaries.has(msg.id)).toBe(false);
  });

  // ---- reactions: aggregation ----------------------------------------------

  it("summariesForMessages counts per emoji and sets reactedByMe per viewer", async () => {
    const { channelId, ownerId } = await makeChannel();
    const other = await makeUser("other");
    const third = await makeUser("third");
    const msg = await makeMessage(channelId, ownerId);

    await repos.messageReactions.add(msg.id, ownerId, "👍");
    await repos.messageReactions.add(msg.id, other, "👍");
    await repos.messageReactions.add(msg.id, third, "❤️");

    // Owner is the viewer: reacted with 👍 but not ❤️.
    const forOwner = await repos.messageReactions.summariesForMessages([msg.id], ownerId);
    expect(forOwner.get(msg.id)).toEqual([
      { emoji: "👍", count: 2, reactedByMe: true },
      { emoji: "❤️", count: 1, reactedByMe: false },
    ]);

    // Third is the viewer: reacted with ❤️ only.
    const forThird = await repos.messageReactions.summariesForMessages([msg.id], third);
    const heart = forThird.get(msg.id)?.find((s) => s.emoji === "❤️");
    const thumb = forThird.get(msg.id)?.find((s) => s.emoji === "👍");
    expect(heart).toEqual({ emoji: "❤️", count: 1, reactedByMe: true });
    expect(thumb).toEqual({ emoji: "👍", count: 2, reactedByMe: false });
  });

  it("orders emoji pills by first occurrence (stable position as counts change)", async () => {
    const { channelId, ownerId } = await makeChannel();
    const a = await makeUser("a");
    const b = await makeUser("b");
    const msg = await makeMessage(channelId, ownerId);

    // 🔥 first, then 🎉, then a second 🔥 (bumps its count, not its position).
    await repos.messageReactions.add(msg.id, ownerId, "🔥");
    await repos.messageReactions.add(msg.id, a, "🎉");
    await repos.messageReactions.add(msg.id, b, "🔥");

    const summaries = await repos.messageReactions.summariesForMessages([msg.id], ownerId);
    expect(summaries.get(msg.id)?.map((s) => s.emoji)).toEqual(["🔥", "🎉"]);
    expect(summaries.get(msg.id)?.find((s) => s.emoji === "🔥")?.count).toBe(2);
  });

  it("summariesForMessages groups a page in one query; empty input → empty map", async () => {
    const { channelId, ownerId } = await makeChannel();
    const m1 = await makeMessage(channelId, ownerId);
    const m2 = await makeMessage(channelId, ownerId);
    const m3 = await makeMessage(channelId, ownerId); // no reactions

    await repos.messageReactions.add(m1.id, ownerId, "👍");
    await repos.messageReactions.add(m2.id, ownerId, "😂");

    const grouped = await repos.messageReactions.summariesForMessages(
      [m1.id, m2.id, m3.id],
      ownerId,
    );
    expect(grouped.get(m1.id)?.[0]?.emoji).toBe("👍");
    expect(grouped.get(m2.id)?.[0]?.emoji).toBe("😂");
    expect(grouped.has(m3.id)).toBe(false); // absent — caller reads `?? []`

    expect((await repos.messageReactions.summariesForMessages([], ownerId)).size).toBe(0);
  });

  // ---- reactions: delete / reap / cascade ----------------------------------

  it("deleteForMessage reaps every reaction on a message", async () => {
    const { channelId, ownerId } = await makeChannel();
    const other = await makeUser("other");
    const msg = await makeMessage(channelId, ownerId);
    await repos.messageReactions.add(msg.id, ownerId, "👍");
    await repos.messageReactions.add(msg.id, other, "🔥");

    const reaped = await repos.messageReactions.deleteForMessage(msg.id);
    expect(reaped).toBe(2);
    expect((await repos.messageReactions.summariesForMessages([msg.id], ownerId)).has(msg.id)).toBe(
      false,
    );
  });

  it("softDelete reaps a message's reactions transactionally", async () => {
    const { channelId, ownerId } = await makeChannel();
    const other = await makeUser("other");
    const msg = await makeMessage(channelId, ownerId);
    await repos.messageReactions.add(msg.id, ownerId, "👍");
    await repos.messageReactions.add(msg.id, other, "❤️");

    const deleted = await repos.messages.softDelete(msg.id);
    expect(deleted?.deletedAt).not.toBeNull();
    expect(deleted?.content).toBe("");
    expect((await repos.messageReactions.summariesForMessages([msg.id], ownerId)).has(msg.id)).toBe(
      false,
    );
  });

  it("hard-deleting a message cascades its reactions; deleting a user cascades theirs", async () => {
    const { channelId, ownerId } = await makeChannel();
    const other = await makeUser("other");

    // Hard-delete the message → reactions cascade.
    const msg = await makeMessage(channelId, ownerId);
    await repos.messageReactions.add(msg.id, ownerId, "👍");
    await client.db.delete(schema.messages).where(eq(schema.messages.id, msg.id));
    const rowsAfterMsgDelete = await client.db
      .select()
      .from(schema.messageReactions)
      .where(eq(schema.messageReactions.messageId, msg.id));
    expect(rowsAfterMsgDelete).toHaveLength(0);

    // Delete a reacting user → only their reaction rows cascade.
    const msg2 = await makeMessage(channelId, ownerId);
    await repos.messageReactions.add(msg2.id, ownerId, "👍");
    await repos.messageReactions.add(msg2.id, other, "🔥");
    await client.db.delete(schema.users).where(eq(schema.users.id, other));
    const remaining = await repos.messageReactions.summariesForMessages([msg2.id], ownerId);
    expect(remaining.get(msg2.id)).toEqual([{ emoji: "👍", count: 1, reactedByMe: true }]);
  });

  // ---- replies: persistence + preview batch --------------------------------

  it("create persists replyToMessageId; getReplyPreviews slices content to the cap", async () => {
    const { channelId, ownerId } = await makeChannel();
    const longContent = "x".repeat(REPLY_PREVIEW_MAX + 50);
    const target = await makeMessage(channelId, ownerId, longContent);

    const reply = await repos.messages.create({
      channelId,
      authorId: ownerId,
      content: "quoting you",
      replyToMessageId: target.id,
    });
    expect(reply.replyToMessageId).toBe(target.id);
    // Persisted (survives a re-read).
    expect((await repos.messages.findById(reply.id))?.replyToMessageId).toBe(target.id);

    const previews = await repos.messages.getReplyPreviews([target.id]);
    const preview = previews.get(target.id);
    expect(preview).toMatchObject({
      id: target.id,
      authorId: ownerId,
      kind: "user",
      deleted: false,
    });
    expect(preview?.content).toBe("x".repeat(REPLY_PREVIEW_MAX));
    expect(preview?.content.length).toBe(REPLY_PREVIEW_MAX);
  });

  it("getReplyPreviews marks a soft-deleted target deleted with blank content", async () => {
    const { channelId, ownerId } = await makeChannel();
    const target = await makeMessage(channelId, ownerId, "the original");
    await repos.messages.softDelete(target.id);

    const preview = (await repos.messages.getReplyPreviews([target.id])).get(target.id);
    expect(preview).toMatchObject({ id: target.id, deleted: true, content: "" });
  });

  it("hard-deleting a reply target SET NULLs the referrer and drops it from the preview map", async () => {
    const { channelId, ownerId } = await makeChannel();
    const target = await makeMessage(channelId, ownerId, "will be gone");
    const reply = await repos.messages.create({
      channelId,
      authorId: ownerId,
      content: "quoting the doomed one",
      replyToMessageId: target.id,
    });

    await client.db.delete(schema.messages).where(eq(schema.messages.id, target.id));

    // Self-FK is ON DELETE SET NULL: the reply survives, its FK is nulled.
    const refreshed = await repos.messages.findById(reply.id);
    expect(refreshed).not.toBeNull();
    expect(refreshed?.replyToMessageId).toBeNull();

    // The target id is absent from the preview map → caller reads `?? null`.
    const previews = await repos.messages.getReplyPreviews([target.id]);
    expect(previews.has(target.id)).toBe(false);

    // Empty input → empty map.
    expect((await repos.messages.getReplyPreviews([])).size).toBe(0);
  });

  it("updateContent does not change an existing reply link (reply is immutable)", async () => {
    const { channelId, ownerId } = await makeChannel();
    const target = await makeMessage(channelId, ownerId, "target");
    const reply = await repos.messages.create({
      channelId,
      authorId: ownerId,
      content: "before edit",
      replyToMessageId: target.id,
    });

    const edited = await repos.messages.updateContent(reply.id, ownerId, "after edit");
    expect(edited?.content).toBe("after edit");
    expect(edited?.replyToMessageId).toBe(target.id);
  });
});
