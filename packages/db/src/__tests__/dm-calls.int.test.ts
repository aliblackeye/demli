/**
 * DM-calls repository integration tests — real Postgres (ADR 0012, Wave 1).
 * Skipped automatically (with a console notice) when the database is down.
 *
 * Covers: the `dm_calls` control-plane record (create / live-lookup / status
 * transitions), the partial unique index that enforces "one live call per DM",
 * the `channels.livekit_room` override surfaced on the token path, and the
 * single-transaction seamless DM → group upgrade.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applyMigrations,
  createDb,
  createRepositories,
  dmCallRoomName,
  DM_CALL_ROOM_PREFIX,
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
  console.warn("[dm-calls.int.test] DATABASE unreachable — skipping");
}

function uniq(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

describe.skipIf(!dbUp)("callsRepo + callUpgradeRepo (ADR 0012)", () => {
  let client: DbClient;
  let repos: Repositories;

  beforeAll(async () => {
    client = createDb(DATABASE_URL, { max: 5 });
    await applyMigrations(client.db);
    repos = createRepositories(client.db);
  });

  afterAll(async () => {
    await client?.close();
  });

  async function makeUser(prefix: string): Promise<string> {
    const u = await repos.users.create({
      username: uniq(prefix),
      displayName: prefix,
      passwordHash: "not-used",
    });
    return u.id;
  }

  /** A fresh DM between two brand-new users (distinct pair ⇒ distinct dm_key). */
  async function freshDm(): Promise<{ dmId: string; callerId: string; calleeId: string }> {
    const callerId = await makeUser("dc_caller");
    const calleeId = await makeUser("dc_callee");
    const { dm } = await repos.dms.getOrCreate(callerId, calleeId);
    return { dmId: dm.id, callerId, calleeId };
  }

  it("create() logs a ringing call whose room is dmcall:<id>", async () => {
    const { dmId, callerId, calleeId } = await freshDm();
    const call = await repos.calls.create({ dmId, callerId, calleeId, media: "audio" });

    expect(call.status).toBe("ringing");
    expect(call.media).toBe("audio");
    expect(call.callerId).toBe(callerId);
    expect(call.calleeId).toBe(calleeId);
    expect(call.roomName).toBe(dmCallRoomName(call.id));
    expect(call.roomName.startsWith(DM_CALL_ROOM_PREFIX)).toBe(true);
    expect(call.startedAt).toBeNull();
    expect(call.endedAt).toBeNull();
    expect(call.upgradedToGroupId).toBeNull();
  });

  it("findLiveForDm() returns the one live call, null when none", async () => {
    const { dmId, callerId, calleeId } = await freshDm();
    expect(await repos.calls.findLiveForDm(dmId)).toBeNull();

    const call = await repos.calls.create({ dmId, callerId, calleeId, media: "video" });
    const live = await repos.calls.findLiveForDm(dmId);
    expect(live?.id).toBe(call.id);
    expect(live?.media).toBe("video");

    await repos.calls.setStatus(call.id, "ended", { endedAt: new Date() });
    expect(await repos.calls.findLiveForDm(dmId)).toBeNull();
  });

  it("partial unique index blocks a 2nd live call, then allows one after the first ends", async () => {
    const { dmId, callerId, calleeId } = await freshDm();
    const first = await repos.calls.create({ dmId, callerId, calleeId, media: "audio" });

    // A second live call on the SAME DM violates dm_calls_one_live_per_dm.
    await expect(
      repos.calls.create({ dmId, callerId, calleeId, media: "audio" }),
    ).rejects.toThrow();

    // Terminal rows are not constrained: end the first, a fresh call is allowed.
    await repos.calls.setStatus(first.id, "declined", { endedAt: new Date() });
    const second = await repos.calls.create({ dmId, callerId, calleeId, media: "audio" });
    expect(second.id).not.toBe(first.id);
    expect((await repos.calls.findLiveForDm(dmId))?.id).toBe(second.id);
  });

  it("setStatus() accept stamps startedAt + clears expiresAt; end stamps endedAt", async () => {
    const { dmId, callerId, calleeId } = await freshDm();
    const call = await repos.calls.create({
      dmId,
      callerId,
      calleeId,
      media: "audio",
      expiresAt: new Date(Date.now() + 30_000),
    });
    expect(call.expiresAt).not.toBeNull();

    const startedAt = new Date();
    const active = await repos.calls.setStatus(call.id, "active", { startedAt });
    expect(active?.status).toBe("active");
    expect(active?.startedAt).not.toBeNull();
    // Contract: expiresAt (ring deadline) is null once no longer ringing.
    expect(active?.expiresAt).toBeNull();
    expect(active?.endedAt).toBeNull();

    const ended = await repos.calls.setStatus(call.id, "ended", { endedAt: new Date() });
    expect(ended?.status).toBe("ended");
    expect(ended?.endedAt).not.toBeNull();
    // startedAt is preserved across the terminal transition.
    expect(ended?.startedAt).not.toBeNull();

    expect(await repos.calls.setStatus(randomUUID(), "ended")).toBeNull();
  });

  it("markUpgraded() links the group, closes the call, clears expiresAt", async () => {
    const { dmId, callerId, calleeId } = await freshDm();
    const call = await repos.calls.create({
      dmId,
      callerId,
      calleeId,
      media: "audio",
      expiresAt: new Date(Date.now() + 30_000),
    });
    // A stand-in group id (the low-level primitive does not validate the FK target
    // beyond referential integrity — use a real group so the FK holds).
    const group = await repos.groups.create({ name: "Linked", ownerId: callerId });

    const upgraded = await repos.calls.markUpgraded(call.id, group.id);
    expect(upgraded?.status).toBe("upgraded");
    expect(upgraded?.upgradedToGroupId).toBe(group.id);
    expect(upgraded?.endedAt).not.toBeNull();
    expect(upgraded?.expiresAt).toBeNull();
  });

  it("createVoiceChannel + findWithMembership surface livekit_room; ordinary voice channel is null", async () => {
    const ownerId = await makeUser("dc_vc_owner");
    const server = await repos.groups.create({ name: "Voice Server", ownerId });

    const plain = await repos.channels.createVoiceChannel({ groupId: server.id, name: "Lobby" });
    const bound = await repos.channels.createVoiceChannel({
      groupId: server.id,
      name: "Call Room",
      livekitRoom: "dmcall:abc-123",
    });
    expect(plain.kind).toBe("voice");
    expect(bound.kind).toBe("voice");

    const plainAccess = await repos.channels.findWithMembership(plain.id, ownerId);
    const boundAccess = await repos.channels.findWithMembership(bound.id, ownerId);
    // Default null ⇒ token path resolves room = channel id (existing behaviour).
    expect(plainAccess?.livekitRoom).toBeNull();
    // Override surfaced for the token path, NOT on the Channel DTO (no wire leak).
    expect(boundAccess?.livekitRoom).toBe("dmcall:abc-123");
    expect("livekitRoom" in (boundAccess?.channel ?? {})).toBe(false);
  });

  it("upgradeDmToGroup() builds group + text + voice(room=call room) + 3 members and flips the call", async () => {
    const { dmId, callerId, calleeId } = await freshDm();
    const thirdId = await makeUser("dc_third");
    const call = await repos.calls.create({ dmId, callerId, calleeId, media: "video" });

    const { group, voiceChannelId } = await repos.callUpgrade.upgradeDmToGroup({
      callId: call.id,
      name: "Upgraded Group",
      ownerId: callerId,
      memberIds: [calleeId, thirdId],
    });

    // Group is a flat group whose streamId is its TEXT channel (not the voice one).
    expect(group.name).toBe("Upgraded Group");
    expect(group.ownerId).toBe(callerId);
    const chans = await repos.channels.listForGroup(group.id);
    expect(chans).toHaveLength(2);
    const text = chans.find((c) => c.kind === "text")!;
    const voice = chans.find((c) => c.kind === "voice")!;
    expect(group.streamId).toBe(text.id);
    expect(voiceChannelId).toBe(voice.id);

    // The voice channel is bound to the ONGOING call's LiveKit room (zero-gap move).
    const voiceAccess = await repos.channels.findWithMembership(voice.id, callerId);
    expect(voiceAccess?.livekitRoom).toBe(call.roomName);

    // groupChats surfaces resolve streamId to the text stream despite the voice channel.
    expect((await repos.groupChats.findById(group.id))?.streamId).toBe(text.id);

    // Exactly three memberships: inviter=owner, the other two=members.
    const details = await repos.groupChats.getDetails(group.id);
    expect(details?.members).toHaveLength(3);
    const byUser = new Map(details!.members.map((m) => [m.userId, m.role]));
    expect(byUser.get(callerId)).toBe("owner");
    expect(byUser.get(calleeId)).toBe("member");
    expect(byUser.get(thirdId)).toBe("member");

    // The source call is closed and linked to the new group.
    const closed = await repos.calls.findById(call.id);
    expect(closed?.status).toBe("upgraded");
    expect(closed?.upgradedToGroupId).toBe(group.id);
    expect(closed?.endedAt).not.toBeNull();
    // The DM has no live call anymore (it was consumed by the upgrade).
    expect(await repos.calls.findLiveForDm(dmId)).toBeNull();
  });

  it("upgradeDmToGroup() refuses a non-live call (double-upgrade guard, atomic rollback)", async () => {
    const { dmId, callerId, calleeId } = await freshDm();
    const thirdId = await makeUser("dc_third2");
    const call = await repos.calls.create({ dmId, callerId, calleeId, media: "audio" });

    await repos.callUpgrade.upgradeDmToGroup({
      callId: call.id,
      name: "First Upgrade",
      ownerId: callerId,
      memberIds: [calleeId, thirdId],
    });

    // A second upgrade on the now-upgraded call rolls back wholesale.
    await expect(
      repos.callUpgrade.upgradeDmToGroup({
        callId: call.id,
        name: "Second Upgrade",
        ownerId: callerId,
        memberIds: [calleeId, thirdId],
      }),
    ).rejects.toThrow();

    // No orphan group was created — the caller still owns exactly the one group.
    const groups = await repos.groupChats.listForUser(callerId);
    expect(groups.map((g) => g.name)).toEqual(["First Upgrade"]);
  });

  it("deleting the DM cascades its dm_calls rows", async () => {
    const { dmId, callerId, calleeId } = await freshDm();
    const call = await repos.calls.create({ dmId, callerId, calleeId, media: "audio" });
    expect(await repos.calls.findById(call.id)).not.toBeNull();

    await client.sql`DELETE FROM friend_groups WHERE id = ${dmId}`;
    expect(await repos.calls.findById(call.id)).toBeNull();
  });
});
