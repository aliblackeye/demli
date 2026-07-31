/**
 * Social layer integration tests — real Postgres (ADR 0010, W1b).
 * Skipped automatically (with a console notice) when the database is down.
 *
 * Covers: friendships (canonical ordering + CHECK, dedup, reverse-pending
 * auto-accept, addressee-only accept, decline/cancel/unfriend, presence ids),
 * friend codes (uniqueness, case/dash-insensitive lookup, regenerate), DMs
 * (kind='dm' construction, one-per-pair uniqueness, hide/unhide with history
 * intact, message-pipeline reuse), and the context-aware profile card.
 *
 * Also exercises migration 0007 end-to-end: `applyMigrations` runs in beforeAll,
 * so a green suite proves the migration applies cleanly (including the enum
 * ADD VALUE inside the migrator's wrapping transaction).
 */

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createDb,
  createRepositories,
  schema,
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
  console.warn("[social.int.test] DATABASE unreachable — skipping");
}

function uniq(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

describe.skipIf(!dbUp)("social layer (M13)", () => {
  let client: DbClient;
  let repos: Repositories;

  async function newUser(prefix: string): Promise<string> {
    const u = await repos.users.create({
      username: uniq(prefix),
      displayName: prefix,
      passwordHash: "not-used",
    });
    return u.id;
  }

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
  });

  afterAll(async () => {
    await client?.close();
  });

  // -------------------------------------------------------------------------
  describe("friendships", () => {
    it("send() stores one canonical pending row (user_a < user_b), requestedBy = sender", async () => {
      const a = await newUser("fr_a");
      const b = await newUser("fr_b");

      const res = await repos.friendships.send(a, b);
      expect(res.outcome).toBe("created");
      expect(res.friendship).not.toBeNull();

      const f = res.friendship!;
      expect(f.status).toBe("pending");
      expect(f.requestedBy).toBe(a);
      // Canonical order: stored user_a < user_b (matches the DB CHECK).
      expect(f.userA < f.userB).toBe(true);
      expect([f.userA, f.userB].sort()).toEqual([a, b].sort());
    });

    it("send() to yourself is rejected without a row", async () => {
      const a = await newUser("fr_self");
      const res = await repos.friendships.send(a, a);
      expect(res.outcome).toBe("self");
      expect(res.friendship).toBeNull();
      expect(await repos.friendships.getFriendshipWith(a, a)).toBeNull();
    });

    it("the DB CHECK forbids a self-friendship row directly", async () => {
      const a = await newUser("fr_check");
      await expect(
        client.db
          .insert(schema.friendships)
          .values({ userA: a, userB: a, status: "pending", requestedBy: a }),
      ).rejects.toThrow();
    });

    it("duplicate outgoing request is an idempotent no-op", async () => {
      const a = await newUser("fr_dup_a");
      const b = await newUser("fr_dup_b");
      await repos.friendships.send(a, b);
      const again = await repos.friendships.send(a, b);
      expect(again.outcome).toBe("already_pending");
      // Still exactly one pending row, still from a.
      const f = await repos.friendships.getFriendshipWith(a, b);
      expect(f?.status).toBe("pending");
      expect(f?.requestedBy).toBe(a);
    });

    it("reverse-pending request auto-accepts (mutual consent → accepted)", async () => {
      const a = await newUser("fr_rev_a");
      const b = await newUser("fr_rev_b");
      await repos.friendships.send(a, b); // a → b pending
      const res = await repos.friendships.send(b, a); // b → a: both consented
      expect(res.outcome).toBe("auto_accepted");
      expect(res.friendship?.status).toBe("accepted");
      // Same single row, now accepted (requestedBy is unchanged = a).
      const f = await repos.friendships.getFriendshipWith(a, b);
      expect(f?.status).toBe("accepted");
      expect(f?.requestedBy).toBe(a);
    });

    it("only the addressee may accept; the requester cannot", async () => {
      const a = await newUser("fr_acc_a");
      const b = await newUser("fr_acc_b");
      await repos.friendships.send(a, b);

      const bySender = await repos.friendships.accept(a, b);
      expect(bySender).toEqual({ ok: false, reason: "not_addressee" });

      const byAddressee = await repos.friendships.accept(b, a);
      expect(byAddressee.ok).toBe(true);
      if (byAddressee.ok) expect(byAddressee.friendship.status).toBe("accepted");

      // Accepting again is "not_pending".
      const twice = await repos.friendships.accept(b, a);
      expect(twice).toEqual({ ok: false, reason: "not_pending" });
    });

    it("accept() on a missing pair is not_found", async () => {
      const a = await newUser("fr_nf_a");
      const b = await newUser("fr_nf_b");
      expect(await repos.friendships.accept(a, b)).toEqual({ ok: false, reason: "not_found" });
    });

    it("listRequests splits incoming vs outgoing; the other party is embedded", async () => {
      const a = await newUser("fr_lr_a");
      const b = await newUser("fr_lr_b");
      await repos.friendships.send(a, b);

      const outA = await repos.friendships.listRequests(a, "outgoing");
      expect(outA.map((r) => r.user.id)).toContain(b);
      expect(await repos.friendships.listRequests(a, "incoming")).toEqual([]);

      const inB = await repos.friendships.listRequests(b, "incoming");
      expect(inB.map((r) => r.user.id)).toContain(a);
      expect(await repos.friendships.listRequests(b, "outgoing")).toEqual([]);
    });

    it("listFriends + listAcceptedFriendIds return the other user (both directions)", async () => {
      const a = await newUser("fr_lf_a");
      const b = await newUser("fr_lf_b");
      await repos.friendships.send(a, b);
      await repos.friendships.accept(b, a);

      const friendsOfA = await repos.friendships.listFriends(a);
      expect(friendsOfA.map((f) => f.user.id)).toContain(b);
      const friendsOfB = await repos.friendships.listFriends(b);
      expect(friendsOfB.map((f) => f.user.id)).toContain(a);

      expect(await repos.friendships.listAcceptedFriendIds(a)).toContain(b);
      expect(await repos.friendships.listAcceptedFriendIds(b)).toContain(a);
    });

    it("remove() deletes the pair (decline/cancel/unfriend); second remove is false", async () => {
      const a = await newUser("fr_rm_a");
      const b = await newUser("fr_rm_b");
      await repos.friendships.send(a, b);
      await repos.friendships.accept(b, a);

      expect(await repos.friendships.remove(a, b)).toBe(true);
      expect(await repos.friendships.getFriendshipWith(a, b)).toBeNull();
      // Order-independent + idempotent.
      expect(await repos.friendships.remove(b, a)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe("friend codes", () => {
    it("create() mints a unique 8-char base32 code; lookups are case/dash-insensitive", async () => {
      const id = await newUser("fc_user");
      const me = await repos.users.findSelf(id);
      expect(me?.friendCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
      const code = me!.friendCode!;

      // Distinct users get distinct codes.
      const other = await repos.users.findSelf(await newUser("fc_other"));
      expect(other?.friendCode).not.toBe(code);

      // Case-insensitive + dashes/spaces ignored; resolves back to the user.
      const grouped = `${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase();
      const found = await repos.users.findByFriendCode(grouped);
      expect(found?.id).toBe(id);
      // Never leaks friendCode for another user (toUser, not toSelfUser).
      expect(found).not.toHaveProperty("friendCode");
    });

    it("regenerateFriendCode() invalidates the old code and mints a new one", async () => {
      const id = await newUser("fc_regen");
      const before = (await repos.users.findSelf(id))!.friendCode!;

      const updated = await repos.users.regenerateFriendCode(id);
      const after = updated!.friendCode!;
      expect(after).not.toBe(before);
      expect(after).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);

      // Old code no longer resolves; new one does.
      expect(await repos.users.findByFriendCode(before)).toBeNull();
      expect((await repos.users.findByFriendCode(after))?.id).toBe(id);
    });
  });

  // -------------------------------------------------------------------------
  describe("dms", () => {
    it("getOrCreate() builds a kind='dm' group with 2 members + 1 stream channel", async () => {
      const a = await newUser("dm_a");
      const b = await newUser("dm_b");

      const { dm, created } = await repos.dms.getOrCreate(a, b);
      expect(created).toBe(true);
      expect(dm.participant.id).toBe(b); // resolved relative to the caller
      expect(dm.streamId).toMatch(/[0-9a-f-]{36}/);

      // Backing friend_groups row is kind='dm'.
      const raw = await repos.groups.findById(dm.id);
      expect(raw?.kind).toBe("dm");

      // Exactly two members, one text stream channel.
      const members = await client.db
        .select()
        .from(schema.friendGroupMembers)
        .where(eq(schema.friendGroupMembers.groupId, dm.id));
      expect(members).toHaveLength(2);
      const channels = await repos.channels.listForGroup(dm.id);
      expect(channels).toHaveLength(1);
      expect(channels[0]!.id).toBe(dm.streamId);
      expect(channels[0]!.kind).toBe("text");
    });

    it("is idempotent — one DM per pair, resolved from either side", async () => {
      const a = await newUser("dm_idem_a");
      const b = await newUser("dm_idem_b");

      const first = await repos.dms.getOrCreate(a, b);
      const second = await repos.dms.getOrCreate(a, b);
      expect(second.created).toBe(false);
      expect(second.dm.id).toBe(first.dm.id);

      // From b's side: same DM, participant is now a.
      const fromB = await repos.dms.getOrCreate(b, a);
      expect(fromB.created).toBe(false);
      expect(fromB.dm.id).toBe(first.dm.id);
      expect(fromB.dm.participant.id).toBe(a);
    });

    it("reuses the channel message pipeline via streamId", async () => {
      const a = await newUser("dm_msg_a");
      const b = await newUser("dm_msg_b");
      const { dm } = await repos.dms.getOrCreate(a, b);
      await repos.messages.create({ channelId: dm.streamId, authorId: a, content: "hi there" });
      const page = await repos.messages.listPage({ channelId: dm.streamId, limit: 10 });
      expect(page.items.map((m) => m.content)).toContain("hi there");
    });

    it("hide() removes the DM from my list only; history + counterpart survive; unhide re-surfaces", async () => {
      const a = await newUser("dm_hide_a");
      const b = await newUser("dm_hide_b");
      const { dm } = await repos.dms.getOrCreate(a, b);
      await repos.messages.create({ channelId: dm.streamId, authorId: a, content: "keep me" });

      expect(await repos.dms.hide(dm.id, a)).toBe(true);
      // Gone from a's list, still present for b.
      expect((await repos.dms.listForUser(a)).map((d) => d.id)).not.toContain(dm.id);
      expect((await repos.dms.listForUser(b)).map((d) => d.id)).toContain(dm.id);
      // History intact — hiding never deletes messages.
      const page = await repos.messages.listPage({ channelId: dm.streamId, limit: 10 });
      expect(page.items.map((m) => m.content)).toContain("keep me");

      // Re-open.
      expect(await repos.dms.unhide(dm.id, a)).toBe(true);
      expect((await repos.dms.listForUser(a)).map((d) => d.id)).toContain(dm.id);
    });

    it("findById() gates on membership — a non-member gets null", async () => {
      const a = await newUser("dm_gate_a");
      const b = await newUser("dm_gate_b");
      const stranger = await newUser("dm_gate_x");
      const { dm } = await repos.dms.getOrCreate(a, b);

      expect((await repos.dms.findById(dm.id, a))?.participant.id).toBe(b);
      expect(await repos.dms.findById(dm.id, stranger)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  describe("getProfile (context-aware card)", () => {
    it("a stranger: friendship 'none', and no roles even with an unrelated groupId", async () => {
      const viewer = await newUser("pf_str_v");
      const target = await newUser("pf_str_t");
      // A server the viewer is NOT a member of.
      const server = await repos.groups.create({ name: "Outsider Server", ownerId: target });

      const profile = await repos.users.getProfile(viewer, target, server.id);
      expect(profile).not.toBeNull();
      expect(profile!.friendship).toBe("none");
      expect(profile!.roles).toBeUndefined();
      expect(profile!.user.id).toBe(target);
    });

    it("derives incoming / outgoing / friends relative to the viewer", async () => {
      const a = await newUser("pf_dir_a");
      const b = await newUser("pf_dir_b");
      await repos.friendships.send(a, b); // a → b

      expect((await repos.users.getProfile(a, b))!.friendship).toBe("outgoing");
      expect((await repos.users.getProfile(b, a))!.friendship).toBe("incoming");

      await repos.friendships.accept(b, a);
      expect((await repos.users.getProfile(a, b))!.friendship).toBe("friends");
      expect((await repos.users.getProfile(b, a))!.friendship).toBe("friends");
    });

    it("returns roles ONLY when a shared server is named; hides them otherwise", async () => {
      const viewer = await newUser("pf_role_v");
      const target = await newUser("pf_role_t");
      const server = await repos.groups.create({ name: "Shared Server", ownerId: viewer });
      await repos.groups.addMember(server.id, target, "member");
      const role = await repos.roles.create({ groupId: server.id, name: "VIP" });
      await repos.roles.assign(server.id, target, role.id);

      // Shared server → roles visible.
      const shared = await repos.users.getProfile(viewer, target, server.id);
      expect(shared!.roles?.map((r) => r.name)).toEqual(["VIP"]);

      // No groupId → no roles.
      expect((await repos.users.getProfile(viewer, target))!.roles).toBeUndefined();

      // A server the viewer is not in → no roles leaked.
      const otherServer = await repos.groups.create({ name: "Not Shared", ownerId: target });
      expect(
        (await repos.users.getProfile(viewer, target, otherServer.id))!.roles,
      ).toBeUndefined();
    });

    it("lists ONLY the servers both users share, name-sorted, without a groupId", async () => {
      const viewer = await newUser("pf_mut_v");
      const target = await newUser("pf_mut_t");

      // Two shared servers (viewer owns one, target owns the other + both join).
      const beta = await repos.groups.create({ name: "Beta", ownerId: viewer });
      await repos.groups.addMember(beta.id, target, "member");
      const alpha = await repos.groups.create({ name: "Alpha", ownerId: target });
      await repos.groups.addMember(alpha.id, viewer, "member");

      // A server only the viewer is in, and one only the target is in — neither
      // is mutual and must be absent.
      const viewerOnly = await repos.groups.create({ name: "ViewerOnly", ownerId: viewer });
      const targetOnly = await repos.groups.create({ name: "TargetOnly", ownerId: target });

      // A flat group chat both belong to must NOT count (server-kind only).
      const chat = await repos.groups.create({
        name: "Flat Chat",
        ownerId: viewer,
        kind: "group",
      });
      await repos.groups.addMember(chat.id, target, "member");

      const profile = await repos.users.getProfile(viewer, target);
      // Name-sorted: Alpha before Beta; the non-mutual + the flat chat excluded.
      expect(profile!.mutualServers?.map((s) => s.name)).toEqual(["Alpha", "Beta"]);
      const ids = profile!.mutualServers?.map((s) => s.id) ?? [];
      expect(ids).not.toContain(viewerOnly.id);
      expect(ids).not.toContain(targetOnly.id);
      expect(ids).not.toContain(chat.id);
    });

    it("never returns mutual servers on the viewer's OWN card", async () => {
      const self = await newUser("pf_mut_self");
      const server = await repos.groups.create({ name: "Solo", ownerId: self });
      expect(await repos.groups.getMembership(server.id, self)).not.toBeNull();

      const own = await repos.users.getProfile(self, self, server.id);
      expect(own!.mutualServers).toBeUndefined();
    });
  });
});
