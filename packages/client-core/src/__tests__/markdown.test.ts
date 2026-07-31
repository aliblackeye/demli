import { describe, expect, it } from "vitest";
import {
  hasMarkdown,
  parseMessageMarkdown,
  type MarkdownBlock,
  type MarkdownInline,
} from "../markdown.js";

/** The single paragraph's inline children (asserts there's exactly one paragraph). */
function inlineOf(input: string): MarkdownInline[] {
  const blocks = parseMessageMarkdown(input);
  expect(blocks).toHaveLength(1);
  expect(blocks[0]?.type).toBe("paragraph");
  return (blocks[0] as Extract<MarkdownBlock, { type: "paragraph" }>).children;
}

/** Flatten a token tree back to its rendered text (structural nodes ignored). */
function renderText(nodes: MarkdownInline[]): string {
  return nodes
    .map((n) => {
      switch (n.type) {
        case "text":
        case "code":
        case "link":
          return n.value;
        case "mention":
          return `@${n.id}`;
        case "emoji":
          // Plain-text rendering of an emoji is its shortcode — the exact
          // characters the author typed.
          return `:${n.name}:`;
        case "break":
          return "\n";
        default:
          return renderText(n.children);
      }
    })
    .join("");
}

describe("parseMessageMarkdown — plain text", () => {
  it("returns a single text node for plain content", () => {
    expect(inlineOf("just some plain text")).toEqual([
      { type: "text", value: "just some plain text" },
    ]);
  });

  it("returns [] for empty / whitespace-only input", () => {
    expect(parseMessageMarkdown("")).toEqual([]);
    expect(parseMessageMarkdown("   ")).toEqual([]);
    expect(parseMessageMarkdown("\n\n")).toEqual([]);
  });

  it("never loses characters — rendered text round-trips plain content", () => {
    const src = "hello world 123 !@#%^&()";
    expect(renderText(inlineOf(src))).toBe(src);
  });
});

describe("parseMessageMarkdown — inline emphasis", () => {
  it("parses **bold**", () => {
    expect(inlineOf("a **b** c")).toEqual([
      { type: "text", value: "a " },
      { type: "strong", children: [{ type: "text", value: "b" }] },
      { type: "text", value: " c" },
    ]);
  });

  it("parses *italic* and _italic_", () => {
    expect(inlineOf("*x*")).toEqual([
      { type: "em", children: [{ type: "text", value: "x" }] },
    ]);
    expect(inlineOf("_y_")).toEqual([
      { type: "em", children: [{ type: "text", value: "y" }] },
    ]);
  });

  it("parses ~~strikethrough~~", () => {
    expect(inlineOf("~~gone~~")).toEqual([
      { type: "strike", children: [{ type: "text", value: "gone" }] },
    ]);
  });

  it("does NOT italicise underscores inside a word (snake_case)", () => {
    expect(inlineOf("call some_snake_case_var now")).toEqual([
      { type: "text", value: "call some_snake_case_var now" },
    ]);
  });

  it("does NOT emphasise a lone / spaced asterisk (math-like prose)", () => {
    expect(renderText(inlineOf("2 * 3 * 4 = 24"))).toBe("2 * 3 * 4 = 24");
    expect(inlineOf("2 * 3 * 4 = 24").every((n) => n.type === "text")).toBe(true);
  });

  it("nests emphasis inside bold", () => {
    expect(inlineOf("**bold _and italic_**")).toEqual([
      {
        type: "strong",
        children: [
          { type: "text", value: "bold " },
          { type: "em", children: [{ type: "text", value: "and italic" }] },
        ],
      },
    ]);
  });

  it("leaves an unmatched delimiter as literal text", () => {
    expect(renderText(inlineOf("a ** b"))).toBe("a ** b");
    expect(renderText(inlineOf("half ~~ open"))).toBe("half ~~ open");
  });
});

describe("parseMessageMarkdown — inline code", () => {
  it("parses `inline code` with literal content (no nested markdown)", () => {
    expect(inlineOf("run `a * b` please")).toEqual([
      { type: "text", value: "run " },
      { type: "code", value: "a * b" },
      { type: "text", value: " please" },
    ]);
  });

  it("does not treat an empty backtick pair as code", () => {
    expect(renderText(inlineOf("a `` b"))).toBe("a `` b");
  });
});

describe("parseMessageMarkdown — spoiler", () => {
  it("parses ||spoiler|| into a spoiler node", () => {
    expect(inlineOf("psst ||secret||")).toEqual([
      { type: "text", value: "psst " },
      { type: "spoiler", children: [{ type: "text", value: "secret" }] },
    ]);
  });

  it("allows formatting inside a spoiler", () => {
    expect(inlineOf("||**big**||")).toEqual([
      {
        type: "spoiler",
        children: [{ type: "strong", children: [{ type: "text", value: "big" }] }],
      },
    ]);
  });
});

