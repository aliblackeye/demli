import type { InfiniteData } from "@tanstack/react-query";
import type { MessagesPage } from "@demli/client-core";
import type { Message, MessageEmbed } from "@demli/types";
import { describe, expect, it } from "vitest";
import { foldMessageEmbeds } from "./embed-fold";

/**
 * The `message.embeds_updated` fold (M17): the async unfurl service publishes the
 * FULL current card set for a message after it was already sent, so the client
 * grafts it onto the cached row. These pin the §27 contract — only the target
 * message rebuilds, every other reference (and the whole cache when nothing
 * changed) is preserved so memoized rows never re-render.
 */

type MessagesCache = InfiniteData<MessagesPage, string | null>;

function makeMessage(id: string, embeds?: MessageEmbed[]): Message {
  return {
    id,
    channelId: "chan-1",
    authorId: "user-1",
    content: "check https://example.com",
    createdAt: "2026-07-19T00:00:00.000Z",
    updatedAt: null,
    deletedAt: null,
    ...(embeds ? { embeds } : {}),
  } as Message;
}

function makeEmbed(url: string, fetchedAt = "2026-07-19T00:00:00.000Z"): MessageEmbed {
  return { url, title: "Title", description: "Desc", imageUrl: null, siteName: "Site", fetchedAt };
}

function makeCache(pages: Message[][]): MessagesCache {
  return {
    pages: pages.map((messages) => ({ messages, nextCursor: null })),
    pageParams: pages.map(() => null),
  };
}

/** Read a message by page/index, asserting it exists (fixtures are fully populated). */
function messageAt(cache: MessagesCache, page: number, index: number): Message {
  const found = cache.pages[page]?.messages[index];
  if (!found) throw new Error(`no message at page ${page} index ${index}`);
  return found;
}

describe("foldMessageEmbeds", () => {
  it("grafts the embed set onto the matching message", () => {
    const embeds = [makeEmbed("https://example.com")];
    const cache = makeCache([[makeMessage("m1"), makeMessage("m2")]]);

    const next = foldMessageEmbeds(cache, "m1", embeds);

    expect(next).toBeDefined();
    // A full replace — the target holds exactly the delivered set.
    expect(messageAt(next!, 0, 0).embeds).toBe(embeds);
  });

  it("rebuilds ONLY the target message; every other reference is preserved (§27)", () => {
    const cache = makeCache([[makeMessage("m1"), makeMessage("m2")]]);
    const untouched = messageAt(cache, 0, 1);

    const next = foldMessageEmbeds(cache, "m1", [makeEmbed("https://example.com")]);

    expect(next).not.toBe(cache); // new cache root
    expect(next!.pages[0]).not.toBe(cache.pages[0]); // new page (its array changed)
    expect(messageAt(next!, 0, 0)).not.toBe(messageAt(cache, 0, 0)); // target rebuilt
    expect(messageAt(next!, 0, 1)).toBe(untouched); // sibling untouched
  });

  it("is a no-op (same cache reference) when the message is not on a loaded page", () => {
    const cache = makeCache([[makeMessage("m1")]]);
    expect(foldMessageEmbeds(cache, "absent", [makeEmbed("https://x.com")])).toBe(cache);
  });

  it("is idempotent: re-applying the same URLs + fetch stamps returns the same cache", () => {
    const embeds = [makeEmbed("https://example.com", "2026-07-19T00:00:00.000Z")];
    const cache = makeCache([[makeMessage("m1", embeds)]]);
    // A distinct array with identical signature must still be recognized as equal.
    const resent = [makeEmbed("https://example.com", "2026-07-19T00:00:00.000Z")];
    expect(foldMessageEmbeds(cache, "m1", resent)).toBe(cache);
  });

  it("re-folds when a re-unfurl changes the fetch stamp", () => {
    const cache = makeCache([[makeMessage("m1", [makeEmbed("https://example.com", "t1")])]]);
    const next = foldMessageEmbeds(cache, "m1", [makeEmbed("https://example.com", "t2")]);
    expect(next).not.toBe(cache);
    expect(messageAt(next!, 0, 0).embeds?.[0]?.fetchedAt).toBe("t2");
  });

  it("finds the message on a later page", () => {
    const cache = makeCache([[makeMessage("m1")], [makeMessage("m2")]]);
    const first = cache.pages[0];
    const next = foldMessageEmbeds(cache, "m2", [makeEmbed("https://example.com")]);
    expect(messageAt(next!, 1, 0).embeds).toHaveLength(1);
    expect(next!.pages[0]).toBe(first); // the unaffected page keeps its reference
  });

  it("returns undefined unchanged when there is no cache", () => {
    expect(foldMessageEmbeds(undefined, "m1", [makeEmbed("https://x.com")])).toBeUndefined();
  });
});
