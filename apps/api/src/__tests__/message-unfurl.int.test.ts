/**
 * M17 — link-preview (unfurl) API integration tests. Drives the REAL unfurl
 * service (with a FAKE page fetcher, so no network) end-to-end through the REST
 * message-create path: extract → parse → persist → publish, then the GET page
 * enrichment and the delete reap.
 *
 * Real Postgres from docker-compose; an InMemoryMutationBus captures the
 * channel-scoped `message.embeds_updated` the gateway fans out. Unfurl is
 * fire-and-forget (the 201 never waits on it), so assertions poll with
 * `vi.waitFor`. Skipped (with a notice) when the database is down.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
import { createUnfurlService, type FetchedPage } from "@demli/unfurl";
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
  console.warn("[message-unfurl.int.test] DATABASE unreachable — skipping integration tests");
}

interface MessageEmbedDTO {
  url: string;
  title: string | null;
  description: string | null;
  imageUrl: string | null;
  siteName: string | null;
  fetchedAt: string;
}
interface MessageDTO {
  id: string;
  channelId: string;
  content: string;
  embeds?: MessageEmbedDTO[];
}

/** Fake page fetcher: an OG page for `unfurl-me` URLs, nothing otherwise. */
async function fakeFetchPage(url: string): Promise<FetchedPage | null> {
  if (!url.includes("unfurl-me")) return null;
  return {
    finalUrl: url,
    html: `<head>
      <meta property="og:title" content="Preview Title">
      <meta property="og:description" content="Preview description here.">
      <meta property="og:image" content="https://cdn.example.com/cover.png">
      <meta property="og:site_name" content="Example">
    </head>`,
  };
}

describe.skipIf(!dbUp)("M17 message unfurl API", () => {
  let client: DbClient;
  let app: FastifyInstance;
  let repos: Repositories;
  const bus = new InMemoryMutationBus();
  const published: RealtimeMutation[] = [];

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const password = "correct-horse-9";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  let ownerToken: string;
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

  async function send(
    token: string,
    chan: string,
    content: string,
  ): Promise<MessageDTO> {
    const res = await app.inject({
      method: "POST",
      url: `/channels/${chan}/messages`,
      headers: auth(token),
      payload: { content },
    });
    expect(res.statusCode).toBe(201);
    return res.json().message as MessageDTO;
  }

  async function list(token: string, chan: string): Promise<MessageDTO[]> {
    const res = await app.inject({
      method: "GET",
      url: `/channels/${chan}/messages`,
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    return res.json().messages as MessageDTO[];
  }

  function embedsEventFor(messageId: string): RealtimeMutation | undefined {
    return published.find(
      (m) =>
        m.event.type === SERVER_EVENT.messageEmbedsUpdated &&
        (m.event.payload as { messageId: string }).messageId === messageId,
    );
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    await bus.subscribe((m) => published.push(m));

    app = await buildApp({
      repos,
      env: loadEnv({ DATABASE_URL }),
      mutationBus: bus,
      unfurl: createUnfurlService({ repos, mutationBus: bus, fetchPage: fakeFetchPage }),
      logger: false,
    });

    const owner = await register(`unf_own_${suffix}`);
    ownerToken = owner.token;
    const group = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(ownerToken),
      payload: { name: "Unfurl Crew" },
    });
    expect(group.statusCode).toBe(201);
    const channel = await app.inject({
      method: "POST",
      url: `/groups/${group.json().group.id}/channels`,
      headers: auth(ownerToken),
      payload: { name: "links", kind: "text" },
    });
    expect(channel.statusCode).toBe(201);
    channelId = channel.json().channel.id as string;
  });

  afterAll(async () => {
    await app?.close();
    await bus.close();
    await client?.close();
  });

  it("publishes message.embeds_updated and joins embeds onto the GET page", async () => {
    published.length = 0;
    const message = await send(ownerToken, channelId, "read https://example.com/unfurl-me today");

    // The 201 does NOT carry embeds — the unfurl runs asynchronously after send.
    expect(message.embeds).toBeUndefined();

    await vi.waitFor(() => expect(embedsEventFor(message.id)).toBeDefined(), { timeout: 4000 });
    const event = embedsEventFor(message.id);
    // Channel-scoped envelope.
    expect(event?.channelId).toBe(channelId);
    expect(event?.groupId).toBeUndefined();
    expect(event?.userId).toBeUndefined();
    const payload = event?.event.payload as { channelId: string; embeds: MessageEmbedDTO[] };
    expect(payload.channelId).toBe(channelId);
    expect(payload.embeds).toHaveLength(1);
    expect(payload.embeds[0]).toMatchObject({
      url: "https://example.com/unfurl-me",
      title: "Preview Title",
      description: "Preview description here.",
      imageUrl: "https://cdn.example.com/cover.png",
      siteName: "Example",
    });

    // A reload's GET page carries the same embed (repo join).
    const listed = (await list(ownerToken, channelId)).find((m) => m.id === message.id);
    expect(listed?.embeds).toHaveLength(1);
    expect(listed?.embeds?.[0]).toMatchObject({
      url: "https://example.com/unfurl-me",
      title: "Preview Title",
      imageUrl: "https://cdn.example.com/cover.png",
    });
    expect(typeof listed?.embeds?.[0]?.fetchedAt).toBe("string");
  });

  it("leaves a URL-less message with no embeds and emits no event", async () => {
    published.length = 0;
    const message = await send(ownerToken, channelId, "just a plain message, no links");

    // Give any (unexpected) async unfurl a chance to run before asserting absence.
    await new Promise((r) => setTimeout(r, 150));
    expect(embedsEventFor(message.id)).toBeUndefined();

    const listed = (await list(ownerToken, channelId)).find((m) => m.id === message.id);
    expect(listed?.embeds).toBeUndefined();
  });

  it("emits no event for a URL that does not unfurl", async () => {
    published.length = 0;
    // `nope` does not match the fake fetcher marker → fetchPage returns null.
    const message = await send(ownerToken, channelId, "dead link https://example.com/nope");

    await new Promise((r) => setTimeout(r, 150));
    expect(embedsEventFor(message.id)).toBeUndefined();
    const listed = (await list(ownerToken, channelId)).find((m) => m.id === message.id);
    expect(listed?.embeds).toBeUndefined();
  });

  it("reaps a message's embeds on delete", async () => {
    const message = await send(ownerToken, channelId, "delete https://example.com/unfurl-me please");
    await vi.waitFor(async () => {
      expect(await repos.messageEmbeds.listForMessage(message.id)).toHaveLength(1);
    }, { timeout: 4000 });

    const del = await app.inject({
      method: "DELETE",
      url: `/messages/${message.id}`,
      headers: auth(ownerToken),
    });
    expect(del.statusCode).toBe(204);
    expect(await repos.messageEmbeds.listForMessage(message.id)).toHaveLength(0);
  });
});