describe("parseMessageMarkdown — links (autolink + composition)", () => {
  it("auto-links a bare http(s) URL", () => {
    expect(inlineOf("see https://demli.app now")).toEqual([
      { type: "text", value: "see " },
      { type: "link", href: "https://demli.app", value: "https://demli.app" },
      { type: "text", value: " now" },
    ]);
  });

  it("peels trailing sentence punctuation off the URL", () => {
    const nodes = inlineOf("go to https://demli.app.");
    expect(nodes).toEqual([
      { type: "text", value: "go to " },
      { type: "link", href: "https://demli.app", value: "https://demli.app" },
      { type: "text", value: "." },
    ]);
  });

  it("keeps a balanced trailing paren in the URL", () => {
    const nodes = inlineOf("https://en.wikipedia.org/wiki/A_(B)");
    expect(nodes).toEqual([
      {
        type: "link",
        href: "https://en.wikipedia.org/wiki/A_(B)",
        value: "https://en.wikipedia.org/wiki/A_(B)",
      },
    ]);
  });

  it("links a URL nested inside bold (markdown + linkify compose)", () => {
    expect(inlineOf("**https://demli.app**")).toEqual([
      {
        type: "strong",
        children: [
          { type: "link", href: "https://demli.app", value: "https://demli.app" },
        ],
      },
    ]);
  });

  it("does not link a non-http scheme", () => {
    expect(renderText(inlineOf("ftp://x.com and mailto:a@b.c"))).toBe(
      "ftp://x.com and mailto:a@b.c",
    );
    expect(inlineOf("ftp://x.com").some((n) => n.type === "link")).toBe(false);
  });
});

describe("parseMessageMarkdown — mentions (<@id>)", () => {
  it("parses a bare user mention into a mention node", () => {
    expect(inlineOf("hey <@u123> there")).toEqual([
      { type: "text", value: "hey " },
      { type: "mention", id: "u123" },
      { type: "text", value: " there" },
    ]);
  });

  it("parses a uuid-shaped id and the broadcast keywords", () => {
    expect(inlineOf("<@3f2504e0-4f89-41d3-9a0c-0305e82c3301>")).toEqual([
      { type: "mention", id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" },
    ]);
    expect(inlineOf("<@everyone>")).toEqual([{ type: "mention", id: "everyone" }]);
    expect(inlineOf("<@here>")).toEqual([{ type: "mention", id: "here" }]);
  });

  it("composes a mention inside formatting", () => {
    expect(inlineOf("**<@u1>**")).toEqual([
      { type: "strong", children: [{ type: "mention", id: "u1" }] },
    ]);
  });

  it("leaves an invalid <@ run as literal text (never markup)", () => {
    // Space in the target, empty target, and an unclosed run all fall through.
    expect(renderText(inlineOf("look at <@ not a mention"))).toBe("look at <@ not a mention");
    expect(inlineOf("<@>").every((n) => n.type === "text")).toBe(true);
    expect(inlineOf("email like a<@b is fine").some((n) => n.type === "mention")).toBe(false);
  });

  it("does not resolve or store a display name — only the id (§28)", () => {
    const nodes = inlineOf("<@abc-123>");
    expect(nodes).toEqual([{ type: "mention", id: "abc-123" }]);
  });
});

describe("parseMessageMarkdown — blocks", () => {
  it("parses a fenced code block with a language", () => {
    expect(parseMessageMarkdown("```ts\nconst x = 1;\n```")).toEqual([
      { type: "codeBlock", value: "const x = 1;", lang: "ts" },
    ]);
  });

  it("parses a fenced code block without a language and keeps content literal", () => {
    expect(parseMessageMarkdown("```\n**not bold** *nor italic*\n```")).toEqual([
      { type: "codeBlock", value: "**not bold** *nor italic*", lang: null },
    ]);
  });

  it("treats an UNCLOSED fence as plain text (never swallows the message)", () => {
    const blocks = parseMessageMarkdown("```\nno close here");
    expect(blocks.every((b) => b.type === "paragraph")).toBe(true);
    expect(renderText((blocks[0] as { children: MarkdownInline[] }).children)).toBe(
      "```\nno close here",
    );
  });

  it("parses a `>` blockquote and folds consecutive quote lines", () => {
    expect(parseMessageMarkdown("> line one\n> line two")).toEqual([
      {
        type: "blockquote",
        children: [
          { type: "text", value: "line one" },
          { type: "break" },
          { type: "text", value: "line two" },
        ],
      },
    ]);
  });

  it("parses a `>>>` multi-line blockquote to end of message", () => {
    const blocks = parseMessageMarkdown(">>> first\nsecond\nthird");
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.type).toBe("blockquote");
  });

  it("keeps inline formatting inside a blockquote", () => {
    const blocks = parseMessageMarkdown("> hello **world**");
    expect(blocks[0]).toEqual({
      type: "blockquote",
      children: [
        { type: "text", value: "hello " },
        { type: "strong", children: [{ type: "text", value: "world" }] },
      ],
    });
  });

  it("splits a paragraph then a code block into separate blocks", () => {
    const blocks = parseMessageMarkdown("intro line\n```\ncode\n```");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.type).toBe("paragraph");
    expect(blocks[1]).toEqual({ type: "codeBlock", value: "code", lang: null });
  });

  it("represents internal newlines as break nodes within a paragraph", () => {
    const nodes = inlineOf("line a\nline b");
    expect(nodes).toEqual([
      { type: "text", value: "line a" },
      { type: "break" },
      { type: "text", value: "line b" },
    ]);
  });
});

