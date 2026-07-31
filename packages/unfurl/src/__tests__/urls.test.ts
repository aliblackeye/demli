import { describe, expect, it } from "vitest";
import { extractUrls } from "../urls.js";

describe("extractUrls", () => {
  it("extracts a single http(s) URL", () => {
    expect(extractUrls("look at https://example.com/page here")).toEqual([
      "https://example.com/page",
    ]);
  });

  it("extracts multiple distinct URLs in first-seen order", () => {
    expect(
      extractUrls("http://a.com and https://b.com then https://c.com/x"),
    ).toEqual(["http://a.com", "https://b.com", "https://c.com/x"]);
  });

  it("de-duplicates the same URL (case-insensitive)", () => {
    expect(extractUrls("https://Example.com/p https://example.com/p")).toEqual([
      "https://Example.com/p",
    ]);
  });

  it("caps at the requested max", () => {
    const many = "https://a.com https://b.com https://c.com https://d.com";
    expect(extractUrls(many, 2)).toEqual(["https://a.com", "https://b.com"]);
  });

  it("defaults the cap to 3", () => {
    const many = "https://a.com https://b.com https://c.com https://d.com";
    expect(extractUrls(many)).toHaveLength(3);
  });

  it("trims trailing sentence punctuation", () => {
    expect(extractUrls("see https://example.com/path.")).toEqual([
      "https://example.com/path",
    ]);
    expect(extractUrls("(https://example.com)")).toEqual(["https://example.com"]);
    expect(extractUrls("link: https://example.com/a, and more")).toEqual([
      "https://example.com/a",
    ]);
  });

  it("keeps a balanced closing paren inside the URL", () => {
    expect(
      extractUrls("https://en.wikipedia.org/wiki/Foo_(disambiguation)"),
    ).toEqual(["https://en.wikipedia.org/wiki/Foo_(disambiguation)"]);
  });

  it("ignores non-http(s) schemes and bare words", () => {
    expect(extractUrls("ftp://x.com file:///etc/passwd just text www.no-scheme.com")).toEqual(
      [],
    );
  });

  it("does not capture angle-bracketed markup boundaries", () => {
    expect(extractUrls("<a href=https://example.com/x>link</a>")).toEqual([
      "https://example.com/x",
    ]);
  });

  it("returns [] for empty / url-less content", () => {
    expect(extractUrls("")).toEqual([]);
    expect(extractUrls("no links here at all")).toEqual([]);
  });

  it("skips an absurdly long URL (defensive cap)", () => {
    const huge = `https://example.com/${"a".repeat(4000)}`;
    expect(extractUrls(`x ${huge} y`)).toEqual([]);
  });
});
