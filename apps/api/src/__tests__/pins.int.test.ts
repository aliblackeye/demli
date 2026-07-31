/**
 * M17 — pinned-messages API integration tests. Drives the real routes end-to-end
 * against a real Postgres from docker-compose, with an InMemoryMutationBus
 * capturing the channel-scoped `message.pinned` / `message.unpinned` fan-out.
 *
 * The centre of gravity is the PERMISSION MATRIX, because that is where the
 * feature can go wrong in a way that is invisible until someone abuses it:
 *  - a server member who is neither the author nor a moderator must be refused;
 *  - the author of a message may pin it;
 *  - MANAGE_MESSAGES (and the owner bypass) may pin anyone's message;
 *  - a NON-member must not even learn the message exists (404, never 403);
 *  - in a DM — which has no role system at all and stores BOTH members as
 *    role="member" — either participant may pin.
 *
 * Skipped (with a notice) when the database is down.
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
import { PINS_MAX_PER_CHANNEL } from "@demli/config";
import { SERVER_EVENT } from "@demli/protocol";
import { PERMISSIONS } from "@demli/types";
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
  console.warn("[pins.int.test] DATABASE unreachable — skipping integration tests");
}

interface PinDTO {
  message: { id: string; content: string; pinned?: boolean };
  pinnedBy: string;
  pinnedAt: string;
}

describe.skipIf(!dbUp)("M17 pinned messages API", () => {
  let client: DbClient;
  let app: FastifyInstance;
  let repos: Repositories;
  const bus = new InMemoryMutationBus();
  const published: RealtimeMutation[] = [];

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const password = "correct-horse-9";
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  let ownerToken: string;
  let ownerId: string;
  let authorToken: string;
  let authorId: string;
  let bystanderToken: string;
  let bystanderId: string;
  let modToken: string;
  let modId: string;
  let outsiderToken: string;
  let groupId: string;
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

  /** Join `token`'s user to the shared server via a fresh invite. */
  async function joinGroup(token: string): Promise<void> {
    const invite = await app.inject({
      method: "POST",
      url: `/groups/${groupId}/invites`,
      headers: auth(ownerToken),
      payload: {},
    });
    expect(invite.statusCode).toBe(201);
    const code = invite.json().invite.code as string;
    const join = await app.inject({
      method: "POST",
      url: `/invites/${code}/redeem`,
      headers: auth(token),
    });
    expect(join.statusCode).toBe(200);
  }

  async function send(token: string, content: string, chan = channelId): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/channels/${chan}/messages`,
      headers: auth(token),
      payload: { content },
    });
    expect(res.statusCode).toBe(201);
    return res.json().message.id as string;
  }

  const pin = (token: string, messageId: string, chan = channelId) =>
    app.inject({
      method: "POST",
      url: `/channels/${chan}/pins/${messageId}`,
      headers: auth(token),
    });

  const unpin = (token: string, messageId: string, chan = channelId) =>
    app.inject({
      method: "DELETE",
      url: `/channels/${chan}/pins/${messageId}`,
      headers: auth(token),
    });

  const listPins = (token: string, chan = channelId) =>
    app.inject({ method: "GET", url: `/channels/${chan}/pins`, headers: auth(token) });

  function eventsFor(messageId: string, type: string): RealtimeMutation[] {
    return published.filter(
      (m) =>
        m.event.type === type &&
        (m.event.payload as { messageId?: string }).messageId === messageId,
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
      logger: false,
    });

    const owner = await register(`pin_own_${suffix}`);
    ownerToken = owner.token;
    ownerId = owner.id;
    const group = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(ownerToken),
      payload: { name: "Pin Crew" },
    });
    expect(group.statusCode).toBe(201);
    groupId = group.json().group.id as string;

    const channel = await app.inject({
      method: "POST",
      url: `/groups/${groupId}/channels`,
      headers: auth(ownerToken),
      payload: { name: "board", kind: "text" },
    });
    expect(channel.statusCode).toBe(201);
    channelId = channel.json().channel.id as string;

    const author = await register(`pin_auth_${suffix}`);
    authorToken = author.token;
    authorId = author.id;
    await joinGroup(authorToken);

    const bystander = await register(`pin_by_${suffix}`);
    bystanderToken = bystander.token;
    bystanderId = bystander.id;
    await joinGroup(bystanderToken);

    const mod = await register(`pin_mod_${suffix}`);
    modToken = mod.token;
    modId = mod.id;
    await joinGroup(modToken);

    const outsider = await register(`pin_out_${suffix}`);
    outsiderToken = outsider.token;

    // Grant the moderator MANAGE_MESSAGES via a real role assignment.
    const role = await app.inject({
      method: "POST",
      url: `/groups/${groupId}/roles`,
      headers: auth(ownerToken),
      payload: { name: "Mods", permissions: PERMISSIONS.MANAGE_MESSAGES },
    });
    expect(role.statusCode).toBe(201);
    const assign = await app.inject({
      method: "PUT",
      url: `/groups/${groupId}/members/${modId}/roles`,
      headers: auth(ownerToken),
      payload: { roleIds: [role.json().role.id] },
    });
    expect(assign.statusCode).toBe(200);
  });

  afterAll(async () => {
    await app?.close();
    await bus.close();
    await client?.close();
  });

  // --- permission matrix ----------------------------------------------------

  it("lets the message author pin their own message", async () => {
    const messageId = await send(authorToken, "author pins this");
    const res = await pin(authorToken, messageId);
    expect(res.statusCode).toBe(201);
    const body = res.json().pin as PinDTO;
    expect(body.message.id).toBe(messageId);
    expect(body.pinnedBy).toBe(authorId);
    expect(body.message.pinned).toBe(true);
    await unpin(authorToken, messageId);
  });

  it("refuses a plain member who is not the author (403)", async () => {
    const messageId = await send(authorToken, "not yours to pin");
    const res = await pin(bystanderToken, messageId);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("FORBIDDEN");
  });

  it("lets MANAGE_MESSAGES pin someone else's message", async () => {
    const messageId = await send(authorToken, "mod pins this");
    const res = await pin(modToken, messageId);
    expect(res.statusCode).toBe(201);
    expect((res.json().pin as PinDTO).pinnedBy).toBe(modId);
    await unpin(modToken, messageId);
  });

  it("lets the owner pin anything (bitfield bypass)", async () => {
    const messageId = await send(authorToken, "owner pins this");
    expect((await pin(ownerToken, messageId)).statusCode).toBe(201);
    await unpin(ownerToken, messageId);
  });

  it("answers 404 (never 403) to a NON-member — existence is not leaked", async () => {
    const messageId = await send(authorToken, "invisible to outsiders");
    const res = await pin(outsiderToken, messageId);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
    expect((await listPins(outsiderToken)).statusCode).toBe(404);
  });

  it("refuses to pin a message that lives in a DIFFERENT channel", async () => {
    const other = await app.inject({
      method: "POST",
      url: `/groups/${groupId}/channels`,
      headers: auth(ownerToken),
      payload: { name: "elsewhere", kind: "text" },
    });
    expect(other.statusCode).toBe(201);
    const otherChannelId = other.json().channel.id as string;
    const messageId = await send(ownerToken, "over here", otherChannelId);

    // Same group, caller can see both channels — but the pin must still be
    // refused, because the message does not belong to the target channel.
    const res = await pin(ownerToken, messageId, channelId);
    expect(res.statusCode).toBe(404);
  });

  // --- behaviour ------------------------------------------------------------

  it("is idempotent: re-pinning does not duplicate or re-broadcast", async () => {
    const messageId = await send(authorToken, "pin me twice");
    expect((await pin(authorToken, messageId)).statusCode).toBe(201);
    const firstPinnedAt = (await listPins(authorToken)).json().pins[0].pinnedAt as string;

    expect((await pin(authorToken, messageId)).statusCode).toBe(201);
    expect(eventsFor(messageId, SERVER_EVENT.messagePinned)).toHaveLength(1);

    const pins = (await listPins(authorToken)).json().pins as PinDTO[];
    expect(pins.filter((p) => p.message.id === messageId)).toHaveLength(1);
    // Re-pinning must not reshuffle the board.
    expect(pins.find((p) => p.message.id === messageId)?.pinnedAt).toBe(firstPinnedAt);

    await unpin(authorToken, messageId);
  });

  it("publishes message.pinned / message.unpinned channel-scoped", async () => {
    const messageId = await send(authorToken, "watch the bus");
    await pin(authorToken, messageId);
    const [pinned] = eventsFor(messageId, SERVER_EVENT.messagePinned);
    expect(pinned?.channelId).toBe(channelId);
    expect(pinned?.groupId).toBeUndefined();

    await unpin(authorToken, messageId);
    const [unpinned] = eventsFor(messageId, SERVER_EVENT.messageUnpinned);
    expect(unpinned?.channelId).toBe(channelId);
  });

  it("unpin is idempotent and does not re-broadcast", async () => {
    const messageId = await send(authorToken, "unpin twice");
    await pin(authorToken, messageId);
    expect((await unpin(authorToken, messageId)).statusCode).toBe(204);
    expect((await unpin(authorToken, messageId)).statusCode).toBe(204);
    expect(eventsFor(messageId, SERVER_EVENT.messageUnpinned)).toHaveLength(1);
  });

  it("marks pinned messages in the GET message page", async () => {
    const messageId = await send(authorToken, "flagged on the page");
    await pin(authorToken, messageId);

    const page = await app.inject({
      method: "GET",
      url: `/channels/${channelId}/messages`,
      headers: auth(bystanderToken),
    });
    const found = (page.json().messages as { id: string; pinned?: boolean }[]).find(
      (m) => m.id === messageId,
    );
    expect(found?.pinned).toBe(true);
    await unpin(authorToken, messageId);
  });

  it("deleting a pinned message reaps the pin and fans message.unpinned", async () => {
    const messageId = await send(authorToken, "delete me while pinned");
    await pin(authorToken, messageId);

    const del = await app.inject({
      method: "DELETE",
      url: `/messages/${messageId}`,
      headers: auth(authorToken),
    });
    expect(del.statusCode).toBe(204);

    const pins = (await listPins(authorToken)).json().pins as PinDTO[];
    expect(pins.some((p) => p.message.id === messageId)).toBe(false);
    expect(eventsFor(messageId, SERVER_EVENT.messageUnpinned).length).toBeGreaterThanOrEqual(1);
  });

  it("refuses to pin a soft-deleted message (404)", async () => {
    const messageId = await send(authorToken, "gone before pinning");
    await app.inject({
      method: "DELETE",
      url: `/messages/${messageId}`,
      headers: auth(authorToken),
    });
    expect((await pin(authorToken, messageId)).statusCode).toBe(404);
  });

  /**
   * The suite's known intermittent failure, now explained: the seeding loop below
   * issues ~100 SEQUENTIAL round trips to a real Postgres and took ~4.3s against
   * vitest's 5s default, so any contention (`pnpm -r run test` points apps/api,
   * packages/db and apps/realtime at the SAME instance) pushed it over. It was
   * always `Test timed out in 5000ms`, never a wrong assertion — the cap this
   * guards was never in doubt. The budget now lives in `apps/api/vitest.config.ts`
   * (testTimeout), which covers the three sibling loop-seeded tests too.
   */
  it("enforces PINS_MAX_PER_CHANNEL with a 409", async () => {
    const capChannel = await app.inject({
      method: "POST",
      url: `/groups/${groupId}/channels`,
      headers: auth(ownerToken),
      payload: { name: "capped", kind: "text" },
    });
    const capId = capChannel.json().channel.id as string;

    // Seed the board to the cap through the REPOSITORY, not the HTTP routes.
    // Filling 50 pins over HTTP would trip the message send / pin rate limits
    // (20 and 30 per 10s) and turn this into a test of the limiter rather than
    // of the cap. The 51st pin below still goes through the real endpoint, which
    // is the assertion that matters.
    for (let i = 0; i < PINS_MAX_PER_CHANNEL; i += 1) {
      const seeded = await repos.messages.create({
        channelId: capId,
        authorId: ownerId,
        content: `pin ${i}`,
      });
      const result = await repos.messagePins.pin(seeded.id, capId, ownerId);
      expect(result.pinned).toBe(true);
    }

    const overflow = await send(ownerToken, "one too many", capId);
    const res = await pin(ownerToken, overflow, capId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe("PINS_FULL");

    // The board is exactly at the cap and un-paginated.
    expect((await listPins(ownerToken, capId)).json().pins).toHaveLength(PINS_MAX_PER_CHANNEL);
  });

  // --- DM: no role system, so either participant may pin --------------------

  it("lets EITHER participant pin in a DM (both are role='member')", async () => {
    // Reuse two already-registered users: /auth/register is capped at 5 per 15
    // minutes per IP, and the fixture has already spent that budget.
    const a = { token: authorToken, id: authorId };
    const b = { token: bystanderToken, id: bystanderId };

    // Befriend, then open the DM.
    const meB = await app.inject({ method: "GET", url: "/users/me", headers: auth(b.token) });
    const friendCode = meB.json().user.friendCode as string;
    const request = await app.inject({
      method: "POST",
      url: "/friends/requests",
      headers: auth(a.token),
      payload: { friendCode },
    });
    expect(request.statusCode).toBe(201);
    const accept = await app.inject({
      method: "POST",
      url: `/friends/requests/${a.id}/accept`,
      headers: auth(b.token),
    });
    expect(accept.statusCode).toBe(200);

    const dm = await app.inject({
      method: "POST",
      url: "/dms",
      headers: auth(a.token),
      payload: { userId: b.id },
    });
    expect([200, 201]).toContain(dm.statusCode);
    const streamId = dm.json().dm.streamId as string;

    // A writes, B pins it — B is neither the author nor a role holder.
    const messageId = await send(a.token, "pin this for me", streamId);
    const res = await pin(b.token, messageId, streamId);
    expect(res.statusCode).toBe(201);
    expect((res.json().pin as PinDTO).pinnedBy).toBe(b.id);

    expect((await unpin(a.token, messageId, streamId)).statusCode).toBe(204);
  });
});
