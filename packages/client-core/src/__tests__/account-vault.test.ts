import { describe, expect, it } from "vitest";
import {
  ACCOUNT_VAULT_STORAGE_KEY,
  AccountVault,
  MAX_STORED_ACCOUNTS,
  emptyVault,
  getActiveAccount,
  listAccounts,
  makeStoredAccount,
  mostRecentAccountId,
  normalizeAccountVault,
  normalizeStoredAccount,
  removeAccount,
  setActiveAccountId,
  upsertAccount,
  type AccountProfileInput,
  type AccountVaultData,
  type StoredAccount,
  type VaultStorage,
} from "../account-vault/index.js";

// --- fixtures ---------------------------------------------------------------

function profile(id: string, overrides: Partial<AccountProfileInput> = {}): AccountProfileInput {
  return {
    accountId: id,
    token: `token-${id}`,
    username: id,
    displayName: id,
    avatarUrl: null,
    ...overrides,
  };
}

function account(id: string, lastUsedAt: number): StoredAccount {
  return makeStoredAccount(profile(id), lastUsedAt);
}

/** In-memory VaultStorage with a controllable clock, mirroring the platform seam. */
function fakeStorage(initial: string | null = null) {
  let value = initial;
  const calls = { get: 0, set: 0, clear: 0 };
  const storage: VaultStorage = {
    async get() {
      calls.get += 1;
      return value;
    },
    async set(next) {
      calls.set += 1;
      value = next;
    },
    async clear() {
      calls.clear += 1;
      value = null;
    },
  };
  return {
    storage,
    calls,
    read: () => value,
    parsed: (): AccountVaultData => (value ? (JSON.parse(value) as AccountVaultData) : emptyVault()),
  };
}

/** Deterministic clock: each read returns the next scripted tick. */
function clock(start = 1_000) {
  let t = start;
  return {
    now: () => (t += 1),
    set: (v: number) => (t = v),
  };
}

// --- normalize / corrupt-blob resilience ------------------------------------

describe("normalizeStoredAccount", () => {
  it("drops records with no accountId or no token", () => {
    expect(normalizeStoredAccount(null)).toBeNull();
    expect(normalizeStoredAccount({ token: "t" })).toBeNull();
    expect(normalizeStoredAccount({ accountId: "u1" })).toBeNull();
    expect(normalizeStoredAccount({ accountId: "u1", token: "" })).toBeNull();
    expect(normalizeStoredAccount({ accountId: "", token: "t" })).toBeNull();
  });

  it("coerces missing/garbage fields to a clean shape", () => {
    const norm = normalizeStoredAccount({
      accountId: "u1",
      token: "t1",
      username: 42,
      displayName: null,
      avatarUrl: 99,
      lastUsedAt: "nope",
    });
    expect(norm).toEqual({
      accountId: "u1",
      token: "t1",
      username: "u1", // falls back to accountId
      displayName: "u1", // falls back to username
      avatarUrl: null, // non-string dropped
      lastUsedAt: 0, // non-number dropped
    });
  });

  it("rejects negative lastUsedAt", () => {
    expect(normalizeStoredAccount({ accountId: "u1", token: "t", lastUsedAt: -5 })?.lastUsedAt).toBe(0);
  });
});

describe("normalizeAccountVault", () => {
  it("returns an empty vault for junk input", () => {
    expect(normalizeAccountVault(null)).toEqual(emptyVault());
    expect(normalizeAccountVault("garbage")).toEqual(emptyVault());
    expect(normalizeAccountVault(42)).toEqual(emptyVault());
    expect(normalizeAccountVault({ accounts: "nope" })).toEqual(emptyVault());
  });

  it("keeps good records and drops corrupt ones", () => {
    const data = normalizeAccountVault({
      accounts: {
        u1: { accountId: "u1", token: "t1", username: "Ali", displayName: "Ali", avatarUrl: null, lastUsedAt: 10 },
        u2: { accountId: "u2" }, // corrupt (no token) → dropped
        u3: { accountId: "u3", token: "t3", lastUsedAt: 20 },
      },
      activeAccountId: "u3",
    });
    expect(Object.keys(data.accounts).sort()).toEqual(["u1", "u3"]);
    expect(data.activeAccountId).toBe("u3");
  });

  it("uses the record's own accountId, not the tampered map key", () => {
    const data = normalizeAccountVault({
      accounts: { "spoofed-key": { accountId: "real", token: "t", lastUsedAt: 1 } },
      activeAccountId: "real",
    });
    expect(Object.keys(data.accounts)).toEqual(["real"]);
    expect(getActiveAccount(data)?.accountId).toBe("real");
  });

  it("clears a dangling activeAccountId that points at no surviving record", () => {
    const data = normalizeAccountVault({
      accounts: { u1: { accountId: "u1", token: "t1", lastUsedAt: 1 } },
      activeAccountId: "ghost",
    });
    expect(data.activeAccountId).toBeNull();
  });
});

