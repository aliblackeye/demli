/**
 * Task #46 — Expo push service unit tests. No network / no DB: the Expo client
 * and the token store are both stubbed, so we assert the pure orchestration —
 * token fan-out, chunking, invalid-token filtering, and dead-token pruning from
 * ticket errors — deterministically.
 */

import { describe, expect, it, vi } from "vitest";
import type { ExpoPushMessage, ExpoPushTicket } from "expo-server-sdk";
import type { UserPushToken } from "@demli/db";
import {
  ExpoPushService,
  type ExpoPushClient,
  type PushTokenStore,
} from "../push.js";
import {
  pushTokenFingerprint,
  type PendingReceipt,
  type PushReceiptTracker,
} from "../push-receipts.js";

/** In-memory token store recording deletions. */
function makeStore(rows: UserPushToken[]): PushTokenStore & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    async listTokensForUsers(userIds) {
      const set = new Set(userIds);
      return rows.filter((r) => set.has(r.userId));
    },
    async deleteByTokens(tokens) {
      deleted.push(...tokens);
      return tokens.length;
    },
  };
}

/**
 * Stub Expo client. `chunkSize` drives chunking; `ticketsFor` maps a chunk to
 * its tickets (default: all ok). `onSend` can throw to simulate an outage.
 */
function makeExpo(opts: {
  chunkSize?: number;
  ticketsFor?: (chunk: ExpoPushMessage[]) => ExpoPushTicket[];
  throwOnSend?: boolean;
} = {}): ExpoPushClient & { sent: ExpoPushMessage[][] } {
  const chunkSize = opts.chunkSize ?? 100;
  const sent: ExpoPushMessage[][] = [];
  return {
    sent,
    chunkPushNotifications(messages) {
      const chunks: ExpoPushMessage[][] = [];
      for (let i = 0; i < messages.length; i += chunkSize) {
        chunks.push(messages.slice(i, i + chunkSize));
      }
      return chunks;
    },
    async sendPushNotificationsAsync(messages) {
      if (opts.throwOnSend) throw new Error("expo outage");
      sent.push(messages);
      return (
        opts.ticketsFor?.(messages) ??
        messages.map(() => ({ status: "ok", id: "r" }) as ExpoPushTicket)
      );
    },
  };
}

const tok = (n: number): string => `ExponentPushToken[valid${n}]`;

