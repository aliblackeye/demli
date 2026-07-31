/**
 * Watch-party store (M20, ADR 0016) — the projection of the four server frames.
 *
 * Two behaviours here are load-bearing and neither is obvious from the types:
 * `watch.stopped` must actually CLEAR the session (an orphaned player would keep
 * projecting a position nobody will ever refresh), and `watch.started` must be an
 * UPSERT so a reconnect snapshot re-seats a stale client on server truth instead
 * of being mistaken for "a new party just began".
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { WatchQueueItem, WatchSessionStatePayload } from "@demli/protocol";
import type { ChannelId, UserId } from "@demli/types";
import { useWatchPartyStore } from "./watch-party-store";

const CHANNEL = "chan-1" as ChannelId;
const OTHER = "chan-2" as ChannelId;
const HOST = "user-host" as UserId;
const NEXT_HOST = "user-next" as UserId;

function payload(over: Partial<WatchSessionStatePayload> = {}): WatchSessionStatePayload {
  return {
    channelId: CHANNEL,
    hostId: HOST,
    source: "youtube",
    videoId: "dQw4w9WgXcQ",
    positionSec: 12,
    playing: true,
    serverTime: new Date(1_000_000).toISOString(),
    ...over,
  };
}

/** A queued item. `itemId` is the handle every mutation names, never an index. */
function item(
  itemId: string,
  videoId = "dQw4w9WgXcQ",
  title: string | null = "Some video",
): WatchQueueItem {
  return {
    itemId,
    videoId,
    addedBy: HOST,
    addedAt: new Date(1_000_000).toISOString(),
    title,
    durationSeconds: 120,
  };
}

beforeEach(() => {
  useWatchPartyStore.getState().reset();
});

