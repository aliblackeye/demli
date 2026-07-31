/**
 * `POST /groups` starter channels — real Postgres from docker-compose.
 * Skipped automatically (with a console notice) when the database is down.
 *
 * Founder request: a new server must not open empty. Proves the HTTP surface:
 * - 201 carries `{ group, channels }` — one text (top) + one voice, so the
 *   client renders the sidebar without a second round trip;
 * - `GET /groups/:groupId` shows the same two channels;
 * - optional `textChannelName` / `voiceChannelName` (the client knows the user's
 *   locale) are honored and validated with the channel-name rules;
 * - a `member.joined` for the creator is published, which is what makes the
 *   gateway index their live connections into the brand-new server and
 *   subscribe them to its channels (see the handler comment in the module);
 * - REGRESSION: `POST /group-chats` still yields a group chat with exactly one
 *   hidden stream channel — no starter channels leak into the flat-chat path.
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
  type Repositories,
} from "@demli/db";
import { SERVER_EVENT } from "@demli/protocol";
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
  console.warn("[server-default-channels.int.test] DATABASE unreachable — skipping");
}

interface ChannelJson {
  id: string;
  kind: "text" | "voice";
  name: string;
  position: number;
  categoryId: string | null;
}

describe.skipIf(!dbUp)("POST /groups default channels", () => {
  let client: DbClient;
  let repos: Repositories;
  let app: FastifyInstance;
  let bus: InMemoryMutationBus;
  const published: RealtimeMutation[] = [];

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const password = "correct-horse-9";
  let ownerToken: string;
  let ownerId: string;

  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    bus = new InMemoryMutationBus();
    await bus.subscribe((m) => published.push(m));
    app = await buildApp({ repos, env: loadEnv({ DATABASE_URL }), mutationBus: bus, logger: false });

    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username: `dc_own_${suffix}`, password, displayName: "DC Owner" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { token: string; user: { id: string } };
    ownerToken = body.token;
    ownerId = body.user.id;
  });

  afterAll(async () => {
    await app?.close();
    await bus?.close();
    await client?.close();
  });

  it("returns the new server WITH one text + one voice channel", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(ownerToken),
      payload: { name: "Fresh Server" },
    });
    expect(res.statusCode).toBe(201);

    const body = res.json() as { group: { id: string }; channels: ChannelJson[] };
    expect(body.group.id).toBeTruthy();
    expect(body.channels).toHaveLength(2);
    expect(body.channels[0]?.kind).toBe("text");
    expect(body.channels[0]?.position).toBe(0);
    expect(body.channels[1]?.kind).toBe("voice");
    expect(body.channels[1]?.position).toBe(1);
    expect(body.channels[0]?.categoryId).toBeNull();
    expect(body.channels[1]?.categoryId).toBeNull();

    // Same two channels come back on the read path the client uses next.
    const details = await app.inject({
      method: "GET",
      url: `/groups/${body.group.id}`,
      headers: auth(ownerToken),
    });
    expect(details.statusCode).toBe(200);
    const shown = (details.json() as { channels: ChannelJson[] }).channels;
    expect(shown.map((c) => c.id)).toEqual(body.channels.map((c) => c.id));
  });

  it("honors client-supplied localized channel names", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(ownerToken),
      payload: { name: "Türkçe Sunucu", textChannelName: " genel ", voiceChannelName: "Lobi" },
    });
    expect(res.statusCode).toBe(201);
    const { channels } = res.json() as { channels: ChannelJson[] };
    // Trimmed by the same rule as POST /groups/:groupId/channels.
    expect(channels[0]?.name).toBe("genel");
    expect(channels[1]?.name).toBe("Lobi");
  });

  it("rejects blank / oversized channel names (400) and creates nothing", async () => {
    const before = (await repos.groups.listForUser(ownerId)).length;

    const badPayloads: Array<Record<string, unknown>> = [
      { name: "Bad Names A", textChannelName: "   " },
      { name: "Bad Names B", voiceChannelName: "x".repeat(65) },
      { name: "Bad Names C", textChannelName: 42 },
    ];
    for (const payload of badPayloads) {
      const res = await app.inject({
        method: "POST",
        url: "/groups",
        headers: auth(ownerToken),
        payload,
      });
      expect(res.statusCode).toBe(400);
    }

    expect((await repos.groups.listForUser(ownerId)).length).toBe(before);
  });

  it("publishes member.joined for the creator (gateway subscribes their sockets)", async () => {
    published.length = 0;
    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(ownerToken),
      payload: { name: "Subscribed Server" },
    });
    expect(res.statusCode).toBe(201);
    const groupId = (res.json() as { group: { id: string } }).group.id;

    const forGroup = published.filter((m) => m.groupId === groupId);
    expect(forGroup).toHaveLength(1);
    const only = forGroup[0];
    expect(only?.event.type).toBe(SERVER_EVENT.memberJoined);
    if (only?.event.type === SERVER_EVENT.memberJoined) {
      expect(only.event.payload.user.id).toBe(ownerId);
      expect(only.event.payload.member.role).toBe("owner");
    }
    // Group-scoped, not channel-scoped: no per-channel fan-out for a server
    // whose only member is the creator holding the HTTP response.
    expect(only?.channelId).toBeUndefined();
  });

  it("REGRESSION: POST /group-chats still yields exactly one stream channel", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/group-chats",
      headers: auth(ownerToken),
      payload: { name: "Flat Chat" },
    });
    expect(res.statusCode).toBe(201);
    const group = (res.json() as { group: { id: string; streamId: string } }).group;

    const rows = await repos.channels.listForGroup(group.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("text");
    expect(rows[0]?.id).toBe(group.streamId);
  });
});
