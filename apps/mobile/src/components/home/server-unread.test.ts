/**
 * Proof that the Home rail's per-server unread badge matches the in-panel channel
 * badge exactly — same mute semantics, aggregated to the server — and that the
 * numeric count (#110) only sums unmuted noise. The helper reaches
 * expo-secure-store transitively (chat-store's mute helper), so we mock it to an
 * inert async backend under the node test env.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

import { muteKey, type MuteEntry } from "../../stores/chat-store";
import { deriveHomeUnreadTotal, deriveServerUnread } from "./server-unread";

const NO_MUTES: Record<string, MuteEntry> = {};
const NO_COUNTS: Record<string, number> = {};

describe("deriveServerUnread", () => {
  let channelsByServer: Record<string, string[]>;
  beforeEach(() => {
    channelsByServer = { s1: ["c1", "c2"], s2: ["c3"] };
  });

  it("lights the badge for a plain unread on an unmuted channel", () => {
    const out = deriveServerUnread(channelsByServer, { c1: true }, {}, { c1: 3 }, NO_MUTES);
    expect(out.s1).toEqual({ unread: true, mention: false, count: 3 });
    expect(out.s2).toEqual({ unread: false, mention: false, count: 0 });
  });

  it("flags a mention (stronger badge) when the unread is an @mention", () => {
    const out = deriveServerUnread(channelsByServer, { c2: true }, { c2: true }, { c2: 1 }, NO_MUTES);
    expect(out.s1).toEqual({ unread: true, mention: true, count: 1 });
  });

  it("sums counts across channels of one server", () => {
    const out = deriveServerUnread(
      channelsByServer,
      { c1: true, c2: true },
      {},
      { c1: 2, c2: 5 },
      NO_MUTES,
    );
    expect(out.s1).toEqual({ unread: true, mention: false, count: 7 });
  });

  it("suppresses the badge entirely for an 'all'-muted channel", () => {
    const mutes = { [muteKey("channel", "c1")]: { mode: "all", until: null } as MuteEntry };
    const out = deriveServerUnread(channelsByServer, { c1: true }, {}, { c1: 9 }, mutes);
    expect(out.s1).toEqual({ unread: false, mention: false, count: 0 });
  });

  it("suppresses when the whole server is 'all'-muted", () => {
    const mutes = { [muteKey("group", "s1")]: { mode: "all", until: null } as MuteEntry };
    const out = deriveServerUnread(channelsByServer, { c1: true, c2: true }, {}, { c1: 4 }, mutes);
    expect(out.s1).toEqual({ unread: false, mention: false, count: 0 });
  });

  it("on a 'mentions'-muted channel, a mention lights the badge but adds NO count (muted noise)", () => {
    const mutes = { [muteKey("channel", "c1")]: { mode: "mentions", until: null } as MuteEntry };
    // plain unread on the mentions-muted channel → no badge
    expect(deriveServerUnread(channelsByServer, { c1: true }, {}, { c1: 5 }, mutes).s1).toEqual({
      unread: false,
      mention: false,
      count: 0,
    });
    // a mention on it → badge + mention, but count stays 0 (falls back to "1+")
    expect(
      deriveServerUnread(channelsByServer, { c1: true }, { c1: true }, { c1: 5 }, mutes).s1,
    ).toEqual({ unread: true, mention: true, count: 0 });
  });

  it("channel mute wins over a looser server mute (most specific)", () => {
    const mutes = {
      [muteKey("group", "s1")]: { mode: "all", until: null } as MuteEntry,
      [muteKey("channel", "c2")]: { mode: "mentions", until: null } as MuteEntry,
    };
    const out = deriveServerUnread(channelsByServer, { c2: true }, { c2: true }, { c2: 8 }, mutes);
    expect(out.s1).toEqual({ unread: true, mention: true, count: 0 });
  });

  it("gives servers with no cached channels an honest empty signal", () => {
    const out = deriveServerUnread({ s3: [] }, { anything: true }, {}, { anything: 3 }, NO_MUTES);
    expect(out.s3).toEqual({ unread: false, mention: false, count: 0 });
  });
});

describe("deriveHomeUnreadTotal", () => {
  const channelsByServer = { s1: ["c1", "c2"] };

  it("sums server counts and non-server (DM) counts", () => {
    const total = deriveHomeUnreadTotal(
      channelsByServer,
      { c1: true, dm1: true },
      {},
      { c1: 4, dm1: 2 },
      NO_MUTES,
    );
    expect(total).toEqual({ count: 6, mention: false, hasUnread: true });
  });

  it("flags a mention from either a server channel or a DM", () => {
    const total = deriveHomeUnreadTotal(
      channelsByServer,
      { dm1: true },
      { dm1: true },
      { dm1: 1 },
      NO_MUTES,
    );
    expect(total.mention).toBe(true);
  });

  it("an 'all'-muted DM never contributes to the total", () => {
    const mutes = { [muteKey("channel", "dm1")]: { mode: "all", until: null } as MuteEntry };
    const total = deriveHomeUnreadTotal(channelsByServer, { dm1: true }, {}, { dm1: 9 }, mutes);
    expect(total).toEqual({ count: 0, mention: false, hasUnread: false });
  });

  it("reports hasUnread with count 0 when a mentions-muted server channel is the only signal", () => {
    const mutes = { [muteKey("channel", "c1")]: { mode: "mentions", until: null } as MuteEntry };
    const total = deriveHomeUnreadTotal(
      channelsByServer,
      { c1: true },
      { c1: true },
      { c1: 5 },
      mutes,
    );
    // Known-unread but uncounted → the badge shows "1+", never a muted-inclusive number.
    expect(total).toEqual({ count: 0, mention: true, hasUnread: true });
  });

  it("is empty when nothing is unread", () => {
    expect(deriveHomeUnreadTotal(channelsByServer, {}, {}, NO_COUNTS, NO_MUTES)).toEqual({
      count: 0,
      mention: false,
      hasUnread: false,
    });
  });
});
