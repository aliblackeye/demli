/**
 * Channel-targeted invites (migration 0021) — integration against real Postgres
 * from docker-compose; auto-skipped with a notice when the database is down.
 *
 * The founder's flow: an invite can point at a CHANNEL. Pressing the link joins
 * the server and lands you on that channel; if it is a voice channel, the next
 * press enters the room. One deep-link format either way — the destination
 * rides on the invite ROW, never on a second URL shape.
 *
 * What is locked here:
 *  - creating a targeted invite stores the target and echoes it back;
 *  - a channel from ANOTHER group → 400, no invite minted;
 *  - a channel the CREATOR cannot see (ADR 0007 restriction) → the SAME 400, so
 *    the response is not an oracle for a restricted channel's existence (§28);
 *  - redeem returns `targetChannel: {id, name, kind}` for a reachable target;
 *  - a role-restricted target still REDEEMS FINE but answers `targetChannel:
 *    null` — the person joins, they just are not pointed at a door they cannot
 *    open (a dead redirect is worse than none, §35);
 *  - deleting the channel does NOT delete the invite: the link keeps working and
 *    degrades to a plain server invite (ON DELETE SET NULL);
 *  - an untargeted invite behaves exactly as before (regression);
 *  - the preview card answers per-viewer with the same honesty rule.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  applyMigrations,
  createDb,
  createRepositories,
  generateSessionToken,
  hashSessionToken,
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
  console.warn("[invite-target-channel.int.test] DATABASE unreachable — skipping");
}

describe.skipIf(!dbUp)("channel-targeted invites (migration 0021)", () => {
  let client: DbClient;
  let repos: Repositories;
  let app: FastifyInstance;

  const suffix = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  interface TestUser {
    token: string;
    id: string;
  }

  let seq = 0;
  /**
   * Users are minted through the repositories, not `POST /auth/register` — this
   * suite needs ~8 accounts and registration is rate-limited per IP (§28), which
   * every injected request shares. Sessions are created the same way the auth
   * module does, so the token is a real one.
   */
  async function register(label: string): Promise<TestUser> {
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
    return { token, id: user.id };
  }

  async function makeServer(owner: TestUser, name: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/groups",
      headers: auth(owner.token),
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().group.id as string;
  }

  async function createRole(serverId: string, owner: TestUser, name: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/roles`,
      headers: auth(owner.token),
      payload: { name },
    });
    expect(res.statusCode).toBe(201);
    return res.json().role.id as string;
  }

  async function createChannel(
    serverId: string,
    actor: TestUser,
    payload: { name: string; kind: "text" | "voice"; roleIds?: string[] },
  ): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: `/groups/${serverId}/channels`,
      headers: auth(actor.token),
      payload,
    });
    expect(res.statusCode).toBe(201);
    return res.json().channel.id as string;
  }

  /** Mint an invite; returns the raw reply so refusal cases can assert on it. */
  async function createInvite(
    serverId: string,
    actor: TestUser,
    payload: Record<string, unknown> = {},
  ) {
    return app.inject({
      method: "POST",
      url: `/groups/${serverId}/invites`,
      headers: auth(actor.token),
      payload,
    });
  }

  async function redeem(code: string, actor: TestUser) {
    return app.inject({
      method: "POST",
      url: `/invites/${code}/redeem`,
      headers: auth(actor.token),
    });
  }

  async function preview(code: string, actor: TestUser) {
    return app.inject({
      method: "GET",
      url: `/invites/${code}/preview`,
      headers: auth(actor.token),
    });
  }

  /** Owner's server under test, plus its two kinds of channel. */
  let owner: TestUser;
  let serverId: string;
  let voiceChannelId: string;
  let restrictedChannelId: string;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
    app = await buildApp({
      repos,
      env: loadEnv({ DATABASE_URL }),
      logger: false,
    });

    owner = await register("tco");
    serverId = await makeServer(owner, `Target Crew ${suffix}`);
    voiceChannelId = await createChannel(serverId, owner, {
      name: "lobi",
      kind: "voice",
    });
    const staffRole = await createRole(serverId, owner, `staff-${suffix}`);
    restrictedChannelId = await createChannel(serverId, owner, {
      name: "staff-only",
      kind: "text",
      roleIds: [staffRole],
    });
  });

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  it("stores the target on the invite row and echoes it back", async () => {
    const res = await createInvite(serverId, owner, { targetChannelId: voiceChannelId });
    expect(res.statusCode).toBe(201);
    const invite = res.json().invite as { code: string; targetChannelId: string | null };
    expect(invite.targetChannelId).toBe(voiceChannelId);

    // …and it is really persisted, not just reflected.
    const stored = await repos.invites.findByCode(invite.code);
    expect(stored?.targetChannelId).toBe(voiceChannelId);
  });

  it("refuses a channel that belongs to ANOTHER group — and mints nothing", async () => {
    const outsider = await register("tcx");
    const otherServerId = await makeServer(outsider, `Other Crew ${suffix}`);
    const foreignChannelId = await createChannel(otherServerId, outsider, {
      name: "elsewhere",
      kind: "text",
    });

    const before = (await repos.invites.listForGroup(serverId)).length;
    const res = await createInvite(serverId, owner, { targetChannelId: foreignChannelId });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect((await repos.invites.listForGroup(serverId)).length).toBe(before);
  });

  it("refuses a channel the CREATOR cannot see, with the same answer as 'not here'", async () => {
    // A plain member may create invites (default invite_policy = "members") but
    // holds no role, so the staff-only channel does not exist as far as they are
    // concerned. The refusal must be indistinguishable from the foreign-channel
    // one above — otherwise the endpoint confirms a restricted channel's id.
    const plain = await register("tcm");
    const joinInvite = await createInvite(serverId, owner);
    expect(joinInvite.statusCode).toBe(201);
    expect((await redeem(joinInvite.json().invite.code, plain)).statusCode).toBe(200);

    const res = await createInvite(serverId, plain, {
      targetChannelId: restrictedChannelId,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");

    // The owner, who CAN see it, is allowed to target the very same channel —
    // proving the refusal was about visibility, not about the channel itself.
    const asOwner = await createInvite(serverId, owner, {
      targetChannelId: restrictedChannelId,
    });
    expect(asOwner.statusCode).toBe(201);
    expect(asOwner.json().invite.targetChannelId).toBe(restrictedChannelId);
  });

  it("rejects a malformed channel id before touching the database", async () => {
    const res = await createInvite(serverId, owner, { targetChannelId: "not-a-uuid" });
    expect(res.statusCode).toBe(400);
  });

  it("redeem lands the joiner on the target channel", async () => {
    const joiner = await register("tcj");
    const invite = await createInvite(serverId, owner, {
      targetChannelId: voiceChannelId,
    });
    expect(invite.statusCode).toBe(201);

    const res = await redeem(invite.json().invite.code, joiner);
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      group: { id: string };
      targetChannel: { id: string; name: string; kind: string } | null;
    };
    expect(body.group.id).toBe(serverId);
    expect(body.targetChannel).toEqual({
      id: voiceChannelId,
      name: "lobi",
      kind: "voice",
    });
    // The membership is real — the target is a bonus, not the outcome.
    expect(await repos.groups.getMembership(serverId, joiner.id)).not.toBeNull();
  });

  it("a ROLE-RESTRICTED target still joins the server but points nowhere", async () => {
    // The single most important row of this table: the invite is valid, the
    // channel exists, and the owner could see it — but the brand-new member has
    // no roles, so pointing them at it would be a dead redirect.
    const joiner = await register("tcr");
    const invite = await createInvite(serverId, owner, {
      targetChannelId: restrictedChannelId,
    });
    expect(invite.statusCode).toBe(201);

    const res = await redeem(invite.json().invite.code, joiner);
    expect(res.statusCode).toBe(200);
    expect(res.json().group.id).toBe(serverId);
    expect(res.json().targetChannel).toBeNull();
    // Joined for real — the null target never blocks the join.
    expect(await repos.groups.getMembership(serverId, joiner.id)).not.toBeNull();
  });

  it("deleting the channel keeps the invite alive and untargeted", async () => {
    const doomedId = await createChannel(serverId, owner, {
      name: `doomed-${suffix}`,
      kind: "text",
    });
    const invite = await createInvite(serverId, owner, { targetChannelId: doomedId });
    expect(invite.statusCode).toBe(201);
    const code = invite.json().invite.code as string;

    const deleted = await app.inject({
      method: "DELETE",
      url: `/channels/${doomedId}`,
      headers: auth(owner.token),
    });
    expect(deleted.statusCode).toBeLessThan(300);

    // The invite row survives (ON DELETE SET NULL, not CASCADE) and simply lost
    // its destination — a link already shared in a chat must not 404.
    const stored = await repos.invites.findByCode(code);
    expect(stored).not.toBeNull();
    expect(stored?.targetChannelId).toBeNull();

    const joiner = await register("tcd");
    const res = await redeem(code, joiner);
    expect(res.statusCode).toBe(200);
    expect(res.json().targetChannel).toBeNull();
    expect(await repos.groups.getMembership(serverId, joiner.id)).not.toBeNull();
  });

  it("an untargeted invite behaves exactly as before (regression)", async () => {
    const joiner = await register("tcp");
    const invite = await createInvite(serverId, owner);
    expect(invite.statusCode).toBe(201);
    expect(invite.json().invite.targetChannelId).toBeNull();

    const res = await redeem(invite.json().invite.code, joiner);
    expect(res.statusCode).toBe(200);
    expect(res.json().group.id).toBe(serverId);
    expect(res.json().targetChannel).toBeNull();
  });

  it("the preview card shows a reachable target and hides an unreachable one", async () => {
    const looker = await register("tcv");

    const open = await createInvite(serverId, owner, { targetChannelId: voiceChannelId });
    expect(open.statusCode).toBe(201);
    const openCard = await preview(open.json().invite.code, looker);
    expect(openCard.statusCode).toBe(200);
    expect((openCard.json().preview as InvitePreview).targetChannel).toEqual({
      id: voiceChannelId,
      name: "lobi",
      kind: "voice",
    });

    // Same viewer, restricted target: the card must not advertise a channel the
    // join cannot deliver, even though the invite itself is perfectly valid.
    const locked = await createInvite(serverId, owner, {
      targetChannelId: restrictedChannelId,
    });
    expect(locked.statusCode).toBe(201);
    const lockedCard = await preview(locked.json().invite.code, looker);
    expect(lockedCard.statusCode).toBe(200);
    expect((lockedCard.json().preview as InvitePreview).targetChannel).toBeNull();

    // Previewing never consumed anything.
    expect((await repos.invites.findByCode(open.json().invite.code))!.useCount).toBe(0);
  });

  it("the OWNER previewing their own restricted-target invite does see it", async () => {
    // The visibility answer is per-viewer, not a property of the invite: the same
    // row that reads null for a stranger reads the real channel for someone who
    // can open it. Guards against "restricted ⇒ always null" being baked in.
    const locked = await createInvite(serverId, owner, {
      targetChannelId: restrictedChannelId,
    });
    expect(locked.statusCode).toBe(201);
    const card = await preview(locked.json().invite.code, owner);
    expect(card.statusCode).toBe(200);
    const targetChannel = (card.json().preview as InvitePreview).targetChannel;
    expect(targetChannel?.id).toBe(restrictedChannelId);
    expect(targetChannel?.kind).toBe("text");
  });
});
