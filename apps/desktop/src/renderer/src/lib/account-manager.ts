/**
 * Desktop account manager (M15 / ADR 0013) — the platform glue that wires the
 * shared multi-account vault + switch-reset contract into the renderer's real
 * stores and clients.
 *
 * The shared core (`@demli/client-core/account-vault`) owns the vault shape
 * and the ORDERED teardown→pivot→bringup (`runAccountSwitch`). This module owns
 * the desktop half: the `AccountVault` singleton (over the safeStorage
 * `vaultStorage` seam), the nine switch EFFECTS bound to the renderer's actual
 * functions, and the high-level operations the UI calls (switch / add / remove /
 * sign out) plus the boot seed + one-time migration.
 *
 * WHY this is the single switch driver (not React): a switch keeps `status`
 * "authenticated" the whole time, so App.tsx's session effect (keyed on `status`)
 * deliberately does NOT re-fire — `runAccountSwitch` here owns realtime/call/store
 * teardown+bringup in the exact contract order, avoiding a race between an
 * imperative switch and a declarative effect (which is what produced the original
 * "zombie session").
 */

import {
  AccountVault,
  ApiClientError,
  probeAccountToken,
  runAccountSwitch,
  runGuardedAccountSwitch,
  type AccountId,
  type AccountSwitchEffects,
  type StoredAccount,
} from "@demli/client-core";
import type { User } from "@demli/types";
import { vaultStorage } from "./account-vault-storage";
import { api, apiBaseUrl } from "./api-client";
import { desktopSessionMetadata } from "./session-metadata";
import { queryClient } from "./query-client";
import { startRealtime, stopRealtime } from "../realtime/connection";
import { attachOutbox, detachOutbox } from "../realtime/outbox";
import { disposeCallController, initCallController } from "./call-controller";
import { clearUnreadMarkers } from "./unread-storage";
import { useAccountsStore } from "../stores/accounts-store";
import { useAuthStore } from "../stores/auth-store";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import { useVideoStageStore } from "../stores/video-stage-store";
import { useVoiceOccupancyStore } from "../stores/voice-occupancy-store";
import { leaveVoiceForReset } from "../stores/voice-store";

/** The single account vault, backed by the OS-encrypted safeStorage bridge. */
const accountVault = new AccountVault(vaultStorage);

/** True once {@link ensureVaultLoaded} has read the persisted blob this session. */
let vaultLoaded = false;

/** Push the vault's current snapshot into the reactive UI store. */
function mirror(): void {
  useAccountsStore.getState()._syncFromVault(accountVault.list(), accountVault.getActiveId());
}

/** The display projection a `User` contributes to a stored account record. */
function projectionOf(user: User, token: string) {
  return {
    accountId: user.id,
    token,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
  };
}

/** Load the persisted vault once (idempotent). Safe before auth is known. */
export async function ensureVaultLoaded(): Promise<void> {
  if (vaultLoaded) return;
  await accountVault.load();
  vaultLoaded = true;
  mirror();
}

/**
 * Record the just-authenticated account as active in the vault and mirror it.
 * Called after a first-login / register / boot-validation success — this is also
 * the ADR 0013 one-time migration: an existing single-account user (token in the
 * secure-token store, no vault yet) is silently seeded into the vault here.
 */
export async function seedActiveAccount(user: User, token: string): Promise<void> {
  await ensureVaultLoaded();
  await accountVault.addAndActivate(projectionOf(user, token));
  mirror();
}

// ---------------------------------------------------------------------------
// The nine switch effects (ADR 0013) bound to the renderer's real functions.
// ---------------------------------------------------------------------------

