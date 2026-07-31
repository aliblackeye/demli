/**
 * Default starter channels for a NEW SERVER — real Postgres.
 * Skipped automatically (with a console notice) when the database is down.
 *
 * Founder request: a freshly created server must not open empty — it comes with
 * one text channel and one voice channel. This file locks the four properties
 * that make that safe:
 *
 * 1. `createServerWithDefaults()` provisions exactly two channels, text first;
 * 2. the names are client-supplied, falling back to the English defaults;
 * 3. the provisioning is ATOMIC — a channel insert failure leaves NO group row;
 * 4. REGRESSION: flat group chats (kind='group') and DMs (kind='dm') still own
 *    exactly ONE hidden stream channel. Both resolve `streamId` by joining their
 *    single kind='text' channel, so a stray second text channel would make that
 *    join ambiguous and break them. The gate is structural (the new method
 *    hardcodes kind='server' and the group-chat/DM paths never call it), and
 *    these tests are the alarm if that ever changes.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  applyMigrations,
  createDb,
  createRepositories,
  DEFAULT_SERVER_TEXT_CHANNEL_NAME,
  DEFAULT_SERVER_VOICE_CHANNEL_NAME,
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
  console.warn("[server-default-channels.int.test] DATABASE unreachable — skipping");
}

function uniq(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * A channel name Postgres cannot store: `text` columns reject an embedded NUL
 * byte. Built at runtime so no NUL ever sits in this source file.
 */
const UNSTORABLE_CHANNEL_NAME = `Lo${String.fromCharCode(0)}bi`;

describe.skipIf(!dbUp)("groupsRepo.createServerWithDefaults", () => {
  let client: DbClient;
  let repos: Repositories;
  let ownerId: string;
  let otherId: string;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);

    const owner = await repos.users.create({
      username: uniq("dflt_owner"),
      displayName: "Default Owner",
      passwordHash: "not-used",
    });
    ownerId = owner.id;
    const other = await repos.users.create({
      username: uniq("dflt_other"),
      displayName: "Default Other",
      passwordHash: "not-used",
    });
    otherId = other.id;
  });

  afterAll(async () => {
    await client?.close();
  });

  it("provisions exactly one text + one voice channel, text first", async () => {
    const { group, channels } = await repos.groups.createServerWithDefaults({
      name: "Starter Server",
      ownerId,
    });

    expect(group.name).toBe("Starter Server");
    expect(group.ownerId).toBe(ownerId);
    expect(group.kind).toBe("server");

    // Returned in sidebar order: text on top, voice under it.
    expect(channels).toHaveLength(2);
    expect(channels[0]?.kind).toBe("text");
    expect(channels[0]?.position).toBe(0);
    expect(channels[1]?.kind).toBe("voice");
    expect(channels[1]?.position).toBe(1);
    // M18: default channels are uncategorized (top-level list).
    expect(channels[0]?.categoryId).toBeNull();
    expect(channels[1]?.categoryId).toBeNull();

    // Persisted, not just returned: getDetails sees the same two, same order.
    const details = await repos.groups.getDetails(group.id);
    expect(details?.channels.map((c) => [c.kind, c.name])).toEqual([
      ["text", channels[0]?.name],
      ["voice", channels[1]?.name],
    ]);
    expect(details?.members).toHaveLength(1);
    expect(details?.members[0]?.role).toBe("owner");
  });

  it("falls back to the English default names when the client sends none", async () => {
    const { channels } = await repos.groups.createServerWithDefaults({
      name: "Fallback Server",
      ownerId,
    });
    expect(channels[0]?.name).toBe(DEFAULT_SERVER_TEXT_CHANNEL_NAME);
    expect(channels[1]?.name).toBe(DEFAULT_SERVER_VOICE_CHANNEL_NAME);
  });

  it("uses the client-supplied localized names when given", async () => {
    const { channels } = await repos.groups.createServerWithDefaults({
      name: "Türkçe Sunucu",
      ownerId,
      textChannelName: "genel",
      voiceChannelName: "Lobi",
    });
    expect(channels[0]?.name).toBe("genel");
    expect(channels[1]?.name).toBe("Lobi");
  });

  it("points system_channel_id at the new text channel", async () => {
    const { group, channels } = await repos.groups.createServerWithDefaults({
      name: "System Channel Server",
      ownerId,
    });
    // Same invariant channelsRepo.create maintains: a server's FIRST text
    // channel receives member joined/left notices — set inside the same
    // transaction so the server is never briefly without one.
    expect(group.systemChannelId).toBe(channels[0]?.id);

    const reread = await repos.groups.findById(group.id);
    expect(reread?.systemChannelId).toBe(channels[0]?.id);
  });

  it("is atomic: a failing channel insert leaves no group row behind", async () => {
    const name = uniq("Atomic Server");
    // The VOICE insert blows up after the group row, the owner membership and
    // the text channel are already written inside the transaction.
    await expect(
      repos.groups.createServerWithDefaults({
        name,
        ownerId,
        voiceChannelName: UNSTORABLE_CHANNEL_NAME,
      }),
    ).rejects.toThrow();

    const rows = await client.db
      .select({ id: schema.friendGroups.id })
      .from(schema.friendGroups)
      .where(eq(schema.friendGroups.name, name));
    expect(rows).toHaveLength(0);
  });

  it("plain create() still provisions NO channels (fixtures/seed unaffected)", async () => {
    const group = await repos.groups.create({ name: "Bare Server", ownerId });
    expect(await repos.channels.listForGroup(group.id)).toHaveLength(0);
  });

  describe("regression: group chats and DMs keep exactly one stream channel", () => {
    it("groupChats.create() adds no extra default channels", async () => {
      const group = await repos.groupChats.create({ name: "No Extras Chat", ownerId });

      const rows = await repos.channels.listForGroup(group.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe("text");
      expect(rows[0]?.name).toBe("stream");
      expect(rows[0]?.id).toBe(group.streamId);

      // streamId still resolves (the join that a second text channel would break).
      expect((await repos.groupChats.findById(group.id))?.streamId).toBe(group.streamId);
    });

    it("dms.getOrCreate() adds no extra default channels", async () => {
      const { dm, created } = await repos.dms.getOrCreate(ownerId, otherId);
      expect(created).toBe(true);

      const rows = await repos.channels.listForGroup(dm.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.kind).toBe("text");
      expect(rows[0]?.id).toBe(dm.streamId);

      expect((await repos.dms.findByPair(ownerId, otherId))?.streamId).toBe(dm.streamId);
    });
  });
});
