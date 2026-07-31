/**
 * Task #46 — offline notifier unit tests. The notifier must push ONLY to the
 * offline subset of recipients, and must never throw (persistence already
 * happened before it is called). Presence and push are stubbed.
 */

import { describe, expect, it, vi } from "vitest";
import { InMemoryPresenceReader } from "@demli/db";
import { createOfflineNotifier } from "../notifications.js";
import type { PushNotification, PushService } from "../push.js";

function makePush(): PushService & { calls: { ids: string[]; n: PushNotification }[] } {
  const calls: { ids: string[]; n: PushNotification }[] = [];
  return {
    calls,
    async sendToUsers(userIds, n) {
      calls.push({ ids: [...userIds], n });
    },
  };
}

const note: PushNotification = { title: "t", body: "b" };

describe("createOfflineNotifier", () => {
  it("pushes only to recipients with no live connection", async () => {
    const presence = new InMemoryPresenceReader(["online-user"]);
    const push = makePush();
    const notifier = createOfflineNotifier({ presence, push });

    await notifier.notify(["online-user", "offline-user"], note);

    expect(push.calls).toHaveLength(1);
    expect(push.calls[0]!.ids).toEqual(["offline-user"]);
  });

  it("does not push when every recipient is online", async () => {
    const presence = new InMemoryPresenceReader(["a", "b"]);
    const push = makePush();
    const notifier = createOfflineNotifier({ presence, push });

    await notifier.notify(["a", "b"], note);

    expect(push.calls).toEqual([]);
  });

  it("does not push for an empty recipient list", async () => {
    const push = makePush();
    const notifier = createOfflineNotifier({ presence: new InMemoryPresenceReader(), push });
    await notifier.notify([], note);
    expect(push.calls).toEqual([]);
  });

  // #110 — the WhatsApp gate: away = no foreground connection. A backgrounded but
  // still-connected recipient (the "desktop→phone, no notification" gap) MUST be
  // pushed; only a FOREGROUND recipient is suppressed.
  it("pushes to a backgrounded recipient even though they hold a live connection", async () => {
    const presence = new InMemoryPresenceReader();
    presence.setBackground("bg-user"); // connected, app off screen
    const push = makePush();
    const notifier = createOfflineNotifier({ presence, push });

    await notifier.notify(["bg-user"], note);

    expect(push.calls).toHaveLength(1);
    expect(push.calls[0]!.ids).toEqual(["bg-user"]);
  });

  it("gates the full foreground/background/offline matrix in one fan-out", async () => {
    const presence = new InMemoryPresenceReader();
    presence.setForeground("fg-user"); // actively listening → suppress
    presence.setBackground("bg-user"); // backgrounded → push
    // off-user never connects → offline → push
    const push = makePush();
    const notifier = createOfflineNotifier({ presence, push });

    await notifier.notify(["fg-user", "bg-user", "off-user"], note);

    expect(push.calls).toHaveLength(1);
    expect([...push.calls[0]!.ids].sort()).toEqual(["bg-user", "off-user"]);
  });

  it("suppresses the push once a backgrounded recipient returns to the foreground", async () => {
    const presence = new InMemoryPresenceReader();
    presence.setBackground("u");
    const push = makePush();
    const notifier = createOfflineNotifier({ presence, push });

    await notifier.notify(["u"], note); // away → pushed
    presence.setForeground("u"); // app returns to foreground
    await notifier.notify(["u"], note); // now suppressed

    expect(push.calls).toHaveLength(1);
    expect(push.calls[0]!.ids).toEqual(["u"]);
  });

  it("never throws and logs when the push service fails", async () => {
    const presence = new InMemoryPresenceReader(); // everyone offline
    const log = vi.fn();
    const push: PushService = {
      async sendToUsers() {
        throw new Error("boom");
      },
    };
    const notifier = createOfflineNotifier({ presence, push, log });

    await expect(notifier.notify(["u1"], note)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });
});

// notifyAlways is the call-ring path (#103): it must ignore the offline gate so a
// backgrounded-but-connected callee still gets the ring, while leaving notify()'s
// offline gate untouched (mention/message/friend pushes must not regress).
describe("createOfflineNotifier — notifyAlways (call ring, presence-independent)", () => {
  it("pushes to ALL recipients, including online ones (bypasses the offline gate)", async () => {
    const presence = new InMemoryPresenceReader(["online-user"]);
    const push = makePush();
    const notifier = createOfflineNotifier({ presence, push });

    await notifier.notifyAlways(["online-user", "offline-user"], note);

    expect(push.calls).toHaveLength(1);
    expect([...push.calls[0]!.ids].sort()).toEqual(["offline-user", "online-user"]);
  });

  it("dedupes recipients and no-ops on an empty list", async () => {
    const presence = new InMemoryPresenceReader(["u"]); // online, but ignored here
    const push = makePush();
    const notifier = createOfflineNotifier({ presence, push });

    await notifier.notifyAlways(["u", "u"], note);
    expect(push.calls).toHaveLength(1);
    expect(push.calls[0]!.ids).toEqual(["u"]);

    await notifier.notifyAlways([], note);
    expect(push.calls).toHaveLength(1); // still just the one send
  });

  it("never throws and logs when the push service fails", async () => {
    const log = vi.fn();
    const push: PushService = {
      async sendToUsers() {
        throw new Error("boom");
      },
    };
    const notifier = createOfflineNotifier({
      presence: new InMemoryPresenceReader(["u"]),
      push,
      log,
    });

    await expect(notifier.notifyAlways(["u"], note)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("boom"));
  });

  it("does not change notify()'s offline gate (regression guard)", async () => {
    const presence = new InMemoryPresenceReader(["online-user"]);
    const push = makePush();
    const notifier = createOfflineNotifier({ presence, push });

    await notifier.notify(["online-user", "offline-user"], note);

    expect(push.calls).toHaveLength(1);
    expect(push.calls[0]!.ids).toEqual(["offline-user"]);
  });
});
