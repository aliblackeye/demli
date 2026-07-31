import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachmentUrl } from "@demli/protocol";
import { createAttachmentUrlResolver } from "../attachment-url-resolver.js";

const HOUR_MS = 60 * 60 * 1000;

function signed(id: string, expiresInMs = HOUR_MS): AttachmentUrl {
  return {
    attachmentId: id,
    url: `https://store.test/${id}`,
    urlExpiresAt: new Date(Date.now() + expiresInMs).toISOString(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

async function flushBatches(): Promise<void> {
  await vi.advanceTimersByTimeAsync(50);
}

describe("createAttachmentUrlResolver — batching", () => {
  it("coalesces requests inside the batch window into one fetch per channel", async () => {
    const fetchUrls = vi.fn(async (_c: string, ids: string[]) => ids.map((id) => signed(id)));
    const resolver = createAttachmentUrlResolver({ fetchUrls });

    resolver.request("c1", ["a1"]);
    resolver.request("c1", ["a2", "a3"]);
    resolver.request("c1", ["a1"]); // duplicate — deduped
    await flushBatches();

    expect(fetchUrls).toHaveBeenCalledTimes(1);
    expect(fetchUrls.mock.calls[0]![1].sort()).toEqual(["a1", "a2", "a3"]);
    expect(resolver.getSnapshot().get("a2")).toEqual({
      status: "ready",
      url: "https://store.test/a2",
    });
  });

  it("keeps channels in separate batches (the endpoint is channel-scoped)", async () => {
    const fetchUrls = vi.fn(async (_c: string, ids: string[]) => ids.map((id) => signed(id)));
    const resolver = createAttachmentUrlResolver({ fetchUrls });

    resolver.request("c1", ["a1"]);
    resolver.request("c2", ["b1"]);
    await flushBatches();

    expect(fetchUrls).toHaveBeenCalledTimes(2);
    expect(fetchUrls.mock.calls.map((c) => c[0]).sort()).toEqual(["c1", "c2"]);
  });

  it("chunks a request larger than the batch max", async () => {
    const fetchUrls = vi.fn(async (_c: string, ids: string[]) => ids.map((id) => signed(id)));
    const resolver = createAttachmentUrlResolver({ fetchUrls, batchMax: 2 });

    resolver.request("c1", ["a1", "a2", "a3", "a4", "a5"]);
    await flushBatches();

    expect(fetchUrls).toHaveBeenCalledTimes(3);
    for (const call of fetchUrls.mock.calls) {
      expect(call[1].length).toBeLessThanOrEqual(2);
    }
  });

  it("does not refetch a fresh URL", async () => {
    const fetchUrls = vi.fn(async (_c: string, ids: string[]) => ids.map((id) => signed(id)));
    const resolver = createAttachmentUrlResolver({ fetchUrls });

    resolver.request("c1", ["a1"]);
    await flushBatches();
    resolver.request("c1", ["a1"]);
    await flushBatches();

    expect(fetchUrls).toHaveBeenCalledTimes(1);
  });
});

describe("createAttachmentUrlResolver — expiry", () => {
  it("re-requests a URL once its expiry (minus margin) passes", async () => {
    const fetchUrls = vi.fn(async (_c: string, ids: string[]) => ids.map((id) => signed(id)));
    const resolver = createAttachmentUrlResolver({ fetchUrls, expiryMarginMs: 60_000 });

    resolver.request("c1", ["a1"]);
    await flushBatches();
    expect(fetchUrls).toHaveBeenCalledTimes(1);

    // Not yet within the margin — still fresh.
    await vi.advanceTimersByTimeAsync(HOUR_MS - 120_000);
    resolver.request("c1", ["a1"]);
    await flushBatches();
    expect(fetchUrls).toHaveBeenCalledTimes(1);

    // Past expiry-minus-margin — must re-sign.
    await vi.advanceTimersByTimeAsync(120_000);
    resolver.request("c1", ["a1"]);
    await flushBatches();
    expect(fetchUrls).toHaveBeenCalledTimes(2);
  });
});

describe("createAttachmentUrlResolver — errors & retry", () => {
  it("marks ids as error on fetch failure and does NOT auto-refetch them", async () => {
    const fetchUrls = vi.fn(async () => {
      throw new Error("boom");
    });
    const resolver = createAttachmentUrlResolver({ fetchUrls });

    resolver.request("c1", ["a1"]);
    await flushBatches();

    expect(resolver.getSnapshot().get("a1")).toEqual({ status: "error", url: null });
    resolver.request("c1", ["a1"]);
    await flushBatches();
    expect(fetchUrls).toHaveBeenCalledTimes(1); // errored ids wait for retry()
  });

  it("retry() refetches an errored id", async () => {
    let fail = true;
    const fetchUrls = vi.fn(async (_c: string, ids: string[]) => {
      if (fail) throw new Error("boom");
      return ids.map((id) => signed(id));
    });
    const resolver = createAttachmentUrlResolver({ fetchUrls });

    resolver.request("c1", ["a1"]);
    await flushBatches();
    expect(resolver.getSnapshot().get("a1")?.status).toBe("error");

    fail = false;
    resolver.retry("c1", "a1");
    expect(resolver.getSnapshot().get("a1")?.status).toBe("loading");
    await flushBatches();
    expect(resolver.getSnapshot().get("a1")).toEqual({
      status: "ready",
      url: "https://store.test/a1",
    });
  });

  it("marks an id error when the server omits it from the response", async () => {
    const fetchUrls = vi.fn(async () => [signed("a1")]);
    const resolver = createAttachmentUrlResolver({ fetchUrls });

    resolver.request("c1", ["a1", "a2"]);
    await flushBatches();

    expect(resolver.getSnapshot().get("a1")?.status).toBe("ready");
    expect(resolver.getSnapshot().get("a2")?.status).toBe("error");
  });
});

describe("createAttachmentUrlResolver — local URLs", () => {
  it("serves a registered local object URL and never fetches it", async () => {
    const fetchUrls = vi.fn(async (_c: string, ids: string[]) => ids.map((id) => signed(id)));
    const resolver = createAttachmentUrlResolver({ fetchUrls });

    resolver.setLocalUrl("a1", "blob:local-preview");
    resolver.request("c1", ["a1"]);
    await flushBatches();

    expect(fetchUrls).not.toHaveBeenCalled();
    expect(resolver.getSnapshot().get("a1")).toEqual({
      status: "ready",
      url: "blob:local-preview",
    });
  });

  it("notifies subscribers when entries change and keeps snapshots stable otherwise", async () => {
    const fetchUrls = vi.fn(async (_c: string, ids: string[]) => ids.map((id) => signed(id)));
    const resolver = createAttachmentUrlResolver({ fetchUrls });
    const listener = vi.fn();
    resolver.subscribe(listener);

    const before = resolver.getSnapshot();
    expect(resolver.getSnapshot()).toBe(before); // stable reference

    resolver.request("c1", ["a1"]);
    expect(listener).toHaveBeenCalled();
    await flushBatches();
    expect(resolver.getSnapshot()).not.toBe(before);
  });
});