describe("watch-party store", () => {
  it("seats a session from a started/state snapshot", () => {
    useWatchPartyStore.getState().upsert(payload(), 1_000_000);
    const session = useWatchPartyStore.getState().sessions[CHANNEL];
    expect(session).toMatchObject({
      channelId: CHANNEL,
      hostId: HOST,
      videoId: "dQw4w9WgXcQ",
      positionSec: 12,
      playing: true,
      receivedAtMs: 1_000_000,
    });
  });

  it("clears the stage on watch.stopped", () => {
    useWatchPartyStore.getState().upsert(payload(), 1_000_000);
    useWatchPartyStore.getState().stop(CHANNEL, "host_stopped");
    expect(useWatchPartyStore.getState().sessions[CHANNEL]).toBeUndefined();
  });

  it("clears the stage when the room empties, too", () => {
    useWatchPartyStore.getState().upsert(payload(), 1_000_000);
    useWatchPartyStore.getState().stop(CHANNEL, "channel_empty");
    expect(useWatchPartyStore.getState().sessions[CHANNEL]).toBeUndefined();
  });

  it("leaves OTHER channels alone when one session stops", () => {
    useWatchPartyStore.getState().upsert(payload(), 1_000_000);
    useWatchPartyStore.getState().upsert(payload({ channelId: OTHER }), 1_000_000);
    useWatchPartyStore.getState().stop(CHANNEL, "host_stopped");
    expect(useWatchPartyStore.getState().sessions[CHANNEL]).toBeUndefined();
    expect(useWatchPartyStore.getState().sessions[OTHER]).toBeDefined();
  });

  it("re-seats on a reconnect snapshot rather than treating it as a new party", () => {
    // Stale local state: an old video, an old position, and a host who has since
    // handed over. The socket drops; on reconnect the gateway pushes ONE
    // `watch.started` for every visible channel with a live session.
    useWatchPartyStore
      .getState()
      .upsert(payload({ videoId: "aaaaaaaaaaa", positionSec: 5, playing: false }), 1_000_000);

    useWatchPartyStore.getState().upsert(
      payload({
        videoId: "bbbbbbbbbbb",
        hostId: NEXT_HOST,
        positionSec: 930,
        playing: true,
        serverTime: new Date(2_000_000).toISOString(),
      }),
      2_000_000,
    );

    const session = useWatchPartyStore.getState().sessions[CHANNEL];
    expect(session).toMatchObject({
      videoId: "bbbbbbbbbbb",
      hostId: NEXT_HOST,
      positionSec: 930,
      playing: true,
      receivedAtMs: 2_000_000,
    });
    // One key, one session — an upsert, never a second entry.
    expect(Object.keys(useWatchPartyStore.getState().sessions)).toEqual([CHANNEL]);
  });

  it("applies a host change without disturbing playback state", () => {
    useWatchPartyStore.getState().upsert(payload({ positionSec: 300 }), 1_000_000);
    useWatchPartyStore.getState().setHost(CHANNEL, NEXT_HOST);
    const session = useWatchPartyStore.getState().sessions[CHANNEL];
    // A handoff must never nudge anyone's playhead — the server does not touch
    // `positionSec`/`updatedAtMs` either.
    expect(session).toMatchObject({ hostId: NEXT_HOST, positionSec: 300, playing: true });
    expect(session?.receivedAtMs).toBe(1_000_000);
  });

  it("ignores a host change for a session it does not hold", () => {
    useWatchPartyStore.getState().setHost(CHANNEL, NEXT_HOST);
    expect(useWatchPartyStore.getState().sessions[CHANNEL]).toBeUndefined();
  });

  it("keeps a refusal per channel and drops it once the session speaks again", () => {
    useWatchPartyStore.getState().refuse(CHANNEL, "NOT_HOST");
    expect(useWatchPartyStore.getState().refusal).toEqual({
      channelId: CHANNEL,
      code: "NOT_HOST",
    });
    // A refusal about one room must not surface on another room's player.
    useWatchPartyStore.getState().upsert(payload({ channelId: OTHER }), 1_000_000);
    expect(useWatchPartyStore.getState().refusal?.channelId).toBe(CHANNEL);
    // …and a snapshot for its OWN room means it is stale.
    useWatchPartyStore.getState().upsert(payload(), 1_000_000);
    expect(useWatchPartyStore.getState().refusal).toBeNull();
  });

  it("drops everything on reset (sign-out / account switch)", () => {
    useWatchPartyStore.getState().upsert(payload(), 1_000_000);
    useWatchPartyStore.getState().refuse(CHANNEL, "NOT_IN_VOICE");
    useWatchPartyStore.getState().setQueue(CHANNEL, [item("q1")]);
    useWatchPartyStore.getState().reset();
    expect(useWatchPartyStore.getState().sessions).toEqual({});
    expect(useWatchPartyStore.getState().queues).toEqual({});
    expect(useWatchPartyStore.getState().titles).toEqual({});
    expect(useWatchPartyStore.getState().refusal).toBeNull();
  });
});

/**
 * The queue slice (wave 3).
 *
 * `watch.queue_updated` carries the COMPLETE list every time, so the store
 * replaces rather than merges — there is no client-side queue to reconcile
 * against, and a merge would be the one place the client could invent an order
 * the server never agreed to.
 */
