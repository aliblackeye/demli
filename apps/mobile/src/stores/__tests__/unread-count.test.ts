/**
 * Per-channel unread COUNT fold (#110). Proves the store reducer contract the
 * badges depend on: a background message on a passive channel bumps the count;
 * reading it (markChannelRead) or opening it (setActiveChannel) zeroes it; a
 * mention upgrades the mention flag without disturbing the count; and clearing an
 * already-read channel does not allocate a new map (no needless re-render).
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

const C1 = "c1" as ChannelId;
const C2 = "c2" as ChannelId;
const G1 = "g1" as GroupId;

function textChannel(id: ChannelId, groupId: GroupId): Channel {
  return { id, groupId, kind: "text", name: "general", position: 0, createdAt: "" } as Channel;
}

function counts(): Record<string, number> {
  return useChatStore.getState().unreadCounts;
}

describe("unread count fold", () => {
  beforeEach(() => {
    useChatStore.getState().resetChatState();
  });

  it("passive channel: each background message bumps the count and sets the flag", () => {
    const chat = useChatStore.getState();
    chat.markChannelUnread(C1);
    chat.markChannelUnread(C1);
    chat.markChannelUnread(C1);
    expect(counts()[C1]).toBe(3);
    expect(useChatStore.getState().unreadChannelIds[C1]).toBe(true);
  });

  it("counts channels independently", () => {
    const chat = useChatStore.getState();
    chat.markChannelUnread(C1);
    chat.markChannelUnread(C2);
    chat.markChannelUnread(C2);
    expect(counts()[C1]).toBe(1);
    expect(counts()[C2]).toBe(2);
  });

  it("markChannelRead zeroes the count and clears the flags", () => {
    const chat = useChatStore.getState();
    chat.markChannelUnread(C1);
    chat.markChannelUnread(C1);
    chat.markChannelRead(C1);
    expect(counts()[C1]).toBeUndefined();
    expect(useChatStore.getState().unreadChannelIds[C1]).toBe(false);
    expect(useChatStore.getState().mentionUnreadChannelIds[C1]).toBe(false);
  });

  it("opening a channel (setActiveChannel) zeroes its count", () => {
    const chat = useChatStore.getState();
    chat.markChannelUnread(C1);
    chat.markChannelUnread(C1);
    chat.setActiveChannel(textChannel(C1, G1));
    expect(counts()[C1]).toBeUndefined();
    expect(useChatStore.getState().activeChannelId).toBe(C1);
  });

  it("a mention still increments the count and upgrades the mention flag", () => {
    const chat = useChatStore.getState();
    chat.markChannelUnread(C1); // plain
    chat.markChannelUnread(C1, true); // mention
    expect(counts()[C1]).toBe(2);
    expect(useChatStore.getState().mentionUnreadChannelIds[C1]).toBe(true);
  });

  it("a plain message after a mention keeps the mention flag and keeps counting", () => {
    const chat = useChatStore.getState();
    chat.markChannelUnread(C1, true); // mention first
    chat.markChannelUnread(C1); // then plain
    expect(counts()[C1]).toBe(2);
    expect(useChatStore.getState().mentionUnreadChannelIds[C1]).toBe(true);
  });

  it("clearing an already-read channel reuses the same map (no re-render churn)", () => {
    const before = useChatStore.getState().unreadCounts;
    useChatStore.getState().markChannelRead(C1); // C1 was never unread
    expect(useChatStore.getState().unreadCounts).toBe(before);
  });

  it("resetChatState wipes all counts (logout)", () => {
    const chat = useChatStore.getState();
    chat.markChannelUnread(C1);
    chat.markChannelUnread(C2);
    chat.resetChatState();
    expect(useChatStore.getState().unreadCounts).toEqual({});
  });
});