// --- pure reducers ----------------------------------------------------------

describe("pure reducers", () => {
  it("upsertAccount dedups by accountId (same id overwrites in place)", () => {
    let data = emptyVault();
    data = upsertAccount(data, account("u1", 10));
    data = upsertAccount(data, makeStoredAccount(profile("u1", { token: "fresh", displayName: "New" }), 20));
    expect(Object.keys(data.accounts)).toEqual(["u1"]);
    expect(data.accounts.u1?.token).toBe("fresh");
    expect(data.accounts.u1?.displayName).toBe("New");
    expect(data.accounts.u1?.lastUsedAt).toBe(20);
  });

  it("upsertAccount does not mutate its input", () => {
    const before = emptyVault();
    const after = upsertAccount(before, account("u1", 10));
    expect(before.accounts).toEqual({});
    expect(after).not.toBe(before);
  });

  it("setActiveAccountId marks active and bumps lastUsedAt", () => {
    let data = upsertAccount(emptyVault(), account("u1", 10));
    data = setActiveAccountId(data, "u1", 99);
    expect(data.activeAccountId).toBe("u1");
    expect(data.accounts.u1?.lastUsedAt).toBe(99);
  });

  it("setActiveAccountId ignores an unknown id (no-op)", () => {
    const data = upsertAccount(emptyVault(), account("u1", 10));
    expect(setActiveAccountId(data, "ghost", 99)).toBe(data);
  });

  it("setActiveAccountId(null) signs out of all", () => {
    let data = setActiveAccountId(upsertAccount(emptyVault(), account("u1", 10)), "u1", 20);
    data = setActiveAccountId(data, null, 30);
    expect(data.activeAccountId).toBeNull();
    expect(Object.keys(data.accounts)).toEqual(["u1"]); // record kept
  });

  it("removeAccount clears active when the active account is removed", () => {
    let data = setActiveAccountId(upsertAccount(emptyVault(), account("u1", 10)), "u1", 20);
    data = upsertAccount(data, account("u2", 15));
    data = removeAccount(data, "u1");
    expect(Object.keys(data.accounts)).toEqual(["u2"]);
    expect(data.activeAccountId).toBeNull();
  });

  it("removeAccount keeps active when a different account is removed", () => {
    let data = upsertAccount(emptyVault(), account("u1", 10));
    data = upsertAccount(data, account("u2", 15));
    data = setActiveAccountId(data, "u1", 20);
    data = removeAccount(data, "u2");
    expect(data.activeAccountId).toBe("u1");
  });

  it("listAccounts orders by lastUsedAt desc", () => {
    let data = upsertAccount(emptyVault(), account("old", 10));
    data = upsertAccount(data, account("new", 30));
    data = upsertAccount(data, account("mid", 20));
    expect(listAccounts(data).map((a) => a.accountId)).toEqual(["new", "mid", "old"]);
  });

  it("mostRecentAccountId honours the exclude filter", () => {
    let data = upsertAccount(emptyVault(), account("a", 10));
    data = upsertAccount(data, account("b", 30));
    expect(mostRecentAccountId(data)).toBe("b");
    expect(mostRecentAccountId(data, "b")).toBe("a");
    expect(mostRecentAccountId(emptyVault())).toBeNull();
  });

  it("evicts the least-recently-used non-active account past the cap", () => {
    let data = emptyVault();
    for (let i = 0; i < MAX_STORED_ACCOUNTS; i += 1) {
      data = upsertAccount(data, account(`u${i}`, i + 1)); // u0 oldest … u7 newest
    }
    data = setActiveAccountId(data, "u0", 500); // protect the oldest by making it active
    data = upsertAccount(data, account("overflow", 999));
    expect(Object.keys(data.accounts).length).toBe(MAX_STORED_ACCOUNTS);
    expect(data.accounts.overflow).toBeDefined();
    expect(data.accounts.u0).toBeDefined(); // active is protected
    expect(data.accounts.u1).toBeUndefined(); // LRU non-active evicted
  });
});

