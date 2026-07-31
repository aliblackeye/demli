/**
 * Invite preview card — `GET /invites/:code/preview` (integration).
 *
 * Real Postgres from docker-compose; auto-skipped when unreachable. Presence is
 * the injected InMemoryPresenceReader so the online count is exercised without
 * Redis (the production RedisPresenceReader counter has its own live test in
 * packages/db).
 *
 * Covers the Director's contract:
 *  - valid code → real name/counts, kind server|group, group createdAt
 *  - onlineCount excludes invisible members (publicPresenceStatus mask)
 *  - expired → INVITE_EXPIRED, exhausted → INVITE_EXHAUSTED, banned → GROUP_BANNED
 *  - existing member → alreadyMember:true + groupId; non-member → groupId:null
 *  - membership beats expiry (member previews an expired invite and still
 *    gets the card, mirroring redeem's precedence)
 *  - preview NEVER redeems: use_count untouched, no membership created
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  applyMigrations,
  createDb,
  createRepositories,
  generateSessionToken,
  hashSessionToken,
  InMemoryPresenceReader,
  sessionExpiresAt,
  type DbClient,
  type Repositories,
} from "@demli/db";
import type { InvitePreview } from "@demli/types";
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
  console.warn("[invite-preview.int.test] DATABASE unreachable — skipping integration tests");
}

describe.skipIf(!dbUp)("GET /invites/:code/preview", () => {
  let client: DbClient;
  let repos: Repositories;
  let app: FastifyInstance;
  let presence: InMemoryPresenceReader;

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  let seq = 0;
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  interface TestUser {
    token: string;
    id: string;
    username: string;
  }

  async function newUser(label = "u"): Promise<TestUser> {
    seq += 1;
    const username = `${label}${seq}_${suffix}`;
    const user = await repos.users.create({
      username,
      displayName: username,
      passwordHash: "not-used",
    });
    const token = generateSessionToken();
    await repos.sessions.create({
      userId: user.id,
      tokenHash: hashSessionToken(token),
      expiresAt: sessionExpiresAt(new Date(), 24),
    });
    return { token, id: user.id, username };
  }

  async function preview(code: string, token?: string) {
    return app.inject({
      method: "GET",
      url: `/invites/${code}/preview`,
      ...(token ? { headers: auth(token) } : {}),
    });
  }

  let owner: TestUser;
  let member: TestUser;
  let stranger: TestUser;
  let serverId: string;
  let serverCode: string;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    presence = new InMemoryPresenceReader();
    app = await buildApp({
      repos,
      env: loadEnv({ DATABASE_URL }),
      presence,
      logger: false,
    });

    owner = await newUser("po");
    member = await newUser("pm");
    stranger = await newUser("ps");

    const created = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(owner.token),
      payload: { name: `Preview Crew ${suffix}` },
    });
    expect(created.statusCode).toBe(201);
    serverId = created.json().group.id as string;

    // member joins through a throwaway invite (the normal path).
    const joinInvite = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/invites`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(joinInvite.statusCode).toBe(201);
    const joined = await app.inject({
      method: "POST",
      url: `/invites/${joinInvite.json().invite.code}/redeem`,
      headers: auth(member.token),
    });
    expect(joined.statusCode).toBe(200);

    // The invite under test.
    const invite = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/invites`,
      headers: auth(owner.token),
      payload: {},
    });
    expect(invite.statusCode).toBe(201);
    serverCode = invite.json().invite.code as string;
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("requires auth", async () => {
    expect((await preview(serverCode)).statusCode).toBe(401);
  });

  it("answers NOT_FOUND for an unknown code", async () => {
    const res = await preview("ZZZZZZZZZZ", stranger.token);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("NOT_FOUND");
  });

  it("returns the real card to a non-member — and NEVER consumes a use", async () => {
    // Presence: owner publicly online, member connected but invisible — the
    // count must show 1, not 2 (invisible is masked to offline for peers).
    presence.setOnline(owner.id);
    presence.setInvisible(member.id);

    const res = await preview(serverCode, stranger.token);
    expect(res.statusCode).toBe(200);
    const card = res.json().preview as InvitePreview;

    const group = await repos.groups.findById(serverId);
    expect(card).toEqual({
      code: serverCode,
      kind: "server",
      groupName: `Preview Crew ${suffix}`,
      groupIconUrl: null,
      memberCount: 2, // owner + member
      onlineCount: 1, // owner only — invisible member excluded
      createdAt: group!.createdAt,
      alreadyMember: false,
      groupId: null, // never disclosed to a non-member
      // Untargeted invite (migration 0021) — channel targets have their own
      // suite in invite-target-channel.int.test.ts.
      targetChannel: null,
    });

    // Read-only: use_count untouched, no membership created.
    const invite = await repos.invites.findByCode(serverCode);
    expect(invite!.useCount).toBe(0);
    expect(await repos.groups.getMembership(serverId, stranger.id)).toBeNull();
  });

  it("tells an existing member alreadyMember and discloses groupId", async () => {
    const res = await preview(serverCode, member.token);
    expect(res.statusCode).toBe(200);
    const card = res.json().preview as InvitePreview;
    expect(card.alreadyMember).toBe(true);
    expect(card.groupId).toBe(serverId);
    expect((await repos.invites.findByCode(serverCode))!.useCount).toBe(0);
  });

  it("answers INVITE_EXPIRED for an expired code — but a member still gets the card", async () => {
    const expired = await repos.invites.create({
      groupId: serverId,
      createdBy: owner.id,
      expiresAt: new Date(Date.now() - 60_000),
      maxUses: null,
    });

    const asStranger = await preview(expired.code, stranger.token);
    expect(asStranger.statusCode).toBe(410);
    expect(asStranger.json().error.code).toBe("INVITE_EXPIRED");

    // Membership beats expiry — same precedence as redeem.
    const asMember = await preview(expired.code, member.token);
    expect(asMember.statusCode).toBe(200);
    expect((asMember.json().preview as InvitePreview).alreadyMember).toBe(true);
  });

  it("answers INVITE_EXHAUSTED once max uses are spent", async () => {
    const oneShot = await repos.invites.create({
      groupId: serverId,
      createdBy: owner.id,
      expiresAt: null,
      maxUses: 1,
    });
    const joiner = await newUser("pj");
    const redeem = await app.inject({
      method: "POST",
      url: `/invites/${oneShot.code}/redeem`,
      headers: auth(joiner.token),
    });
    expect(redeem.statusCode).toBe(200);

    const res = await preview(oneShot.code, stranger.token);
    expect(res.statusCode).toBe(410);
    expect(res.json().error.code).toBe("INVITE_EXHAUSTED");
    // The redeem above is the ONLY use — previews added none.
    expect((await repos.invites.findByCode(oneShot.code))!.useCount).toBe(1);
  });

  it("refuses a banned user with GROUP_BANNED, whatever the invite's state", async () => {
    const banned = await newUser("pb");
    await repos.groupBans.ban({
      groupId: serverId,
      userId: banned.id,
      bannedBy: owner.id,
      reason: null,
    });

    const res = await preview(serverCode, banned.token);
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe("GROUP_BANNED");

    // Ban precedes the expiry rules (one answer for a banned user — no oracle
    // for whether the code itself is live, §28).
    const expired = await repos.invites.create({
      groupId: serverId,
      createdBy: owner.id,
      expiresAt: new Date(Date.now() - 60_000),
      maxUses: null,
    });
    const stillBanned = await preview(expired.code, banned.token);
    expect(stillBanned.statusCode).toBe(403);
    expect(stillBanned.json().error.code).toBe("GROUP_BANNED");
  });

  it("previews a group-DM link as kind 'group'", async () => {
    const gOwner = await newUser("pg");
    const created = await app.inject({
      method: "POST",
      url: "/group-chats",
      headers: auth(gOwner.token),
      payload: { name: `flat_${suffix}` },
    });
    expect(created.statusCode).toBe(201);
    const groupChatId = created.json().group.id as string;

    const invite = await app.inject({
      method: "POST",
      url: `/group-chats/${groupChatId}/invites`,
      headers: auth(gOwner.token),
      payload: {},
    });
    expect(invite.statusCode).toBe(201);
    const code = invite.json().invite.code as string;

    const res = await preview(code, stranger.token);
    expect(res.statusCode).toBe(200);
    const card = res.json().preview as InvitePreview;
    expect(card.kind).toBe("group");
    expect(card.groupName).toBe(`flat_${suffix}`);
    expect(card.groupIconUrl).toBeNull();
    expect(card.memberCount).toBe(1); // just the owner
    expect(card.alreadyMember).toBe(false);
    expect(card.groupId).toBeNull();
    expect((await repos.invites.findByCode(code))!.useCount).toBe(0);
  });
});
