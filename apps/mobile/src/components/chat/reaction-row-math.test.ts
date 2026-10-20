import { describe, expect, it } from "vitest";
import { quickReactionLayout } from "./reaction-row-math";

// The sheet pads its body by 8 and the row by 4 on each side: 24dp in total.
const row = (screen: number) => screen - 24;

/** Total width the row's cells take. */
const used = (l: { count: number; cell: number }, hasMore: boolean) =>
  (l.count + (hasMore ? 1 : 0)) * l.cell;

describe("quickReactionLayout", () => {
  it.each([320, 360, 384, 393, 412, 430])("never runs past a %idp screen", (screen) => {
    const l = quickReactionLayout(row(screen), 8, true);
    expect(used(l, true)).toBeLessThanOrEqual(row(screen));
    expect(l.cell).toBeGreaterThanOrEqual(36);
    expect(l.cell).toBeLessThanOrEqual(44);
  });

  it("keeps the whole palette when 9 cells of 40dp+ fit", () => {
    expect(quickReactionLayout(row(393), 8, true)).toEqual({ count: 8, cell: 41 });
    expect(quickReactionLayout(row(412), 8, true)).toEqual({ count: 8, cell: 43 });
  });

  it("drops trailing emoji, never 'more', on a 360dp phone", () => {
    expect(quickReactionLayout(row(360), 8, true)).toEqual({ count: 7, cell: 42 });
  });

  it("caps at a 44dp cell on a wide screen", () => {
    expect(quickReactionLayout(row(600), 8, true).cell).toBe(44);
  });

  it("without 'more' it shrinks instead of hiding an emoji (nothing else reaches it)", () => {
    const l = quickReactionLayout(row(320), 8, false);
    expect(l.count).toBe(8);
    expect(used(l, false)).toBeLessThanOrEqual(row(320));
  });
});
