/**
 * Group-chat repository integration tests — real Postgres.
 * Skipped automatically (with a console notice) when the database is down.
 *
 * Focus (ADR 0005): a "group" is a friend_groups row with kind='group' that
 * owns exactly one hidden stream channel; servers and groups must never
 * cross-contaminate the listing surfaces.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createDb,
  createRepositories,
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
  console.warn("[group-chats.int.test] DATABASE unreachable — skipping");
}

function uniq(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

describe.skipIf(!dbUp)("groupChatsRepo", () => {
  let client: DbClient;
  let repos: Repositories;
  let ownerId: string;
  let otherId: string;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);

    const owner = await repos.users.create({
      username: uniq("gc_owner"),
      displayName: "GC Owner",
      passwordHash: "not-used",
    });
    ownerId = owner.id;
    const other = await repos.users.create({
      username: uniq("gc_other"),
      displayName: "GC Other",
      passwordHash: "not-used",
    });
    otherId = other.id;
  });

  afterAll(async () => {
    await client?.close();
  });

  it("create() inserts a kind='group' row, owner membership, and one stream channel", async () => {
    const group = await repos.groupChats.create({ name: "Stream Squad", ownerId });

    // Group projection: streamId is a real channel id, no channel list.
    expect(group.name).toBe("Stream Squad");
    expect(group.ownerId).toBe(ownerId);
    expect(group.streamId).toMatch(/[0-9a-f-]{36}/);

    // Backing friend_groups row is kind='group' (not surfaced on Group DTO,
    // read via the underlying FriendGroup repo for verification).
    const raw = await repos.groups.findById(group.id);
    expect(raw?.kind).toBe("group");

    // Owner membership exists with role 'owner'.
    const membership = await repos.groups.getMembership(group.id, ownerId);
    expect(membership?.role).toBe("owner");

    // Exactly one channel, and it IS the stream.
    const channels = await repos.channels.listForGroup(group.id);
    expect(channels).toHaveLength(1);
    expect(channels[0]!.id).toBe(group.streamId);
    expect(channels[0]!.kind).toBe("text");
    expect(channels[0]!.name).toBe("stream");
    expect(channels[0]!.position).toBe(0);
  });

  it("reuses the channel message pipeline via streamId", async () => {
    const group = await repos.groupChats.create({ name: "Chatty Group", ownerId });
    await repos.messages.create({
      channelId: group.streamId,
      authorId: ownerId,
      content: "first stream message",
    });
    const page = await repos.messages.listPage({ channelId: group.streamId, limit: 10 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.content).toBe("first stream message");
  });

  it("listForUser returns only groups the user belongs to, with streamId resolved", async () => {
    const solo = await repos.users.create({
      username: uniq("gc_solo"),
      displayName: "Solo",
      passwordHash: "not-used",
    });
    const g1 = await repos.groupChats.create({ name: "Solo G1", ownerId: solo.id });
    const g2 = await repos.groupChats.create({ name: "Solo G2", ownerId: solo.id });

    const list = await repos.groupChats.listForUser(solo.id);
    expect(list.map((g) => g.id).sort()).toEqual([g1.id, g2.id].sort());
    // Each carries a resolved, non-empty streamId equal to its own channel.
    for (const g of list) {
      const channels = await repos.channels.listForGroup(g.id);
      expect(g.streamId).toBe(channels[0]!.id);
    }
  });

  it("does not cross-contaminate: groups and servers stay on separate surfaces", async () => {
    const mixed = await repos.users.create({
      username: uniq("gc_mixed"),
      displayName: "Mixed",
      passwordHash: "not-used",
    });
    const server = await repos.groups.create({ name: "Mixed Server", ownerId: mixed.id });
    const group = await repos.groupChats.create({ name: "Mixed Group", ownerId: mixed.id });

    // groupChats.listForUser sees only the group.
    const groupList = await repos.groupChats.listForUser(mixed.id);
    expect(groupList.map((g) => g.id)).toEqual([group.id]);

    // groups.listForUser (server-only default) sees only the server.
    const serverList = await repos.groups.listForUser(mixed.id);
    expect(serverList.map((g) => g.id)).toEqual([server.id]);
    expect(serverList.every((g) => g.kind === "server")).toBe(true);
  });

  it("groups.listForUser preserves server-only behavior after the kind column", async () => {
    const user = await repos.users.create({
      username: uniq("gc_srvonly"),
      displayName: "Server Only",
      passwordHash: "not-used",
    });
    await repos.groups.create({ name: "S1", ownerId: user.id });
    await repos.groups.create({ name: "S2", ownerId: user.id });
    await repos.groupChats.create({ name: "G-hidden", ownerId: user.id });

    // Default filter is 'server' — the group must not appear.
    const servers = await repos.groups.listForUser(user.id);
    expect(servers.map((s) => s.name).sort()).toEqual(["S1", "S2"]);

    // Explicit 'group' filter returns the flat chat's backing row.
    const asGroups = await repos.groups.listForUser(user.id, "group");
    expect(asGroups.map((g) => g.name)).toEqual(["G-hidden"]);
  });

  it("addMember / removeMember manage membership and getDetails reflects it", async () => {
    const group = await repos.groupChats.create({ name: "Member Ops", ownerId });

    const added = await repos.groupChats.addMember(group.id, otherId);
    expect(added.role).toBe("member");

    let details = await repos.groupChats.getDetails(group.id);
    expect(details).not.toBeNull();
    expect(details!.group.streamId).toBe(group.streamId);
    expect(details!.members.map((m) => m.userId).sort()).toEqual([ownerId, otherId].sort());
    expect(details!.members.every((m) => typeof m.user.username === "string")).toBe(true);

    const removed = await repos.groupChats.removeMember(group.id, otherId);
    expect(removed).toBe(true);
    // Removing a non-member is a no-op that reports false.
    expect(await repos.groupChats.removeMember(group.id, otherId)).toBe(false);

    details = await repos.groupChats.getDetails(group.id);
    expect(details!.members.map((m) => m.userId)).toEqual([ownerId]);
  });

  it("findById / getDetails ignore servers (kind filter)", async () => {
    const server = await repos.groups.create({ name: "Not A Group", ownerId });
    expect(await repos.groupChats.findById(server.id)).toBeNull();
    expect(await repos.groupChats.getDetails(server.id)).toBeNull();
  });
});
