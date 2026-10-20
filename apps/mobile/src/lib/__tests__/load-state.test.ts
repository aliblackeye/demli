/**
 * The admin screens' load-state rule. The bug this pins: a failed request
 * (offline, 5xx) rendered "This channel no longer exists." with only Back,
 * because "not loading + no entity" was read as "deleted".
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveEntityLoadState, resolveListLoadState } from "../load-state";

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

describe("resolveListLoadState (server settings roles)", () => {
  it("never says 'empty' while loading or after a failure", () => {
    expect(resolveListLoadState({ isLoading: true, isError: false }, undefined)).toBe("loading");
    expect(resolveListLoadState({ isLoading: false, isError: true }, undefined)).toBe("error");
  });

  it("'empty' only after a successful empty answer; cached items win", () => {
    expect(resolveListLoadState({ isLoading: false, isError: false }, [])).toBe("empty");
    expect(resolveListLoadState({ isLoading: false, isError: true }, [{}])).toBe("ready");
    expect(resolveListLoadState({ isLoading: false, isError: false }, [{}])).toBe("ready");
  });

  it("server settings gates 'no roles yet' on that state, not on `roles ?? []`", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const screen = readFileSync(join(here, "..", "..", "..", "app", "(app)", "server-settings.tsx"), "utf8");
    expect(screen).toContain("resolveListLoadState(rolesQuery, roles)");
    expect(screen).not.toMatch(/\(roles \?\? \[\]\)\.length === 0/);
    const none = screen.indexOf('t("mobile:serverSettings.noRoles")');
    expect(screen.slice(Math.max(0, none - 120), none)).toContain('rolesState === "empty"');
  });
});
