/**
 * Multi-account vault + switch-reset contract (ADR 0013). The shared, framework-
 * free core both desktop and mobile consume; platform storage (safeStorage /
 * SecureStore) and the switch effects (query cache, stores, voice, realtime) are
 * injected by each app's glue in the next wave.
 */

export {
  ACCOUNT_VAULT_STORAGE_KEY,
  MAX_STORED_ACCOUNTS,
  accountCount,
  emptyVault,
  getAccount,
  getActiveAccount,
  hasAccount,
  listAccounts,
  makeStoredAccount,
  mostRecentAccountId,
  normalizeAccountVault,
  normalizeStoredAccount,
  removeAccount,
  setActiveAccountId,
  upsertAccount,
} from "./vault-model.js";
export type {
  AccountId,
  AccountProfileInput,
  AccountVaultData,
  StoredAccount,
} from "./vault-model.js";

export { AccountVault } from "./account-vault.js";
export type { AccountVaultOptions, VaultStorage } from "./account-vault.js";

export { ACCOUNT_SWITCH_STEPS, AccountSwitchTimeoutError, runAccountSwitch } from "./switch-reset.js";
export type {
  AccountSwitchEffects,
  AccountSwitchOptions,
  AccountSwitchPhase,
  AccountSwitchResult,
  AccountSwitchStep,
  AccountSwitchStepError,
  AccountSwitchStepId,
} from "./switch-reset.js";

export { DEFAULT_TOKEN_PROBE_TIMEOUT_MS, probeAccountToken } from "./token-probe.js";
export type { ProbeFetch, TokenProbeOptions, TokenProbeResult } from "./token-probe.js";

export { runGuardedAccountSwitch } from "./guarded-switch.js";
export type {
  GuardedAccountSwitchInput,
  GuardedAccountSwitchResult,
  GuardedAccountSwitchStatus,
} from "./guarded-switch.js";
