/**
 * The reply bar's quoted line. See ../reply-preview.ts for why this exists.
 *
 * These are the cases that produce an empty or MISLEADING bar, not the happy
 * path — a caption-less image is ordinary, and a pasted multi-line quote must
 * not present its first line as though it were the whole message.
 */
import { describe, expect, it } from "vitest";
import { replyPreviewText } from "../reply-preview.js";

const EMPTY = "Ek dosya";

describe("replyPreviewText", () => {
  it("shows the message text", () => {
    expect(replyPreviewText("bugün geliyor musun", EMPTY)).toBe("bugün geliyor musun");
  });

  it("names the attachment when the message carries no text", () => {
    expect(replyPreviewText("", EMPTY)).toBe(EMPTY);
    expect(replyPreviewText("   ", EMPTY)).toBe(EMPTY);
    expect(replyPreviewText("\n\n", EMPTY)).toBe(EMPTY);
  });

  it("flattens newlines rather than quietly quoting only the first line", () => {
    expect(replyPreviewText("ilk satır\nikinci satır", EMPTY)).toBe("ilk satır ikinci satır");
    expect(replyPreviewText("a\n\n\nb", EMPTY)).toBe("a b");
    expect(replyPreviewText("a\tb", EMPTY)).toBe("a b");
  });

  it("trims so the quote starts at the first word", () => {
    expect(replyPreviewText("  selam  ", EMPTY)).toBe("selam");
  });

  it("does not truncate — CSS knows the real width and draws a real ellipsis", () => {
    expect(replyPreviewText("x".repeat(500), EMPTY)).toHaveLength(500);
  });
});
