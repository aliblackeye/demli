/**
 * Collapse and "hide muted" must never take the user off the row they are on.
 *
 * The founder's rule for collapse is literal — "hangi kanal seçili duruyorsa
 * sadece orası gözükmeli" — and the same exemption has to survive the mute
 * toggle, because the two hide rules run at the same time on the same list. The
 * nastiest case is the one no single-feature test would think to write: a user
 * talking in a voice room, reading a different channel, with BOTH toggles on.
 * Two rows must remain.
 */

import { describe, expect, it } from "vitest";
import type { Channel } from "@demli/types";
import {
  hasVisibleChannels,
  isPinnedSidebarChannel,
  visibleSidebarChannels,
  type SidebarVisibilityOptions,
} from "../sidebar-visibility.js";

function ch(id: string, kind: Channel["kind"] = "text", position = 0): Channel {
  return {
    id,
    groupId: "g1",
    kind,
    name: id,
    position,
    createdAt: "2026-01-01T00:00:00.000Z",
    categoryId: null,
  } as Channel;
}

const CHANNELS = [ch("general"), ch("games"), ch("lobby", "voice"), ch("afk", "voice")];

function opts(overrides: Partial<SidebarVisibilityOptions> = {}): SidebarVisibilityOptions {
  return {
    collapsed: false,
    hideMuted: false,
    mutedChannelIds: new Set<string>(),
    pinned: { activeChannelId: null, connectedVoiceChannelId: null },
    ...overrides,
  };
}

const idsOf = (list: readonly Channel[]): string[] => list.map((c) => c.id);

describe("nothing hidden", () => {
  it("returns the SAME array instance when neither rule applies", () => {
    // Identity, not just equality: a fresh array every render would churn the
    // sidebar's memo deps for the overwhelmingly common case (§27).
    expect(visibleSidebarChannels(CHANNELS, opts())).toBe(CHANNELS);
  });

  it("also short-circuits when hideMuted is on but nothing is muted", () => {
    expect(visibleSidebarChannels(CHANNELS, opts({ hideMuted: true }))).toBe(CHANNELS);
  });
});

describe("collapsed sections", () => {
  it("keeps ONLY the selected channel", () => {
    const visible = visibleSidebarChannels(
      CHANNELS,
      opts({ collapsed: true, pinned: { activeChannelId: "games", connectedVoiceChannelId: null } }),
    );
    expect(idsOf(visible)).toEqual(["games"]);
  });

  it("keeps the connected voice room even while the user reads elsewhere", () => {
    // The two "where am I" senses are independent; collapsing must not hide the
    // room your microphone is in just because your eyes are in #general.
    const visible = visibleSidebarChannels(
      CHANNELS,
      opts({
        collapsed: true,
        pinned: { activeChannelId: "general", connectedVoiceChannelId: "lobby" },
      }),
    );
    expect(idsOf(visible)).toEqual(["general", "lobby"]);
  });

  it("closes the section entirely when nothing in it is pinned", () => {
    const options = opts({
      collapsed: true,
      pinned: { activeChannelId: "somewhere-else", connectedVoiceChannelId: null },
    });
    expect(visibleSidebarChannels(CHANNELS, options)).toEqual([]);
    expect(hasVisibleChannels(CHANNELS, options)).toBe(false);
  });

  it("outranks the mute filter — a collapsed section shows the pinned row regardless", () => {
    const visible = visibleSidebarChannels(
      CHANNELS,
      opts({
        collapsed: true,
        hideMuted: true,
        mutedChannelIds: new Set(["games"]),
        pinned: { activeChannelId: "games", connectedVoiceChannelId: null },
      }),
    );
    expect(idsOf(visible)).toEqual(["games"]);
  });
});

describe("hide muted channels", () => {
  it("drops muted rows", () => {
    const visible = visibleSidebarChannels(
      CHANNELS,
      opts({ hideMuted: true, mutedChannelIds: new Set(["games", "afk"]) }),
    );
    expect(idsOf(visible)).toEqual(["general", "lobby"]);
  });

  it("keeps a muted channel the user is currently reading", () => {
    const visible = visibleSidebarChannels(
      CHANNELS,
      opts({
        hideMuted: true,
        mutedChannelIds: new Set(["games"]),
        pinned: { activeChannelId: "games", connectedVoiceChannelId: null },
      }),
    );
    expect(idsOf(visible)).toEqual(["general", "games", "lobby", "afk"]);
  });

  it("keeps a muted voice room the user is connected to", () => {
    const visible = visibleSidebarChannels(
      CHANNELS,
      opts({
        hideMuted: true,
        mutedChannelIds: new Set(["lobby"]),
        pinned: { activeChannelId: "general", connectedVoiceChannelId: "lobby" },
      }),
    );
    expect(idsOf(visible)).toEqual(["general", "games", "lobby", "afk"]);
  });

  it("does nothing while the toggle is off, however many channels are muted", () => {
    expect(
      visibleSidebarChannels(CHANNELS, opts({ mutedChannelIds: new Set(["games", "lobby"]) })),
    ).toBe(CHANNELS);
  });
});

describe("both rules at once", () => {
  it("keeps exactly the two places the user occupies", () => {
    const visible = visibleSidebarChannels(
      CHANNELS,
      opts({
        collapsed: true,
        hideMuted: true,
        mutedChannelIds: new Set(["general", "games", "lobby", "afk"]),
        pinned: { activeChannelId: "general", connectedVoiceChannelId: "lobby" },
      }),
    );
    expect(idsOf(visible)).toEqual(["general", "lobby"]);
  });
});

describe("isPinnedSidebarChannel", () => {
  it("answers for both senses and nothing else", () => {
    const pinned = { activeChannelId: "a", connectedVoiceChannelId: "b" };
    expect(isPinnedSidebarChannel("a", pinned)).toBe(true);
    expect(isPinnedSidebarChannel("b", pinned)).toBe(true);
    expect(isPinnedSidebarChannel("c", pinned)).toBe(false);
  });

  it("never treats a null pin as a match", () => {
    // The bug this guards: `channel.id === null` is false, but a helper that
    // compared the OTHER way round ("is the pin in this list") could match a
    // missing pin against a missing id and keep an arbitrary row alive.
    expect(
      isPinnedSidebarChannel("a", { activeChannelId: null, connectedVoiceChannelId: null }),
    ).toBe(false);
  });
});
