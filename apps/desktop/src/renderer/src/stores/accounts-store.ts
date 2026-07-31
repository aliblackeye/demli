/**
 * Reactive mirror of the multi-account vault for the UI (M15 / ADR 0013).
 *
 * The `AccountVault` (lib/account-manager) is the source of truth; this zustand
 * store only holds a render-friendly projection so the profile-menu switcher and
 * the "add account" overlay re-render on change. Every vault mutation calls
 * {@link useAccountsStore.getState}._syncFromVault to push the new snapshot here —
 * components never touch the vault directly.
 *
 * It also owns two pieces of switch UI state:
 *  - `switching` — a full-screen "switching account…" overlay is shown while
 *    `runAccountSwitch` tears the old identity down and brings the new one up, so
 *    no stale (previous-account) data ever flashes mid-switch.
 *  - `addingAccount` — the login screen is shown as an OVERLAY (current session
 *    kept live) for the "Hesap ekle" flow.
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
  /** True while the "add account" login overlay is open. */
  addingAccount: boolean;
  /**
   * When the add-account overlay is open for a RE-AUTH (a stored account whose
   * session died, #100), the handle to prefill; null for a normal "add account".
   */
  reauthUsername: string | null;
  /**
   * Set when the last switch completed but a best-effort bringup step failed
   * (e.g. profile refresh) — the UI can show a soft, non-blocking warning.
   */
  switchWarning: boolean;
  /**
   * A transient, non-blocking switch error to toast (`offline` = the target
   * account was unreachable so the switch was cancelled). Cleared on dismiss.
   */
  switchError: "offline" | null;

  /** Internal: replace the mirrored snapshot after a vault mutation. */
  _syncFromVault: (accounts: StoredAccount[], activeAccountId: AccountId | null) => void;
  setSwitching: (switching: boolean) => void;
  /** Toggle the add-account overlay; always clears any re-auth prefill. */
  setAddingAccount: (addingAccount: boolean) => void;
  /** Open the add-account overlay in RE-AUTH mode, prefilled for `username` (#100). */
  beginReauth: (username: string) => void;
  setSwitchWarning: (switchWarning: boolean) => void;
  setSwitchError: (switchError: "offline" | null) => void;
}

export const useAccountsStore = create<AccountsStore>()((set) => ({
  accounts: [],
  activeAccountId: null,
  switching: false,
  addingAccount: false,
  reauthUsername: null,
  switchWarning: false,
  switchError: null,

  _syncFromVault: (accounts, activeAccountId) => set({ accounts, activeAccountId }),
  setSwitching: (switching) => set({ switching }),
  setAddingAccount: (addingAccount) => set({ addingAccount, reauthUsername: null }),
  beginReauth: (username) => set({ addingAccount: true, reauthUsername: username, switchError: null }),
  setSwitchWarning: (switchWarning) => set({ switchWarning }),
  setSwitchError: (switchError) => set({ switchError }),
}));