describe("watch-party store — queue", () => {
  it("replaces the queue wholesale on every update", () => {
    useWatchPartyStore.getState().setQueue(CHANNEL, [item("q1"), item("q2")]);
    useWatchPartyStore.getState().setQueue(CHANNEL, [item("q3")]);
    const queue = useWatchPartyStore.getState().queues[CHANNEL];
    expect(queue?.map((i) => i.itemId)).toEqual(["q3"]);
  });

  it("accepts an empty queue — a drained queue is not a missing one", () => {
    useWatchPartyStore.getState().setQueue(CHANNEL, [item("q1")]);
    useWatchPartyStore.getState().setQueue(CHANNEL, []);
    expect(useWatchPartyStore.getState().queues[CHANNEL]).toEqual([]);
  });

  it("keeps queues per channel", () => {
    useWatchPartyStore.getState().setQueue(CHANNEL, [item("q1")]);
    useWatchPartyStore.getState().setQueue(OTHER, [item("q2"), item("q3")]);
    expect(useWatchPartyStore.getState().queues[CHANNEL]).toHaveLength(1);
    expect(useWatchPartyStore.getState().queues[OTHER]).toHaveLength(2);
  });

  it("drops the queue when the session stops", () => {
    useWatchPartyStore.getState().upsert(payload(), 1_000_000);
    useWatchPartyStore.getState().setQueue(CHANNEL, [item("q1")]);
    useWatchPartyStore.getState().stop(CHANNEL, "host_stopped");
    // The queue is server state that no longer exists. Keeping it would open the
    // NEXT party in this room with the previous one's leftovers on screen.
    expect(useWatchPartyStore.getState().queues[CHANNEL]).toBeUndefined();
    expect(useWatchPartyStore.getState().titles[CHANNEL]).toBeUndefined();
  });

  it("leaves other rooms' queues alone when one session stops", () => {
    useWatchPartyStore.getState().upsert(payload(), 1_000_000);
    useWatchPartyStore.getState().setQueue(CHANNEL, [item("q1")]);
    useWatchPartyStore.getState().setQueue(OTHER, [item("q2")]);
    useWatchPartyStore.getState().stop(CHANNEL, "channel_empty");
    expect(useWatchPartyStore.getState().queues[OTHER]).toHaveLength(1);
  });

  it("records a WATCH_QUEUE_FULL refusal like any other watch refusal", () => {
    useWatchPartyStore.getState().refuse(CHANNEL, "WATCH_QUEUE_FULL");
    expect(useWatchPartyStore.getState().refusal).toEqual({
      channelId: CHANNEL,
      code: "WATCH_QUEUE_FULL",
    });
  });
});

describe("watch-party store — remembering titles", () => {
  it("learns titles from the queue", () => {
    useWatchPartyStore
      .getState()
      .setQueue(CHANNEL, [item("q1", "aaaaaaaaaaa", "First"), item("q2", "bbbbbbbbbbb", "Second")]);
    expect(useWatchPartyStore.getState().titles[CHANNEL]).toEqual({
      aaaaaaaaaaa: "First",
      bbbbbbbbbbb: "Second",
    });
  });

  it("keeps the PLAYING video's title after it left the queue", () => {
    // This is the whole reason the map exists: an item is removed from the queue
    // the moment it starts playing, so the one video everybody is looking at
    // would otherwise be the only one the panel could not name.
    useWatchPartyStore.getState().upsert(payload({ videoId: "ccccccccccc" }), 1_000_000);
    useWatchPartyStore
      .getState()
      .setQueue(CHANNEL, [item("q1", "ccccccccccc", "Up next"), item("q2", "ddddddddddd", "Later")]);

    // The server advances: "Up next" starts playing and leaves the queue.
    useWatchPartyStore.getState().upsert(payload({ videoId: "ccccccccccc" }), 1_100_000);
    useWatchPartyStore.getState().setQueue(CHANNEL, [item("q2", "ddddddddddd", "Later")]);

    expect(useWatchPartyStore.getState().titles[CHANNEL]?.["ccccccccccc"]).toBe("Up next");
  });

  it("stays bounded — a title for a video that is neither queued nor playing is dropped", () => {
    useWatchPartyStore.getState().upsert(payload({ videoId: "zzzzzzzzzzz" }), 1_000_000);
    useWatchPartyStore.getState().setQueue(CHANNEL, [item("q1", "aaaaaaaaaaa", "Gone soon")]);
    useWatchPartyStore.getState().setQueue(CHANNEL, [item("q2", "bbbbbbbbbbb", "Current")]);
    const titles = useWatchPartyStore.getState().titles[CHANNEL] ?? {};
    expect(titles["aaaaaaaaaaa"]).toBeUndefined();
    expect(titles["bbbbbbbbbbb"]).toBe("Current");
  });

  it("does not record a null title", () => {
    useWatchPartyStore.getState().setQueue(CHANNEL, [item("q1", "aaaaaaaaaaa", null)]);
    expect(useWatchPartyStore.getState().titles[CHANNEL]).toEqual({});
  });
});
