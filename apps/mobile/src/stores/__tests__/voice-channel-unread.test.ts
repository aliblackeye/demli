/**
 * A voice channel's chat counts (M20).
 *
 * Since the backend wave every voice channel carries a real text chat, so its
 * traffic has to move the same unread machinery a text channel's does — and the
 * client gate that used to stop it was subtle: `setActiveChannel` bailed on
 * anything whose kind was not "text", which meant the channel you were READING
 * never became the active one, so every message arriving in front of you was
 * flagged unread. This locks the whole chain: the flag, the count, the mute
 * precedence, and the rail's per-server aggregate.
 *
 * chat-store transitively imports expo-secure-store (the divider watermark
 * persistence), so we mock it to an inert async backend under vitest's node env.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

import type { Channel, ChannelId, GroupId } from "@demli/types";
import { useChatStore } from "../chat-store";
import { deriveServerUnread } from "../../components/home/server-unread";

const LOBBY = "lobby" as ChannelId;
const GENERAL = "general" as ChannelId;
const SERVER = "server-1" as GroupId;

function channel(id: ChannelId, kind: Channel["kind"]): Channel {
  return { id, groupId: SERVER, kind, name: id, position: 0, createdAt: "" } as Channel;
}

describe("a voice channel is a selectable, countable chat", () => {
  beforeEach(() => {
    useChatStore.getState().resetChatState();
  });

  it("counts background messages on a voice channel like any other stream", () => {
    const chat = useChatStore.getState();
    chat.markChannelUnread(LOBBY);
    chat.markChannelUnread(LOBBY);
    expect(useChatStore.getState().unreadChannelIds[LOBBY]).toBe(true);
    expect(useChatStore.getState().unreadCounts[LOBBY]).toBe(2);
  });

  it("SELECTS a voice channel — the gate is chat-capability, not kind", () => {
    useChatStore.getState().setActiveChannel(channel(LOBBY, "voice"));
    expect(useChatStore.getState().activeChannelId).toBe(LOBBY);
    expect(useChatStore.getState().activeGroupId).toBe(SERVER);
  });

  it("opening its chat clears the unread flag and zeroes the count", () => {
    const chat = useChatStore.getState();
    chat.markChannelUnread(LOBBY);
    chat.markChannelUnread(LOBBY, true);
    chat.setActiveChannel(channel(LOBBY, "voice"));
    const after = useChatStore.getState();
    expect(after.unreadChannelIds[LOBBY]).toBe(false);
    expect(after.unreadCounts[LOBBY]).toBeUndefined();
    expect(after.mentionUnreadChannelIds[LOBBY]).toBe(false);
  });

  it("remembers it as the group's last channel, so returning lands back on it", () => {
    useChatStore.getState().setActiveChannel(channel(LOBBY, "voice"));
    expect(useChatStore.getState().lastChannelByGroup[SERVER]).toBe(LOBBY);
  });

  it("'mark as read' works on it without opening it", () => {
    const chat = useChatStore.getState();
    chat.markChannelUnread(LOBBY);
    chat.markChannelRead(LOBBY);
    expect(useChatStore.getState().unreadChannelIds[LOBBY]).toBe(false);
    expect(useChatStore.getState().unreadCounts[LOBBY]).toBeUndefined();
  });
});

describe("the server rail badge includes voice channels", () => {
  it("sums a voice channel's unread into its server's badge", () => {
    const derived = deriveServerUnread(
      { [SERVER]: [GENERAL, LOBBY] },
      { [LOBBY]: true },
      {},
      { [LOBBY]: 3 },
      {},
    );
    expect(derived[SERVER]).toEqual({ unread: true, mention: false, count: 3 });
  });

  it("honors a mute on the voice channel itself", () => {
    const derived = deriveServerUnread(
      { [SERVER]: [GENERAL, LOBBY] },
      { [LOBBY]: true },
      {},
      { [LOBBY]: 3 },
      { [`channel:${LOBBY}`]: { mode: "all", until: null } },
    );
    expect(derived[SERVER]).toEqual({ unread: false, mention: false, count: 0 });
  });
});
