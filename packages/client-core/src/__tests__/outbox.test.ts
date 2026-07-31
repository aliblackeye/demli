/**
 * Offline send queue (M17) — model + controller.
 *
 * Covers the three acceptance criteria named in the task: offline→online ORDER,
 * nonce DEDUPE, and the 3-ATTEMPT cap; plus hydration/persistence and the
 * channel-gone edge case.
 *
 * Timers and transport are INJECTED (the `call-controller.test.ts` idiom) rather
 * than faked globally, so every assertion is about the queue's logic and never
 * about real time.
 */

import { describe, expect, it, vi } from "vitest";
import {
  createOutboxController,
  enqueueItem,
  markAttemptFailed,
  markSending,
  nextSendable,
  OUTBOX_MAX_ATTEMPTS,
  pendingCount,
  removeItem,
  requeueInFlight,
  retryItem,
  sanitizeOutboxMap,
  type OutboxItem,
  type OutboxMap,
  type OutboxStorage,
} from "../outbox/index.js";

// --- fixtures ---------------------------------------------------------------

function item(overrides: Partial<OutboxItem> = {}): OutboxItem {
  return {
    nonce: "n1",
    channelId: "c1",
    authorId: "u1",
    content: "hello",
    createdAt: "2026-07-21T10:00:00.000Z",
    status: "queued",
    attempts: 0,
    errorKey: null,
    ...overrides,
  };
}

/** Controllable timer seam: nothing fires until the test says so. */
function fakeTimers() {
  let seq = 0;
  const pending = new Map<number, () => void>();
  return {
    setTimer: vi.fn((cb: () => void) => {
      const handle = ++seq;
      pending.set(handle, cb);
      return handle as unknown as ReturnType<typeof setTimeout>;
    }),
    clearTimer: vi.fn((handle: ReturnType<typeof setTimeout>) => {
      pending.delete(handle as unknown as number);
    }),
    /** Fire every armed timer (persist debounce + ack deadline). */
    fireAll(): void {
      const callbacks = [...pending.values()];
      pending.clear();
      for (const cb of callbacks) cb();
    },
    /** Fire only the most recently armed timer — the ack deadline. */
    fireLast(): void {
      const handles = [...pending.keys()];
      const last = handles[handles.length - 1];
      if (last === undefined) return;
      const cb = pending.get(last)!;
      pending.delete(last);
      cb();
    },
    count(): number {
      return pending.size;
    },
  };
}

function fakeStorage(initial: string | null = null) {
  let value = initial;
  const storage: OutboxStorage = {
    get: async () => value,
    set: async (next) => {
      value = next;
    },
    clear: async () => {
      value = null;
    },
  };
  return {
    storage,
    read: () => value,
    parsed: () => (value === null ? null : (JSON.parse(value) as unknown)),
  };
}

/** Controller wired to a scriptable transport. */
function harness(options: { storage?: OutboxStorage; online?: boolean } = {}) {
  const timers = fakeTimers();
  const sent: OutboxItem[] = [];
  let accept = true;
  const onChannelGone = vi.fn();

  const controller = createOutboxController({
    send: (queued) => {
      if (!accept) return false;
      sent.push(queued);
      return true;
    },
    ...(options.storage ? { storage: options.storage } : {}),
    onChannelGone,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
  });
  if (options.online !== false) controller.setOnline(true);

  return {
    controller,
    timers,
    sent,
    onChannelGone,
    setAccept: (v: boolean) => {
      accept = v;
    },
  };
}

// --- model ------------------------------------------------------------------

describe("outbox model — identity", () => {
  it("returns the same reference when nothing changed", () => {
    const map = enqueueItem({}, item());
    expect(removeItem(map, "c1", "missing")).toBe(map);
    expect(markSending(map, "c1", "missing")).toBe(map);
    expect(retryItem(map, "c1", "n1")).toBe(map); // not failed → no-op
    expect(requeueInFlight(map)).toBe(map); // nothing in flight
  });
});

describe("outbox model — dedupe", () => {
  it("ignores a repeated nonce", () => {
    const first = enqueueItem({}, item({ content: "original" }));
    const second = enqueueItem(first, item({ content: "duplicate" }));

    expect(second).toBe(first);
    expect(second["c1"]).toHaveLength(1);
    expect(second["c1"]?.[0]?.content).toBe("original");
  });

  it("collapses duplicate nonces on hydration", () => {
    const restored = sanitizeOutboxMap({
      c1: [item({ nonce: "dup", content: "first" }), item({ nonce: "dup", content: "second" })],
    });
    expect(restored["c1"]).toHaveLength(1);
    expect(restored["c1"]?.[0]?.content).toBe("first");
  });
});

