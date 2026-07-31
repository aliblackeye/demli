/**
 * Command palette data-layer tests — the mobile mirror of the desktop
 * CommandMenu (M20/W5).
 *
 * These cover the three things a palette can silently get wrong: offering an
 * action the user cannot perform on the current surface, sending a selection to
 * the wrong target, and failing to find a row the user can plainly see.
 */
import { describe, expect, it } from "vitest";
import type { Channel, FriendGroup } from "@demli/types";
import {
  buildPaletteItems,
  filterPaletteItems,
  foldForSearch,
  toPaletteRows,
  type PaletteInput,
  type PaletteItem,
} from "./palette-items";

/** Test `t`: returns the key plus its params so labels stay identifiable. */
const t = (key: string, params?: Record<string, string>): string =>
  params ? `${key}(${Object.values(params).join(",")})` : key;

function server(id: string, name: string): FriendGroup {
  return {
    id,
    name,
    iconUrl: null,
    ownerId: "u1",
    kind: "server",
    createdAt: "2026-01-01T00:00:00.000Z",
  } as FriendGroup;
}

function channel(
  id: string,
  name: string,
  kind: "text" | "voice",
  position: number,
  groupId = "g1",
): Channel {
  return { id, groupId, kind, name, position } as Channel;
}

const CHANNELS: Channel[] = [
  channel("c-voice", "lobi", "voice", 2),
  channel("c-general", "genel", "text", 0),
  channel("c-games", "oyunlar", "text", 1),
];

const SERVERS = [server("g1", "Demli"), server("g2", "Kanka Kulübü")];

function input(overrides: Partial<PaletteInput> = {}): PaletteInput {
  return {
    t,
    selectedServerId: "g1",
    selectedServerName: "Demli",
    servers: SERVERS,
    channels: CHANNELS,
    lastChannelId: null,
    voiceActive: false,
    micEnabled: true,
    deafened: false,
    ...overrides,
  };
}

const ids = (items: readonly PaletteItem[]): string[] => items.map((i) => i.id);

describe("buildPaletteItems — server surface", () => {
  it("lists the selected server's text and voice channels in position order", () => {
    const items = buildPaletteItems(input());
    const text = items.filter((i) => i.section === "textChannels");
    const voice = items.filter((i) => i.section === "voiceChannels");

    expect(ids(text)).toEqual(["text:c-general", "text:c-games"]);
    expect(ids(voice)).toEqual(["voice:c-voice"]);
    expect(text[0]?.action).toEqual({
      kind: "openTextChannel",
      channelId: "c-general",
      groupId: "g1",
      name: "genel",
    });
    expect(voice[0]?.action).toEqual({
      kind: "joinVoiceChannel",
      channelId: "c-voice",
      groupId: "g1",
      name: "lobi",
    });
  });

  it("offers every OTHER server under switchServer, never the selected one", () => {
    const items = buildPaletteItems(input());
    const switches = items.filter((i) => i.section === "switchServer");
    expect(ids(switches)).toEqual(["server:g2"]);
    expect(switches[0]?.action).toEqual({ kind: "switchServer", groupId: "g2" });
  });

  it("targets the last-opened text channel for search, else the first one", () => {
    const withLast = buildPaletteItems(input({ lastChannelId: "c-games" }));
    expect(withLast.find((i) => i.id === "action:search")?.action).toEqual({
      kind: "searchMessages",
      channelId: "c-games",
      name: "oyunlar",
    });

    const withoutLast = buildPaletteItems(input());
    expect(withoutLast.find((i) => i.id === "action:search")?.action).toEqual({
      kind: "searchMessages",
      channelId: "c-general",
      name: "genel",
    });
  });

  it("drops the search action when the server has no text channel to search", () => {
    const items = buildPaletteItems(input({ channels: [channel("c-v", "lobi", "voice", 0)] }));
    expect(ids(items)).not.toContain("action:search");
  });

  it("carries the selected server into the invite action", () => {
    const items = buildPaletteItems(input());
    expect(items.find((i) => i.id === "action:invite")?.action).toEqual({
      kind: "invitePeople",
      groupId: "g1",
      serverName: "Demli",
    });
  });
});

describe("buildPaletteItems — home surface (no server selected)", () => {
  const home = () =>
    buildPaletteItems(input({ selectedServerId: null, selectedServerName: null }));

  it("hides every server-scoped entry, exactly as desktop hides them off the server view", () => {
    const listed = ids(home());
    expect(listed).not.toContain("action:invite");
    expect(listed).not.toContain("action:search");
    expect(home().some((i) => i.section === "textChannels")).toBe(false);
    expect(home().some((i) => i.section === "voiceChannels")).toBe(false);
  });

  it("still offers every server to switch to, and the global actions", () => {
    const listed = ids(home());
    expect(listed).toContain("server:g1");
    expect(listed).toContain("server:g2");
    expect(listed).toEqual(
      expect.arrayContaining([
        "action:create-server",
        "action:join-server",
        "action:voice-settings",
        "action:settings",
      ]),
    );
  });
});

