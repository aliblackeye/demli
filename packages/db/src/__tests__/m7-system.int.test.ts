/**
 * M7b repo-level integration tests — real Postgres.
 * Skipped automatically (with a console notice) when the database is down.
 *
 * Covers migration 0004: system channel auto-assignment, message `kind`,
 * `slowmode_seconds` / `audio_bitrate_kbps` persistence, and the FK
 * ON DELETE SET NULL behavior of `friend_groups.system_channel_id`.
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
  console.warn("[m7-system.int.test] DATABASE unreachable — skipping");
}

describe.skipIf(!dbUp)("m7 system channel + message kind (repo level)", () => {
  let client: DbClient;
  let repos: Repositories;
  let ownerId: string;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);

    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const owner = await repos.users.create({
      username: `m7sys_${suffix}`,
      displayName: "M7 Sys",
      passwordHash: "not-used",
    });
    ownerId = owner.id;
  });

  afterAll(async () => {
    await client?.close();
  });

  it("assigns the server's FIRST text channel as system channel; later channels never re-point it", async () => {
    const server = await repos.groups.create({ name: "M7 Crew", ownerId });
    expect(server.systemChannelId).toBeNull();

    // A voice channel first — must NOT become the system channel.
    await repos.channels.create({ groupId: server.id, kind: "voice", name: "lobby" });
    expect((await repos.groups.findById(server.id))?.systemChannelId).toBeNull();

    const first = await repos.channels.create({
      groupId: server.id,
      kind: "text",
      name: "general",
    });
    expect((await repos.groups.findById(server.id))?.systemChannelId).toBe(first.id);

    // A second text channel leaves the assignment untouched.
    await repos.channels.create({ groupId: server.id, kind: "text", name: "games" });
    expect((await repos.groups.findById(server.id))?.systemChannelId).toBe(first.id);
  });

  it("never assigns a system channel to flat group chats", async () => {
    const chat = await repos.groupChats.create({ name: "M7 Chat", ownerId });
    // The group chat's stream is a text channel, but kind='group' rows are excluded.
    const row = await repos.groups.findById(chat.id);
    expect(row?.systemChannelId).toBeNull();
  });

  it("update() re-points or clears the system channel", async () => {
    const server = await repos.groups.create({ name: "M7 Repoint", ownerId });
    const a = await repos.channels.create({ groupId: server.id, kind: "text", name: "a" });
    const b = await repos.channels.create({ groupId: server.id, kind: "text", name: "b" });
    expect((await repos.groups.findById(server.id))?.systemChannelId).toBe(a.id);

    const repointed = await repos.groups.update(server.id, { systemChannelId: b.id });
    expect(repointed?.systemChannelId).toBe(b.id);

    const cleared = await repos.groups.update(server.id, { systemChannelId: null });
    expect(cleared?.systemChannelId).toBeNull();
  });

  it("clears system_channel_id via FK when the system channel is deleted", async () => {
    const server = await repos.groups.create({ name: "M7 FkNull", ownerId });
    const general = await repos.channels.create({
      groupId: server.id,
      kind: "text",
      name: "general",
    });
    expect((await repos.groups.findById(server.id))?.systemChannelId).toBe(general.id);

    await repos.channels.delete(general.id);
    expect((await repos.groups.findById(server.id))?.systemChannelId).toBeNull();
  });

  it("persists message kind and defaults to 'user'", async () => {
    const server = await repos.groups.create({ name: "M7 Kind", ownerId });
    const channel = await repos.channels.create({
      groupId: server.id,
      kind: "text",
      name: "general",
    });

    const user = await repos.messages.create({
      channelId: channel.id,
      authorId: ownerId,
      content: "hello",
    });
    expect(user.kind).toBe("user");

    const system = await repos.messages.create({
      channelId: channel.id,
      authorId: ownerId,
      content: "M7 Sys sunucuya katıldı",
      kind: "system",
    });
    expect(system.kind).toBe("system");

    const page = await repos.messages.listPage({ channelId: channel.id, limit: 10 });
    const byId = new Map(page.items.map((m) => [m.id, m.kind]));
    expect(byId.get(user.id)).toBe("user");
    expect(byId.get(system.id)).toBe("system");
  });

  it("persists slowmodeSeconds and audioBitrateKbps through channelsRepo.update", async () => {
    const server = await repos.groups.create({ name: "M7 Meta", ownerId });
    const text = await repos.channels.create({
      groupId: server.id,
      kind: "text",
      name: "general",
    });
    const voice = await repos.channels.create({
      groupId: server.id,
      kind: "voice",
      name: "lobby",
    });
    expect(text.slowmodeSeconds).toBe(0);
    expect(voice.audioBitrateKbps).toBeNull();

    const slow = await repos.channels.update(text.id, { slowmodeSeconds: 30 });
    expect(slow?.slowmodeSeconds).toBe(30);

    const tuned = await repos.channels.update(voice.id, { audioBitrateKbps: 96 });
    expect(tuned?.audioBitrateKbps).toBe(96);
    const reset = await repos.channels.update(voice.id, { audioBitrateKbps: null });
    expect(reset?.audioBitrateKbps).toBeNull();
  });
});
