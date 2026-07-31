/**
 * Single-active-voice-session eviction — decision logic + registry side effects.
 * Pure/unit: no Redis, no LiveKit server, no realtime gateway (all faked).
 * Live 2-device behavior is a manual/hardware gate (see the handoff report).
 */

import { describe, expect, it, vi } from "vitest";
import type { RealtimeMutationPublisher, RedisClient } from "@demli/db";
import { SERVER_EVENT } from "@demli/protocol";
import {
  createVoiceSessionRegistry,
  livekitHttpUrl,
  shouldEvictVoiceSession,
  voiceSessionKey,
} from "../modules/media/voice-session.js";

const USER = "user-1";
const ROOM_A = "room-a";
const ROOM_B = "room-b";

describe("shouldEvictVoiceSession (decision)", () => {
  it("does NOT evict when there is no previous session", () => {
    expect(shouldEvictVoiceSession(null, ROOM_A)).toBe(false);
  });

  it("does NOT evict when re-joining the SAME room (reconnect / retry / same-room device)", () => {
    expect(shouldEvictVoiceSession(ROOM_A, ROOM_A)).toBe(false);
  });

  it("EVICTS when joining a DIFFERENT room (cross-room / other device)", () => {
    expect(shouldEvictVoiceSession(ROOM_A, ROOM_B)).toBe(true);
  });
});

describe("livekitHttpUrl", () => {
  it("maps ws:// → http:// and wss:// → https://, leaving http(s) untouched", () => {
    expect(livekitHttpUrl("ws://localhost:7880")).toBe("http://localhost:7880");
    expect(livekitHttpUrl("wss://livekit.example.com")).toBe("https://livekit.example.com");
    expect(livekitHttpUrl("https://livekit.example.com")).toBe("https://livekit.example.com");
  });
});

/** An in-memory ioredis stand-in exposing only get/set (all the registry uses). */
function fakeRedis(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  const set = vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    return "OK";
  });
  const get = vi.fn(async (key: string) => store.get(key) ?? null);
  return { store, get, set, client: { get, set } as unknown as RedisClient };
}

function fakeRoomService() {
  return { removeParticipant: vi.fn(async () => undefined) };
}

function fakeBus() {
  const publish = vi.fn(async () => undefined);
  return { publish } as RealtimeMutationPublisher & { publish: ReturnType<typeof vi.fn> };
}

describe("createVoiceSessionRegistry.recordAndEvict", () => {
  it("records the new room and evicts the previous DIFFERENT session (SFU + event)", async () => {
    const redis = fakeRedis({ [voiceSessionKey(USER)]: ROOM_A });
    const roomService = fakeRoomService();
    const bus = fakeBus();
    const registry = createVoiceSessionRegistry({
      redis: redis.client,
      roomService,
      mutationBus: bus,
      ttlSeconds: 3600,
    });

    await registry.recordAndEvict(USER, ROOM_B);

    // Recorded the new room.
    expect(redis.set).toHaveBeenCalledWith(voiceSessionKey(USER), ROOM_B, "EX", 3600);
    // Force-removed the OLD room's participant (never the new one).
    expect(roomService.removeParticipant).toHaveBeenCalledWith(ROOM_A, USER);
    // Published a typed voice.session_replaced for the OLD room, user-scoped.
    expect(bus.publish).toHaveBeenCalledTimes(1);
    expect(bus.publish).toHaveBeenCalledWith({
      userId: USER,
      event: {
        type: SERVER_EVENT.voiceSessionReplaced,
        payload: { roomId: ROOM_A, reason: "joined_elsewhere" },
      },
    });
  });

  it("does NOT evict when re-joining the same room (no removeParticipant, no event)", async () => {
    const redis = fakeRedis({ [voiceSessionKey(USER)]: ROOM_A });
    const roomService = fakeRoomService();
    const bus = fakeBus();
    const registry = createVoiceSessionRegistry({
      redis: redis.client,
      roomService,
      mutationBus: bus,
      ttlSeconds: 3600,
    });

    await registry.recordAndEvict(USER, ROOM_A);

    expect(redis.set).toHaveBeenCalledWith(voiceSessionKey(USER), ROOM_A, "EX", 3600);
    expect(roomService.removeParticipant).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it("does NOT evict on the first-ever join (no previous session)", async () => {
    const redis = fakeRedis();
    const roomService = fakeRoomService();
    const bus = fakeBus();
    const registry = createVoiceSessionRegistry({
      redis: redis.client,
      roomService,
      mutationBus: bus,
      ttlSeconds: 3600,
    });

    await registry.recordAndEvict(USER, ROOM_A);

    expect(roomService.removeParticipant).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it("still publishes the eviction even when removeParticipant fails (best-effort)", async () => {
    const redis = fakeRedis({ [voiceSessionKey(USER)]: ROOM_A });
    const roomService = fakeRoomService();
    roomService.removeParticipant.mockRejectedValueOnce(new Error("participant not found"));
    const bus = fakeBus();
    const registry = createVoiceSessionRegistry({
      redis: redis.client,
      roomService,
      mutationBus: bus,
      ttlSeconds: 3600,
    });

    await expect(registry.recordAndEvict(USER, ROOM_B)).resolves.toBeUndefined();
    expect(bus.publish).toHaveBeenCalledTimes(1);
  });

  it("never throws when Redis itself fails — the join must always succeed", async () => {
    const redis = fakeRedis();
    redis.get.mockRejectedValueOnce(new Error("redis down"));
    const roomService = fakeRoomService();
    const bus = fakeBus();
    const registry = createVoiceSessionRegistry({
      redis: redis.client,
      roomService,
      mutationBus: bus,
      ttlSeconds: 3600,
    });

    await expect(registry.recordAndEvict(USER, ROOM_B)).resolves.toBeUndefined();
    // Without a record we cannot evict this time (safe — LiveKit handles duplicates).
    expect(roomService.removeParticipant).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });
});
