import { describe, expect, it } from "vitest";
import type { UserId } from "@demli/types";
import {
  filterMutedRecipients,
  type ActiveMuteRow,
  type NotificationMuteStore,
} from "../mute-filter.js";

const CHANNEL = "chan-1";
const GROUP = "group-1";
const ALICE = "alice" as UserId;
const BOB = "bob" as UserId;
const CAROL = "carol" as UserId;

/** In-memory store returning a fixed row set (already "active" — no expiry logic here). */
function store(rows: ActiveMuteRow[]): NotificationMuteStore {
  return {
    async listActiveForRecipients({ userIds, channelId, groupId }) {
      return rows.filter(
        (r) =>
          userIds.includes(r.userId) &&
          ((r.scope === "channel" && r.targetId === channelId) ||
            (r.scope === "group" && r.targetId === groupId)),
      );
    },
  };
}

const ctx = (isMention: boolean) => ({ channelId: CHANNEL, groupId: GROUP, isMention });

describe("filterMutedRecipients (notification mute push gate)", () => {
  it("passes everyone through when no store is wired", async () => {
    const out = await filterMutedRecipients(undefined, [ALICE, BOB], ctx(false));
    expect(out).toEqual([ALICE, BOB]);
  });

  it("keeps unmuted recipients untouched", async () => {
    const out = await filterMutedRecipients(store([]), [ALICE, BOB], ctx(false));
    expect(out).toEqual([ALICE, BOB]);
  });

  it("drops a channel mode=all recipient for a plain message", async () => {
    const s = store([{ userId: ALICE, scope: "channel", targetId: CHANNEL, mode: "all" }]);
    const out = await filterMutedRecipients(s, [ALICE, BOB], ctx(false));
    expect(out).toEqual([BOB]);
  });

  it("drops a channel mode=all recipient EVEN for a mention", async () => {
    const s = store([{ userId: ALICE, scope: "channel", targetId: CHANNEL, mode: "all" }]);
    const out = await filterMutedRecipients(s, [ALICE, BOB], ctx(true));
    expect(out).toEqual([BOB]);
  });

  it("mode=mentions: silences a plain message but passes a mention", async () => {
    const s = store([{ userId: ALICE, scope: "group", targetId: GROUP, mode: "mentions" }]);
    expect(await filterMutedRecipients(s, [ALICE, BOB], ctx(false))).toEqual([BOB]);
    expect(await filterMutedRecipients(s, [ALICE, BOB], ctx(true))).toEqual([ALICE, BOB]);
  });

  it("a group mode=all mute covers a channel under it", async () => {
    const s = store([{ userId: ALICE, scope: "group", targetId: GROUP, mode: "all" }]);
    const out = await filterMutedRecipients(s, [ALICE, BOB], ctx(false));
    expect(out).toEqual([BOB]);
  });

  it("channel-scope mute WINS over group-scope mute (most specific)", async () => {
    // Group says all (silence everything); channel says mentions (louder). The
    // channel setting is more specific → a mention passes.
    const s = store([
      { userId: ALICE, scope: "group", targetId: GROUP, mode: "all" },
      { userId: ALICE, scope: "channel", targetId: CHANNEL, mode: "mentions" },
    ]);
    expect(await filterMutedRecipients(s, [ALICE], ctx(true))).toEqual([ALICE]);
    expect(await filterMutedRecipients(s, [ALICE], ctx(false))).toEqual([]);
  });

  it("filters independently per recipient", async () => {
    const s = store([
      { userId: ALICE, scope: "channel", targetId: CHANNEL, mode: "all" },
      { userId: CAROL, scope: "group", targetId: GROUP, mode: "mentions" },
    ]);
    // plain message: Alice(all)→drop, Carol(mentions,plain)→drop, Bob→keep
    expect(await filterMutedRecipients(s, [ALICE, BOB, CAROL], ctx(false))).toEqual([BOB]);
    // mention: Alice(all)→drop, Carol(mentions)→keep, Bob→keep
    expect(await filterMutedRecipients(s, [ALICE, BOB, CAROL], ctx(true))).toEqual([BOB, CAROL]);
  });

  it("fails OPEN when the store throws (never drops the push on error)", async () => {
    const throwing: NotificationMuteStore = {
      async listActiveForRecipients() {
        throw new Error("db down");
      },
    };
    const logs: string[] = [];
    const out = await filterMutedRecipients(throwing, [ALICE, BOB], ctx(false), (m) =>
      logs.push(m),
    );
    expect(out).toEqual([ALICE, BOB]);
    expect(logs[0]).toContain("mute filter failed");
  });

  it("short-circuits an empty recipient list without querying", async () => {
    let called = false;
    const s: NotificationMuteStore = {
      async listActiveForRecipients() {
        called = true;
        return [];
      },
    };
    expect(await filterMutedRecipients(s, [], ctx(false))).toEqual([]);
    expect(called).toBe(false);
  });
});
