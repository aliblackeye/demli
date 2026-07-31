import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readWebNotificationPermission,
  useWebNotificationPermission,
  webNotificationsSupported,
} from "./web-permission";
import { pushInAppNotification, useInAppNotifications } from "./in-app-notifications";

/**
 * "Web'de izin yokken çökmüyor" — the notification path must degrade, never
 * throw. These run in the plain Node test environment (no jsdom), which is
 * exactly the "no window / no Notification API" shape we have to survive, and we
 * additionally fake the browser shapes we cannot get otherwise.
 */

const globalRef = globalThis as unknown as {
  window?: unknown;
  document?: unknown;
  Notification?: unknown;
};

afterEach(() => {
  delete globalRef.window;
  delete globalRef.document;
  delete globalRef.Notification;
  useInAppNotifications.getState().clear();
  vi.restoreAllMocks();
});

/** Install a minimal browser-ish global with the given Notification permission. */
function fakeBrowser(permission: NotificationPermission | null): void {
  const notification =
    permission === null
      ? undefined
      : {
          permission,
          requestPermission: vi.fn(async () => permission),
        };
  const win: Record<string, unknown> = {
    demli: { appInfo: { platform: "web", version: "0.0.0" } },
  };
  if (notification) win.Notification = notification;
  globalRef.window = win;
  if (notification) globalRef.Notification = notification;
}

describe("web notification permission", () => {
  it("reports unsupported with no window at all (Node / early paint)", () => {
    expect(webNotificationsSupported()).toBe(false);
    expect(readWebNotificationPermission()).toBe("unsupported");
  });

  it("reports unsupported on a browser with no Notification API (old iOS Safari)", () => {
    fakeBrowser(null);
    expect(webNotificationsSupported()).toBe(false);
    expect(readWebNotificationPermission()).toBe("unsupported");
  });

  it("reports the browser's answer verbatim", () => {
    fakeBrowser("default");
    expect(readWebNotificationPermission()).toBe("default");
    fakeBrowser("granted");
    expect(readWebNotificationPermission()).toBe("granted");
    fakeBrowser("denied");
    expect(readWebNotificationPermission()).toBe("denied");
  });

  it("request() resolves instead of throwing when unsupported", async () => {
    await expect(useWebNotificationPermission.getState().request()).resolves.toBe("unsupported");
  });

  it("request() does not re-prompt once the browser already decided", async () => {
    fakeBrowser("denied");
    const notification = globalRef.Notification as { requestPermission: ReturnType<typeof vi.fn> };
    await expect(useWebNotificationPermission.getState().request()).resolves.toBe("denied");
    expect(notification.requestPermission).not.toHaveBeenCalled();
  });
});

describe("in-app fallback", () => {
  it("accepts an alert when no OS toast can be shown, and never grows unbounded", () => {
    for (let i = 0; i < 6; i++) {
      pushInAppNotification({
        title: `t${i}`,
        body: "b",
        navigate: { target: "friends" },
      });
    }
    const items = useInAppNotifications.getState().items;
    expect(items).toHaveLength(3);
    // The NEWEST three survive — an old alert must never hide a fresh one.
    expect(items.map((i) => i.title)).toEqual(["t3", "t4", "t5"]);
  });

  it("dismiss removes exactly one entry", () => {
    pushInAppNotification({ title: "a", body: "", navigate: { target: "friends" } });
    pushInAppNotification({ title: "b", body: "", navigate: { target: "friends" } });
    const first = useInAppNotifications.getState().items[0];
    expect(first).toBeDefined();
    useInAppNotifications.getState().dismiss(first!.id);
    expect(useInAppNotifications.getState().items.map((i) => i.title)).toEqual(["b"]);
  });
});
