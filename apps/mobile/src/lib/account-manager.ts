/**
 * Mobile account manager (M15 / ADR 0013) — the platform glue that wires the
 * shared multi-account vault + switch-reset contract into the mobile app's real
 * stores and clients. The mirror of the desktop renderer's lib/account-manager.ts.
 *
 * The shared core (`@demli/client-core/account-vault`) owns the vault shape
 * and the ORDERED teardown→pivot→bringup (`runAccountSwitch`). This module owns
 * the mobile half: the `AccountVault` singleton (over the SecureStore
 * `vaultStorage` seam), the nine switch EFFECTS bound to the app's real functions
 * (incl. the mobile-only push re-register), and the high-level operations the UI
 * calls (switch / add / remove / sign out) plus the boot seed + one-time
 * migration.
 *
 * WHY this is the single switch driver: a switch keeps `status` "authenticated",
 * so app/_layout.tsx's realtime effect (keyed on `status`) deliberately does NOT
 * re-fire — `runAccountSwitch` here owns the ordered teardown+bringup, avoiding a
 * race between an imperative switch and a declarative effect (the "zombie session").
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
import { vaultStorage } from "@/lib/account-vault-storage";
import { getApi } from "@/lib/clients";
import { API_URL } from "@/lib/server-config";
import { mobileSessionMetadata } from "@/lib/session-metadata";
import { queryClient } from "@/lib/query-client";
import { clearUnreadMarkers } from "@/lib/unread-storage";
import { startRealtime, stopRealtime } from "@/realtime/connection";
import { attachOutbox, detachOutbox } from "@/realtime/outbox";
import { configureCallController, resetCallController } from "@/stores/call-store";
import { registerPushToken, unregisterPushToken } from "@/push/push-manager";
import { useAccountsStore } from "@/stores/accounts-store";
import { useAuthStore } from "@/stores/auth-store";
import { useAttachmentStore } from "@/stores/attachment-store";
import { useChatStore } from "@/stores/chat-store";
import { useInAppNotificationStore } from "@/stores/in-app-notification-store";
import { useVoiceOccupancyStore } from "@/stores/voice-occupancy-store";
import { useWatchPartyStore } from "@/stores/watch-party-store";
import { leaveVoiceForReset } from "@/stores/voice-store";

/** The single account vault, backed by the OS-encrypted SecureStore adapter. */
const accountVault = new AccountVault(vaultStorage);

/**
 * Time-box each BRINGUP step of the ordered switch (ADR 0013). On a real device a
 * slow/hung native step — Expo/FCM push-token mint in `pushReregister`, or a
 * `getMe` on a bad network in `profileRefresh` — would otherwise never resolve, so
 * the covering switch overlay would stay up forever (the founder's "black screen,
 * kill the app"). 8s is generous for a healthy network yet bounds the worst case.
 */
const SWITCH_BRINGUP_TIMEOUT_MS = 8_000;

let vaultLoaded = false;

function mirror(): void {
  useAccountsStore.getState()._syncFromVault(accountVault.list(), accountVault.getActiveId());
}

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
 * Record the just-authenticated account as active in the vault. Called after a
 * first-login / register / boot-validation success — this is also the ADR 0013
 * one-time migration: an existing single-account user (token in SecureStore, no
 * vault yet) is silently seeded here.
 */
export async function seedActiveAccount(user: User, token: string): Promise<void> {
  await ensureVaultLoaded();
  await accountVault.addAndActivate(projectionOf(user, token));
  mirror();
}

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
// The nine switch effects (ADR 0013) bound to the mobile app's real functions.
// ---------------------------------------------------------------------------

