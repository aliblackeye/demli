/**
 * The sanitizer + field factories every request schema is built on.
 *
 * The cases that matter are the invisible ones: a name made of zero-width
 * spaces, a bidi override, a CRLF paste. Those are the inputs that pass a naive
 * `min(1)` and then render as nothing.
 *
 * Every invisible character below is written as a `\u` escape ON PURPOSE — a
 * test whose literals cannot be seen cannot be reviewed, and a stray paste would
 * silently change what is being asserted.
 */

import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  hasVisibleCharacter,
  httpUrl,
  isHttpUrl,
  nameText,
  sanitizeText,
  sanitizedText,
} from "../requests/text.js";
import { validationCodeOf } from "../requests/codes.js";

const ZWSP = "\u200B"; // zero-width space
const ZWNJ = "\u200C"; // zero-width NON-joiner — KEPT (Persian/Hindi letter shaping)
const ZWJ = "\u200D"; // zero-width joiner — KEPT (emoji sequences)
const BOM = "\uFEFF";
const SOFT_HYPHEN = "\u00AD";
const WORD_JOINER = "\u2060";
const RTL_OVERRIDE = "\u202E";
const POP_DIRECTIONAL = "\u202C";
const LTR_ISOLATE = "\u2066";
const POP_ISOLATE = "\u2069";

/** The first issue's Demli code, or null. */
function firstCode(result: z.SafeParseReturnType<unknown, unknown>): string | null {
  if (result.success) return null;
  const issue = result.error.issues[0];
  return issue ? validationCodeOf(issue) : null;
}

describe("sanitizeText", () => {
  it("trims surrounding whitespace", () => {
    expect(sanitizeText("  Ali  ")).toBe("Ali");
  });

  it("strips zero-width spaces, BOM, soft hyphen and word joiner", () => {
    expect(sanitizeText(`A${ZWSP}l${BOM}i${SOFT_HYPHEN}${WORD_JOINER}`)).toBe("Ali");
  });

  it("strips bidi overrides and isolates", () => {
    expect(sanitizeText(`${RTL_OVERRIDE}Ali${POP_DIRECTIONAL}`)).toBe("Ali");
    expect(sanitizeText(`${LTR_ISOLATE}Ali${POP_ISOLATE}`)).toBe("Ali");
  });

  it("strips control characters, including tabs and newlines, on a single line", () => {
    expect(sanitizeText("A\tl\ni\r")).toBe("Ali");
  });

  it("KEEPS zero-width joiner so emoji sequences survive", () => {
    // A ZWJ family emoji is three emoji held together by two ZWJ. A blanket
    // \p{Cf} strip would silently explode it into three separate people.
    const family = `\u{1F468}${ZWJ}\u{1F469}${ZWJ}\u{1F467}`;
    expect(sanitizeText(`Ali ${family}`)).toBe(`Ali ${family}`);
  });

  it("KEEPS zero-width non-joiner (Persian/Hindi letter shaping)", () => {
    const persian = `می${ZWNJ}روم`;
    expect(sanitizeText(persian)).toBe(persian);
  });

  it("keeps Turkish characters untouched", () => {
    expect(sanitizeText("Ali Karagöz — Şişli, İstanbul")).toBe(
      "Ali Karagöz — Şişli, İstanbul",
    );
  });

  it("keeps newlines and normalizes CRLF/CR in multiline mode", () => {
    expect(sanitizeText("bir\r\niki\ryedi", { multiline: true })).toBe("bir\niki\nyedi");
  });

  it("still strips zero-width characters in multiline mode", () => {
    expect(sanitizeText(`bir${ZWSP}\niki`, { multiline: true })).toBe("bir\niki");
  });

  it("is idempotent", () => {
    const messy = `  ${ZWSP}Ali${RTL_OVERRIDE}\r\n `;
    expect(sanitizeText(sanitizeText(messy))).toBe(sanitizeText(messy));
  });
});

describe("hasVisibleCharacter", () => {
  it("is false for whitespace and invisible characters", () => {
    expect(hasVisibleCharacter("")).toBe(false);
    expect(hasVisibleCharacter("   ")).toBe(false);
    expect(hasVisibleCharacter(`${ZWSP}${ZWJ}`)).toBe(false);
  });

  it("is true as soon as one real glyph is present", () => {
    expect(hasVisibleCharacter(" a ")).toBe(true);
    expect(hasVisibleCharacter("\u{1F600}")).toBe(true);
  });
});

describe("sanitizedText", () => {
  const bio = sanitizedText({ max: 10, multiline: true });

  it("allows an empty value when min is 0", () => {
    expect(bio.parse("")).toBe("");
  });

  it("measures length AFTER trimming", () => {
    expect(bio.parse("   ten chars   ")).toBe("ten chars");
  });

  it("rejects one character over the max", () => {
    expect(bio.safeParse("abcdefghijk").success).toBe(false);
  });

  it("accepts exactly the max", () => {
    expect(bio.parse("abcdefghij")).toBe("abcdefghij");
  });
});

describe("nameText", () => {
  const name = nameText(8);

  it("accepts a normal name", () => {
    expect(name.parse(" Genel ")).toBe("Genel");
  });

  it("rejects an empty name as required, not as invisible", () => {
    const result = name.safeParse("   ");
    expect(result.success).toBe(false);
    // `min(1)` fires first: an empty field is "required", not "no visible character".
    expect(result.success === false && result.error.issues[0]?.code).toBe("too_small");
  });

  it("rejects a name made only of joiners", () => {
    expect(firstCode(name.safeParse(`${ZWJ}${ZWJ}`))).toBe("noVisibleCharacter");
  });

  it("rejects a name over the max", () => {
    expect(name.safeParse("123456789").success).toBe(false);
  });
});

describe("isHttpUrl", () => {
  it("accepts http and https", () => {
    expect(isHttpUrl("http://example.com/a.png")).toBe(true);
    expect(isHttpUrl("https://cdn.karagozali.com/a.png?x=1")).toBe(true);
  });

  it("rejects the schemes zod's .url() would have accepted", () => {
    // These are the reason this helper exists: `new URL()` parses all of them.
    expect(isHttpUrl("javascript:alert(1)")).toBe(false);
    expect(isHttpUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isHttpUrl("file:///etc/passwd")).toBe(false);
    expect(isHttpUrl("demli://join/abcd")).toBe(false);
  });

  it("rejects a relative path and plain text", () => {
    expect(isHttpUrl("/avatars/1.png")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
  });
});

describe("httpUrl", () => {
  const url = httpUrl(32);

  it("reports invalidUrl for a bad scheme", () => {
    expect(firstCode(url.safeParse("javascript:alert(1)"))).toBe("invalidUrl");
  });

  it("enforces the length cap", () => {
    expect(url.safeParse(`https://example.com/${"a".repeat(64)}`).success).toBe(false);
  });
});
