/**
 * Reactive mirror of the multi-account vault for the UI (M15 / ADR 0013) — the
 * mobile mirror of the desktop renderer's stores/accounts-store.ts.
 *
 * The `AccountVault` (lib/account-manager) is the source of truth; this zustand
 * store holds a render-friendly projection so the "You" switcher and add-account
 * flow re-render on change. `switching` drives a covering overlay while
 * `runAccountSwitch` tears the old identity down and brings the new one up, so no
 * stale (previous-account) data ever flashes mid-switch.
 */
import { create } from "zustand";
import type { AccountId, StoredAccount } from "@demli/client-core";

interface AccountsStore {
  /** Stored accounts, most-recently-used first (mirror of `vault.list()`). */
  accounts: StoredAccount[];
  /** The active account id, or null when signed out of all. */
  activeAccountId: AccountId | null;
  /** True while an account switch is in flight (drives the covering overlay). */
  switching: boolean;
  /** Set when the last switch completed but a best-effort bringup step failed. */
  switchWarning: boolean;

  /** Internal: replace the mirrored snapshot after a vault mutation. */
  _syncFromVault: (accounts: StoredAccount[], activeAccountId: AccountId | null) => void;
  setSwitching: (switching: boolean) => void;
  setSwitchWarning: (switchWarning: boolean) => void;
}

export const useAccountsStore = create<AccountsStore>()((set) => ({
  accounts: [],
  activeAccountId: null,
  switching: false,
  switchWarning: false,

  _syncFromVault: (accounts, activeAccountId) => set({ accounts, activeAccountId }),
  setSwitching: (switching) => set({ switching }),
  setSwitchWarning: (switchWarning) => set({ switchWarning }),
}));
