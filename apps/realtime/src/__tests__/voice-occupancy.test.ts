/**
 * Unit tests for the gateway's LiveKit → occupant mapping (STATE RESYNC). No DB
 * and no live SFU: plain objects cast to the protobuf types exercise the pure
 * `participantsToOccupants`, and a stubbed room service exercises the reader's
 * occupied-only + unavailable-throws contract.
 */

import { describe, expect, it } from "vitest";
import {
  ParticipantInfo_State,
  TrackSource,
  type ParticipantInfo,
  type Room,
  type RoomServiceClient,
} from "livekit-server-sdk";
import type { ChannelId } from "@demli/types";
import {
  createLiveKitVoiceOccupancyReader,
  participantsToOccupants,
  VoiceOccupancyUnavailableError,
} from "../voice-occupancy.js";

function participant(
  identity: string,
  state: ParticipantInfo_State,
  tracks: Array<{ source: TrackSource; muted: boolean }>,
): ParticipantInfo {
  return { identity, state, tracks } as unknown as ParticipantInfo;
}

function room(name: string, numParticipants: number): Room {
  return { name, numParticipants } as unknown as Room;
}

describe("participantsToOccupants", () => {
  it("derives screenSharing/camera/muted from published tracks", () => {
    const occupants = participantsToOccupants([
      participant("sharer", ParticipantInfo_State.ACTIVE, [
        { source: TrackSource.MICROPHONE, muted: false },
        { source: TrackSource.SCREEN_SHARE, muted: false },
      ]),
      participant("watcher", ParticipantInfo_State.ACTIVE, [
        { source: TrackSource.MICROPHONE, muted: true },
        { source: TrackSource.CAMERA, muted: false },
      ]),
    ]);
    expect(occupants).toEqual([
      { userId: "sharer", muted: false, screenSharing: true, camera: false },
      { userId: "watcher", muted: true, screenSharing: false, camera: true },
    ]);
  });

  it("skips DISCONNECTED participants and treats a mic-less participant as muted", () => {
    const occupants = participantsToOccupants([
      participant("gone", ParticipantInfo_State.DISCONNECTED, []),
      participant("silent", ParticipantInfo_State.JOINED, []),
    ]);
    expect(occupants).toEqual([{ userId: "silent", muted: true, screenSharing: false, camera: false }]);
  });
});

describe("createLiveKitVoiceOccupancyReader", () => {
  const CH_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as ChannelId;
  const CH_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" as ChannelId;

  it("returns occupants ONLY for occupied rooms, keyed by channel id", async () => {
    const roomService: Pick<RoomServiceClient, "listRooms" | "listParticipants"> = {
      // CH_A occupied, CH_B lingering-empty (numParticipants 0).
      listRooms: async () => [room(CH_A, 1), room(CH_B, 0)],
      listParticipants: async (name) =>
        name === CH_A
          ? [participant("u1", ParticipantInfo_State.ACTIVE, [{ source: TrackSource.SCREEN_SHARE, muted: false }])]
          : [],
    };
    const reader = createLiveKitVoiceOccupancyReader({ roomService });

    const occ = await reader.read([CH_A, CH_B]);
    expect([...occ.keys()]).toEqual([CH_A]);
    expect(occ.get(CH_A)).toEqual([{ userId: "u1", muted: true, screenSharing: true, camera: false }]);
  });

  it("returns an empty map without querying when there are no visible voice channels", async () => {
    let called = false;
    const roomService: Pick<RoomServiceClient, "listRooms" | "listParticipants"> = {
      listRooms: async () => {
        called = true;
        return [];
      },
      listParticipants: async () => [],
    };
    const occ = await createLiveKitVoiceOccupancyReader({ roomService }).read([]);
    expect(occ.size).toBe(0);
    expect(called).toBe(false);
  });

  it("THROWS VoiceOccupancyUnavailableError when listRooms fails (SFU down)", async () => {
    const roomService: Pick<RoomServiceClient, "listRooms" | "listParticipants"> = {
      listRooms: async () => {
        throw new Error("connect ECONNREFUSED");
      },
      listParticipants: async () => [],
    };
    await expect(
      createLiveKitVoiceOccupancyReader({ roomService }).read([CH_A]),
    ).rejects.toBeInstanceOf(VoiceOccupancyUnavailableError);
  });

  it("is best-effort per room: one room's listParticipants failure skips only that room", async () => {
    const roomService: Pick<RoomServiceClient, "listRooms" | "listParticipants"> = {
      listRooms: async () => [room(CH_A, 1), room(CH_B, 1)],
      listParticipants: async (name) => {
        if (name === CH_A) throw new Error("transient");
        return [participant("u2", ParticipantInfo_State.ACTIVE, [{ source: TrackSource.MICROPHONE, muted: false }])];
      },
    };
    const occ = await createLiveKitVoiceOccupancyReader({ roomService }).read([CH_A, CH_B]);
    expect([...occ.keys()]).toEqual([CH_B]);
  });

  it("reads an upgraded call's channel from the call room it really runs in", async () => {
    const CALL_ROOM = "dmcall:cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const asked: string[][] = [];
    const roomService: Pick<RoomServiceClient, "listRooms" | "listParticipants"> = {
      listRooms: async (names?: string[]) => {
        asked.push(names ?? []);
        return [room(CALL_ROOM, 2)];
      },
      listParticipants: async (name) =>
        name === CALL_ROOM
          ? [
              participant("u1", ParticipantInfo_State.ACTIVE, []),
              participant("u2", ParticipantInfo_State.ACTIVE, []),
            ]
          : [],
    };
    const occ = await createLiveKitVoiceOccupancyReader({ roomService }).read(
      [CH_A, CH_B],
      new Map([[CH_B, CALL_ROOM]]),
    );
    expect(asked).toEqual([[CH_A, CALL_ROOM]]);
    expect([...occ.keys()]).toEqual([CH_B]);
    expect(occ.get(CH_B)?.map((o) => o.userId)).toEqual(["u1", "u2"]);
  });
});
