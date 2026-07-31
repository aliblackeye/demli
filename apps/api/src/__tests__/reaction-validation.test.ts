/**
 * M17 reaction-key validation (unit, no DB). The reaction gate accepts a single
 * unicode emoji OR a `:name:` custom-emoji shortcode; arbitrary text is rejected.
 * This covers the two structural halves in isolation — the unicode test
 * (`isUnicodeEmojiReaction`, API-only, `v`-flag `\p{RGI_Emoji}`) and the shared
 * shortcode parser (`parseCustomEmojiShortcode`, @demli/config). The per-group
 * custom-emoji lookup that authorizes a `:name:` reaction is exercised by the
 * integration suite (message-enrichment.int.test.ts).
 */

import { describe, expect, it } from "vitest";
import { parseCustomEmojiShortcode } from "@demli/config";
import { isUnicodeEmojiReaction } from "../lib/reaction-emoji.js";

describe("isUnicodeEmojiReaction", () => {
  it("accepts a single unicode emoji, including forms outside the quick palette", () => {
    for (const emoji of [
      "👍", // simple
      "❤️", // U+2764 U+FE0F (variation selector)
      "🔥",
      "🦄", // outside the old fixed 8-emoji palette
      "😎",
      "🥳",
      "👍🏽", // skin-tone modifier
      "👨‍👩‍👧", // ZWJ family sequence
      "🇹🇷", // regional-indicator flag
    ]) {
      expect(isUnicodeEmojiReaction(emoji)).toBe(true);
    }
  });

  it("rejects arbitrary text, bare non-emoji code points, and multi-emoji strings", () => {
    for (const bad of [
      "", // empty
      "hello", // plain text
      "5", // a digit has the Emoji property but is not an RGI emoji
      "#", // ditto
      "a",
      "👍👍", // two emoji — a reaction key is exactly one
      "👍x", // emoji plus trailing text
      ":cat:", // a shortcode is NOT a unicode emoji (handled by the parser)
      "<script>", // an injection attempt is just text
    ]) {
      expect(isUnicodeEmojiReaction(bad)).toBe(false);
    }
  });
});

describe("parseCustomEmojiShortcode", () => {
  it("returns the inner name for a well-formed `:name:` shortcode", () => {
    expect(parseCustomEmojiShortcode(":cat:")).toBe("cat");
    expect(parseCustomEmojiShortcode(":party_time:")).toBe("party_time");
    expect(parseCustomEmojiShortcode(":a1_b2:")).toBe("a1_b2");
    // Max-length name (32 chars) is accepted.
    const maxName = "a".repeat(32);
    expect(parseCustomEmojiShortcode(`:${maxName}:`)).toBe(maxName);
  });

  it("returns null for anything that is not a valid shortcode", () => {
    for (const bad of [
      "cat", // no colons
      ":cat", // missing closing colon
      "cat:", // missing opening colon
      "::", // empty name
      ":a:", // 1-char name (min is 2)
      ":Cat:", // uppercase is not in the grammar (names are lowercased)
      ":bad name:", // whitespace not allowed
      ":sad-face:", // hyphen not allowed
      `:${"a".repeat(33)}:`, // over the 32-char cap
      "👍", // a unicode emoji is not a shortcode
      "",
    ]) {
      expect(parseCustomEmojiShortcode(bad)).toBeNull();
    }
  });
});
