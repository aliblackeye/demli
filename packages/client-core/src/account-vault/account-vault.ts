/**
 * AccountVault — the storage-backed multi-account registry (ADR 0013).
 *
 * A thin async wrapper that composes the pure reducers in vault-model.ts with a
 * platform {@link VaultStorage} seam. It caches the vault in memory (the source
 * of truth after {@link AccountVault.load}) and write-throughs every mutation to
 * storage as a normalized JSON string — exactly the string in / string out shape
 * of the existing `TokenStorage` seam (ADR 0002), so a platform reuses its
 * encrypted store (Electron safeStorage bridge / expo-secure-store) with almost
 * no new code.
 *
 * The vault is a REGISTRY, not the live session. It never touches the api client,
 * the WebSocket, the query cache, or the voice engine — flipping the active
 * account (and tearing the old one down without leaving a zombie) is the job of
 * `runAccountSwitch` in switch-reset.ts, which the platform wires with this vault
 * as one of its injected effects.
 */

import {
  accountCount,
  emptyVault,
  getAccount,
  getActiveAccount,
  hasAccount,
  listAccounts,
  makeStoredAccount,
  mostRecentAccountId,
  normalizeAccountVault,
  removeAccount,
  setActiveAccountId,
  upsertAccount,
  type AccountId,
  type AccountProfileInput,
  type AccountVaultData,
  type StoredAccount,
} from "./vault-model.js";

/**
 * Platform persistence seam for the vault — the interface lives here (shared),
 * the IMPLEMENTATION stays per-app because storage is platform-specific:
 *
 * - desktop → Electron `safeStorage` behind the preload bridge (OS-encrypted).
 * - mobile  → `expo-secure-store`.
 *
 * Deals in serialized JSON strings (mirrors {@link import("./index.js")} /
 * TokenStorage) so the encrypted backends fit unchanged. Async by design so the
 * secure-store backends (which are async) satisfy it directly.
 */
export interface VaultStorage {
  /** The persisted blob as a string, or null when nothing is stored. */
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  /** Wipe the whole vault (full sign-out of every account). */
  clear(): Promise<void>;
}

export interface AccountVaultOptions {
  /** Injected clock (epoch ms) — defaults to Date.now; overridden in tests. */
  now?: () => number;
}

export class AccountVault {
  private data: AccountVaultData = emptyVault();
  private readonly storage: VaultStorage;
  private readonly now: () => number;

  constructor(storage: VaultStorage, options: AccountVaultOptions = {}) {
    this.storage = storage;
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Read + normalize the persisted blob into the in-memory cache. Corrupt,
   * legacy, or absent storage yields an empty vault (never throws). Call once on
   * boot before reading; returns the loaded snapshot.
   */
  async load(): Promise<AccountVaultData> {
    let raw: unknown = null;
    try {
      const stored = await this.storage.get();
      raw = stored === null ? null : (JSON.parse(stored) as unknown);
    } catch {
      // Unavailable storage or unparseable blob → start clean.
      raw = null;
    }
    this.data = normalizeAccountVault(raw);
    return this.data;
  }

  /** The current in-memory vault (source of truth after {@link load}). */
  snapshot(): AccountVaultData {
    return this.data;
  }

  /** All accounts, most-recently-used first. */
  list(): StoredAccount[] {
    return listAccounts(this.data);
  }

  get(accountId: AccountId): StoredAccount | null {
    return getAccount(this.data, accountId);
  }

  has(accountId: AccountId): boolean {
    return hasAccount(this.data, accountId);
  }

  getActive(): StoredAccount | null {
    return getActiveAccount(this.data);
  }

  getActiveId(): AccountId | null {
    return this.data.activeAccountId;
  }

  count(): number {
    return accountCount(this.data);
  }

  /** Most-recently-used account id, optionally excluding one (e.g. on removal). */
  mostRecentId(excludeId?: AccountId): AccountId | null {
    return mostRecentAccountId(this.data, excludeId);
  }

  /**
   * Add or refresh a record (dedup by accountId — a re-login overwrites token +
   * profile in place). Does NOT change the active account; use {@link addAndActivate}
   * for the "add account and land on it" flow, or call {@link setActive} after.
   */
  async upsert(input: AccountProfileInput): Promise<StoredAccount> {
    const account = makeStoredAccount(input, this.now());
    this.data = upsertAccount(this.data, account);
    await this.persist();
    return account;
  }

  /**
   * Upsert then mark active — the completion of an "add account" login. The
   * caller still runs {@link import("./switch-reset.js").runAccountSwitch} to tear
   * the previous session down; this only records the new account as current.
   */
  async addAndActivate(input: AccountProfileInput): Promise<StoredAccount> {
    const account = makeStoredAccount(input, this.now());
    this.data = setActiveAccountId(upsertAccount(this.data, account), account.accountId, account.lastUsedAt);
    await this.persist();
    return account;
  }

  /**
   * Mark an already-stored account active (bumps its lastUsedAt). Passing null
   * signs out of all accounts; passing an unknown id is a no-op.
   */
  async setActive(accountId: AccountId | null): Promise<void> {
    this.data = setActiveAccountId(this.data, accountId, this.now());
    await this.persist();
  }

  /**
   * Remove a record. Removing the active account clears the active id to null
   * (the caller decides whether to switch to {@link mostRecentId} or sign out).
   */
  async remove(accountId: AccountId): Promise<void> {
    this.data = removeAccount(this.data, accountId);
    await this.persist();
  }

  /** Wipe every account (full sign-out). */
  async clear(): Promise<void> {
    this.data = emptyVault();
    try {
      await this.storage.clear();
    } catch {
      // Best effort — the in-memory vault is already empty for this session.
    }
  }

  private async persist(): Promise<void> {
    try {
      await this.storage.set(JSON.stringify(this.data));
    } catch {
      // Storage unavailable — the in-memory vault stays authoritative for the
      // session; the choice just won't survive a relaunch (mirrors TokenStorage).
    }
  }
}