function buildSwitchEffects(target: StoredAccount): AccountSwitchEffects {
  return {
    // 1. Teardown — hang up any live/ringing DM call (old token still valid).
    endActiveCall: () => {
      resetCallController();
    },
    // 2. Teardown — leave the LiveKit room / release mic+screen (NOT dispose).
    voiceLeaveDispose: () => leaveVoiceForReset(),
    // 3. Teardown — close the WebSocket bound to the OLD token.
    realtimeDisconnect: () => {
      stopRealtime();
      // Persistent send queue (M17): detach from the OLD account's file before
      // the identity flips, so its unsent messages stay on disk for that account
      // and can never drain into the next session.
      void detachOutbox();
    },
    // 4. PIVOT — flip identity: vault active + auth bearer + secure-token cache +
    //    a transient cached identity so the UI shows the new account at once.
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
    //    storeReset surface): chat, unread watermarks, occupancy, attachment
    //    drafts, in-app banner.
    storeReset: () => {
      // The chat reset RE-SEEDS the new session user into the author directory in
      // the same update (P0 "unknown author"): `activateToken` (step 4) already
      // pivoted the auth store onto `target`, and a switch keeps `status`
      // authenticated — so app/_layout's status-keyed seed never re-fires here.
      useChatStore.getState().resetChatState(useAuthStore.getState().user);
      clearUnreadMarkers();
      useVoiceOccupancyStore.getState().reset();
      // The watch party belongs to the OUTGOING user's room membership. Left
      // behind, the new account would open the voice screen onto a player it has
      // no session for and will never receive a heartbeat about.
      useWatchPartyStore.getState().reset();
      useAttachmentStore.getState().resetAttachmentDrafts();
      useInAppNotificationStore.getState().dismiss();
    },
    // 7. Bringup — fresh WebSocket + call controller re-keyed to the new user.
    realtimeConnect: () => {
      startRealtime(target.token);
      configureCallController(target.accountId);
      // Re-point the queue at the NEW account and replay anything it left behind.
      void attachOutbox(target.accountId);
    },
    // 8. Bringup — rebind the push token to the NEW account (mobile-only).
    pushReregister: async () => {
      await unregisterPushToken();
      await registerPushToken();
    },
    // 9. Bringup — refresh the cached profile from the server + the auth store.
    profileRefresh: async () => {
      const { user } = await getApi().getMe();
      await accountVault.upsert(projectionOf(user, target.token));
      useAuthStore.getState().setUser(user);
      // The authoritative profile also replaces the transient projection in the
      // message-author directory (display name / avatar), so own rows render the
      // real identity rather than the vault's cached copy.
      useChatStore.getState().upsertUsers([user]);
      mirror();
    },
  };
}

// ---------------------------------------------------------------------------
// High-level operations the UI calls.
// ---------------------------------------------------------------------------

/**
 * What a {@link switchAccount} attempt resolved to, so the caller can drive
 * navigation (P0 #100). `noop` = nothing to do (already active / mid-switch);
 * `switched` = landed on the target; `reauth` = the target token is dead, the
 * caller opens re-auth prefilled for `account` (the current session is intact);
 * `offline` = the target was unreachable, stay put and warn.
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
 * switch is running. Unless `skipProbe` is set, the target token is PROBED first
 * (GET /users/me with the target bearer, without touching the live client): a
 * dead token routes to re-auth instead of pivoting into a 401 storm that would
 * dump the user to the login screen and tear down their current session (#100).
 *
 * `onSwitched` (fix/switch-black-2, P0): a navigation hook run ONLY on a
 * successful switch, and CRITICALLY while `switching` is still true — i.e. while
 * app/(app)/_layout has the whole navigation Stack unmounted behind the covering
 * overlay. Navigating here means that when the Stack remounts (switching → false)
 * it mounts FRESH at the target route, instead of the caller popping the switcher
 * screen and reparenting a live `removeClippedSubviews` list mid-store-reset —
 * the Fabric "view already has a parent" crash that black-screened the app.
 */
