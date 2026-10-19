import { describe, expect, it } from "vitest";
import { messageAffordances, shouldDropDraft } from "./message-affordances";

const own = { isOwn: true, hasText: true, canPin: false, blocked: false };

describe("messageAffordances", () => {
  it("offers reply and edit on your own text message", () => {
    expect(messageAffordances(own)).toEqual({ reply: true, edit: true, copy: true, pin: false, delete: true });
  });

  it("never offers reply or edit in a DM with a peer you blocked", () => {
    const a = messageAffordances({ ...own, blocked: true });
    expect(a.reply).toBe(false);
    expect(a.edit).toBe(false);
    // Reading, copying and removing your own words still work.
    expect(a.copy).toBe(true);
    expect(a.delete).toBe(true);
  });

  it("edit needs text and authorship; delete needs authorship", () => {
    expect(messageAffordances({ ...own, hasText: false }).edit).toBe(false);
    expect(messageAffordances({ ...own, hasText: false }).copy).toBe(false);
    const theirs = messageAffordances({ ...own, isOwn: false });
    expect(theirs.edit).toBe(false);
    expect(theirs.delete).toBe(false);
    expect(theirs.reply).toBe(true);
  });

  it("pin follows the permission", () => {
    expect(messageAffordances({ ...own, canPin: true }).pin).toBe(true);
  });
});

describe("shouldDropDraft", () => {
  it("drops this DM's reply or edit draft once the peer is blocked", () => {
    expect(shouldDropDraft({ channelId: "dm-1" }, "dm-1", true)).toBe(true);
  });
  it("keeps it while not blocked, and never touches another thread's draft", () => {
    expect(shouldDropDraft({ channelId: "dm-1" }, "dm-1", false)).toBe(false);
    expect(shouldDropDraft({ channelId: "ch-9" }, "dm-1", true)).toBe(false);
    expect(shouldDropDraft(null, "dm-1", true)).toBe(false);
  });
});
