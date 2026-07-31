/**
 * Multi-account vault — the PURE data model (ADR 0013).
 *
 * Demli keeps several signed-in accounts side by side (the "hesap değiştir"
 * menu): the user holds a live session token per account and flips between
 * them from the profile menu without re-typing a password. This file owns the
 * SHAPE of that vault and the pure, framework-free helpers over it — no storage,
 * no clock, no I/O. `AccountVault` (account-vault.ts) wraps a platform
 * {@link VaultStorage} around these reducers; the switch-reset sequence lives in
 * switch-reset.ts.
 *
 * PLATFORM-AGNOSTIC by construction (mirrors participant-volume.ts): desktop and
 * mobile share ONE model — the record shape, the clamp/normalize of an untrusted
 * persisted blob, the storage KEY, and the dedup/ordering rules. Each platform
 * owns only the persistence I/O (safeStorage bridge on desktop, expo-secure-store
 * on mobile), injected via {@link VaultStorage}.
 *
 * accountId === the user's own id (one record per user), so a re-login for an
 * already-stored account OVERWRITES its record rather than duplicating it.
 */

import type { UserId } from "@demli/types";

/** A vault record is keyed by the user's own id — one account per user. */
export type AccountId = UserId;

/**
 * Storage key both platforms persist the vault under (localStorage/safeStorage on
 * desktop, SecureStore on mobile). Shared so the clients agree on where it lives.
 * The token(s) inside make this SENSITIVE — platforms MUST use their encrypted
 * store, never plain localStorage (security parity with TokenStorage, ADR 0002).
 */
export const ACCOUNT_VAULT_STORAGE_KEY = "demli.account-vault";

/**
 * Upper bound on stored accounts. A vault that grows without limit is a token
 * hoard; past the cap the least-recently-used NON-active record is evicted on the
 * next add. Not a product surface — a safety rail, generous enough that no real
 * user hits it.
 */
export const MAX_STORED_ACCOUNTS = 8;

/**
 * One signed-in account. `token` is the opaque session token (validated
 * server-side on every use); the three display fields are a CACHED projection of
 * the {@link import("@demli/types").User} for the switcher UI, refreshed from
 * `getMe` on switch (see switch-reset `profileRefresh`). `lastUsedAt` (epoch ms)
 * orders the switcher and drives LRU eviction.
 */
export interface StoredAccount {
  accountId: AccountId;
  token: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
  lastUsedAt: number;
}

/** The whole persisted blob: the record set plus which one is signed in. */
export interface AccountVaultData {
  /** accountId → record. Keyed (not an array) so a re-login dedups by overwrite. */
  accounts: Record<AccountId, StoredAccount>;
  /** The account currently active, or null when signed out of all of them. */
  activeAccountId: AccountId | null;
}

/**
 * What a fresh login / `getMe` supplies to seed or refresh a record. `lastUsedAt`
 * is stamped by the vault (the clock is injected, never read here), and
 * `displayName` falls back to `username` when blank.
 */
export interface AccountProfileInput {
  accountId: AccountId;
  token: string;
  username: string;
  displayName: string;
  avatarUrl?: string | null;
}

/** A pristine, empty vault. */
export function emptyVault(): AccountVaultData {
  return { accounts: {}, activeAccountId: null };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Build a record from a login/refresh input, stamping `lastUsedAt` = `now`. */
export function makeStoredAccount(input: AccountProfileInput, now: number): StoredAccount {
  return {
    accountId: input.accountId,
    token: input.token,
    username: input.username,
    // A blank display name would render an empty switcher row — fall back to the
    // handle, which the User contract guarantees is present.
    displayName: isNonEmptyString(input.displayName) ? input.displayName : input.username,
    avatarUrl: input.avatarUrl ?? null,
    lastUsedAt: Number.isFinite(now) ? now : 0,
  };
}

/**
 * Validate/repair ONE untrusted record. A record with no accountId or no token is
 * useless (can't key it, can't authenticate) → dropped (null). Everything else is
 * coerced to a clean shape; never throws.
 */
export function normalizeStoredAccount(raw: unknown): StoredAccount | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!isNonEmptyString(r.accountId) || !isNonEmptyString(r.token)) return null;
  const username = isNonEmptyString(r.username) ? r.username : r.accountId;
  const displayName = isNonEmptyString(r.displayName) ? r.displayName : username;
  const avatarUrl = isNonEmptyString(r.avatarUrl) ? r.avatarUrl : null;
  const lastUsedAt =
    typeof r.lastUsedAt === "number" && Number.isFinite(r.lastUsedAt) && r.lastUsedAt >= 0
      ? r.lastUsedAt
      : 0;
  return { accountId: r.accountId, token: r.token, username, displayName, avatarUrl, lastUsedAt };
}

/**
 * Validate/repair the whole persisted blob into a clean {@link AccountVaultData}.
 * Junk records are dropped; a record's own `accountId` (not its map key) is
 * authoritative, so a tampered key can't shadow another account. A dangling
 * `activeAccountId` (points at no surviving record) is cleared to null so the app
 * lands on the picker instead of a phantom session. Never throws — a corrupt or
 * legacy blob yields an empty vault.
 */
