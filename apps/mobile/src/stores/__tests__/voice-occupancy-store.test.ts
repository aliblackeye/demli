/**
 * Unit tests for the voice-channel occupancy store reducer logic and the shared
 * state-resync focus-pull policy. The store reducer + resync/pull code is
 * identical to the desktop renderer's stores/voice-occupancy-store.ts, so this
 * suite covers the seed/resync/add/remove/dedupe/prune algorithm and the
 * throttled occupancy pull for BOTH platforms.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  NO_OCCUPANTS,
  OCCUPANCY_PULL_THROTTLE_MS,
  createThrottledOccupancyPull,
  useVoiceOccupancyStore,
} from "../voice-occupancy-store";

const store = () => useVoiceOccupancyStore.getState();

describe("voice occupancy store", () => {
  beforeEach(() => store().reset());

  it("seeds occupancy from a snapshot, copying (not aliasing) the payload", () => {
    const payload = [
      { channelId: "voice-1", occupants: [{ userId: "u1", muted: false }] },
      { channelId: "voice-2", occupants: [{ userId: "u2", muted: true }] },
    ];
    store().seed(payload);
    expect(store().byChannel).toEqual({
      "voice-1": [{ userId: "u1", muted: false }],
      "voice-2": [{ userId: "u2", muted: true }],
    });
    // Mutating the source payload must not leak into the store.
    payload[0]!.occupants.push({ userId: "hax", muted: false });
    expect(store().byChannel["voice-1"]).toHaveLength(1);
  });

  it("seed replaces the whole map and drops empty channels", () => {
    store().seed([{ channelId: "voice-1", occupants: [{ userId: "u1", muted: false }] }]);
    store().seed([
      { channelId: "voice-2", occupants: [{ userId: "u2", muted: false }] },
      { channelId: "voice-3", occupants: [] }, // empty → omitted
    ]);
    expect(store().byChannel).toEqual({ "voice-2": [{ userId: "u2", muted: false }] });
  });

  it("resync REPLACES the map and empties channels absent from the snapshot", () => {
    store().seed([
      { channelId: "voice-1", occupants: [{ userId: "u1", muted: false }] },
      { channelId: "voice-2", occupants: [{ userId: "u2", muted: false }] },
    ]);
    // Authoritative snapshot only mentions voice-2 → voice-1 is authoritatively
    // empty and voice-2's occupant set is replaced wholesale.
    store().resync([{ channelId: "voice-2", occupants: [{ userId: "u3", muted: true }] }]);
    expect(store().byChannel).toEqual({ "voice-2": [{ userId: "u3", muted: true }] });
  });

  it("resync stores the optional screenSharing/camera media-plane fields", () => {
    store().resync([
      {
        channelId: "voice-1",
        occupants: [{ userId: "u1", muted: false, screenSharing: true, camera: false }],
      },
    ]);
    expect(store().byChannel["voice-1"]).toEqual([
      { userId: "u1", muted: false, screenSharing: true, camera: false },
    ]);
  });

  it("resync([]) authoritatively clears occupancy (nobody in any visible channel)", () => {
    store().seed([{ channelId: "voice-1", occupants: [{ userId: "u1", muted: false }] }]);
    store().resync([]);
    expect(store().byChannel).toEqual({});
  });

  it("resync copies (not aliases) the snapshot payload", () => {
    const payload = [{ channelId: "voice-1", occupants: [{ userId: "u1", muted: false }] }];
    store().resync(payload);
    payload[0]!.occupants.push({ userId: "hax", muted: false });
    expect(store().byChannel["voice-1"]).toHaveLength(1);
  });

  it("adds an occupant to a fresh channel", () => {
    store().addOccupant("voice-1", "u1", false);
    expect(store().byChannel["voice-1"]).toEqual([{ userId: "u1", muted: false }]);
  });

  it("dedupes a duplicate join (idempotent re-announce) by userId", () => {
    store().addOccupant("voice-1", "u1", false);
    const before = store().byChannel;
    store().addOccupant("voice-1", "u1", false);
    // Same reference back — no churn — and still a single occupant.
    expect(store().byChannel).toBe(before);
    expect(store().byChannel["voice-1"]).toHaveLength(1);
  });

  it("updates muted state for an existing occupant", () => {
    store().addOccupant("voice-1", "u1", false);
    store().addOccupant("voice-1", "u1", true);
    expect(store().byChannel["voice-1"]).toEqual([{ userId: "u1", muted: true }]);
  });

  it("removes an occupant and prunes the channel when it empties", () => {
    store().addOccupant("voice-1", "u1", false);
    store().addOccupant("voice-1", "u2", false);
    store().removeOccupant("voice-1", "u1");
    expect(store().byChannel["voice-1"]).toEqual([{ userId: "u2", muted: false }]);
    store().removeOccupant("voice-1", "u2");
    expect(store().byChannel["voice-1"]).toBeUndefined();
  });

  it("ignores a leave for an unknown channel/user without churn", () => {
    store().addOccupant("voice-1", "u1", false);
    const before = store().byChannel;
    store().removeOccupant("voice-1", "ghost");
    store().removeOccupant("voice-9", "u1");
    expect(store().byChannel).toBe(before);
  });

  it("reset clears everything", () => {
    store().addOccupant("voice-1", "u1", false);
    store().reset();
    expect(store().byChannel).toEqual({});
  });

  it("exposes a stable NO_OCCUPANTS sentinel", () => {
    expect(NO_OCCUPANTS).toHaveLength(0);
    expect(NO_OCCUPANTS).toBe(NO_OCCUPANTS);
  });
});

describe("createThrottledOccupancyPull (state-resync focus pull)", () => {
  beforeEach(() => store().reset());

  it("resyncs the store on a successful pull", async () => {
    const snapshot = {
      channels: [
        { channelId: "voice-1", occupants: [{ userId: "u1", muted: false, screenSharing: true }] },
      ],
    };
    const resync = vi.fn();
    const puller = createThrottledOccupancyPull({
      fetchSnapshot: async () => snapshot,
      resync,
    });

    await puller.pull();
    expect(resync).toHaveBeenCalledWith(snapshot.channels);
  });

  it("throttles: at most one request per window, then fires again once it elapses", async () => {
    let t = 100_000;
    const fetchSnapshot = vi.fn(async () => ({ channels: [] }));
    const puller = createThrottledOccupancyPull({
      fetchSnapshot,
      resync: vi.fn(),
      now: () => t,
    });

    await puller.pull(); // first → fires
    await puller.pull(); // same instant → throttled
    t += OCCUPANCY_PULL_THROTTLE_MS - 1;
    await puller.pull(); // still inside the window → throttled
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    t += 1; // window boundary reached (relative to the first pull)
    await puller.pull(); // elapsed → fires
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });

  it("keeps the current view on a 503 — never resyncs, reports the error", async () => {
    const failure = new Error("VOICE_OCCUPANCY_UNAVAILABLE");
    const fetchSnapshot = vi.fn(async () => {
      throw failure;
    });
    const resync = vi.fn();
    const onError = vi.fn();
    const puller = createThrottledOccupancyPull({ fetchSnapshot, resync, onError });

    await puller.pull();
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(resync).not.toHaveBeenCalled(); // view kept — occupancy never cleared
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("leaves the live store untouched when a focus pull fails (keep-view, real store)", async () => {
    store().seed([{ channelId: "voice-1", occupants: [{ userId: "u1", muted: false }] }]);
    const before = store().byChannel;
    const puller = createThrottledOccupancyPull({
      fetchSnapshot: async () => {
        throw new Error("503");
      },
      resync: (channels) => store().resync(channels),
    });

    await puller.pull();
    // Reference-identical: a failed pull performs zero setState — nothing cleared.
    expect(store().byChannel).toBe(before);
  });

  it("reset() lets the next pull fire immediately despite the throttle", async () => {
    const t = 100_000;
    const fetchSnapshot = vi.fn(async () => ({ channels: [] }));
    const puller = createThrottledOccupancyPull({
      fetchSnapshot,
      resync: vi.fn(),
      now: () => t,
    });

    await puller.pull(); // fires (1)
    await puller.pull(); // throttled
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    puller.reset();
    await puller.pull(); // throttle cleared → fires again (2)
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
  });
});