describe("ExpoPushService", () => {
  it("sends one message per device with title/body/data", async () => {
    const store = makeStore([
      { userId: "u1", token: tok(1), platform: "ios" },
      { userId: "u1", token: tok(2), platform: "android" },
    ]);
    const expo = makeExpo();
    const svc = new ExpoPushService({ tokens: store, expo });

    await svc.sendToUsers(["u1"], {
      title: "Ada",
      body: "hi",
      data: { type: "dm_message", dmId: "d1" },
    });

    expect(expo.sent).toHaveLength(1);
    const msgs = expo.sent[0]!;
    expect(msgs.map((m) => m.to).sort()).toEqual([tok(1), tok(2)].sort());
    expect(msgs[0]).toMatchObject({ title: "Ada", body: "hi", priority: "high" });
    expect(msgs[0]!.data).toEqual({ type: "dm_message", dmId: "d1" });
    expect(store.deleted).toEqual([]);
  });

  it("chunks large token sets", async () => {
    const rows: UserPushToken[] = Array.from({ length: 5 }, (_, i) => ({
      userId: "u1",
      token: tok(i),
      platform: "ios" as const,
    }));
    const expo = makeExpo({ chunkSize: 2 });
    const svc = new ExpoPushService({ tokens: makeStore(rows), expo });

    await svc.sendToUsers(["u1"], { title: "t", body: "b" });

    // 5 tokens / chunk size 2 → 3 send calls (2 + 2 + 1).
    expect(expo.sent.map((c) => c.length)).toEqual([2, 2, 1]);
  });

  it("filters and prunes malformed (non-Expo) tokens without sending them", async () => {
    const store = makeStore([
      { userId: "u1", token: tok(1), platform: "ios" },
      { userId: "u1", token: "not-a-real-token", platform: "android" },
    ]);
    const expo = makeExpo();
    const svc = new ExpoPushService({ tokens: store, expo });

    await svc.sendToUsers(["u1"], { title: "t", body: "b" });

    expect(expo.sent[0]!.map((m) => m.to)).toEqual([tok(1)]);
    expect(store.deleted).toEqual(["not-a-real-token"]);
  });

  it("prunes tokens Expo reports as DeviceNotRegistered (mapped by ticket index)", async () => {
    const store = makeStore([
      { userId: "u1", token: tok(1), platform: "ios" },
      { userId: "u1", token: tok(2), platform: "android" },
    ]);
    const expo = makeExpo({
      ticketsFor: (chunk) =>
        chunk.map((m) =>
          m.to === tok(2)
            ? ({
                status: "error",
                message: "gone",
                details: { error: "DeviceNotRegistered" },
              } as ExpoPushTicket)
            : ({ status: "ok", id: "r" } as ExpoPushTicket),
        ),
    });
    const svc = new ExpoPushService({ tokens: store, expo });

    await svc.sendToUsers(["u1"], { title: "t", body: "b" });

    expect(store.deleted).toEqual([tok(2)]);
  });

  it("does NOT prune on non-DeviceNotRegistered ticket errors, but logs them", async () => {
    const store = makeStore([{ userId: "u1", token: tok(1), platform: "ios" }]);
    const log = vi.fn();
    const expo = makeExpo({
      ticketsFor: () => [
        { status: "error", message: "too big", details: { error: "MessageTooBig" } } as ExpoPushTicket,
      ],
    });
    const svc = new ExpoPushService({ tokens: store, expo, log });

    await svc.sendToUsers(["u1"], { title: "t", body: "b" });

    expect(store.deleted).toEqual([]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("MessageTooBig"));
  });

  it("swallows a send outage (never throws) yet still prunes malformed tokens", async () => {
    const store = makeStore([
      { userId: "u1", token: tok(1), platform: "ios" },
      { userId: "u1", token: "bad", platform: "ios" },
    ]);
    const expo = makeExpo({ throwOnSend: true });
    const svc = new ExpoPushService({ tokens: store, expo });

    await expect(svc.sendToUsers(["u1"], { title: "t", body: "b" })).resolves.toMatchObject({
      tokens: 2,
      ok: 0,
      invalid: 1,
      errors: { chunk_failed: 1 },
    });
    // Malformed token pruned; the valid one's send failed but did not throw.
    expect(store.deleted).toEqual(["bad"]);
  });

  it("no-ops on empty recipients or when no device is registered", async () => {
    const emptyExpo = makeExpo();
    const svc1 = new ExpoPushService({ tokens: makeStore([]), expo: emptyExpo });
    await svc1.sendToUsers([], { title: "t", body: "b" });
    await svc1.sendToUsers(["nobody"], { title: "t", body: "b" });
    expect(emptyExpo.sent).toEqual([]);
  });

  it("returns a summary with fingerprints, never the raw tokens", async () => {
    const store = makeStore([
      { userId: "u1", token: tok(1), platform: "android" },
      { userId: "u1", token: tok(2), platform: "android" },
    ]);
    const expo = makeExpo({
      ticketsFor: (chunk) =>
        chunk.map((m) =>
          m.to === tok(2)
            ? ({ status: "error", message: "x", details: { error: "MessageRateExceeded" } } as ExpoPushTicket)
            : ({ status: "ok", id: "r1" } as ExpoPushTicket),
        ),
    });
    const summary = await new ExpoPushService({ tokens: store, expo }).sendToUsers(["u1"], {
      title: "t",
      body: "b",
    });
    expect(summary).toMatchObject({ tokens: 2, ok: 1, errors: { MessageRateExceeded: 1 } });
    expect(summary.tokenIds).toEqual([pushTokenFingerprint(tok(1)), pushTokenFingerprint(tok(2))]);
    expect(JSON.stringify(summary)).not.toContain("ExponentPushToken");
  });

  it("queues every ok ticket for a delayed receipt check", async () => {
    const store = makeStore([
      { userId: "u1", token: tok(1), platform: "android" },
      { userId: "u2", token: tok(2), platform: "android" },
    ]);
    const tracked: PendingReceipt[] = [];
    const receipts = { track: (e: readonly PendingReceipt[]) => tracked.push(...e) };
    const expo = makeExpo({
      ticketsFor: (chunk) => chunk.map((m) => ({ status: "ok", id: `rid-${String(m.to)}` }) as ExpoPushTicket),
    });
    await new ExpoPushService({
      tokens: store,
      expo,
      receipts: receipts as unknown as PushReceiptTracker,
    }).sendToUsers(["u1", "u2"], { title: "t", body: "b", data: { type: "dm_message" } });
    expect(tracked).toEqual([
      { receiptId: `rid-${tok(1)}`, token: tok(1), kind: "dm_message" },
      { receiptId: `rid-${tok(2)}`, token: tok(2), kind: "dm_message" },
    ]);
  });

  it("builds a receipt tracker automatically when the client can fetch receipts", () => {
    const expo = {
      ...makeExpo(),
      chunkPushNotificationReceiptIds: (ids: string[]) => [ids],
      getPushNotificationReceiptsAsync: async () => ({}),
    };
    expect(new ExpoPushService({ tokens: makeStore([]), expo }).receipts).not.toBeNull();
    expect(new ExpoPushService({ tokens: makeStore([]), expo: makeExpo() }).receipts).toBeNull();
    expect(
      new ExpoPushService({ tokens: makeStore([]), expo, receipts: false }).receipts,
    ).toBeNull();
  });

  it("dedupes recipient ids before fetching tokens", async () => {
    const store = makeStore([{ userId: "u1", token: tok(1), platform: "ios" }]);
    const spy = vi.spyOn(store, "listTokensForUsers");
    const svc = new ExpoPushService({ tokens: store, expo: makeExpo() });

    await svc.sendToUsers(["u1", "u1", "u1"], { title: "t", body: "b" });

    expect(spy).toHaveBeenCalledWith(["u1"]);
  });
});