function buildSwitchEffects(target: StoredAccount): AccountSwitchEffects {
  return {
    // 1. Teardown — hang up any live/ringing DM call (old token still valid).
    endActiveCall: () => {
      disposeCallController();
    },
    // 2. Teardown — leave the LiveKit room / release mic+screen (NOT dispose; the
    //    engine is a lifetime singleton, see leaveVoiceForReset).
    voiceLeaveDispose: () => leaveVoiceForReset(),
    // 3. Teardown — close the WebSocket bound to the OLD token (stop its backoff).
    realtimeDisconnect: () => {
      stopRealtime();
      // Persistent send queue (M17): detach from the OLD account's blob before
      // the identity flips, so its unsent messages stay on disk for that account
      // and can never drain into the next session.
      void detachOutbox();
    },
    // 4. PIVOT — flip identity: vault active + auth bearer + secure-token cache +
    //    a transient cached identity so the shell shows the new account at once
    //    (profileRefresh replaces it with the full server profile).
    activateToken: async () => {
      await accountVault.setActive(target.accountId);
      await useAuthStore.getState().pivotSession(target.token);
      useAuthStore.getState().setUser(transientUser(target));
    },
    // 5. Bringup — drop ALL cached server data from the old identity.
    queryCacheClear: () => {
      queryClient.clear();
    },
    // 6. Bringup — reset every per-user in-memory / local store (the ADR
    //    storeReset surface): chat selection+unread+mutes+presence+typing+users,
    //    the non-partitioned unread watermarks, occupancy, video stage, UI chrome.
    storeReset: () => {
      useChatStore.getState().resetChatState();
      clearUnreadMarkers();
      useVoiceOccupancyStore.getState().reset();
      useVideoStageStore.getState().reset();
      useUiStore.getState().resetForAccountSwitch();
    },
    // 7. Bringup — fresh WebSocket + call controller re-keyed to the new user.
    realtimeConnect: () => {
      startRealtime(target.token);
      initCallController(target.accountId);
      // Re-point the queue at the NEW account and replay anything it left behind.
      void attachOutbox(target.accountId);
    },
    // 8. pushReregister — desktop has no push token; omitted (mobile-only).
    // 9. Bringup — refresh the cached profile from the server + the auth store.
    profileRefresh: async () => {
      const { user } = await api.getMe();
      await accountVault.upsert(projectionOf(user, target.token));
      useAuthStore.getState().setUser(user);
      mirror();
    },
  };
}

/**
 * A best-effort full `User` from the cached vault projection, shown transiently at
 * the pivot so the shell reflects the NEW account immediately even before
 * `profileRefresh` returns (and if it fails on a flaky network). `createdAt` is a
 * placeholder the real `getMe` overwrites; it is never a user-visible field on the
 * footer/switcher.
 */