export function normalizeAccountVault(raw: unknown): AccountVaultData {
  const out = emptyVault();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  const rawAccounts = r.accounts;
  if (rawAccounts && typeof rawAccounts === "object") {
    for (const value of Object.values(rawAccounts as Record<string, unknown>)) {
      const account = normalizeStoredAccount(value);
      if (account) out.accounts[account.accountId] = account;
    }
  }
  if (isNonEmptyString(r.activeAccountId) && out.accounts[r.activeAccountId]) {
    out.activeAccountId = r.activeAccountId;
  }
  return out;
}

// -- selectors ---------------------------------------------------------------

/** All accounts, most-recently-used first (stable tiebreak by name then id). */
export function listAccounts(data: AccountVaultData): StoredAccount[] {
  return Object.values(data.accounts).sort((a, b) => {
    if (b.lastUsedAt !== a.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
    if (a.displayName !== b.displayName) return a.displayName.localeCompare(b.displayName);
    return a.accountId.localeCompare(b.accountId);
  });
}

export function getAccount(data: AccountVaultData, accountId: AccountId): StoredAccount | null {
  return data.accounts[accountId] ?? null;
}

export function hasAccount(data: AccountVaultData, accountId: AccountId): boolean {
  return data.accounts[accountId] !== undefined;
}

export function getActiveAccount(data: AccountVaultData): StoredAccount | null {
  return data.activeAccountId ? (data.accounts[data.activeAccountId] ?? null) : null;
}

export function accountCount(data: AccountVaultData): number {
  return Object.keys(data.accounts).length;
}

/**
 * The most-recently-used account id, optionally excluding one (e.g. the account
 * being removed, to pick who to switch to next). Null when none qualifies.
 */
export function mostRecentAccountId(
  data: AccountVaultData,
  excludeId?: AccountId,
): AccountId | null {
  for (const account of listAccounts(data)) {
    if (account.accountId !== excludeId) return account.accountId;
  }
  return null;
}

// -- pure reducers (never mutate the input) ----------------------------------

/**
 * Add or overwrite a record (dedup by accountId — a re-login replaces the old
 * token/profile in place). Adding a NEW account past {@link MAX_STORED_ACCOUNTS}
 * evicts the least-recently-used account that is neither active nor the one just
 * added. Does NOT change `activeAccountId` — activation is a separate step.
 */
export function upsertAccount(data: AccountVaultData, account: StoredAccount): AccountVaultData {
  const accounts: Record<AccountId, StoredAccount> = {
    ...data.accounts,
    [account.accountId]: account,
  };
  const next: AccountVaultData = { accounts, activeAccountId: data.activeAccountId };
  return enforceCap(next, account.accountId);
}

function enforceCap(data: AccountVaultData, keepId: AccountId): AccountVaultData {
  let accounts = data.accounts;
  while (Object.keys(accounts).length > MAX_STORED_ACCOUNTS) {
    const victim = evictionCandidate(accounts, data.activeAccountId, keepId);
    if (!victim) break; // only protected records remain — leave the vault as-is
    const { [victim]: _removed, ...rest } = accounts;
    void _removed;
    accounts = rest;
  }
  return accounts === data.accounts ? data : { ...data, accounts };
}

function evictionCandidate(
  accounts: Record<AccountId, StoredAccount>,
  activeId: AccountId | null,
  keepId: AccountId,
): AccountId | null {
  let victim: StoredAccount | null = null;
  for (const account of Object.values(accounts)) {
    if (account.accountId === activeId || account.accountId === keepId) continue;
    if (!victim || account.lastUsedAt < victim.lastUsedAt) victim = account;
  }
  return victim ? victim.accountId : null;
}

/**
 * Set the active account and stamp its `lastUsedAt` = `now` (a switch counts as
 * use). Passing null signs out of all accounts. Passing an id that is NOT stored
 * is a no-op (returns the input unchanged) — resilience against a stale id.
 */
export function setActiveAccountId(
  data: AccountVaultData,
  accountId: AccountId | null,
  now: number,
): AccountVaultData {
  if (accountId === null) {
    return data.activeAccountId === null ? data : { ...data, activeAccountId: null };
  }
  const account = data.accounts[accountId];
  if (!account) return data;
  return {
    activeAccountId: accountId,
    accounts: { ...data.accounts, [accountId]: { ...account, lastUsedAt: now } },
  };
}

/**
 * Remove a record. Removing the ACTIVE account clears `activeAccountId` to null
 * (the caller then either switches to {@link mostRecentAccountId} or signs out).
 * Removing an absent id is a no-op.
 */
export function removeAccount(data: AccountVaultData, accountId: AccountId): AccountVaultData {
  if (!data.accounts[accountId]) return data;
  const { [accountId]: _removed, ...rest } = data.accounts;
  void _removed;
  return {
    accounts: rest,
    activeAccountId: data.activeAccountId === accountId ? null : data.activeAccountId,
  };
}