export async function switchAccount(
  accountId: AccountId,
  options: { skipProbe?: boolean; onSwitched?: () => void } = {},
): Promise<AccountSwitchOutcome> {
  const store = useAccountsStore.getState();
  if (store.switching) return { status: "noop" };
  if (accountId === accountVault.getActiveId()) return { status: "noop" };
  const target = accountVault.get(accountId);
  if (!target) {
    mirror();
    return { status: "noop" };
  }

  const switchOptions = { bringupTimeoutMs: SWITCH_BRINGUP_TIMEOUT_MS };

  store.setSwitching(true);
  store.setSwitchWarning(false);
  try {
    // Fresh-token path (a just-completed add-account login): the token was minted
    // a beat ago, so skip the probe and run the ordered switch directly.
    if (options.skipProbe) {
      const result = await runAccountSwitch(buildSwitchEffects(target), switchOptions);
      const warning = result.errors.length > 0;
      store.setSwitchWarning(warning);
      if (warning) console.warn("[accounts] switch completed with non-fatal errors", result.errors);
      options.onSwitched?.();
      return { status: "switched", warning };
    }

    const outcome = await runGuardedAccountSwitch<StoredAccount>({
      target,
      previous: accountVault.getActive(),
      probeToken: (token) => probeAccountToken({ baseUrl: API_URL, token }),
      makeEffects: (account) => buildSwitchEffects(account),
      isAuthError: isUnauthorized,
      switchOptions,
    });

    if (outcome.status === "switched") {
      store.setSwitchWarning(outcome.warning);
      if (outcome.warning) console.warn("[accounts] switch completed with non-fatal errors");
      options.onSwitched?.();
      return { status: "switched", warning: outcome.warning };
    }
    return { status: outcome.status, account: outcome.account };
  } finally {
    mirror();
    store.setSwitching(false);
  }
}

/**
 * Complete an "add account" login/register: store the new account WITHOUT
 * dropping the current session, then run the ordered switch onto it (tearing the
 * current account down). `getApi().login`/`register` never touch the active bearer
 * (auth:false), so the current session is undisturbed until the switch pivots.
 */
async function addAccountSession(user: User, token: string): Promise<void> {
  await ensureVaultLoaded();
  await accountVault.upsert(projectionOf(user, token));
  mirror();
  // The token was just minted by login/register — no need to probe it.
  await switchAccount(user.id, { skipProbe: true });
}

/**
 * "Add account" via username/password. `reactivate` re-sends the login with the
 * reactivation flag so a frozen (soft-deleted) account within its grace window is
 * restored rather than answering `403 ACCOUNT_FROZEN` (M15).
 */
export async function loginAndAddAccount(
  username: string,
  password: string,
  reactivate?: boolean,
): Promise<void> {
  // Build the body as a variable so the additive `reactivate` field (not in the
  // shared login type — client-core is owned elsewhere and forwards the body
  // verbatim) passes without an object-literal excess-property error.
  const base = { username, password, ...mobileSessionMetadata() };
  const body = reactivate ? { ...base, reactivate: true } : base;
  const { token, user } = await getApi().login(body);
  await addAccountSession(user, token);
}

/** "Add account" via register. `birthdate` is the ISO `YYYY-MM-DD` date of birth (M15). */
export async function registerAndAddAccount(
  username: string,
  password: string,
  displayName?: string,
  birthdate?: string,
): Promise<void> {
  const { token, user } = await getApi().register({
    username,
    password,
    displayName,
    ...(birthdate ? { birthdate } : {}),
    ...mobileSessionMetadata(),
  });
  await addAccountSession(user, token);
}

/**
 * Remove a stored account from the switcher. Removing a NON-active account just
 * drops it locally (its server token stays valid until it expires or is revoked
 * from the Sessions screen). Removing the ACTIVE account is a sign-out of it.
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
 * Sign out of the ACTIVE account: revoke its token server-side (best effort),
 * drop it from the vault, then either switch to the most-recent remaining account
 * or, when none remain, fully sign out to the login screen.
 */
export async function logoutActiveAccount(): Promise<void> {
  await ensureVaultLoaded();
  const activeId = accountVault.getActiveId();
  const nextId = accountVault.mostRecentId(activeId ?? undefined);

  try {
    await getApi().logout();
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
    // next account signs fully out (never leave a revoked session standing — that
    // is the very black-screen bug this hardening fixes, #100).
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
 * the push binding, and sign out (auth store → unauthenticated, which fires
 * _layout.tsx's cleanup: stop realtime, reset call/chat/attachment stores, clear
 * query cache).
 */
async function fullSignOut(): Promise<void> {
  try {
    await leaveVoiceForReset();
  } catch {
    // Best effort.
  }
  try {
    await unregisterPushToken();
  } catch {
    // Best effort.
  }
  await useAuthStore.getState().signOutLocal();
  mirror();
}