describe("outbox model — ordering", () => {
  it("drains the globally oldest queued item, across channels", () => {
    let map: OutboxMap = {};
    map = enqueueItem(map, item({ nonce: "b", channelId: "c2", createdAt: "2026-07-21T10:00:01.000Z" }));
    map = enqueueItem(map, item({ nonce: "a", channelId: "c1", createdAt: "2026-07-21T10:00:00.000Z" }));
    map = enqueueItem(map, item({ nonce: "c", channelId: "c1", createdAt: "2026-07-21T10:00:02.000Z" }));

    expect(nextSendable(map)?.nonce).toBe("a");
  });

  it("returns null while an item is in flight (one at a time)", () => {
    let map: OutboxMap = enqueueItem({}, item({ nonce: "a" }));
    map = enqueueItem(map, item({ nonce: "b", createdAt: "2026-07-21T10:00:01.000Z" }));
    map = markSending(map, "c1", "a");

    expect(nextSendable(map)).toBeNull();
  });
});

describe("outbox model — attempt cap", () => {
  it("returns to queued while attempts remain, then fails", () => {
    let map: OutboxMap = enqueueItem({}, item());

    for (let i = 1; i <= OUTBOX_MAX_ATTEMPTS; i += 1) {
      map = markSending(map, "c1", "n1");
      expect(map["c1"]?.[0]?.attempts).toBe(i);
      map = markAttemptFailed(map, "c1", "n1", "timeout");
    }

    expect(map["c1"]?.[0]?.status).toBe("failed");
    expect(map["c1"]?.[0]?.errorKey).toBe("attempts_exhausted");
    expect(nextSendable(map)).toBeNull();
  });

  it("treats channel_gone as terminal regardless of attempts", () => {
    let map: OutboxMap = enqueueItem({}, item());
    map = markSending(map, "c1", "n1");
    map = markAttemptFailed(map, "c1", "n1", "channel_gone");

    expect(map["c1"]?.[0]?.status).toBe("failed");
    expect(map["c1"]?.[0]?.errorKey).toBe("channel_gone");
  });

  it("resets the budget on an explicit user retry", () => {
    let map: OutboxMap = enqueueItem({}, item({ status: "failed", attempts: 3 }));
    map = retryItem(map, "c1", "n1");

    expect(map["c1"]?.[0]).toMatchObject({ status: "queued", attempts: 0, errorKey: null });
  });
});

describe("outbox model — hydration", () => {
  it("drops malformed entries instead of throwing", () => {
    const restored = sanitizeOutboxMap({
      c1: [item(), null, 42, { nonce: "x" }, item({ nonce: "blank", content: "   " })],
      c2: "not-an-array",
    });
    expect(Object.keys(restored)).toEqual(["c1"]);
    expect(restored["c1"]).toHaveLength(1);
  });

  it("re-queues an item persisted mid-flight", () => {
    const restored = sanitizeOutboxMap({ c1: [item({ status: "sending", attempts: 1 })] });
    expect(restored["c1"]?.[0]).toMatchObject({ status: "queued", attempts: 1 });
  });

  it("fails an in-flight item that had already exhausted its attempts", () => {
    const restored = sanitizeOutboxMap({
      c1: [item({ status: "sending", attempts: OUTBOX_MAX_ATTEMPTS })],
    });
    expect(restored["c1"]?.[0]?.status).toBe("failed");
  });

  it("ignores an entry filed under the wrong channel bucket", () => {
    const restored = sanitizeOutboxMap({ c1: [item({ channelId: "c2" })] });
    expect(restored).toEqual({});
  });
});

// --- controller -------------------------------------------------------------

describe("outbox controller — offline then online", () => {
  it("holds messages while offline and sends them in order on reconnect", () => {
    const h = harness({ online: false });

    h.controller.enqueue(item({ nonce: "a", createdAt: "2026-07-21T10:00:00.000Z" }));
    h.controller.enqueue(item({ nonce: "b", createdAt: "2026-07-21T10:00:01.000Z" }));
    h.controller.enqueue(item({ nonce: "c", createdAt: "2026-07-21T10:00:02.000Z" }));
    expect(h.sent).toHaveLength(0);
    expect(pendingCount(h.controller.getState())).toBe(3);

    // Reconnect: exactly one goes out, and only the next follows each ack.
    h.controller.setOnline(true);
    expect(h.sent.map((s) => s.nonce)).toEqual(["a"]);

    h.controller.confirm("c1", "a");
    expect(h.sent.map((s) => s.nonce)).toEqual(["a", "b"]);

    h.controller.confirm("c1", "b");
    h.controller.confirm("c1", "c");
    expect(h.sent.map((s) => s.nonce)).toEqual(["a", "b", "c"]);
    expect(pendingCount(h.controller.getState())).toBe(0);
  });

  it("re-queues an in-flight item when the socket drops", () => {
    const h = harness();
    h.controller.enqueue(item());
    expect(h.sent).toHaveLength(1);

    h.controller.setOnline(false);
    expect(h.controller.getState()["c1"]?.[0]).toMatchObject({ status: "queued", attempts: 1 });

    h.controller.setOnline(true);
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.nonce).toBe("n1");
  });

  it("stops draining when the transport reports it is closed", () => {
    const h = harness();
    h.setAccept(false);
    h.controller.enqueue(item({ nonce: "a" }));
    h.controller.enqueue(item({ nonce: "b", createdAt: "2026-07-21T10:00:01.000Z" }));

    expect(h.sent).toHaveLength(0);
    expect(h.controller.getState()["c1"]?.[0]?.errorKey).toBe("offline");
  });
});

