import type { MessageEmbed } from "@demli/types";
import { describe, expect, it } from "vitest";
import { capEmbeds, displayHost, isHttpUrl, MAX_EMBEDS } from "./link-embed";

/**
 * Pure render-logic for the link-preview cards (M17). The card itself is
 * device-verified, but its safety + capping decisions are pinned here: only
 * http(s) is ever clickable (§28), and a message never shows more than 3 cards.
 */

function makeEmbed(url: string): MessageEmbed {
  return { url, title: null, description: null, imageUrl: null, siteName: null, fetchedAt: "t" };
}

describe("isHttpUrl", () => {
  it("accepts http and https in any case", () => {
    expect(isHttpUrl("http://example.com")).toBe(true);
    expect(isHttpUrl("https://example.com/path?q=1")).toBe(true);
    expect(isHttpUrl("HTTPS://EXAMPLE.COM")).toBe(true);
  });

  it("rejects every non-http(s) scheme and non-URL", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<h1>x</h1>",
      "ftp://host/file",
      "mailto:a@b.com",
      "file:///etc/passwd",
      "example.com",
      "//example.com",
      "",
    ]) {
      expect(isHttpUrl(bad)).toBe(false);
    }
  });
});

describe("displayHost", () => {
  it("strips scheme, path/query, and a leading www.", () => {
    expect(displayHost("https://www.github.com/anthropic/repo?x=1")).toBe("github.com");
    expect(displayHost("http://example.com")).toBe("example.com");
  });

  it("keeps a port and preserves host case", () => {
    expect(displayHost("http://Example.com:8080/x")).toBe("Example.com:8080");
  });

  it("returns the input unchanged when it is not an http(s) URL", () => {
    expect(displayHost("not a url")).toBe("not a url");
  });
});

describe("capEmbeds", () => {
  it("keeps the same reference when already within the cap", () => {
    const list = [makeEmbed("https://a.com"), makeEmbed("https://b.com")];
    expect(capEmbeds(list)).toBe(list);
  });

  it("caps to the first MAX_EMBEDS when there are more", () => {
    const list = Array.from({ length: 5 }, (_, i) => makeEmbed(`https://${i}.com`));
    const capped = capEmbeds(list);
    expect(capped).toHaveLength(MAX_EMBEDS);
    expect(capped.map((e) => e.url)).toEqual(["https://0.com", "https://1.com", "https://2.com"]);
    expect(capped).not.toBe(list);
  });
});
