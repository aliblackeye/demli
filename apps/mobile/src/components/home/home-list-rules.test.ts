import { describe, expect, it } from "vitest";
import { channelRowBadge, dmListStates, uncategorizedTextSection } from "./home-list-rules";

const ok = { dmsPending: false, dmsFailed: false, groupsPending: false, groupsFailed: false };

describe("DM list states", () => {
  it("keeps the skeleton while DMs load even when group chats already arrived empty", () => {
    // The audit case: group chats resolve [] first — must NOT read as "no direct messages".
    const s = dmListStates({ ...ok, dmsPending: true, rowCount: 0 });
    expect(s.skeleton).toBe(true);
    expect(s.band).toBeNull();
  });

  it("keeps the skeleton while DMs load even when group chats already have rows", () => {
    expect(dmListStates({ ...ok, dmsPending: true, rowCount: 3 }).skeleton).toBe(true);
  });

  it("waits for group chats too when there is nothing at all to show yet", () => {
    expect(dmListStates({ ...ok, groupsPending: true, rowCount: 0 }).skeleton).toBe(true);
  });

  it("shows the welcoming empty state only when both lists loaded and are empty", () => {
    expect(dmListStates({ ...ok, rowCount: 0 })).toEqual({ skeleton: false, empty: "empty", band: null });
  });

  it("says the DM load failed even though group chats filled the list", () => {
    expect(dmListStates({ ...ok, dmsFailed: true, rowCount: 2 }).band).toBe("dms");
  });

  it("says the group-chat load failed (it was never read before)", () => {
    expect(dmListStates({ ...ok, groupsFailed: true, rowCount: 4 }).band).toBe("groups");
    // And with nothing on screen it is an error, never "no direct messages".
    expect(dmListStates({ ...ok, groupsFailed: true, rowCount: 0 }).empty).toBe("error");
  });

  it("names both when both failed over cached rows", () => {
    expect(dmListStates({ ...ok, dmsFailed: true, groupsFailed: true, rowCount: 5 }).band).toBe("both");
  });

  it("uses the full error state, not a band, when nothing could be shown", () => {
    const s = dmListStates({ ...ok, dmsFailed: true, rowCount: 0 });
    expect(s).toEqual({ skeleton: false, empty: "error", band: null });
  });
});

describe("uncategorized text section", () => {
  it("lists the uncategorized text channels when there are any", () => {
    expect(uncategorizedTextSection(2, [{ kind: "text" }, { kind: "text" }])).toBe("list");
  });

  it("omits the section — no false 'no text channels' — when every text channel is in a category", () => {
    expect(uncategorizedTextSection(0, [{ kind: "text" }, { kind: "voice" }])).toBe("omit");
  });

  it("says the server has no text channels only when that is true", () => {
    expect(uncategorizedTextSection(0, [{ kind: "voice" }])).toBe("empty");
    expect(uncategorizedTextSection(0, [])).toBe("empty");
  });
});

describe("channel row unread badge (desktop ChannelItem parity)", () => {
  const base = { unread: true, mention: false, unreadCount: 3, muteMode: null } as const;

  it("is the neutral chip for a plain unread", () => {
    expect(channelRowBadge(base)).toEqual({ text: "3", tone: "neutral" });
  });

  it("is coral only for a mention", () => {
    expect(channelRowBadge({ ...base, mention: true })).toEqual({ text: "3", tone: "accent" });
  });

  it("never shows a '1+' chip for an uncounted unread — the pip says it alone", () => {
    expect(channelRowBadge({ ...base, unreadCount: 0 })).toBeNull();
  });

  it("withholds the count on a mentions-muted channel (it would include the muted messages)", () => {
    expect(channelRowBadge({ ...base, mention: true, muteMode: "mentions" })).toBeNull();
  });

  it("shows nothing for a read channel", () => {
    expect(channelRowBadge({ ...base, unread: false })).toBeNull();
  });

  it("caps like every other badge", () => {
    expect(channelRowBadge({ ...base, unreadCount: 250 })).toEqual({ text: "99+", tone: "neutral" });
  });
});
