import { describe, expect, it } from "vitest";
import { parseOpenGraph } from "../parse.js";

const BASE = "https://example.com/article";

describe("parseOpenGraph", () => {
  it("reads the OpenGraph set", () => {
    const html = `
      <html><head>
        <meta property="og:title" content="The Title" />
        <meta property="og:description" content="A short description." />
        <meta property="og:image" content="https://cdn.example.com/img.png" />
        <meta property="og:site_name" content="Example" />
        <title>Ignored fallback</title>
      </head></html>`;
    expect(parseOpenGraph(html, BASE)).toEqual({
      title: "The Title",
      description: "A short description.",
      imageUrl: "https://cdn.example.com/img.png",
      siteName: "Example",
    });
  });

  it("prefers og:* over twitter:* over bare fallbacks", () => {
    const html = `
      <head>
        <meta name="twitter:title" content="Twitter Title" />
        <meta property="og:title" content="OG Title" />
        <title>Tag Title</title>
        <meta name="description" content="meta desc" />
        <meta name="twitter:description" content="twitter desc" />
      </head>`;
    const parsed = parseOpenGraph(html, BASE);
    expect(parsed.title).toBe("OG Title");
    expect(parsed.description).toBe("twitter desc"); // twitter beats bare description
  });

  it("falls back to <title> and <meta name=description>", () => {
    const html = `<head><title>Plain Title</title><meta name="description" content="Plain desc"></head>`;
    const parsed = parseOpenGraph(html, BASE);
    expect(parsed.title).toBe("Plain Title");
    expect(parsed.description).toBe("Plain desc");
    expect(parsed.imageUrl).toBeNull();
    expect(parsed.siteName).toBeNull();
  });

  it("resolves a relative og:image against the final URL", () => {
    const html = `<head><meta property="og:image" content="/media/cover.jpg"></head>`;
    expect(parseOpenGraph(html, "https://news.example.com/story").imageUrl).toBe(
      "https://news.example.com/media/cover.jpg",
    );
  });

  it("rejects a non-http(s) og:image", () => {
    const html = `<head><meta property="og:image" content="javascript:alert(1)"><title>t</title></head>`;
    expect(parseOpenGraph(html, BASE).imageUrl).toBeNull();
  });

  it("decodes HTML entities and collapses whitespace", () => {
    const html = `<head><meta property="og:title" content="A &amp; B  &#39;quote&#39;"></head>`;
    expect(parseOpenGraph(html, BASE).title).toBe("A & B 'quote'");
  });

  it("handles single-quoted and unquoted attributes", () => {
    const html = `<head><meta property='og:title' content='Single'><meta name=og:site_name content=Bare></head>`;
    const parsed = parseOpenGraph(html, BASE);
    expect(parsed.title).toBe("Single");
    expect(parsed.siteName).toBe("Bare");
  });

  it("returns all-null for metadata-less HTML", () => {
    expect(parseOpenGraph("<html><body>no head tags</body></html>", BASE)).toEqual({
      title: null,
      description: null,
      imageUrl: null,
      siteName: null,
    });
  });

  it("caps overly long fields", () => {
    const long = "x".repeat(5000);
    const html = `<head><meta property="og:title" content="${long}"></head>`;
    const title = parseOpenGraph(html, BASE).title ?? "";
    expect(title.length).toBeLessThanOrEqual(300);
  });

  it("uses og:image:secure_url when og:image is absent", () => {
    const html = `<head><meta property="og:image:secure_url" content="https://cdn.example.com/s.png"></head>`;
    expect(parseOpenGraph(html, BASE).imageUrl).toBe("https://cdn.example.com/s.png");
  });
});
