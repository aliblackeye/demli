/**
 * M6 Wave 1 repository tests — server/channel management + delete cascades.
 * Real Postgres; skipped (with a notice) when the database is down.
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
  console.warn("[m6-wave1.int.test] DATABASE unreachable — skipping");
}

function uniq(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

describe.skipIf(!dbUp)("M6 wave 1 repos", () => {
  let client: DbClient;
  let repos: Repositories;
  let ownerId: string;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    const owner = await repos.users.create({
      username: uniq("w1_owner"),
      displayName: "W1 Owner",
      passwordHash: "not-used",
    });
    ownerId = owner.id;
  });

  afterAll(async () => {
    await client?.close();
  });

  it("groups.update patches name and iconUrl, and clears iconUrl with null", async () => {
    const server = await repos.groups.create({ name: "Before", ownerId });

    const renamed = await repos.groups.update(server.id, {
      name: "After",
      iconUrl: "https://cdn.example.com/icon.png",
    });
    expect(renamed?.name).toBe("After");
    expect(renamed?.iconUrl).toBe("https://cdn.example.com/icon.png");
    expect(renamed?.kind).toBe("server");

    const cleared = await repos.groups.update(server.id, { iconUrl: null });
    expect(cleared?.iconUrl).toBeNull();
    expect(cleared?.name).toBe("After"); // untouched key preserved

    expect(await repos.groups.update(crypto.randomUUID(), { name: "x" })).toBeNull();
  });

  it("channels.update patches description/maxParticipants and clears with null", async () => {
    const server = await repos.groups.create({ name: "Chan Server", ownerId });
    const voice = await repos.channels.create({
      groupId: server.id,
      kind: "voice",
      name: "Lobby",
    });

    const updated = await repos.channels.update(voice.id, {
      name: "Main Lobby",
      description: "Hang out here",
      maxParticipants: 8,
    });
    expect(updated?.name).toBe("Main Lobby");
    expect(updated?.description).toBe("Hang out here");
    expect(updated?.maxParticipants).toBe(8);

    const cleared = await repos.channels.update(voice.id, {
      description: null,
      maxParticipants: null,
    });
    expect(cleared?.description).toBeNull();
    expect(cleared?.maxParticipants).toBeNull();
    expect(cleared?.name).toBe("Main Lobby");
  });

  it("channels.delete removes the channel and cascades its messages", async () => {
    const server = await repos.groups.create({ name: "Del Chan", ownerId });
    const channel = await repos.channels.create({
      groupId: server.id,
      kind: "text",
      name: "general",
    });
    const msg = await repos.messages.create({
      channelId: channel.id,
      authorId: ownerId,
      content: "doomed",
    });

    expect(await repos.channels.delete(channel.id)).toBe(true);
    expect(await repos.channels.findById(channel.id)).toBeNull();
    expect(await repos.messages.findById(msg.id)).toBeNull();
    // Deleting again is a no-op.
    expect(await repos.channels.delete(channel.id)).toBe(false);
  });

  it("groups.delete cascades channels, members, messages, and invites", async () => {
    const member = await repos.users.create({
      username: uniq("w1_member"),
      displayName: "W1 Member",
      passwordHash: "not-used",
    });
    const server = await repos.groups.create({ name: "Cascade Server", ownerId });
    await repos.groups.addMember(server.id, member.id, "member");
    const channel = await repos.channels.create({
      groupId: server.id,
      kind: "text",
      name: "general",
    });
    const msg = await repos.messages.create({
      channelId: channel.id,
      authorId: ownerId,
      content: "will be cascaded",
    });
    const invite = await repos.invites.create({
      groupId: server.id,
      createdBy: ownerId,
      expiresAt: null,
      maxUses: null,
    });

    expect(await repos.groups.delete(server.id)).toBe(true);

    // Everything the server owned is gone.
    expect(await repos.groups.findById(server.id)).toBeNull();
    expect(await repos.groups.getMembership(server.id, member.id)).toBeNull();
    expect(await repos.channels.findById(channel.id)).toBeNull();
    expect(await repos.messages.findById(msg.id)).toBeNull();

    const inviteRows = await client
      .sql`select count(*)::int as n from invites where id = ${invite.id}`;
    expect((inviteRows[0] as { n: number }).n).toBe(0);

    // The users themselves are untouched (no cascade to users).
    expect(await repos.users.findById(ownerId)).not.toBeNull();
    expect(await repos.users.findById(member.id)).not.toBeNull();
  });
});