// --- AccountVault (storage-backed) ------------------------------------------

describe("AccountVault", () => {
  it("loads an empty vault when storage is empty", async () => {
    const { storage } = fakeStorage();
    const vault = new AccountVault(storage);
    expect(await vault.load()).toEqual(emptyVault());
    expect(vault.list()).toEqual([]);
    expect(vault.getActive()).toBeNull();
  });

  it("recovers to an empty vault from an unparseable blob (never throws)", async () => {
    const { storage } = fakeStorage("{not json");
    const vault = new AccountVault(storage);
    expect(await vault.load()).toEqual(emptyVault());
  });

  it("upsert write-throughs a normalized blob under the shared key", async () => {
    const c = clock();
    const io = fakeStorage();
    const vault = new AccountVault(io.storage, { now: c.now });
    await vault.load();
    const stored = await vault.upsert(profile("u1"));
    expect(stored.accountId).toBe("u1");
    // The active account is unchanged by a plain upsert.
    expect(vault.getActiveId()).toBeNull();
    // Persisted immediately.
    expect(io.parsed().accounts.u1?.token).toBe("token-u1");
    // The key the platform stores under is the shared constant.
    expect(ACCOUNT_VAULT_STORAGE_KEY).toBe("demli.account-vault");
  });

  it("addAndActivate records the account AND marks it active", async () => {
    const c = clock();
    const io = fakeStorage();
    const vault = new AccountVault(io.storage, { now: c.now });
    await vault.load();
    await vault.addAndActivate(profile("u1"));
    expect(vault.getActiveId()).toBe("u1");
    expect(io.parsed().activeAccountId).toBe("u1");
  });

  it("switches the active account with the newest lastUsedAt winning ordering", async () => {
    const c = clock();
    const vault = new AccountVault(fakeStorage().storage, { now: c.now });
    await vault.load();
    await vault.addAndActivate(profile("u1"));
    await vault.addAndActivate(profile("u2"));
    expect(vault.getActiveId()).toBe("u2");
    await vault.setActive("u1"); // switch back → u1 becomes most-recent
    expect(vault.getActiveId()).toBe("u1");
    expect(vault.list()[0]?.accountId).toBe("u1");
  });

  it("re-login for an existing account overwrites its token without duplicating", async () => {
    const vault = new AccountVault(fakeStorage().storage, { now: clock().now });
    await vault.load();
    await vault.addAndActivate(profile("u1", { token: "old" }));
    await vault.upsert(profile("u1", { token: "new" }));
    expect(vault.count()).toBe(1);
    expect(vault.get("u1")?.token).toBe("new");
  });

  it("removing the active account clears active and exposes the next most-recent", async () => {
    const vault = new AccountVault(fakeStorage().storage, { now: clock().now });
    await vault.load();
    await vault.addAndActivate(profile("u1"));
    await vault.addAndActivate(profile("u2")); // u2 active, newer
    const next = vault.mostRecentId("u2");
    await vault.remove("u2");
    expect(vault.getActiveId()).toBeNull();
    expect(next).toBe("u1"); // the UI switches here
    expect(vault.has("u2")).toBe(false);
  });

  it("clear() wipes storage and memory", async () => {
    const io = fakeStorage();
    const vault = new AccountVault(io.storage, { now: clock().now });
    await vault.load();
    await vault.addAndActivate(profile("u1"));
    await vault.clear();
    expect(vault.list()).toEqual([]);
    expect(vault.getActiveId()).toBeNull();
    expect(io.read()).toBeNull();
    expect(io.calls.clear).toBe(1);
  });

  it("survives a storage.set failure — in-memory stays authoritative", async () => {
    const failing: VaultStorage = {
      async get() {
        return null;
      },
      async set() {
        throw new Error("keystore unavailable");
      },
      async clear() {},
    };
    const vault = new AccountVault(failing, { now: clock().now });
    await vault.load();
    await expect(vault.addAndActivate(profile("u1"))).resolves.toBeDefined();
    expect(vault.getActiveId()).toBe("u1"); // memory holds even though disk failed
  });

  it("round-trips through storage into a second vault instance", async () => {
    const io = fakeStorage();
    const first = new AccountVault(io.storage, { now: clock().now });
    await first.load();
    await first.addAndActivate(profile("u1"));
    await first.upsert(profile("u2"));

    const second = new AccountVault(io.storage, { now: clock().now });
    await second.load();
    expect(second.getActiveId()).toBe("u1");
    expect(second.count()).toBe(2);
  });
});
