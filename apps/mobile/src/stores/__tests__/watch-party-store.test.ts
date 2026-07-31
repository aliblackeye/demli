/**
 * The mobile watch-party store is a projection of server frames. These tests pin
 * the three behaviours a phone depends on more than a desktop does:
 * `watch.started` being an UPSERT (the reconnect snapshot after every tunnel),
 * the queue dying with the session, and the refusal never leaking across rooms.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { WatchQueueItem, WatchSessionStatePayload } from "@demli/protocol";
import { useWatchPartyStore } from "../watch-party-store";

const CHANNEL = "channel-1";
const OTHER = "channel-2";

function payload(over: Partial<WatchSessionStatePayload> = {}): WatchSessionStatePayload {
  return {
    channelId: CHANNEL,
    hostId: "user-host",
    source: "youtube",
    videoId: "dQw4w9WgXcQ",
    positionSec: 12,
    playing: true,
    serverTime: new Date().toISOString(),
    ...over,
  } as WatchSessionStatePayload;
}

function queueItem(over: Partial<WatchQueueItem> = {}): WatchQueueItem {
  return {
    itemId: "item-1",
    videoId: "aaaaaaaaaaa",
    title: "First",
    durationSeconds: 120,
    addedBy: "user-1",
    ...over,
  } as WatchQueueItem;
}

beforeEach(() => {
  useWatchPartyStore.getState().reset();
});

describe("upsert", () => {
  it("seats a session from a frame, with the LOCAL arrival time", () => {
    useWatchPartyStore.getState().upsert(payload(), 1_000);
    const session = useWatchPartyStore.getState().sessions[CHANNEL];
    expect(session?.videoId).toBe("dQw4w9WgXcQ");
    expect(session?.positionSec).toBe(12);
    // `receivedAtMs` is what projects the playhead forward across a background
    // gap, so it must be the local reading and not the server's clock.
    expect(session?.receivedAtMs).toBe(1_000);
  });

  it("re-seats an EXISTING session — there is no 'first frame' branch", () => {
    useWatchPartyStore.getState().upsert(payload({ positionSec: 12 }), 1_000);
    useWatchPartyStore.getState().upsert(payload({ positionSec: 300 }), 2_000);
    expect(useWatchPartyStore.getState().sessions[CHANNEL]?.positionSec).toBe(300);
  });

  it("clears a refusal for that room — a live snapshot makes it stale", () => {
    useWatchPartyStore.getState().refuse(CHANNEL, "NOT_HOST");
    useWatchPartyStore.getState().upsert(payload());
    expect(useWatchPartyStore.getState().refusal).toBeNull();
  });

  it("leaves another room's refusal alone", () => {
    useWatchPartyStore.getState().refuse(OTHER, "NOT_HOST");
    useWatchPartyStore.getState().upsert(payload());
    expect(useWatchPartyStore.getState().refusal).toEqual({
      channelId: OTHER,
      code: "NOT_HOST",
    });
  });
});

describe("setHost", () => {
  it("applies a transfer", () => {
    useWatchPartyStore.getState().upsert(payload());
    useWatchPartyStore.getState().setHost(CHANNEL, "user-other");
    expect(useWatchPartyStore.getState().sessions[CHANNEL]?.hostId).toBe("user-other");
  });

  it("ignores a host change for a session we do not hold", () => {
    // Not an error: we may not have received the snapshot yet, and the next
    // heartbeat carries `hostId` anyway.
    expect(() => useWatchPartyStore.getState().setHost(OTHER, "user-other")).not.toThrow();
    expect(useWatchPartyStore.getState().sessions[OTHER]).toBeUndefined();
  });

  it("is a no-op when the host is unchanged, keeping the session reference stable", () => {
    useWatchPartyStore.getState().upsert(payload());
    const before = useWatchPartyStore.getState().sessions[CHANNEL];
    useWatchPartyStore.getState().setHost(CHANNEL, "user-host");
    expect(useWatchPartyStore.getState().sessions[CHANNEL]).toBe(before);
  });
});

describe("setQueue", () => {
  it("replaces the queue wholesale — the server sends the complete list", () => {
    useWatchPartyStore.getState().setQueue(CHANNEL, [queueItem(), queueItem({ itemId: "b" })]);
    useWatchPartyStore.getState().setQueue(CHANNEL, [queueItem({ itemId: "c" })]);
    expect(useWatchPartyStore.getState().queues[CHANNEL]).toHaveLength(1);
  });

  it("remembers the title of the video that is playing RIGHT NOW", () => {
    // An item is removed from the queue the moment it starts playing, so without
    // this carry-forward the one video everybody is looking at is the only one
    // that cannot be named.
    useWatchPartyStore.getState().upsert(payload({ videoId: "aaaaaaaaaaa" }));
    useWatchPartyStore.getState().setQueue(CHANNEL, [queueItem({ videoId: "aaaaaaaaaaa" })]);
    // It starts playing → the server drops it from the queue.
    useWatchPartyStore.getState().setQueue(CHANNEL, []);
    expect(useWatchPartyStore.getState().titles[CHANNEL]?.["aaaaaaaaaaa"]).toBe("First");
  });

  it("lets a still-queued item restate its own title", () => {
    useWatchPartyStore.getState().upsert(payload({ videoId: "aaaaaaaaaaa" }));
    useWatchPartyStore.getState().setQueue(CHANNEL, [queueItem({ videoId: "aaaaaaaaaaa" })]);
    useWatchPartyStore
      .getState()
      .setQueue(CHANNEL, [queueItem({ videoId: "aaaaaaaaaaa", title: "Renamed" })]);
    expect(useWatchPartyStore.getState().titles[CHANNEL]?.["aaaaaaaaaaa"]).toBe("Renamed");
  });

  it("stores no title for an item that has none", () => {
    useWatchPartyStore.getState().setQueue(CHANNEL, [queueItem({ title: null })]);
    expect(useWatchPartyStore.getState().titles[CHANNEL]?.["aaaaaaaaaaa"]).toBeUndefined();
  });
});

describe("stop", () => {
  it("drops the session, the queue and the titles together", () => {
    useWatchPartyStore.getState().upsert(payload());
    useWatchPartyStore.getState().setQueue(CHANNEL, [queueItem()]);
    useWatchPartyStore.getState().stop(CHANNEL, "host_stopped");

    const state = useWatchPartyStore.getState();
    expect(state.sessions[CHANNEL]).toBeUndefined();
    // The queue is server-side state that no longer exists; keeping it would
    // open the next party in this room with the previous one's leftovers.
    expect(state.queues[CHANNEL]).toBeUndefined();
    expect(state.titles[CHANNEL]).toBeUndefined();
  });

  it("clears a refusal for that room", () => {
    useWatchPartyStore.getState().upsert(payload());
    useWatchPartyStore.getState().refuse(CHANNEL, "WATCH_QUEUE_FULL");
    useWatchPartyStore.getState().stop(CHANNEL, "host_stopped");
    expect(useWatchPartyStore.getState().refusal).toBeNull();
  });

  it("is a no-op for a room we hold nothing for", () => {
    const before = useWatchPartyStore.getState();
    useWatchPartyStore.getState().stop(OTHER, "channel_empty");
    expect(useWatchPartyStore.getState().sessions).toBe(before.sessions);
  });

  it("leaves other rooms untouched", () => {
    useWatchPartyStore.getState().upsert(payload());
    useWatchPartyStore.getState().upsert(payload({ channelId: OTHER }));
    useWatchPartyStore.getState().stop(CHANNEL, "host_stopped");
    expect(useWatchPartyStore.getState().sessions[OTHER]).toBeDefined();
  });
});

describe("reset", () => {
  it("drops everything — sign-out and account switch depend on it", () => {
    useWatchPartyStore.getState().upsert(payload());
    useWatchPartyStore.getState().setQueue(CHANNEL, [queueItem()]);
    useWatchPartyStore.getState().refuse(CHANNEL, "NOT_IN_VOICE");
    useWatchPartyStore.getState().reset();

    const state = useWatchPartyStore.getState();
    expect(state.sessions).toEqual({});
    expect(state.queues).toEqual({});
    expect(state.titles).toEqual({});
    expect(state.refusal).toBeNull();
  });
});
