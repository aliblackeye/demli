import { describe, expect, it } from "vitest";
import {
  BROADCAST_MENTION_CANDIDATES,
  applyMentionInsert,
  applyMentionPick,
  deserializeMentions,
  detectMentionQuery,
  foldMentionChar,
  foldMentionText,
  rankMentionCandidates,
  serializeMentions,
  type MentionCandidate,
} from "../mentions.js";

const ALI: MentionCandidate = { id: "u-ali", label: "Ali Kara", username: "ali" };
const ALICE: MentionCandidate = { id: "u-alice", label: "Alice", username: "alice" };
const BURAK: MentionCandidate = { id: "u-burak", label: "Burak", username: "burak" };
const ROSTER = [ALI, ALICE, BURAK, ...BROADCAST_MENTION_CANDIDATES];

describe("detectMentionQuery", () => {
  it("detects the @fragment the caret sits in", () => {
    const text = "hey @al";
    expect(detectMentionQuery(text, text.length)).toEqual({ query: "al", start: 4 });
  });

  it("returns null when @ is glued to a word (email)", () => {
    const text = "mail me at ali@host";
    expect(detectMentionQuery(text, text.length)).toBeNull();
  });

  it("returns null once whitespace follows the @ (fragment ended)", () => {
    const text = "@ali done";
    expect(detectMentionQuery(text, text.length)).toBeNull();
  });

  it("detects an empty query right after a lone @", () => {
    expect(detectMentionQuery("@", 1)).toEqual({ query: "", start: 0 });
    expect(detectMentionQuery("go @", 4)).toEqual({ query: "", start: 3 });
  });
});

describe("rankMentionCandidates", () => {
  it("prefixes rank above substrings and broadcast floats up when matched", () => {
    const ranked = rankMentionCandidates("al", ROSTER);
    expect(ranked.map((c) => c.id)).toEqual(["u-ali", "u-alice"]);
  });

  it("lists everyone (broadcast first) for an empty query", () => {
    const ranked = rankMentionCandidates("", ROSTER);
    expect(ranked.slice(0, 2).every((c) => c.broadcast)).toBe(true);
    expect(ranked).toHaveLength(ROSTER.length);
  });

  it("matches @everyone by keyword", () => {
    expect(rankMentionCandidates("every", ROSTER).map((c) => c.id)).toEqual(["everyone"]);
  });

  describe("Turkish I / İ / ı / i", () => {
    const ISMAIL: MentionCandidate = { id: "u-ismail", label: "İsmail" };
    const IRMAK: MentionCandidate = { id: "u-irmak", label: "Irmak" };
    const ISIK: MentionCandidate = { id: "u-isik", label: "Işık" };
    const TR = [ISMAIL, IRMAK, ISIK];
    const ids = (q: string) => rankMentionCandidates(q, TR).map((c) => c.id);

    it("finds İsmail from a lower-case query, letter by letter", () => {
      expect(ids("i")).toContain("u-ismail");
      expect(ids("is")).toContain("u-ismail");
      expect(ids("ism")).toEqual(["u-ismail"]);
      expect(ids("İs")).toContain("u-ismail");
    });

    it("finds Irmak from a dotless ı, and Işık from ış", () => {
      expect(ids("ır")).toEqual(["u-irmak"]);
      expect(ids("Ir")).toEqual(["u-irmak"]);
      expect(ids("ış")).toEqual(["u-isik"]);
      expect(ids("ışı")).toEqual(["u-isik"]);
    });

    it("matches a dotless ı inside a name as a substring", () => {
      expect(ids("şık")).toEqual(["u-isik"]);
      expect(ids("şik")).toEqual(["u-isik"]);
    });
  });
});

describe("foldMentionText", () => {
  it("folds I / İ / ı to i and keeps the length", () => {
    expect(foldMentionText("İsmail")).toBe("ismail");
    expect(foldMentionText("Işık")).toBe("işik");
    expect(foldMentionText("İsmail")).toHaveLength("İsmail".length);
    expect(foldMentionChar("Ş")).toBe("ş");
  });
});

describe("applyMentionPick", () => {
  it("replaces the @fragment with the token + trailing space and reports the caret", () => {
    const text = "hey @al";
    const q = detectMentionQuery(text, text.length)!;
    const res = applyMentionPick(text, q.start, text.length, ALI);
    expect(res.text).toBe("hey @Ali Kara ");
    expect(res.caret).toBe("hey @Ali Kara ".length);
    expect(res.pending).toEqual({ id: "u-ali", token: "@Ali Kara" });
  });
});

describe("serializeMentions", () => {
  it("rewrites picked tokens to <@id> on send", () => {
    const text = "hey @Ali Kara and @everyone";
    const mentions = [
      { id: "u-ali", token: "@Ali Kara" },
      { id: "everyone", token: "@everyone" },
    ];
    expect(serializeMentions(text, mentions)).toBe("hey <@u-ali> and <@everyone>");
  });

  it("handles prefix-colliding names (longest first) and duplicates", () => {
    const text = "@Ali Kara vs @Alice and @Ali Kara again";
    const mentions = [
      { id: "u-ali", token: "@Ali Kara" },
      { id: "u-alice", token: "@Alice" },
      { id: "u-ali", token: "@Ali Kara" },
    ];
    expect(serializeMentions(text, mentions)).toBe(
      "<@u-ali> vs <@u-alice> and <@u-ali> again",
    );
  });

  it("leaves an edited (no-longer-matching) token as literal text", () => {
    const text = "hey @Ali Kar"; // user deleted the trailing 'a'
    expect(serializeMentions(text, [{ id: "u-ali", token: "@Ali Kara" }])).toBe(
      "hey @Ali Kar",
    );
  });
});

