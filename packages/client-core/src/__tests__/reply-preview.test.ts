/**
 * The reply bar's quoted line. See ../reply-preview.ts for why this exists.
 *
 * These are the cases that produce an empty or MISLEADING bar, not the happy
 * path — a caption-less image is ordinary, and a pasted multi-line quote must
 * not present its first line as though it were the whole message.
 */
import { describe, expect, it } from "vitest";
import {
  PREVIEW_SPOILER,
  messagePlainText,
  messagePreviewText,
  replyPreviewText,
} from "../reply-preview.js";

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

describe("messagePlainText / messagePreviewText", () => {
  const names: Record<string, string> = { "u-ali": "Ali", "u-irem": "İrem" };
  const resolve = (id: string) => names[id] ?? "?";

  it("shows mentions as @Name, never the <@id> wire token", () => {
    expect(messagePlainText("selam <@u-ali>", resolve)).toBe("selam @Ali");
    expect(messagePlainText("<@everyone> toplantı", resolve)).toBe("@everyone toplantı");
    expect(messagePlainText("<@u-irem> ve <@u-ali>", resolve)).not.toContain("<@");
  });

  it("drops markup markers and keeps the words", () => {
    expect(messagePlainText("**kalın** ve _eğik_ ve ~~çizik~~", resolve)).toBe("kalın ve eğik ve çizik");
    expect(messagePlainText("`kod` burada", resolve)).toBe("kod burada");
  });

  it("keeps a spoiler hidden", () => {
    const plain = messagePlainText("sonunda ||ölüyor||", resolve);
    expect(plain).not.toContain("ölüyor");
    expect(plain).toBe(`sonunda ${PREVIEW_SPOILER}`);
  });

  it("keeps a custom emoji as its shortcode and flattens to one line", () => {
    expect(messagePreviewText("hey :parrot:\n\nikinci <@u-ali>", resolve, "[görsel]")).toBe(
      "hey :parrot: ikinci @Ali",
    );
  });

  it("falls back to the empty label for a caption-less attachment", () => {
    expect(messagePreviewText("", resolve, "[görsel]")).toBe("[görsel]");
  });

  it("drops a mention the stored 120-char cut split in half", () => {
    expect(messagePreviewText("bak <@u-ali> ve <@0198f3a", resolve, "[görsel]")).toBe("bak @Ali ve");
  });
});