describe("parseMessageMarkdown — safety (CLAUDE.md §28)", () => {
  it("emits HTML/script content as literal TEXT — never markup", () => {
    const src = '<script>alert("xss")</script> & <b>x</b>';
    const nodes = inlineOf(src);
    // Every node is a plain text node; the exact source is preserved verbatim.
    expect(nodes.every((n) => n.type === "text")).toBe(true);
    expect(renderText(nodes)).toBe(src);
  });

  it("only ever produces http(s) hrefs", () => {
    for (const block of parseMessageMarkdown("a https://ok.com b javascript:evil() c")) {
      if (block.type === "codeBlock") continue;
      for (const node of block.children) {
        if (node.type === "link") expect(node.href).toMatch(/^https?:\/\//);
      }
    }
  });

  it("does not hang or overflow on adversarial nested delimiters (depth-bounded)", () => {
    const bomb = "*".repeat(500) + "x" + "*".repeat(500);
    const started = Date.now();
    const nodes = inlineOf(bomb);
    // Completes promptly (no runaway recursion) and the content survives — the
    // depth cap turns excess nesting into literal text rather than looping.
    expect(Date.now() - started).toBeLessThan(1000);
    expect(renderText(nodes)).toContain("x");
  });

  it("preserves all characters for plain text of any length", () => {
    const long = "a normal sentence ".repeat(50);
    expect(renderText(inlineOf(long))).toBe(long);
  });
});

describe("hasMarkdown", () => {
  it("is false for plain text", () => {
    expect(hasMarkdown("hello there friend")).toBe(false);
  });

  it("is true when any supported markup or URL is present", () => {
    for (const s of ["**b**", "_i_", "~~s~~", "`c`", "||sp||", "> q", "http://x.com", "<@u1>"]) {
      expect(hasMarkdown(s)).toBe(true);
    }
  });
});


// --- custom emoji shortcodes (M17) ------------------------------------------

describe("parseMessageMarkdown - custom emoji", () => {
  it("tokenizes a :name: shortcode", () => {
    expect(inlineOf("hey :party: there")).toEqual([
      { type: "text", value: "hey " },
      { type: "emoji", name: "party" },
      { type: "text", value: " there" },
    ]);
  });

  it("lowercases the name so :Cat: and :cat: are one emoji", () => {
    expect(inlineOf(":Cat:")).toEqual([{ type: "emoji", name: "cat" }]);
  });

  it("leaves ordinary prose with colons alone", () => {
    for (const input of ["meet at 10:30", "note: this", ":x:", "a::b"]) {
      expect(inlineOf(input).every((node) => node.type === "text")).toBe(true);
    }
  });

  it("does not format a shortcode inside inline code", () => {
    expect(inlineOf("`:party:`")).toEqual([{ type: "code", value: ":party:" }]);
  });

  it("rejects an over-long name (stays literal text)", () => {
    expect(inlineOf(`:${"a".repeat(33)}:`).every((node) => node.type === "text")).toBe(true);
  });

  it("handles two shortcodes in a row", () => {
    expect(inlineOf(":a1::b2:")).toEqual([
      { type: "emoji", name: "a1" },
      { type: "emoji", name: "b2" },
    ]);
  });
});

describe("hasMarkdown - custom emoji fast path", () => {
  it("returns true for a shortcode-only message", () => {
    expect(hasMarkdown(":party:")).toBe(true);
  });

  it("stays false for prose with a bare colon", () => {
    expect(hasMarkdown("meet at 10:30")).toBe(false);
    expect(hasMarkdown("note: this")).toBe(false);
  });
});
