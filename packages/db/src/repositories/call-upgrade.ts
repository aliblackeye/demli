import { eq } from "drizzle-orm";
import type { CallId, ChannelId, Group, UserId } from "@demli/types";
import type { Db } from "../client.js";
import { toGroupChat } from "../mappers.js";
import { channels, dmCalls, friendGroupMembers, friendGroups } from "../schema.js";

export interface UpgradeResult {
  /** The freshly created flat group (its `streamId` is the new text channel). */
  group: Group;
  /** The new voice channel bound to the ongoing call's LiveKit room. */
  voiceChannelId: ChannelId;
}

/**
 * The seamless DM-call → group upgrade (ADR 0012 §6), done in ONE transaction so
 * a partial upgrade can never leave a half-built group or a double-upgraded call.
 *
 * The founder's firmest ask is *uninterrupted* media for the two originals. We
 * deliver it by binding the new group's voice channel to the call's EXISTING
 * LiveKit room (`channels.livekit_room = dm_calls.room_name`): the two originals
 * are already connected to that room, so there is zero reconnect and zero media
 * gap. The third person joins the group voice channel and their token resolves to
 * the same room, landing them in the live call.
 */
export function callUpgradeRepo(db: Db) {
  return {
    /**
     * Atomically: lock + assert the source call is still live, create the group
     * (`kind='group'`), add the owner + member memberships, create the hidden
     * text stream channel and a voice channel bound to the call's room, then flip
     * the call to `upgraded` (linking the group, stamping `endedAt`). Rolls back
     * wholesale on any failure — including a non-live call (guards against a
     * concurrent double-upgrade via the `FOR UPDATE` row lock).
     *
     * `ownerId` is the inviter (becomes `owner`); `memberIds` are the other two
     * participants (the other original + the invitee) added as `member`s.
     * `ownerId` is de-duplicated out of `memberIds` so the three memberships hold
     * even if a caller passes overlapping ids.
     */
    async upgradeDmToGroup(input: {
      callId: CallId;
      name: string;
      ownerId: UserId;
      memberIds: UserId[];
      /** Voice channel display name; defaults to "Voice". */
      voiceChannelName?: string;
    }): Promise<UpgradeResult> {
      return db.transaction(async (tx) => {
        // Lock the source call and assert it is still live. The lock serializes
        // concurrent upgrade attempts; the status check is the double-upgrade
        // guard. `room_name` is what we rebind onto the voice channel.
        const [call] = await tx
          .select({ roomName: dmCalls.roomName, status: dmCalls.status })
          .from(dmCalls)
          .where(eq(dmCalls.id, input.callId))
          .for("update")
          .limit(1);
        if (!call) throw new Error(`dm_call ${input.callId} not found`);
        if (call.status !== "ringing" && call.status !== "active") {
          throw new Error(`dm_call ${input.callId} is not live (status=${call.status})`);
        }

        // 1) The new flat group.
        const [groupRow] = await tx
          .insert(friendGroups)
          .values({ name: input.name, ownerId: input.ownerId, kind: "group" })
          .returning();
        if (!groupRow) throw new Error("insert friend_groups returned no row");

        // 2) Three memberships: the inviter as owner, the rest as members.
        const memberSet = new Set(input.memberIds);
        memberSet.delete(input.ownerId);
        await tx.insert(friendGroupMembers).values([
          { groupId: groupRow.id, userId: input.ownerId, role: "owner" as const },
          ...[...memberSet].map((userId) => ({
            groupId: groupRow.id,
            userId,
            role: "member" as const,
          })),
        ]);

        // 3) The hidden text stream (the group's message pipeline, ADR 0005).
        const [streamRow] = await tx
          .insert(channels)
          .values({ groupId: groupRow.id, kind: "text", name: "stream", position: 0 })
          .returning();
        if (!streamRow) throw new Error("insert stream channel returned no row");

        // 4) The voice channel bound to the ONGOING call's room — the whole point
        //    of the upgrade. The two originals are already in this LiveKit room.
        const [voiceRow] = await tx
          .insert(channels)
          .values({
            groupId: groupRow.id,
            kind: "voice",
            name: input.voiceChannelName ?? "Voice",
            position: 1,
            livekitRoom: call.roomName,
          })
          .returning();
        if (!voiceRow) throw new Error("insert voice channel returned no row");

        // 5) Close the call log: status → upgraded, link the group. Media never
        //    dropped; only the control-plane row transitions.
        await tx
          .update(dmCalls)
          .set({
            status: "upgraded",
            upgradedToGroupId: groupRow.id,
            endedAt: new Date(),
            expiresAt: null,
          })
          .where(eq(dmCalls.id, input.callId));

        return { group: toGroupChat(groupRow, streamRow.id), voiceChannelId: voiceRow.id };
      });
    },
  };
}

export type CallUpgradeRepo = ReturnType<typeof callUpgradeRepo>;