describe("deserializeMentions", () => {
  it("turns <@id> content back into @Name and rebuilds the pending list", () => {
    const resolve = (id: string) => (id === "u-ali" ? "Ali Kara" : null);
    const { text, mentions } = deserializeMentions("hi <@u-ali> and <@everyone>", resolve);
    expect(text).toBe("hi @Ali Kara and @everyone");
    expect(mentions).toEqual([
      { id: "u-ali", token: "@Ali Kara" },
      { id: "everyone", token: "@everyone" },
    ]);
  });

  it("round-trips through serialize (edit → save keeps the encoding)", () => {
    const original = "ping <@u-ali> now";
    const { text, mentions } = deserializeMentions(original, () => "Ali Kara");
    expect(serializeMentions(text, mentions)).toBe(original);
  });

  it("falls back to the id when the member is unknown", () => {
    const { text } = deserializeMentions("<@ghost>", () => null);
    expect(text).toBe("@ghost");
  });
});

/**
 * The USER MENU's "Mention" entry (right-click a person → Mention).
 *
 * The founder's report — "bahset deyince chate yazdı fakat otomatik seçmedi
 * kişiyi" — is the failure mode these tests pin down: text that LOOKS like a
 * mention but is sent as plain prose. So every case here ends at the wire form.
 */
describe("applyMentionInsert (menu → composer)", () => {
  /** What the composer does on send. */
  const wire = (r: ReturnType<typeof applyMentionInsert>): string =>
    serializeMentions(r.text, [r.pending]).trim();

  it("mentions for real from an empty composer", () => {
    const r = applyMentionInsert("", 0, { id: "u-ali", label: "Ali Kara" });
    expect(r.text).toBe("@Ali Kara ");
    expect(wire(r)).toBe("<@u-ali>");
  });

  it("inserts AT THE CARET, not at the end", () => {
    const r = applyMentionInsert("selam naber", 6, { id: "u-ali", label: "Ali Kara" });
    expect(r.text).toBe("selam @Ali Kara naber");
    expect(wire(r)).toBe("selam <@u-ali> naber");
  });

  it("leaves the caret just past the inserted token", () => {
    const r = applyMentionInsert("selam ", 6, { id: "u-ali", label: "Ali Kara" });
    expect(r.text.slice(0, r.caret)).toBe("selam @Ali Kara ");
  });

  it("adds the boundary space a caret glued to a word would otherwise eat", () => {
    // Without it the text is `selam@Ali Kara`, which serializeMentions REFUSES
    // to rewrite (an `@` after a word char is an email, not a ping) — the exact
    // way a mention degrades into plain text with nothing visibly wrong.
    const r = applyMentionInsert("selam", 5, { id: "u-ali", label: "Ali Kara" });
    expect(r.text).toBe("selam @Ali Kara ");
    expect(wire(r)).toBe("selam <@u-ali>");
  });

  it("does not double the space when the caret already follows whitespace", () => {
    const r = applyMentionInsert("selam ", 6, { id: "u-ali", label: "Ali Kara" });
    expect(r.text).toBe("selam @Ali Kara ");
  });

  it("treats a newline as a valid boundary", () => {
    const r = applyMentionInsert("selam\n", 6, { id: "u-ali", label: "Ali Kara" });
    expect(r.text).toBe("selam\n@Ali Kara ");
    expect(wire(r)).toBe("selam\n<@u-ali>");
  });

  it("clamps an out-of-range caret instead of corrupting the text", () => {
    const r = applyMentionInsert("hey", 999, { id: "u-ali", label: "Ali Kara" });
    expect(r.text).toBe("hey @Ali Kara ");
    expect(wire(r)).toBe("hey <@u-ali>");
  });

  it("survives the user typing a message around it", () => {
    const r = applyMentionInsert("", 0, { id: "u-ali", label: "Ali Kara" });
    const typed = `${r.text}bugün müsait misin?`;
    expect(serializeMentions(typed, [r.pending]).trim()).toBe("<@u-ali> bugün müsait misin?");
  });

  it("produces the SAME token an autocomplete pick would", () => {
    const picked = applyMentionPick("@ali", 0, 4, ALI);
    const inserted = applyMentionInsert("", 0, { id: ALI.id, label: ALI.label });
    expect(inserted.pending).toEqual(picked.pending);
    expect(inserted.text).toBe(picked.text);
  });

  it("keeps two mentions of similar names apart on the wire", () => {
    const first = applyMentionInsert("", 0, { id: "u-ali", label: "Ali" });
    const second = applyMentionInsert(first.text, first.caret, { id: "u-alix", label: "Alix" });
    expect(serializeMentions(second.text, [first.pending, second.pending]).trim()).toBe(
      "<@u-ali> <@u-alix>",
    );
  });
});