function transientUser(account: StoredAccount): User {
  return {
    id: account.accountId,
    username: account.username,
    displayName: account.displayName,
    avatarUrl: account.avatarUrl,
    bio: null,
    createdAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// High-level operations the UI calls.
// ---------------------------------------------------------------------------

/**
 * What a {@link switchAccount} attempt resolved to. Desktop drives its UI from
 * the store side-effects below (the switcher calls this fire-and-forget), but the
 * outcome is returned too for symmetry with mobile and for callers that branch on
 * it (e.g. the post-logout hop). `noop` = nothing to do; `switched` = landed on
 * the target; `reauth` = target token dead → re-auth overlay opened for it (the
 * current session stays live); `offline` = target unreachable → stayed put (#100).
 */
export type AccountSwitchOutcome =
  | { status: "noop" }
  | { status: "switched"; warning: boolean }
  | { status: "reauth"; account: StoredAccount }
  | { status: "offline"; account: StoredAccount };

/** True when `err` is a session-auth (401) failure from the api client. */
function isUnauthorized(err: unknown): boolean {
  return err instanceof ApiClientError && err.code === "UNAUTHORIZED";
}

/**
 * Switch to an already-stored account. No-op when it is already active or a
 * switch is in flight. Shows the covering "switching…" overlay for the duration
 * so no previous-account data flashes.
 *
 * Unless `skipProbe` is set, the target token is PROBED first (GET /users/me with
 * the target bearer, without touching the live client): a dead token opens the
 * re-auth overlay instead of pivoting into a 401 storm that would dump the user to
 * the login screen and tear down their current session (#100).
 */
export async function switchAccount(
  accountId: AccountId,
  options: { skipProbe?: boolean } = {},
): Promise<AccountSwitchOutcome> {
  const store = useAccountsStore.getState();
  if (store.switching) return { status: "noop" };
  if (accountId === accountVault.getActiveId()) return { status: "noop" };
  const target = accountVault.get(accountId);
  if (!target) {
    mirror();
    return { status: "noop" };
  }

  store.setSwitching(true);
  store.setSwitchWarning(false);
  store.setSwitchError(null);
  try {
    // Fresh-token path (a just-completed add-account login): the token was minted
    // a beat ago, so skip the probe and run the ordered switch directly.
    if (options.skipProbe) {
      const result = await runAccountSwitch(buildSwitchEffects(target));
      const warning = result.errors.length > 0;
      store.setSwitchWarning(warning);
      if (warning) console.warn("[accounts] switch completed with non-fatal errors", result.errors);
      return { status: "switched", warning };
    }

    const outcome = await runGuardedAccountSwitch<StoredAccount>({
      target,
      previous: accountVault.getActive(),
      probeToken: (token) => probeAccountToken({ baseUrl: apiBaseUrl, token }),
      makeEffects: (account) => buildSwitchEffects(account),
      isAuthError: isUnauthorized,
    });

    if (outcome.status === "switched") {
      store.setSwitchWarning(outcome.warning);
      if (outcome.warning) console.warn("[accounts] switch completed with non-fatal errors");
      return { status: "switched", warning: outcome.warning };
    }
    if (outcome.status === "reauth") {
      // Open the add-account overlay prefilled for the dead account — the current
      // session keeps running untouched behind it.
      store.beginReauth(outcome.account.username);
      return { status: "reauth", account: outcome.account };
    }
    // offline — surface a soft toast and stay on the current account.
    store.setSwitchError("offline");
    return { status: "offline", account: outcome.account };
  } finally {
    mirror();
    store.setSwitching(false);
  }
}

/** Open the login screen as an overlay for "add account" (current session stays live). */
export function beginAddAccount(): void {
  useAccountsStore.getState().setAddingAccount(true);
}

/** Close the "add account" overlay without changing the session. */
export function cancelAddAccount(): void {
  useAccountsStore.getState().setAddingAccount(false);
}

/**
 * Complete an "add account" login/register: store the new account WITHOUT
 * dropping the current session, then run the ordered switch onto it (tearing the
 * current account down). `api.login`/`register` never touch the active bearer
 * (auth:false), so the current session is undisturbed until the switch pivots.
 */
async function addAccountSession(user: User, token: string): Promise<void> {
  await ensureVaultLoaded();
  await accountVault.upsert(projectionOf(user, token));
  mirror();
  useAccountsStore.getState().setAddingAccount(false);
  // The token was just minted by login/register — no need to probe it.
  await switchAccount(user.id, { skipProbe: true });
}

/** "Add account" via username/password. */
export async function loginAndAddAccount(username: string, password: string): Promise<void> {
  const { token, user } = await api.login({ username, password, ...desktopSessionMetadata() });
  await addAccountSession(user, token);
}

/** "Add account" via register. */
export async function registerAndAddAccount(
  username: string,
  password: string,
  displayName?: string,
  /** ISO date of birth `YYYY-MM-DD` (M15) — for +18 content gating server-side. */
  birthdate?: string,
): Promise<void> {
  const { token, user } = await api.register({
    username,
    password,
    displayName,
    birthdate,
    ...desktopSessionMetadata(),
  });
  await addAccountSession(user, token);
}

/**
 * Remove a stored account from the switcher. Removing a NON-active account just
 * drops it locally (its server token stays valid until it expires or is revoked
 * from the Sessions screen — we can't revoke it here without its bearer). Removing
 * the ACTIVE account is a sign-out of that account (see {@link logoutActiveAccount}).
 */
export async function removeAccount(accountId: AccountId): Promise<void> {
  if (accountId === accountVault.getActiveId()) {
    await logoutActiveAccount();
    return;
  }
  await accountVault.remove(accountId);
  mirror();
}

/**
 * Sign out of the ACTIVE account. Revokes its token server-side (best effort),
 * drops it from the vault, then either switches to the most-recent remaining
 * account (staying signed in as someone) or, when none remain, fully signs out to
 * the login screen. This is what the profile-menu "Log out" now does.
 */
export async function logoutActiveAccount(): Promise<void> {
  await ensureVaultLoaded();
  const activeId = accountVault.getActiveId();
  const nextId = accountVault.mostRecentId(activeId ?? undefined);

  // Revoke the current session server-side while its bearer is still active.
  try {
    await api.logout();
  } catch {
    // Best effort — local sign-out proceeds regardless.
  }

  if (activeId) {
    await accountVault.remove(activeId);
    mirror();
  }

  if (nextId) {
    // The next account's stored token may itself be dead. Route through the same
    // guarded switch: only a clean landing keeps us signed in; a dead/unreachable
    // next account signs fully out (never leave a revoked session standing — the
    // very black-screen bug this hardening fixes, #100).
    const outcome = await switchAccount(nextId);
    if (outcome.status !== "switched") {
      await fullSignOut();
    }
  } else {
    await fullSignOut();
  }
}

/**
 * Local teardown to the login screen when no account remains: leave voice, drop
 * the session (auth store → unauthenticated, which fires App.tsx's cleanup:
 * dispose call controller, stop realtime, reset chat, clear query cache).
 */
async function fullSignOut(): Promise<void> {
  try {
    await leaveVoiceForReset();
  } catch {
    // Best effort.
  }
  await useAuthStore.getState().signOutLocal();
  mirror();
}
