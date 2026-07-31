/**
 * Message repository integration tests — real Postgres.
 * Skipped automatically (with a console notice) when the database is down.
 *
 * Focus: nonce idempotency (GAP 1). A retried send with the same
 * (author, nonce) must resolve to the ORIGINAL row, never a duplicate.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createDb, createRepositories, type DbClient, type Repositories } from "../index.js";
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
  console.warn("[messages-repo.int.test] DATABASE unreachable — skipping");
}

describe.skipIf(!dbUp)("messagesRepo.create idempotency", () => {
  let client: DbClient;
  let repos: Repositories;
  let channelId: string;
  let authorId: string;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);

    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const author = await repos.users.create({
      username: `msgrepo_${suffix}`,
      displayName: "Msg Repo",
      passwordHash: "not-used",
    });
    authorId = author.id;
    const group = await repos.groups.create({ name: "Msg Repo Crew", ownerId: authorId });
    const channel = await repos.channels.create({
      groupId: group.id,
      kind: "text",
      name: "repo-general",
    });
    channelId = channel.id;
  });

  afterAll(async () => {
    await client?.close();
  });

  async function countByContent(content: string): Promise<number> {
    const page = await repos.messages.listPage({ channelId, limit: 100 });
    return page.items.filter((m) => m.content === content).length;
  }

  it("returns the same row for a repeated (author, nonce) and inserts once", async () => {
    const nonce = `n-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const content = `idem ${nonce}`;

    const first = await repos.messages.create({ channelId, authorId, content, nonce });
    const second = await repos.messages.create({
      channelId,
      authorId,
      content: "DIFFERENT CONTENT — ignored on conflict",
      nonce,
    });

    expect(second.id).toBe(first.id);
    // The conflict path returns the ORIGINAL row (original content preserved).
    expect(second.content).toBe(content);
    expect(await countByContent(content)).toBe(1);
  });

  it("dedupes concurrent identical sends to a single row", async () => {
    const nonce = `n-conc-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const content = `concurrent ${nonce}`;

    const results = await Promise.all([
      repos.messages.create({ channelId, authorId, content, nonce }),
      repos.messages.create({ channelId, authorId, content, nonce }),
      repos.messages.create({ channelId, authorId, content, nonce }),
    ]);

    const ids = new Set(results.map((m) => m.id));
    expect(ids.size).toBe(1);
    expect(await countByContent(content)).toBe(1);
  });

  it("does NOT dedupe null-nonce inserts (seed/server path)", async () => {
    const content = `no-nonce ${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const a = await repos.messages.create({ channelId, authorId, content });
    const b = await repos.messages.create({ channelId, authorId, content });
    expect(a.id).not.toBe(b.id);
    expect(await countByContent(content)).toBe(2);
  });

  it("scopes the nonce per author (same nonce, different author is a new row)", async () => {
    const nonce = `n-author-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const other = await repos.users.create({
      username: `msgrepo2_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      displayName: "Other",
      passwordHash: "not-used",
    });
    await repos.groups.addMember(
      (await repos.groups.listForUser(authorId))[0]!.id,
      other.id,
      "member",
    );

    const mine = await repos.messages.create({
      channelId,
      authorId,
      content: `author-scope A ${nonce}`,
      nonce,
    });
    const theirs = await repos.messages.create({
      channelId,
      authorId: other.id,
      content: `author-scope B ${nonce}`,
      nonce,
    });
    expect(theirs.id).not.toBe(mine.id);
  });
});
