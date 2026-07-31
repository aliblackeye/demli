/**
 * Migration 0024 — the one-shot repair for avatar/banner/icon URLs whose SCHEME
 * could never have been legal. Real Postgres; skipped (loudly) when it is down.
 *
 * WHY THIS TEST EXISTS SEPARATELY FROM THE API TESTS. The API now refuses to
 * WRITE a `javascript:` avatar, which says nothing about the rows written while
 * `z.string().url()` was the rule — those are already in production and are
 * served to every client that can see the user. The fix is only half a fix
 * without the repair, and the repair is a hand-written SQL file that nothing
 * else executes, so it needs its own proof.
 *
 * The statements are read OUT OF THE SHIPPED MIGRATION FILE rather than
 * re-typed. A test that re-typed them would pass against a migration that says
 * something else — which is precisely the failure mode this repo has been bitten
 * by (`gates-that-lie`). `applyMigrations` cannot be used to drive this: it is
 * journal-tracked and a no-op on the second call, so the file is executed
 * directly against rows seeded for the purpose.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { applyMigrations, createDb, type DbClient } from "../index.js";
import { refuseToSkipIfRequired } from "../testing.js";

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgresql://postgres:postgres@localhost:5432/demli";

const MIGRATION_PATH = fileURLToPath(
  new URL("../../migrations/0024_media_url_scheme_repair.sql", import.meta.url),
);

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
  console.warn("[media-url-repair.int.test] DATABASE unreachable — skipping");
}

function uniq(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

describe.skipIf(!dbUp)("migration 0024 — media URL scheme repair", () => {
  let client: DbClient;
  /** The migration's own UPDATE statements, straight off disk. */
  let statements: string[];

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 3 });
    await applyMigrations(client.db);
    statements = readFileSync(MIGRATION_PATH, "utf8")
      // Comment lines first: the file's rationale block sits directly above the
      // first statement, so splitting on `;` without stripping them glues the
      // whole prose onto statement one and it stops looking like an UPDATE.
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter((s) => s.toUpperCase().startsWith("UPDATE"));
    // Four columns are repaired: users.avatar_url, users.banner_url,
    // friend_groups.icon_url, friend_groups.banner_url. A file that lost one
    // would silently leave a column unrepaired, so the count is pinned.
    expect(statements).toHaveLength(4);
  });

  afterAll(async () => {
    await client?.close();
  });

  /** Re-run the shipped repair over whatever is currently in the tables. */
  async function runRepair(): Promise<void> {
    for (const statement of statements) {
      await client.sql.unsafe(statement);
    }
  }

  async function seedUser(avatarUrl: string | null, bannerUrl: string | null): Promise<string> {
    const username = uniq("repair");
    const [row] = await client.sql<{ id: string }[]>`
      insert into users (username, display_name, password_hash, friend_code, avatar_url, banner_url)
      values (${username}, ${username}, 'x', ${uniq("fc")}, ${avatarUrl}, ${bannerUrl})
      returning id
    `;
    return row!.id;
  }

  async function readUser(id: string) {
    const [row] = await client.sql<{ avatar_url: string | null; banner_url: string | null }[]>`
      select avatar_url, banner_url from users where id = ${id}
    `;
    return row!;
  }

  it("nulls avatar/banner URLs whose scheme is not http(s)", async () => {
    const hostile = [
      "javascript:alert(1)",
      "data:text/html;base64,PHN2Zz48L3N2Zz4=",
      "file:///etc/passwd",
      // Contains `https://` but does not START with it — the anchor is what makes
      // this a scheme test and not a substring test.
      "javascript:/*https://x/*/alert(1)",
    ];
    for (const url of hostile) {
      const id = await seedUser(url, url);
      await runRepair();
      const row = await readUser(id);
      expect(row.avatar_url, `avatar ${url}`).toBeNull();
      expect(row.banner_url, `banner ${url}`).toBeNull();
    }
  });

  it("leaves legitimate http(s) URLs alone, in any letter case", async () => {
    const legit = [
      "https://cdn.example.com/a/b.png",
      "http://localhost:9000/storage/x.webp",
      // RFC 3986 says the scheme is case-insensitive, so this is a REAL URL and
      // nulling it would be data loss caused by the fix.
      "HTTPS://cdn.example.com/a/b.png",
    ];
    for (const url of legit) {
      const id = await seedUser(url, url);
      await runRepair();
      const row = await readUser(id);
      expect(row.avatar_url, `avatar ${url}`).toBe(url);
      expect(row.banner_url, `banner ${url}`).toBe(url);
    }
  });

  it("leaves NULL as NULL and is idempotent", async () => {
    const id = await seedUser(null, "javascript:alert(1)");
    await runRepair();
    expect((await readUser(id)).avatar_url).toBeNull();
    expect((await readUser(id)).banner_url).toBeNull();
    // Second pass: nothing left matching the predicate, nothing changes.
    await runRepair();
    expect((await readUser(id)).avatar_url).toBeNull();
    expect((await readUser(id)).banner_url).toBeNull();
  });

  it("repairs friend_groups icon_url and banner_url too", async () => {
    const ownerId = await seedUser(null, null);
    const [group] = await client.sql<{ id: string }[]>`
      insert into friend_groups (name, owner_id, icon_url, banner_url)
      values (${uniq("g")}, ${ownerId}, 'javascript:alert(1)', 'https://cdn.example.com/b.png')
      returning id
    `;
    await runRepair();
    const [row] = await client.sql<{ icon_url: string | null; banner_url: string | null }[]>`
      select icon_url, banner_url from friend_groups where id = ${group!.id}
    `;
    expect(row!.icon_url).toBeNull();
    // The legitimate one on the same row survives — the repair is per-value, not
    // "this row looked suspicious, clear it".
    expect(row!.banner_url).toBe("https://cdn.example.com/b.png");
  });
});