describe("buildPaletteItems — voice actions", () => {
  it("hides mute/deafen with no live session (they would be no-ops)", () => {
    const listed = ids(buildPaletteItems(input({ voiceActive: false })));
    expect(listed).not.toContain("action:mic");
    expect(listed).not.toContain("action:deafen");
  });

  it("labels mute/deafen by current state while a session is live", () => {
    const on = buildPaletteItems(input({ voiceActive: true, micEnabled: true, deafened: false }));
    expect(on.find((i) => i.id === "action:mic")?.label).toBe("mobile:voice.controlMute");
    expect(on.find((i) => i.id === "action:deafen")?.label).toBe("mobile:voice.controlDeafen");

    const off = buildPaletteItems(input({ voiceActive: true, micEnabled: false, deafened: true }));
    expect(off.find((i) => i.id === "action:mic")?.label).toBe("mobile:voice.controlUnmute");
    expect(off.find((i) => i.id === "action:deafen")?.label).toBe("mobile:voice.controlUndeafen");
  });
});

describe("buildPaletteItems — desktop parity", () => {
  it("never emits an action the desktop palette does not have", () => {
    const items = buildPaletteItems(input({ voiceActive: true }));
    const kinds = new Set(items.map((i) => i.action.kind));
    expect([...kinds].sort()).toEqual(
      [
        "createServer",
        "invitePeople",
        "joinServerWithCode",
        "joinVoiceChannel",
        "openSettings",
        "openTextChannel",
        "searchMessages",
        "switchServer",
        "toggleDeafen",
        "toggleMic",
        "voiceSettings",
      ].sort(),
    );
  });
});

describe("filterPaletteItems", () => {
  const items = buildPaletteItems(input({ voiceActive: true }));

  it("returns everything for an empty or whitespace query", () => {
    expect(filterPaletteItems(items, "")).toHaveLength(items.length);
    expect(filterPaletteItems(items, "   ")).toHaveLength(items.length);
  });

  it("matches a channel name case- and diacritic-insensitively", () => {
    expect(ids(filterPaletteItems(items, "GENEL"))).toContain("text:c-general");
    expect(ids(filterPaletteItems(items, "kulubu"))).toContain("server:g2");
    expect(ids(filterPaletteItems(items, "KULÜBÜ"))).toContain("server:g2");
  });

  it("requires every token to match (AND), not just one", () => {
    const both = ids(filterPaletteItems(items, "sunucu kod"));
    expect(both).toEqual(["action:join-server"]);
    expect(ids(filterPaletteItems(items, "genel kod"))).toEqual([]);
  });

  it("finds a row through its hidden cross-language keywords", () => {
    expect(ids(filterPaletteItems(items, "mute"))).toContain("action:mic");
    expect(ids(filterPaletteItems(items, "mikrofon"))).toContain("action:mic");
    expect(ids(filterPaletteItems(items, "ayarlar"))).toContain("action:settings");
  });

  it("returns nothing when the query matches nothing", () => {
    expect(filterPaletteItems(items, "zzzzqq")).toEqual([]);
  });

  it("cannot surface an action that was never built for this surface", () => {
    const homeItems = buildPaletteItems(
      input({ selectedServerId: null, selectedServerName: null }),
    );
    expect(ids(filterPaletteItems(homeItems, "davet"))).not.toContain("action:invite");
  });
});

describe("foldForSearch", () => {
  it("folds Turkish letters onto their ASCII base, both cases", () => {
    expect(foldForSearch("Açık ÇÖĞÜŞİ ıI")).toBe("acik cogusi ii");
  });
});

describe("toPaletteRows", () => {
  it("emits one heading per non-empty section run, in order", () => {
    const rows = toPaletteRows(buildPaletteItems(input()));
    const headers = rows.filter((r) => r.type === "header");
    expect(headers.map((r) => (r.type === "header" ? r.section : ""))).toEqual([
      "textChannels",
      "voiceChannels",
      "switchServer",
      "actions",
    ]);
  });

  it("emits no heading for a section the filter emptied", () => {
    // "oyunlar" hits exactly one text channel; every other section goes empty,
    // so a stray "Voice channels" / "Actions" heading would show up here.
    const filtered = filterPaletteItems(buildPaletteItems(input()), "oyunlar");
    const rows = toPaletteRows(filtered);
    expect(rows.filter((r) => r.type === "header")).toHaveLength(1);
    expect(rows).toHaveLength(2);
  });

  it("produces no rows at all when nothing matched", () => {
    expect(toPaletteRows([])).toEqual([]);
  });
});
