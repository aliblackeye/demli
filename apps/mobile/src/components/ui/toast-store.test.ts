import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DURATION,
  MAX_VISIBLE,
  dismissToast,
  getToasts,
  resetToastsForTest,
  subscribeToasts,
  toast,
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
