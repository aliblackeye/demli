/**
 * Unfurl service orchestration tests (M17). A fake page fetcher, an in-memory
 * embeds repo, and a capturing publisher exercise the full pipeline —
 * extract → fetch → parse → persist → publish — plus the cache, the per-user
 * fetch cap, and the never-throws contract. No network, no DB.
 */

import { describe, expect, it, vi } from "vitest";
import type { RealtimeMutation, RealtimeMutationPublisher } from "@demli/db";
import { SERVER_EVENT } from "@demli/protocol";
import type { MessageEmbed } from "@demli/types";
import type { FetchedPage } from "../fetcher.js";
import { createUnfurlService, type UnfurlServiceDeps } from "../service.js";

function ogHtml(title: string): FetchedPage {
  return {
    finalUrl: "https://example.com/final",
    html: `<head><meta property="og:title" content="${title}"><meta property="og:site_name" content="Example"></head>`,
  };
}

/** In-memory stand-in for the messageEmbeds repo (only what the service uses). */
function fakeRepo() {
  const byMessage = new Map<string, MessageEmbed[]>();
  const replaceForMessage = vi.fn(
    async (messageId: string, embeds: Array<Omit<MessageEmbed, "fetchedAt">>) => {
      const stored = embeds.map((e) => ({ ...e, fetchedAt: new Date().toISOString() }));
      byMessage.set(messageId, stored);
      return stored;
    },
  );
  return {
    byMessage,
    repo: {
      messageEmbeds: {
        replaceForMessage,
        listForMessage: async (id: string) => byMessage.get(id) ?? [],
        listForMessages: async () => new Map(),
        deleteForMessage: async () => 0,
      },
    } as unknown as UnfurlServiceDeps["repos"],
    replaceForMessage,
  };
}

function capturingBus() {
  const published: RealtimeMutation[] = [];
  const bus: RealtimeMutationPublisher = {
    publish: vi.fn(async (m: RealtimeMutation) => {
      published.push(m);
    }),
  };
  return { bus, published };
}

const input = {
  messageId: "m1",
  channelId: "c1",
  authorId: "u1",
};