describe("outbox controller — attempts and acks", () => {
  it("retries on ack timeout and gives up after the cap", () => {
    const h = harness();
    h.controller.enqueue(item());

    // Each timeout re-queues and immediately re-drains, so attempts accumulate.
    h.timers.fireLast();
    h.timers.fireLast();
    h.timers.fireLast();

    expect(h.sent).toHaveLength(OUTBOX_MAX_ATTEMPTS);
    expect(h.controller.getState()["c1"]?.[0]).toMatchObject({
      status: "failed",
      errorKey: "attempts_exhausted",
    });
  });

  it("removes an item once the server confirms it", () => {
    const h = harness();
    h.controller.enqueue(item());
    h.controller.confirm("c1", "n1");

    expect(h.controller.getState()["c1"]).toBeUndefined();
  });

  it("a rejected item stops blocking the queue", () => {
    const h = harness();
    h.controller.enqueue(item({ nonce: "a" }));
    h.controller.enqueue(item({ nonce: "b", createdAt: "2026-07-21T10:00:01.000Z" }));

    h.controller.reject("c1", "a");
    // "a" went back to queued (attempts remain) and is still oldest, so it leads.
    expect(h.sent.map((s) => s.nonce)).toEqual(["a", "a"]);
  });

  it("a user retry re-dispatches a failed item", () => {
    const h = harness();
    h.controller.enqueue(item());
    h.timers.fireLast();
    h.timers.fireLast();
    h.timers.fireLast();
    expect(h.controller.getState()["c1"]?.[0]?.status).toBe("failed");

    h.controller.retry("c1", "n1");
    expect(h.sent).toHaveLength(OUTBOX_MAX_ATTEMPTS + 1);
  });
});

describe("outbox controller — channel gone", () => {
  it("drops the channel's queue and reports what was lost", () => {
    const h = harness();
    h.controller.enqueue(item({ nonce: "a" }));
    h.controller.enqueue(item({ nonce: "b", createdAt: "2026-07-21T10:00:01.000Z" }));

    h.controller.dropChannel("c1");

    expect(h.controller.getState()["c1"]).toBeUndefined();
    expect(h.onChannelGone).toHaveBeenCalledTimes(1);
    const [channelId, dropped] = h.onChannelGone.mock.calls[0]!;
    expect(channelId).toBe("c1");
    expect((dropped as OutboxItem[]).map((d) => d.nonce)).toEqual(["a", "b"]);
  });

  it("keeps draining other channels after one is dropped", () => {
    const h = harness();
    h.controller.enqueue(item({ nonce: "a", channelId: "c1" }));
    h.controller.enqueue(item({ nonce: "b", channelId: "c2", createdAt: "2026-07-21T10:00:01.000Z" }));

    h.controller.dropChannel("c1");
    expect(h.sent.map((s) => s.nonce)).toEqual(["a", "b"]);
  });
});

describe("outbox controller — persistence", () => {
  it("persists the queue and restores it on hydrate", async () => {
    const store = fakeStorage();
    const first = harness({ storage: store.storage, online: false });
    first.controller.enqueue(item({ nonce: "a" }));
    first.controller.enqueue(item({ nonce: "b", createdAt: "2026-07-21T10:00:01.000Z" }));
    first.timers.fireAll(); // flush the debounced write
    await Promise.resolve();

    expect(store.parsed()).not.toBeNull();

    // A fresh process: hydrate, then reconnect and drain in the original order.
    const second = harness({ storage: store.storage, online: false });
    await second.controller.hydrate();
    expect(pendingCount(second.controller.getState())).toBe(2);

    second.controller.setOnline(true);
    second.controller.confirm("c1", "a");
    expect(second.sent.map((s) => s.nonce)).toEqual(["a", "b"]);
  });

  it("starts empty when the persisted blob is corrupt", async () => {
    const store = fakeStorage("{not json");
    const h = harness({ storage: store.storage, online: false });
    await h.controller.hydrate();

    expect(h.controller.getState()).toEqual({});
  });

  it("clear() wipes memory and storage", async () => {
    const store = fakeStorage();
    const h = harness({ storage: store.storage });
    h.controller.enqueue(item());
    h.timers.fireAll();
    await Promise.resolve();

    await h.controller.clear();
    expect(h.controller.getState()).toEqual({});
    expect(store.read()).toBeNull();
  });
});
