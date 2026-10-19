/**
 * The caller-drop ring reaper over stub repos (the DB-backed suite covers the
 * SQL). Asserts the part a backgrounded phone depends on: once the caller is
 * gone, the callee's ring push is REPLACED by the missed-call line on the same
 * tag — a phone that only knows about the call through its push never sees the
 * `call.ended` event.
 */

import { describe, expect, it } from "vitest";
import type { RealtimeMutation, Repositories } from "@demli/db";
import { callPushTag, type OfflineNotifier, type PushNotification } from "@demli/notifications";
import { SERVER_EVENT } from "@demli/protocol";
import type { DmCall, UserId } from "@demli/types";
import { createDmCallDisconnectReaper } from "../dm-call-disconnect.js";

const CALLER = "caller" as UserId;
const CALLEE = "callee" as UserId;

function harness(options: { offline: boolean; withNotifier?: boolean }) {
  const pushes: Array<{ to: readonly string[]; push: PushNotification }> = [];
  const published: RealtimeMutation[] = [];
  const timers: Array<() => void> = [];
  const repos = {
    calls: {
      missRingingByCaller: async () =>
        [{ id: "call-1", callerId: CALLER, calleeId: CALLEE, status: "missed" }] as DmCall[],
    },
    users: { findById: async (id: string) => ({ id, displayName: "Ali" }) },
  } as unknown as Repositories;
  const notifier: OfflineNotifier = {
    notify: async () => undefined,
    notifyAlways: async (to, push) => {
      pushes.push({ to, push });
    },
  };
  const reaper = createDmCallDisconnectReaper({
    repos,
    mutationBus: { publish: async (m) => void published.push(m) },
    ...(options.withNotifier === false ? {} : { notifier }),
    isOffline: async () => options.offline,
    setTimer: (cb) => {
      timers.push(cb);
      return timers.length;
    },
    clearTimer: () => undefined,
  });
  return {
    reaper,
    pushes,
    published,
    async fire() {
      for (const cb of timers.splice(0)) cb();
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

describe("caller-drop ring reaper", () => {
  it("replaces the callee's ring push with the missed-call line", async () => {
    const h = harness({ offline: true });
    h.reaper.onUserOffline(CALLER);
    await h.fire();

    expect(h.published.filter((m) => m.event.type === SERVER_EVENT.callEnded)).toHaveLength(2);
    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]!.to).toEqual([CALLEE]);
    expect(h.pushes[0]!.push).toMatchObject({
      title: "Ali",
      body: "Missed call",
      collapseKey: callPushTag("call-1"),
    });
  });

  it("a caller who came back within the grace window keeps the ring and sends nothing", async () => {
    const h = harness({ offline: false });
    h.reaper.onUserOffline(CALLER);
    await h.fire();
    expect(h.pushes).toEqual([]);
    expect(h.published).toEqual([]);
  });
});
