/**
 * Selection contract for voice-channel chat (M20).
 *
 * The whole client-side feature rests on one store rule: a VOICE channel is a
 * legal `activeChannelId`. Before M20 `setActiveChannel` returned early on any
 * non-text kind, so the center could never render a voice channel's chat no
 * matter what the sidebar did — which is exactly the kind of silent refusal that
 * looks like a broken click rather than a rejected write.
 *
 * The second rule is subtler and was the real trap: `ensureChannelSelection`
 * runs on every group-details settle, so a kind check left in THERE would have
 * let the user open a voice chat and then yanked them back to #general a
 * heartbeat later, seemingly at random.
 *
 * (Node environment — the renderer has no DOM harness — so this covers the store
 * contract the components read, not the rendered tree. The component wiring is
 * locked separately in ../lib/voice-channel-chat-wiring.test.ts.)
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { Channel, ChannelId, GroupId } from "@demli/types";
import { useChatStore } from "./chat-store";

const GROUP = "group-1" as GroupId;

function channel(id: string, kind: Channel["kind"], position: number): Channel {
  return {
    id: id as ChannelId,
    groupId: GROUP,
    kind,
    name: id,
    position,
  } as Channel;
}

const general = channel("general", "text", 0);
const random = channel("random", "text", 1);
const lobby = channel("lobby", "voice", 0);

const store = () => useChatStore.getState();

describe("a voice channel is a chat target", () => {
  beforeEach(() => {
    useChatStore.setState({
      activeView: "server",
      activeGroupId: GROUP,
      activeChannelId: general.id,
      lastChannelByGroup: {},
      unreadChannelIds: {},
      unreadCounts: {},
      mentionUnreadChannelIds: {},
    });
  });

  it("selects a voice channel, so its chat can render", () => {
    store().setActiveChannel(lobby);
    expect(store().activeChannelId).toBe(lobby.id);
    expect(store().activeGroupId).toBe(GROUP);
  });

  it("remembers it as the group's last channel", () => {
    store().setActiveChannel(lobby);
    expect(store().lastChannelByGroup[GROUP]).toBe(lobby.id);
  });

  it("clears the voice channel's unread the moment it is opened", () => {
    useChatStore.setState({
      unreadChannelIds: { [lobby.id]: true },
      unreadCounts: { [lobby.id]: 4 },
      mentionUnreadChannelIds: { [lobby.id]: true },
    });
    store().setActiveChannel(lobby);
    expect(store().unreadChannelIds[lobby.id]).toBe(false);
    expect(store().unreadCounts[lobby.id]).toBeUndefined();
    expect(store().mentionUnreadChannelIds[lobby.id]).toBe(false);
  });

  it("counts unread on a voice channel exactly like a text one", () => {
    // The realtime handler is kind-agnostic; this asserts the store it calls is
    // too, which is what puts the pip on the voice row (task #3).
    store().markChannelUnread(lobby.id);
    store().markChannelUnread(lobby.id);
    store().markChannelMentionUnread(lobby.id);
    expect(store().unreadChannelIds[lobby.id]).toBe(true);
    expect(store().unreadCounts[lobby.id]).toBe(2);
    expect(store().mentionUnreadChannelIds[lobby.id]).toBe(true);

    store().markChannelRead(lobby.id);
    expect(store().unreadChannelIds[lobby.id]).toBe(false);
    expect(store().unreadCounts[lobby.id]).toBeUndefined();
  });

  it("refuses a kind that carries no chat at all — the gate still fails closed", () => {
    const forum = channel("forum", "forum" as Channel["kind"], 2);
    store().setActiveChannel(forum);
    expect(store().activeChannelId).toBe(general.id);
  });
});

describe("ensureChannelSelection", () => {
  beforeEach(() => {
    useChatStore.setState({
      activeView: "server",
      activeGroupId: GROUP,
      activeChannelId: null,
      lastChannelByGroup: {},
      unreadChannelIds: {},
      unreadCounts: {},
      mentionUnreadChannelIds: {},
    });
  });

  it("keeps a deliberately opened voice channel across a details refetch", () => {
    useChatStore.setState({ activeChannelId: lobby.id });
    store().ensureChannelSelection([general, random, lobby]);
    expect(store().activeChannelId).toBe(lobby.id);
  });

  it("restores a remembered voice channel when re-entering the server", () => {
    useChatStore.setState({ lastChannelByGroup: { [GROUP]: lobby.id } });
    store().ensureChannelSelection([general, random, lobby]);
    expect(store().activeChannelId).toBe(lobby.id);
  });

  it("still opens a server on its first TEXT channel, never a voice one", () => {
    // A default that lands inside a voice channel would put "join voice" in
    // front of a user who only opened the server.
    store().ensureChannelSelection([lobby, random, general]);
    expect(store().activeChannelId).toBe(general.id);
  });

  it("repairs a selection whose channel disappeared", () => {
    useChatStore.setState({ activeChannelId: lobby.id });
    store().ensureChannelSelection([general, random]);
    expect(store().activeChannelId).toBe(general.id);
  });

  it("clears the selection when the server has no chat-capable channel left", () => {
    useChatStore.setState({ activeChannelId: general.id });
    store().ensureChannelSelection([]);
    expect(store().activeChannelId).toBeNull();
  });
});
