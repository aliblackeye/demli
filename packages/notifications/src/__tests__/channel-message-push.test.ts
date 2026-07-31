/**
 * Unit tests for the shared "all messages" channel push dispatcher (#94). No DB:
 * the repo slice (reverse fan-out query, per-user visibility, group/user lookups)
 * and the mute store are stubbed, and the notifier records its calls — so this
 * asserts the pure orchestration (audience split, mute gating, push format,
 * collapse key) deterministically. Mentions are built via the protocol encoder,
 * so no `<@…>` string is hand-written.
 */

import { describe, expect, it } from "vitest";
import { encodeMention } from "@demli/protocol";
import type { UserId } from "@demli/types";
import {
  channelMessagePushContent,
  channelPushCollapseKey,
  dispatchChannelMessagePush,
  type ChannelMessagePushRepos,
} from "../channel-message-push.js";
import type { ActiveMuteRow, NotificationMuteStore } from "../mute-filter.js";
import type { OfflineNotifier } from "../notifications.js";
import type { PushNotification } from "../push.js";

interface NotifyCall {
  ids: UserId[];
  n: PushNotification;
}

function makeNotifier(): { notifier: OfflineNotifier; calls: NotifyCall[] } {
  const calls: NotifyCall[] = [];
  return {
    calls,
    notifier: {
      async notify(ids, n) {
        // Mirror the real offline gate's shape without a presence check: record
        // exactly what a call site handed the notifier.
        calls.push({ ids: [...ids], n });
      },
      // Channel-message fan-out only ever uses notify(); mirror the presence-
      // independent call-ring path so the stub satisfies the interface.
      async notifyAlways(ids, n) {
        calls.push({ ids: [...ids], n });
      },
    },
  };
}

/** Stub repos: `audience` = who can see the channel; `visible` = mention re-check set. */
function makeRepos(opts: {
  audience: UserId[];
  visible?: Iterable<UserId>;
  groupName?: string;
  authorName?: string;
  mutes?: ActiveMuteRow[];
}): ChannelMessagePushRepos {
  const visibleSet = new Set(opts.visible ?? opts.audience);
  const muteStore: NotificationMuteStore | undefined = opts.mutes
    ? {
        async listActiveForRecipients({ userIds }) {
          const set = new Set(userIds);
          return (opts.mutes ?? []).filter((r) => set.has(r.userId));
        },
      }
    : undefined;
  return {
    channelAccess: {
      async recipientIdsForChannel() {
        return [...opts.audience];
      },
      async canUserSeeChannel(_groupId, _channelId, userId) {
        return visibleSet.has(userId);
      },
    },
    groups: {
      async findById() {
        return { name: opts.groupName ?? "Crew" } as never;
      },
    },
    users: {
      async findById() {
        return { displayName: opts.authorName ?? "Ada" } as never;
      },
    },
    ...(muteStore ? { notificationMutes: muteStore } : {}),
  };
}

const ARGS = {
  channelId: "c1",
  groupId: "g1",
  channelName: "general",
  authorId: "author",
  messageId: "m1",
} as const;

describe("dispatchChannelMessagePush", () => {
  it("pushes the plain channel notification to every visible member except the author", async () => {
    const repos = makeRepos({ audience: ["author", "u2", "u3"], authorName: "Ada", groupName: "Crew" });
    const { notifier, calls } = makeNotifier();

    await dispatchChannelMessagePush(
      { repos, notifier },
      { ...ARGS, content: "  hello   crew  " },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.ids.slice().sort()).toEqual(["u2", "u3"]);
    expect(calls[0]!.n.title).toBe("Crew #general");
    expect(calls[0]!.n.body).toBe("Ada: hello crew");
    expect(calls[0]!.n.data).toMatchObject({ type: "message", channelId: "c1", groupId: "g1", name: "general" });
    expect(calls[0]!.n.collapseKey).toBe("channel:c1");
  });

  it("splits a send: the @mentioned member gets the mention push, the rest the channel push", async () => {
    const repos = makeRepos({ audience: ["author", "tagged", "other"], visible: ["tagged", "other"] });
    const { notifier, calls } = makeNotifier();

    await dispatchChannelMessagePush(
      { repos, notifier },
      { ...ARGS, content: `look ${encodeMention("tagged")}` },
    );

    expect(calls).toHaveLength(2);
    const mention = calls.find((c) => (c.n.data as { type?: string }).type === "mention");
    const channel = calls.find((c) => (c.n.data as { type?: string }).type === "message");
    expect(mention?.ids).toEqual(["tagged"]);
    expect(mention?.n.collapseKey).toBeUndefined(); // mentions are not collapsed
    expect(channel?.ids).toEqual(["other"]);
    expect(channel?.n.collapseKey).toBe("channel:c1");
  });

  it("mode=all silences a member; mode=mentions drops a plain message for them", async () => {
    const repos = makeRepos({
      audience: ["author", "muteAll", "muteMentions", "open"],
      mutes: [
        { userId: "muteAll", scope: "channel", targetId: "c1", mode: "all" },
        { userId: "muteMentions", scope: "channel", targetId: "c1", mode: "mentions" },
      ],
    });
    const { notifier, calls } = makeNotifier();

    await dispatchChannelMessagePush({ repos, notifier }, { ...ARGS, content: "plain hi" });

    // Only the un-muted member survives the plain (isMention:false) channel push.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ids).toEqual(["open"]);
  });

  it("a mentions-mode mute lets a direct @mention through as the mention push", async () => {
    const repos = makeRepos({
      audience: ["author", "fan"],
      mutes: [{ userId: "fan", scope: "channel", targetId: "c1", mode: "mentions" }],
    });
    const { notifier, calls } = makeNotifier();

    await dispatchChannelMessagePush(
      { repos, notifier },
      { ...ARGS, content: `ping ${encodeMention("fan")}` },
    );

    expect(calls).toHaveLength(1);
    expect(calls[0]!.ids).toEqual(["fan"]);
    expect((calls[0]!.n.data as { type?: string }).type).toBe("mention");
  });

  it("is a no-op with no notifier, and when the author is the only visible member", async () => {
    const repos = makeRepos({ audience: ["author"] });
    const { notifier, calls } = makeNotifier();

    // No notifier → nothing delivered.
    await dispatchChannelMessagePush({ repos }, { ...ARGS, content: "hi" });
    // Author-only audience → no recipients.
    await dispatchChannelMessagePush({ repos, notifier }, { ...ARGS, content: "hi" });

    expect(calls).toEqual([]);
  });
});

describe("channelMessagePushContent / channelPushCollapseKey", () => {
  it("formats 'Server #channel' over 'Author: text'", () => {
    expect(
      channelMessagePushContent({
        groupName: "Crew",
        channelName: "general",
        authorName: "Ada",
        content: "  yo   ",
      }),
    ).toEqual({ title: "Crew #general", body: "Ada: yo" });
  });

  it("reuses the attachment placeholder for an empty body", () => {
    expect(
      channelMessagePushContent({ groupName: "C", channelName: "g", authorName: "A", content: "  " }).body,
    ).toBe("A: Sent an attachment.");
  });

  it("namespaces the per-channel collapse key", () => {
    expect(channelPushCollapseKey("c1")).toBe("channel:c1");
  });
});
