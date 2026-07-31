/**
 * M17 — link-preview (unfurl) over the gateway — real Postgres + real WebSockets.
 * The WS `message.send` path is the PRIMARY send path (desktop), so this proves
 * a desktop-sent message with a URL gets unfurled: the gateway fires the unfurl
 * service (fake page fetcher, no network) after broadcasting `message.created`,
 * the service publishes `message.embeds_updated` on the mutation bus, and the
 * gateway's OWN bus subscriber fans it out to the channel's subscribers.
 *
 * Skipped automatically (with a console notice) when the database is down.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createDb,
  createRepositories,
  generateSessionToken,
  hashSessionToken,
  InMemoryMutationBus,
  sessionExpiresAt,
  type DbClient,
  type Repositories,
} from "@demli/db";
import { clientEvent, SERVER_EVENT } from "@demli/protocol";
import { createUnfurlService, type FetchedPage } from "@demli/unfurl";
import { createGateway, type Gateway } from "../gateway.js";
import { InMemoryPresenceStore } from "../presence.js";
import { DATABASE_URL, isDbUp, TestClient } from "./harness.js";
import { refuseToSkipIfRequired } from "@demli/db/testing";

const dbUp = await isDbUp();
if (!dbUp) {
  refuseToSkipIfRequired("postgres");
  console.warn("[gateway.unfurl.int.test] DATABASE unreachable — skipping integration tests");
}

async function fakeFetchPage(url: string): Promise<FetchedPage | null> {
  if (!url.includes("unfurl-me")) return null;
  return {
    finalUrl: url,
    html: `<head>
      <meta property="og:title" content="WS Preview">
      <meta property="og:site_name" content="Example">
    </head>`,
  };
}

describe.skipIf(!dbUp)("gateway unfurl (WS)", () => {
  let client: DbClient;
  let repos: Repositories;
  let gateway: Gateway;
  let port: number;

  let senderId: string;
  let tokenSender: string;
  let channelId: string;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);

    const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const sender = await repos.users.create({
      username: `unf_ws_${suffix}`,
      displayName: "Unfurl Sender",
      passwordHash: "not-used",
    });
    senderId = sender.id;
    tokenSender = generateSessionToken();
    await repos.sessions.create({
      userId: senderId,
      tokenHash: hashSessionToken(tokenSender),
      expiresAt: sessionExpiresAt(new Date(), 1),
    });

    const group = await repos.groups.create({ name: "Unfurl WS Crew", ownerId: senderId });
    const general = await repos.channels.create({ groupId: group.id, kind: "text", name: "general" });
    channelId = general.id;

    // ONE bus shared by the gateway (subscriber → fan-out) and the unfurl service
    // (publisher) — exactly the production wiring.
    const bus = new InMemoryMutationBus();
    gateway = createGateway(
      {
        repos,
        presence: new InMemoryPresenceStore(),
        mutationBus: bus,
        unfurl: createUnfurlService({ repos, mutationBus: bus, fetchPage: fakeFetchPage }),
      },
      { port: 0 },
    );
    port = await gateway.ready;
  });

  afterAll(async () => {
    await gateway?.close();
    await client?.close();
  });

  it("fans out message.embeds_updated after a WS send with an unfurlable URL", async () => {
    const a = await TestClient.connect(port, tokenSender);
    await a.waitFor(SERVER_EVENT.authSucceeded);

    const nonce = `unf-ws-${Date.now()}`;
    a.send(
      clientEvent.messageSend({
        channelId,
        content: "look https://example.com/unfurl-me now",
        nonce,
      }),
    );

    const created = await a.waitFor(
      SERVER_EVENT.messageCreated,
      (e) => e.payload.nonce === nonce,
    );
    const messageId = created.payload.id;
    // message.created carries NO embeds (they are not ready at send time).
    expect(created.payload.embeds).toBeUndefined();

    const embedsEvent = await a.waitFor(
      SERVER_EVENT.messageEmbedsUpdated,
      (e) => e.payload.messageId === messageId,
    );
    expect(embedsEvent.payload.channelId).toBe(channelId);
    expect(embedsEvent.payload.embeds).toHaveLength(1);
    expect(embedsEvent.payload.embeds[0]).toMatchObject({
      url: "https://example.com/unfurl-me",
      title: "WS Preview",
      siteName: "Example",
    });

    // Persisted for the reload path.
    expect(await repos.messageEmbeds.listForMessage(messageId)).toHaveLength(1);

    a.close();
  });

  it("emits no embeds_updated for a URL-less WS send (ordered-socket barrier)", async () => {
    const a = await TestClient.connect(port, tokenSender);
    await a.waitFor(SERVER_EVENT.authSucceeded);

    const plainNonce = `unf-plain-${Date.now()}`;
    a.send(clientEvent.messageSend({ channelId, content: "no links here", nonce: plainNonce }));
    const plain = await a.waitFor(
      SERVER_EVENT.messageCreated,
      (e) => e.payload.nonce === plainNonce,
    );

    // A later unfurlable send whose embeds_updated DOES arrive proves the socket
    // had every chance — the plain message's (absent) event would have come first.
    const linkNonce = `unf-after-plain-${Date.now()}`;
    a.send(
      clientEvent.messageSend({
        channelId,
        content: "https://example.com/unfurl-me",
        nonce: linkNonce,
      }),
    );
    const link = await a.waitFor(
      SERVER_EVENT.messageCreated,
      (e) => e.payload.nonce === linkNonce,
    );
    await a.waitFor(
      SERVER_EVENT.messageEmbedsUpdated,
      (e) => e.payload.messageId === link.payload.id,
    );

    const leaked = a.envelopes.some(
      (env) =>
        env.event.type === SERVER_EVENT.messageEmbedsUpdated &&
        env.event.payload.messageId === plain.payload.id,
    );
    expect(leaked).toBe(false);

    a.close();
  });
});
