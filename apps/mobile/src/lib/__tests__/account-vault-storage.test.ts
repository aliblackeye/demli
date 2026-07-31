import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCOUNT_VAULT_STORAGE_KEY } from "@demli/client-core";

// The adapter's only dependency is expo-secure-store (a native module). Replace it
// wholesale so this pure-logic test runs in the node env like the rest of the suite.
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

import * as SecureStore from "expo-secure-store";
import { vaultStorage } from "../account-vault-storage";

afterEach(() => {
  vi.clearAllMocks();
});

describe("mobile vaultStorage (VaultStorage over expo-secure-store)", () => {
  it("get reads the vault blob under ACCOUNT_VAULT_STORAGE_KEY", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValue('{"accounts":{}}');

    const value = await vaultStorage.get();

    expect(SecureStore.getItemAsync).toHaveBeenCalledWith(ACCOUNT_VAULT_STORAGE_KEY);
    expect(value).toBe('{"accounts":{}}');
  });

  it("get returns null when the keystore throws (never propagates)", async () => {
    vi.mocked(SecureStore.getItemAsync).mockRejectedValue(new Error("keystore locked"));
    await expect(vaultStorage.get()).resolves.toBeNull();
  });

  it("set write-throughs the serialized blob under the vault key", async () => {
    vi.mocked(SecureStore.setItemAsync).mockResolvedValue(undefined);

    await vaultStorage.set('{"accounts":{"u1":{}}}');

    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      ACCOUNT_VAULT_STORAGE_KEY,
      '{"accounts":{"u1":{}}}',
    );
  });

  it("set swallows a keystore failure (best-effort persistence)", async () => {
    vi.mocked(SecureStore.setItemAsync).mockRejectedValue(new Error("disk full"));
    await expect(vaultStorage.set("{}")).resolves.toBeUndefined();
  });

  it("clear deletes the vault key (full sign-out of every account)", async () => {
    vi.mocked(SecureStore.deleteItemAsync).mockResolvedValue(undefined);

    await vaultStorage.clear();

    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith(ACCOUNT_VAULT_STORAGE_KEY);
  });

  it("uses the SAME shared key the desktop safeStorage bridge persists under", () => {
    // The key is defined once in the shared vault model so both platforms agree.
    expect(ACCOUNT_VAULT_STORAGE_KEY).toBe("demli.account-vault");
  });
});
