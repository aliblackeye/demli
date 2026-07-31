/**
 * Message search API integration tests (ADR 0011 §5). Real Postgres from
 * docker-compose; skipped (with a notice) when the database is down.
 *
 * Covers the acceptance criteria for GET /channels/:channelId/messages/search:
 * auth required (401), channel visibility (non-member ⇒ 404, no existence leak),
 * short-query rejection (< 3 chars ⇒ 400), full MessageDTO enrichment on hits,
 * newest-first ordering, and keyset `?before=` pagination without duplicates.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  applyMigrations,
  createDb,
  createRepositories,
  InMemoryMutationBus,
  type DbClient,
} from "@demli/db";
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
  console.warn("[messages-search.int.test] DATABASE unreachable — skipping integration tests");
}

interface MessageDTO {
  id: string;
  channelId: string;
  authorId: string;
  content: string;
  replyTo?: { id: string; deleted: boolean } | null;
}

describe.skipIf(!dbUp)("message search API", () => {
  let client: DbClient;
  let app: FastifyInstance;
  const bus = new InMemoryMutationBus();

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const password = "correct-horse-9";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  let ownerToken: string;
  let strangerToken: string;
  let channelId: string;

  async function register(username: string): Promise<{ token: string; id: string }> {
    const res = await app.inject({
      method: "POST",
      url: "/auth/register",
      payload: { username, password, displayName: username },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { token: string; user: { id: string } };
    return { token: body.token, id: body.user.id };
  }

  async function createGroup(token: string, name: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(token),
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().group.id as string;
  }

  async function createTextChannel(token: string, groupId: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/groups/${groupId}/channels`,
      headers: auth(token),
      payload: { name: `chan-${Math.random().toString(36).slice(2, 6)}`, kind: "text" },
    });
    expect(res.statusCode).toBe(201);
    return res.json().channel.id as string;
  }

  async function send(
    token: string,
    payload: Record<string, unknown>,
  ): Promise<MessageDTO> {
    // 2ms spacing keeps createdAt strictly increasing ⇒ deterministic ordering.
    await new Promise((r) => setTimeout(r, 2));
    const res = await app.inject({
      method: "POST",
      url: `/channels/${channelId}/messages`,
      headers: auth(token),
      payload,
    });
    expect(res.statusCode).toBe(201);
    return res.json().message as MessageDTO;
  }

  async function search(
    token: string | null,
    chan: string,
    params: Record<string, string>,
  ): Promise<{ status: number; messages?: MessageDTO[]; nextCursor?: string | null }> {
    const qs = new URLSearchParams(params).toString();
    const res = await app.inject({
      method: "GET",
      url: `/channels/${chan}/messages/search?${qs}`,
      ...(token ? { headers: auth(token) } : {}),
    });
    const body = res.statusCode === 200 ? res.json() : {};
    return { status: res.statusCode, messages: body.messages, nextCursor: body.nextCursor };
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    app = await buildApp({
      repos: createRepositories(client.db),
      env: loadEnv({ DATABASE_URL }),
      mutationBus: bus,
      logger: false,
    });

    const owner = await register(`srchapi_own_${suffix}`);
    const stranger = await register(`srchapi_str_${suffix}`);
    ownerToken = owner.token;
    strangerToken = stranger.token;

    const groupId = await createGroup(ownerToken, "Search API Crew");
    channelId = await createTextChannel(ownerToken, groupId);

    // A stranger with their own group — used to prove channel-visibility 404.
    await createGroup(strangerToken, "Stranger Crew");
  });

  afterAll(async () => {
    await app?.close();
    await bus.close();
    await client?.close();
  });

  it("requires authentication (401)", async () => {
    const res = await search(null, channelId, { q: "anything" });
    expect(res.status).toBe(401);
  });

  it("rejects a query shorter than 3 characters (400)", async () => {
    expect((await search(ownerToken, channelId, { q: "ab" })).status).toBe(400);
    // Whitespace-padded short query is trimmed first, then rejected.
    expect((await search(ownerToken, channelId, { q: "  x  " })).status).toBe(400);
  });

  it("hides a channel the caller cannot see (404, no existence leak)", async () => {
    const res = await search(strangerToken, channelId, { q: "hello" });
    expect(res.status).toBe(404);
  });

  it("returns matching messages newest-first as enriched DTOs", async () => {
    const term = `zebrafish${Math.random().toString(36).slice(2, 6)}`;
    const first = await send(ownerToken, { content: `${term} one` });
    await send(ownerToken, { content: "totally unrelated line" });
    const second = await send(ownerToken, { content: `${term} two` });

    const res = await search(ownerToken, channelId, { q: term });
    expect(res.status).toBe(200);
    const ids = (res.messages ?? []).map((m) => m.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
    // Newest-first: the later send comes before the earlier one.
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
    // The non-matching line is absent.
    expect((res.messages ?? []).some((m) => m.content === "totally unrelated line")).toBe(false);
  });

  it("enriches search hits with the reply preview", async () => {
    const term = `replyterm${Math.random().toString(36).slice(2, 6)}`;
    const target = await send(ownerToken, { content: `${term} original` });
    const reply = await send(ownerToken, {
      content: `${term} quoting`,
      replyToMessageId: target.id,
    });

    const res = await search(ownerToken, channelId, { q: term });
    const hit = (res.messages ?? []).find((m) => m.id === reply.id);
    expect(hit).toBeDefined();
    expect(hit?.replyTo?.id).toBe(target.id);
    expect(hit?.replyTo?.deleted).toBe(false);
  });

  it("paginates with ?before= without duplicating rows", async () => {
    const term = `pageapi${Math.random().toString(36).slice(2, 6)}`;
    const created: string[] = [];
    for (let i = 0; i < 3; i++) created.push((await send(ownerToken, { content: `${term} ${i}` })).id);

    const first = await search(ownerToken, channelId, { q: term, limit: "2" });
    expect(first.status).toBe(200);
    expect(first.messages).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();

    const second = await search(ownerToken, channelId, {
      q: term,
      limit: "2",
      before: first.nextCursor as string,
    });
    expect(second.status).toBe(200);
    expect(second.messages).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const seen = [...(first.messages ?? []), ...(second.messages ?? [])].map((m) => m.id);
    expect(new Set(seen).size).toBe(3);
    // Strictly newest-first across the page boundary.
    expect(seen).toEqual([...created].reverse());
  });
});
