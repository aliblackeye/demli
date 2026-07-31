/**
 * M17 message-embeds repo-level integration tests — real Postgres.
 * Skipped automatically (with a console notice) when the database is down.
 *
 * Covers migration 0015 + messageEmbedsRepo:
 * - replaceForMessage writes cards, assigns position from array order, and
 *   returns them ordered with a DB `fetchedAt`
 * - replaceForMessage is a REPLACE (idempotent re-unfurl: no accumulation/dupes)
 *   and clears when passed an empty array
 * - listForMessages bulk grouping (no N+1); absent message → absent from map
 * - deleteForMessage removes the rows and reports the count
 * - FK cascade: hard-deleting a message reaps its embeds
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
  console.warn("[message-embeds.int.test] DATABASE unreachable — skipping");
}

const RUN = randomUUID().slice(0, 8);

describe.skipIf(!dbUp)("m17 message embeds (repo level)", () => {
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

  async function makeMessage(content = "hi"): Promise<{ channelId: string; messageId: string }> {
    const owner = await repos.users.create({
      username: `emb_${nextSuffix()}`,
      displayName: "owner",
      passwordHash: "not-used",
    });
    const group = await repos.groups.create({ name: "Embeds Test", ownerId: owner.id });
    const channel = await repos.channels.create({
      groupId: group.id,
      kind: "text",
      name: "general",
    });
    const message = await repos.messages.create({
      channelId: channel.id,
      authorId: owner.id,
      content,
    });
    return { channelId: channel.id, messageId: message.id };
  }

  const card = (url: string, title: string) => ({
    url,
    title,
    description: null,
    imageUrl: null,
    siteName: null,
  });

  it("writes cards in position order with a DB fetchedAt", async () => {
    const { messageId } = await makeMessage();
    const stored = await repos.messageEmbeds.replaceForMessage(messageId, [
      card("https://a.example/1", "First"),
      { ...card("https://b.example/2", "Second"), imageUrl: "https://cdn.example/x.png" },
    ]);

    expect(stored.map((e) => e.url)).toEqual(["https://a.example/1", "https://b.example/2"]);
    expect(stored[0]?.title).toBe("First");
    expect(stored[1]?.imageUrl).toBe("https://cdn.example/x.png");
    expect(typeof stored[0]?.fetchedAt).toBe("string");
    expect(Number.isNaN(Date.parse(stored[0]?.fetchedAt ?? ""))).toBe(false);
  });

  it("REPLACES on re-unfurl — no accumulation or duplicates", async () => {
    const { messageId } = await makeMessage();
    await repos.messageEmbeds.replaceForMessage(messageId, [
      card("https://a.example/1", "Old A"),
      card("https://b.example/2", "Old B"),
    ]);
    const second = await repos.messageEmbeds.replaceForMessage(messageId, [
      card("https://a.example/1", "New A"),
    ]);

    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ url: "https://a.example/1", title: "New A" });
    expect(await repos.messageEmbeds.listForMessage(messageId)).toHaveLength(1);
  });

  it("clears embeds when replaced with an empty array", async () => {
    const { messageId } = await makeMessage();
    await repos.messageEmbeds.replaceForMessage(messageId, [card("https://a.example/1", "A")]);
    expect(await repos.messageEmbeds.replaceForMessage(messageId, [])).toEqual([]);
    expect(await repos.messageEmbeds.listForMessage(messageId)).toEqual([]);
  });

  it("bulk-groups by message id (no N+1); absent message absent from map", async () => {
    const a = await makeMessage();
    const b = await makeMessage();
    const c = await makeMessage(); // never gets embeds
    await repos.messageEmbeds.replaceForMessage(a.messageId, [card("https://a.example/1", "A")]);
    await repos.messageEmbeds.replaceForMessage(b.messageId, [
      card("https://b.example/1", "B1"),
      card("https://b.example/2", "B2"),
    ]);

    const map = await repos.messageEmbeds.listForMessages([
      a.messageId,
      b.messageId,
      c.messageId,
    ]);
    expect(map.get(a.messageId)).toHaveLength(1);
    expect(map.get(b.messageId)?.map((e) => e.url)).toEqual([
      "https://b.example/1",
      "https://b.example/2",
    ]);
    expect(map.has(c.messageId)).toBe(false);
  });

  it("deleteForMessage removes the rows and reports the count", async () => {
    const { messageId } = await makeMessage();
    await repos.messageEmbeds.replaceForMessage(messageId, [
      card("https://a.example/1", "A"),
      card("https://b.example/2", "B"),
    ]);
    expect(await repos.messageEmbeds.deleteForMessage(messageId)).toBe(2);
    expect(await repos.messageEmbeds.listForMessage(messageId)).toEqual([]);
    // Idempotent: nothing left to delete.
    expect(await repos.messageEmbeds.deleteForMessage(messageId)).toBe(0);
  });

  it("cascades embeds when the message is hard-deleted", async () => {
    const { messageId } = await makeMessage();
    await repos.messageEmbeds.replaceForMessage(messageId, [card("https://a.example/1", "A")]);

    await client.db.delete(schema.messages).where(eq(schema.messages.id, messageId));
    expect(await repos.messageEmbeds.listForMessage(messageId)).toEqual([]);
  });
});
