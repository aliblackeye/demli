/**
 * Delayed Expo receipt check: due-time scheduling, DeviceNotRegistered pruning
 * at the RECEIPT stage, logged (never pruned) operational errors, the bounded
 * queue, and best-effort behaviour on an Expo outage. Clock and timer injected.
 */

import { describe, expect, it, vi } from "vitest";
import type { ExpoPushReceipt } from "expo-server-sdk";
import {
  PushReceiptTracker,
  pushTokenFingerprint,
  type ExpoReceiptClient,
} from "../push-receipts.js";

function harness(opts: {
  receipts?: Record<string, ExpoPushReceipt>;
  fail?: boolean;
  maxPending?: number;
  chunk?: number;
}) {
  let clock = 1_000;
  const timers: { fn: () => void; ms: number }[] = [];
  const deleted: string[] = [];
  const fetched: string[][] = [];
  const log = vi.fn();
  const expo: ExpoReceiptClient = {
    chunkPushNotificationReceiptIds: (ids) => {
      const size = opts.chunk ?? 1000;
      const out: string[][] = [];
      for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
      return out;
    },
    getPushNotificationReceiptsAsync: async (ids) => {
      fetched.push(ids);
      if (opts.fail) throw new Error("expo down");
      const out: Record<string, ExpoPushReceipt> = {};
      for (const id of ids) {
        const r = opts.receipts?.[id];
        if (r) out[id] = r;
      }
      return out;
    },
  };
  const tracker = new PushReceiptTracker({
    expo,
    deleteByTokens: async (tokens) => {
      deleted.push(...tokens);
      return tokens.length;
    },
    log,
    delayMs: 15 * 60_000,
    maxPending: opts.maxPending,
    now: () => clock,
    schedule: (fn, ms) => timers.push({ fn, ms }),
  });
  return {
    tracker,
    timers,
    deleted,
    fetched,
    log,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

const T = (n: number) => `ExponentPushToken[t${n}]`;

describe("PushReceiptTracker", () => {
  it("schedules one check ~15 minutes after the send and does nothing before it is due", async () => {
    const h = harness({});
    h.tracker.track([{ receiptId: "r1", token: T(1), kind: "dm_message" }]);
    h.tracker.track([{ receiptId: "r2", token: T(2), kind: "dm_message" }]);
    expect(h.timers).toHaveLength(1); // one armed timer, not one per send
    expect(h.timers[0]!.ms).toBe(15 * 60_000);

    const early = await h.tracker.flushDue();
    expect(early.checked).toBe(0);
    expect(h.fetched).toEqual([]);
    expect(h.tracker.pending).toBe(2);
  });

  it("prunes DeviceNotRegistered at the receipt stage and logs a summary", async () => {
    const h = harness({
      receipts: {
        r1: { status: "ok" },
        r2: { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
      },
    });
    h.tracker.track([
      { receiptId: "r1", token: T(1), kind: "dm_message" },
      { receiptId: "r2", token: T(2), kind: "dm_message" },
    ]);
    h.advance(15 * 60_000);
    const summary = await h.tracker.flushDue();

    expect(h.fetched).toEqual([["r1", "r2"]]);
    expect(h.deleted).toEqual([T(2)]);
    expect(summary).toMatchObject({
      checked: 2,
      ok: 1,
      errors: { DeviceNotRegistered: 1 },
      pruned: 1,
      missing: 0,
    });
    expect(h.tracker.pending).toBe(0);
    const line = h.log.mock.calls.map((c) => String(c[0])).find((m) => m.startsWith("[push] receipts"));
    expect(line).toBeDefined();
    expect(line).not.toContain("ExponentPushToken");
  });

  it.each(["InvalidCredentials", "MessageTooBig", "MessageRateExceeded", "MismatchSenderId"])(
    "logs %s with a token fingerprint but never prunes it",
    async (code) => {
      const h = harness({
        receipts: {
          r1: {
            status: "error",
            message: "nope",
            details: { error: code as "InvalidCredentials" },
          },
        },
      });
      h.tracker.track([{ receiptId: "r1", token: T(1), kind: "call_ring" }]);
      h.advance(15 * 60_000);
      const summary = await h.tracker.flushDue();

      expect(h.deleted).toEqual([]);
      expect(summary.errors).toEqual({ [code]: 1 });
      const messages = h.log.mock.calls.map((c) => String(c[0]));
      const errorLine = messages.find((m) => m.startsWith("[push] receipt error"));
      expect(errorLine).toContain(code);
      expect(errorLine).toContain(pushTokenFingerprint(T(1)));
      expect(errorLine).toContain("call_ring");
      expect(messages.join("\n")).not.toContain(T(1));
    },
  );

  it("counts receipts Expo no longer has as missing", async () => {
    const h = harness({ receipts: {} });
    h.tracker.track([{ receiptId: "r1", token: T(1), kind: "message" }]);
    h.advance(15 * 60_000);
    expect(await h.tracker.flushDue()).toMatchObject({ checked: 1, missing: 1, pruned: 0 });
  });

  it("swallows an Expo outage (best-effort, nothing pruned, never rejects)", async () => {
    const h = harness({ fail: true });
    h.tracker.track([{ receiptId: "r1", token: T(1), kind: "message" }]);
    h.advance(15 * 60_000);
    await expect(h.tracker.flushDue()).resolves.toMatchObject({ checked: 1, missing: 1 });
    expect(h.deleted).toEqual([]);
    expect(h.log).toHaveBeenCalledWith(expect.stringContaining("expo down"));
  });

  it("checks in Expo-sized chunks", async () => {
    const h = harness({ chunk: 2, receipts: {} });
    h.tracker.track(
      [1, 2, 3, 4, 5].map((n) => ({ receiptId: `r${n}`, token: T(n), kind: "message" })),
    );
    h.advance(15 * 60_000);
    await h.tracker.flushDue();
    expect(h.fetched.map((c) => c.length)).toEqual([2, 2, 1]);
  });

  it("keeps memory bounded by shedding the oldest ids", async () => {
    const h = harness({ maxPending: 3, receipts: {} });
    h.tracker.track(
      [1, 2, 3, 4, 5].map((n) => ({ receiptId: `r${n}`, token: T(n), kind: "message" })),
    );
    expect(h.tracker.pending).toBe(3);
    h.advance(15 * 60_000);
    const summary = await h.tracker.flushDue();
    expect(h.fetched).toEqual([["r3", "r4", "r5"]]);
    expect(summary.dropped).toBe(2);
  });

  it("only checks what is due and re-arms for the rest", async () => {
    const h = harness({ receipts: {} });
    h.tracker.track([{ receiptId: "r1", token: T(1), kind: "message" }]);
    h.advance(10 * 60_000);
    h.tracker.track([{ receiptId: "r2", token: T(2), kind: "message" }]);
    h.advance(5 * 60_000); // r1 due, r2 has 10 min to go
    // fire the armed timer the way the real scheduler would
    h.timers.shift()!.fn();
    await Promise.resolve();
    await h.tracker.flushDue();
    expect(h.fetched).toEqual([["r1"]]);
    expect(h.tracker.pending).toBe(1);
    expect(h.timers.at(-1)!.ms).toBe(10 * 60_000);
  });
});