describe("createUnfurlService", () => {
  it("persists embeds and publishes a channel-scoped message.embeds_updated", async () => {
    const { repo, replaceForMessage } = fakeRepo();
    const { bus, published } = capturingBus();
    const fetchPage = vi.fn(async () => ogHtml("Hello"));

    const service = createUnfurlService({ repos: repo, mutationBus: bus, fetchPage });
    await service.unfurlMessage({ ...input, content: "check https://example.com/a out" });

    expect(fetchPage).toHaveBeenCalledWith("https://example.com/a");
    expect(replaceForMessage).toHaveBeenCalledTimes(1);
    expect(replaceForMessage.mock.calls[0]?.[1]).toEqual([
      {
        url: "https://example.com/a",
        title: "Hello",
        description: null,
        imageUrl: null,
        siteName: "Example",
      },
    ]);

    expect(published).toHaveLength(1);
    const mutation = published[0];
    expect(mutation?.channelId).toBe("c1");
    expect(mutation?.groupId).toBeUndefined();
    expect(mutation?.userId).toBeUndefined();
    expect(mutation?.event.type).toBe(SERVER_EVENT.messageEmbedsUpdated);
    const payload = mutation?.event.payload as {
      channelId: string;
      messageId: string;
      embeds: MessageEmbed[];
    };
    expect(payload.channelId).toBe("c1");
    expect(payload.messageId).toBe("m1");
    expect(payload.embeds[0]).toMatchObject({ url: "https://example.com/a", title: "Hello" });
  });

  it("does nothing for content with no URL", async () => {
    const { repo, replaceForMessage } = fakeRepo();
    const { bus, published } = capturingBus();
    const fetchPage = vi.fn(async () => ogHtml("x"));

    const service = createUnfurlService({ repos: repo, mutationBus: bus, fetchPage });
    await service.unfurlMessage({ ...input, content: "just a plain message" });

    expect(fetchPage).not.toHaveBeenCalled();
    expect(replaceForMessage).not.toHaveBeenCalled();
    expect(published).toHaveLength(0);
  });

  it("stores nothing when the page yields no meaningful card", async () => {
    const { repo, replaceForMessage } = fakeRepo();
    const { bus, published } = capturingBus();
    const fetchPage = vi.fn(async () => ({
      finalUrl: "https://example.com/x",
      html: "<html><body>no meta</body></html>",
    }));

    const service = createUnfurlService({ repos: repo, mutationBus: bus, fetchPage });
    await service.unfurlMessage({ ...input, content: "https://example.com/x" });

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(replaceForMessage).not.toHaveBeenCalled();
    expect(published).toHaveLength(0);
  });

  it("stores nothing when the fetch is blocked/failed (null)", async () => {
    const { repo, replaceForMessage } = fakeRepo();
    const { bus, published } = capturingBus();
    const fetchPage = vi.fn(async () => null);

    const service = createUnfurlService({ repos: repo, mutationBus: bus, fetchPage });
    await service.unfurlMessage({ ...input, content: "https://blocked.example/x" });

    expect(replaceForMessage).not.toHaveBeenCalled();
    expect(published).toHaveLength(0);
  });

  it("caches by URL — a repeated URL is fetched once", async () => {
    const { repo } = fakeRepo();
    const { bus } = capturingBus();
    const fetchPage = vi.fn(async () => ogHtml("Cached"));
    const service = createUnfurlService({ repos: repo, mutationBus: bus, fetchPage });

    await service.unfurlMessage({ ...input, messageId: "m1", content: "https://example.com/same" });
    await service.unfurlMessage({ ...input, messageId: "m2", content: "https://example.com/same" });

    // Second message re-used the cached parse.
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("enforces the per-user fetch cap within the window", async () => {
    const { repo } = fakeRepo();
    const { bus } = capturingBus();
    const fetchPage = vi.fn(async (url: string) => ({
      finalUrl: url,
      html: `<head><meta property="og:title" content="t"></head>`,
    }));
    const service = createUnfurlService({
      repos: repo,
      mutationBus: bus,
      fetchPage,
      perUserFetchesPerMinute: 1,
    });

    await service.unfurlMessage({
      ...input,
      content: "https://a.example/1 https://b.example/2",
    });
    // Only the first URL consumed the single fetch token; the second was skipped.
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledWith("https://a.example/1");
  });

  it("honors the per-message URL cap", async () => {
    const { repo } = fakeRepo();
    const { bus } = capturingBus();
    const fetchPage = vi.fn(async (url: string) => ({
      finalUrl: url,
      html: `<head><meta property="og:title" content="t"></head>`,
    }));
    const service = createUnfurlService({
      repos: repo,
      mutationBus: bus,
      fetchPage,
      maxUrlsPerMessage: 1,
    });

    await service.unfurlMessage({
      ...input,
      content: "https://a.example/1 https://b.example/2 https://c.example/3",
    });
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it("persists even without a mutation bus (no fan-out)", async () => {
    const { repo, replaceForMessage } = fakeRepo();
    const fetchPage = vi.fn(async () => ogHtml("NoBus"));
    const service = createUnfurlService({ repos: repo, fetchPage });

    await service.unfurlMessage({ ...input, content: "https://example.com/a" });
    expect(replaceForMessage).toHaveBeenCalledTimes(1);
  });

  it("never throws when the repo write fails", async () => {
    const { bus, published } = capturingBus();
    const repo = {
      messageEmbeds: {
        replaceForMessage: vi.fn(async () => {
          throw new Error("db down");
        }),
        listForMessage: async () => [],
        listForMessages: async () => new Map(),
        deleteForMessage: async () => 0,
      },
    } as unknown as UnfurlServiceDeps["repos"];
    const service = createUnfurlService({
      repos: repo,
      mutationBus: bus,
      fetchPage: async () => ogHtml("boom"),
    });

    await expect(
      service.unfurlMessage({ ...input, content: "https://example.com/a" }),
    ).resolves.toBeUndefined();
    expect(published).toHaveLength(0);
  });
});
