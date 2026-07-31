/**
 * Message search repository integration tests — real Postgres (ADR 0011 §5).
 * Skipped automatically (with a console notice) when the database is down.
 *
 * Focus: `messagesRepo.search` — full-text (websearch_to_tsquery, 'simple') OR
 * literal-substring (ILIKE) matching, newest-first ordering, keyset `before`
 * pagination with no duplicates, soft-delete exclusion, and channel scoping.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createDb,
  createRepositories,
  MESSAGES_SEARCH_MAX_LIMIT,
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
  console.warn("[messages-search.int.test] DATABASE unreachable — skipping");
}

describe.skipIf(!dbUp)("messagesRepo.search", () => {
  let client: DbClient;
  let repos: Repositories;
  let channelId: string;
  let otherChannelId: string;
  let authorId: string;

  // Tag every message with this run-unique token so searches never collide with
  // rows left by other tests sharing the Postgres instance.
  const tag = `srch${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);

    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const author = await repos.users.create({
      username: `search_${suffix}`,
      displayName: "Search Author",
      passwordHash: "not-used",
    });
    authorId = author.id;
    const group = await repos.groups.create({ name: "Search Crew", ownerId: authorId });
    channelId = (
      await repos.channels.create({ groupId: group.id, kind: "text", name: "search-general" })
    ).id;
    otherChannelId = (
      await repos.channels.create({ groupId: group.id, kind: "text", name: "search-other" })
    ).id;
  });

  afterAll(async () => {
    await client?.close();
  });

  async function seed(channel: string, content: string): Promise<string> {
    // A tiny delay keeps createdAt strictly increasing so newest-first ordering
    // is deterministic across the seeded rows (same-ms rows fall back to id).
    await new Promise((r) => setTimeout(r, 2));
    const m = await repos.messages.create({ channelId: channel, authorId, content });
    return m.id;
  }

  it("finds whole-word matches via full-text and orders them newest-first", async () => {
    const oldest = await seed(channelId, `${tag} alpha the quick brown fox`);
    const middle = await seed(channelId, `${tag} beta lazy dog jumps`);
    const newest = await seed(channelId, `${tag} gamma the fox runs`);
    // A non-matching row in the same channel must be excluded.
    await seed(channelId, `${tag} delta unrelated content`);

    const page = await repos.messages.search(channelId, "fox");
    const ids = page.items.map((m) => m.id);
    // Two rows contain "fox" — newest first.
    expect(ids).toContain(newest);
    expect(ids).toContain(oldest);
    expect(ids).not.toContain(middle);
    expect(ids.indexOf(newest)).toBeLessThan(ids.indexOf(oldest));
  });

  it("matches literal substrings that the tokenizer would miss (ILIKE arm)", async () => {
    const id = await seed(channelId, `${tag} supercalifragilistic`);
    // "califrag" is a substring inside one token — no lexeme boundary, so only
    // the ILIKE arm can find it.
    const page = await repos.messages.search(channelId, "califrag");
    expect(page.items.map((m) => m.id)).toContain(id);
  });

  it("is case-insensitive", async () => {
    const id = await seed(channelId, `${tag} MixedCaseHaystack`);
    const page = await repos.messages.search(channelId, "mixedcasehaystack");
    expect(page.items.map((m) => m.id)).toContain(id);
  });

  it("scopes results to the given channel", async () => {
    const here = await seed(channelId, `${tag} needle-in-here`);
    const elsewhere = await seed(otherChannelId, `${tag} needle-in-here`);
    const page = await repos.messages.search(channelId, "needle-in-here");
    const ids = page.items.map((m) => m.id);
    expect(ids).toContain(here);
    expect(ids).not.toContain(elsewhere);
  });

  it("excludes soft-deleted messages", async () => {
    const id = await seed(channelId, `${tag} ephemeral vanishing token`);
    // Present before delete.
    expect(
      (await repos.messages.search(channelId, "vanishing")).items.map((m) => m.id),
    ).toContain(id);
    await repos.messages.softDelete(id);
    // Gone after delete (content blanked + excluded).
    expect(
      (await repos.messages.search(channelId, "vanishing")).items.map((m) => m.id),
    ).not.toContain(id);
  });

  it("paginates with the `before` cursor without duplicates or gaps", async () => {
    const term = `pagetoken${Math.random().toString(36).slice(2, 6)}`;
    const created: string[] = [];
    for (let i = 0; i < 5; i++) created.push(await seed(channelId, `${tag} ${term} row ${i}`));

    const first = await repos.messages.search(channelId, term, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await repos.messages.search(channelId, term, {
      limit: 2,
      before: first.nextCursor,
    });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).not.toBeNull();

    const third = await repos.messages.search(channelId, term, {
      limit: 2,
      before: second.nextCursor,
    });
    expect(third.items).toHaveLength(1);
    expect(third.nextCursor).toBeNull();

    const seen = [...first.items, ...second.items, ...third.items].map((m) => m.id);
    // No duplicates across pages, and every seeded row appears exactly once.
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual([...created].sort());
    // Global order is strictly newest-first across page boundaries.
    expect(seen).toEqual([...created].reverse());
  });

  it("returns an empty page for a blank query and clamps the limit", async () => {
    const blank = await repos.messages.search(channelId, "   ");
    expect(blank.items).toEqual([]);
    expect(blank.nextCursor).toBeNull();

    // Over-max limit is clamped rather than honored verbatim.
    const clamped = await repos.messages.search(channelId, tag, {
      limit: MESSAGES_SEARCH_MAX_LIMIT + 100,
    });
    expect(clamped.items.length).toBeLessThanOrEqual(MESSAGES_SEARCH_MAX_LIMIT);
  });
});
