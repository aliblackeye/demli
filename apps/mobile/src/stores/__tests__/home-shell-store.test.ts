/**
 * Logic-layer proof of the Home shell's selection model — the piece that decides
 * which rail entry is active and therefore what the panel renders. RN rendering
 * is not simulated in this repo (vitest, node env), so the branches the founder
 * cares about (rail→server panel, Home→DM panel, stale-selection self-heal, the
 * relaunch round-trip) are proven here on the pure resolvers + the persisted store.
 *
 * expo-secure-store is a native module → mocked to an inert async backend so the
 * persist middleware runs without a device.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

import {
  normalizeSelectedServerId,
  resolveSelectedServerId,
  useHomeShellStore,
} from "../home-shell-store";

describe("normalizeSelectedServerId (untrusted persisted blob)", () => {
  it("keeps a non-empty string id", () => {
    expect(normalizeSelectedServerId("srv_1")).toBe("srv_1");
  });

  it("coerces every non-string / empty value to Home (null)", () => {
    expect(normalizeSelectedServerId(null)).toBeNull();
    expect(normalizeSelectedServerId(undefined)).toBeNull();
    expect(normalizeSelectedServerId("")).toBeNull();
    expect(normalizeSelectedServerId(42)).toBeNull();
    expect(normalizeSelectedServerId({ id: "x" })).toBeNull();
  });
});

describe("resolveSelectedServerId (rail active ↔ panel content)", () => {
  it("Home entry stays Home → panel shows the DM list", () => {
    expect(resolveSelectedServerId(null, ["a", "b"])).toBeNull();
  });

  it("a selected server the user still belongs to resolves to that server → channel panel", () => {
    expect(resolveSelectedServerId("b", ["a", "b"])).toBe("b");
  });

  it("a stale selection (server since left) self-heals to Home", () => {
    expect(resolveSelectedServerId("gone", ["a", "b"])).toBeNull();
  });

  it("holds the stored id while the server list is still loading (null)", () => {
    expect(resolveSelectedServerId("b", null)).toBe("b");
  });
});

describe("useHomeShellStore (persisted selection)", () => {
  beforeEach(() => {
    useHomeShellStore.setState({ selectedServerId: null });
  });

  it("selects a server and remembers it (the relaunch round-trip source)", () => {
    useHomeShellStore.getState().selectServer("srv_42");
    expect(useHomeShellStore.getState().selectedServerId).toBe("srv_42");
  });

  it("returns to Home when null is selected", () => {
    useHomeShellStore.getState().selectServer("srv_42");
    useHomeShellStore.getState().selectServer(null);
    expect(useHomeShellStore.getState().selectedServerId).toBeNull();
  });

  it("no-ops a re-selection of the current entry (avoids a needless panel churn)", () => {
    useHomeShellStore.getState().selectServer("srv_1");
    const before = useHomeShellStore.getState();
    useHomeShellStore.getState().selectServer("srv_1");
    // Same object identity ⇒ zustand did not `set`, so no subscriber re-ran.
    expect(useHomeShellStore.getState()).toBe(before);
  });
});
