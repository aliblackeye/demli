import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DURATION,
  MAX_VISIBLE,
  claimAnnouncement,
  dismissToast,
  getActiveToastHost,
  getToasts,
  registerToastHost,
  resetToastsForTest,
  subscribeToasts,
  toast,
  unregisterToastHost,
} from "./toast-store";

beforeEach(() => resetToastsForTest());

describe("toast queue", () => {
  it("queues with defaults and notifies subscribers", () => {
    let calls = 0;
    const off = subscribeToasts(() => {
      calls += 1;
    });
    const id = toast({ title: "Kopyalandı" });
    expect(getToasts()).toEqual([
      { id, key: undefined, title: "Kopyalandı", description: undefined, variant: "neutral", duration: DEFAULT_DURATION, action: undefined },
    ]);
    expect(calls).toBe(1);
    off();
    toast({ title: "x" });
    expect(calls).toBe(1);
  });

  it("keeps only the newest MAX_VISIBLE", () => {
    for (let i = 0; i < MAX_VISIBLE + 2; i += 1) toast({ title: `t${i}` });
    const titles = getToasts().map((r) => r.title);
    expect(titles).toHaveLength(MAX_VISIBLE);
    expect(titles[titles.length - 1]).toBe(`t${MAX_VISIBLE + 1}`);
  });

  it("a repeated key replaces instead of stacking", () => {
    toast({ title: "Kopyalandı", key: "copy" });
    toast({ title: "Başka", key: "other" });
    const id = toast({ title: "Kopyalandı", key: "copy" });
    expect(getToasts().map((r) => r.key)).toEqual(["other", "copy"]);
    expect(getToasts()[1]?.id).toBe(id);
  });

  it("dismiss removes exactly that toast and ignores unknown ids", () => {
    const a = toast({ title: "a" });
    toast({ title: "b" });
    dismissToast(a);
    dismissToast(999);
    expect(getToasts().map((r) => r.title)).toEqual(["b"]);
  });
});

describe("toast hosts (one window draws the queue)", () => {
  it("the most recently mounted host is active; unmounting hands the queue back", () => {
    expect(getActiveToastHost()).toBeNull();
    const root = registerToastHost();
    expect(getActiveToastHost()).toBe(root);
    // A sheet opens: its Modal window is on top, so its host takes over.
    const sheet = registerToastHost();
    expect(getActiveToastHost()).toBe(sheet);
    // A second sheet over the first.
    const nested = registerToastHost();
    expect(getActiveToastHost()).toBe(nested);
    unregisterToastHost(nested);
    expect(getActiveToastHost()).toBe(sheet);
    unregisterToastHost(sheet);
    expect(getActiveToastHost()).toBe(root);
  });

  it("a host change notifies the hosts so they re-render", () => {
    let calls = 0;
    const off = subscribeToasts(() => {
      calls += 1;
    });
    const id = registerToastHost();
    unregisterToastHost(id);
    unregisterToastHost(id); // second unregister is a no-op
    expect(calls).toBe(2);
    off();
  });

  it("an out-of-order unmount (the lower host goes first) keeps the top host active", () => {
    const root = registerToastHost();
    const sheet = registerToastHost();
    unregisterToastHost(root);
    expect(getActiveToastHost()).toBe(sheet);
  });

  it("a toast is announced once even when it moves between hosts", () => {
    const id = toast({ title: "Kaydedildi" });
    expect(claimAnnouncement(id)).toBe(true);
    expect(claimAnnouncement(id)).toBe(false);
    const other = toast({ title: "Kopyalandı" });
    expect(claimAnnouncement(other)).toBe(true);
  });
});
