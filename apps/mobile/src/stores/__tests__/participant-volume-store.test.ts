/**
 * Deterministic proof of the per-user volume PERSIST ROUND-TRIP (the store is the
 * mobile side of the "User Volume" contract). expo-secure-store is a native module,
 * so we mock it to an inert async backend under the node test env — the persist
 * middleware then runs without a device. We assert the pure clamp/prune behavior the
 * write-through relies on; the untrusted-blob normalize is covered in @demli/media.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

import { DEFAULT_PARTICIPANT_VOLUME } from "@demli/media";
import {
  loadPersistedParticipantVolumes,
  useParticipantVolumes,
} from "../participant-volume-store";

describe("participant-volume-store (mobile persistence)", () => {
  beforeEach(() => {
    useParticipantVolumes.setState({ volumes: {} });
  });

  it("stores a non-default level and exposes it for seeding", () => {
    useParticipantVolumes.getState().setVolume("u1", 0.5);
    expect(useParticipantVolumes.getState().volumes).toEqual({ u1: 0.5 });
    // loadPersistedParticipantVolumes is what seeds the engine.
    expect(loadPersistedParticipantVolumes()).toEqual({ u1: 0.5 });
  });

  it("clamps out-of-range levels into [0,2]", () => {
    useParticipantVolumes.getState().setVolume("hi", 5);
    useParticipantVolumes.getState().setVolume("lo", -3);
    expect(useParticipantVolumes.getState().volumes).toEqual({ hi: 2, lo: 0 });
  });

  it("prunes an entry set back to 100% (never accumulates redundant defaults)", () => {
    useParticipantVolumes.getState().setVolume("u1", 0.4);
    expect(useParticipantVolumes.getState().volumes.u1).toBe(0.4);
    useParticipantVolumes.getState().setVolume("u1", DEFAULT_PARTICIPANT_VOLUME);
    expect(useParticipantVolumes.getState().volumes).toEqual({});
  });

  it("keeps 0 (muted-for-you) as an explicit stored level, distinct from default", () => {
    useParticipantVolumes.getState().setVolume("u2", 0);
    expect(useParticipantVolumes.getState().volumes).toEqual({ u2: 0 });
  });
});
