/**
 * The admin screens' load-state rule. The bug this pins: a failed request
 * (offline, 5xx) rendered "This channel no longer exists." with only Back,
 * because "not loading + no entity" was read as "deleted".
 */
import { describe, expect, it } from "vitest";
import { resolveEntityLoadState } from "../load-state";

describe("resolveEntityLoadState", () => {
  it("a failed request is an error, never 'not found'", () => {
    // Also while Retry runs: TanStack keeps status "error" during the refetch,
    // so isLoading stays false and the error block (with its spinner) remains.
    expect(resolveEntityLoadState({ isLoading: false, isError: true }, false)).toBe("error");
  });

  it("a first fetch in flight is loading", () => {
    expect(resolveEntityLoadState({ isLoading: true, isError: false }, false)).toBe("loading");
  });

  it("only a successful fetch without the entity is missing", () => {
    expect(resolveEntityLoadState({ isLoading: false, isError: false }, false)).toBe("missing");
  });

  it("an entity in hand wins over a failed background refetch", () => {
    expect(resolveEntityLoadState({ isLoading: false, isError: true }, true)).toBe("ready");
    expect(resolveEntityLoadState({ isLoading: false, isError: false }, true)).toBe("ready");
  });
});
