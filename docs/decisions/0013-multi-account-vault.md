# ADR 0013 — Multi-Account Vault & Switch-Reset Contract (M15)

**Status:** accepted — shipped; account switching is live on desktop, web and mobile
**Date:** 2026-07-19

## Context

Founder ask (roadmap M15, memory-scoped): an account switcher. A user keeps
several signed-in accounts **on the device** and flips between them from the profile
menu without re-typing a password.

- **Sessions live on the device** — desktop `safeStorage` (encrypted, behind the
  preload bridge), mobile `expo-secure-store`. Same as the token today (ADR 0002).
- **"Hesap değiştir"** — switch to another stored account instantly.
- **"Hesap ekle"** — go to login *without dropping the current session*; on success
  you land on the new account and the old one stays in the switcher.
- **Full reset on switch** — WS + query cache + all per-user state.

The last point is the whole reason this ADR exists. A live incident this week: an
account switch left the *previous* identity's state dangling — a **"zombie session"**.
The voice engine was still on the old LiveKit room, the WebSocket kept re-authing with
the stale token, and the query cache served the old user's groups/DMs to the new user.
The fix is **not** "remember to clean up" scattered across two platforms. It is **one
ordered teardown+bringup sequence, defined and tested once in shared code**, that both
platforms drive by injecting their platform effects. Getting that order right — and
making it un-bypassable — is the core architectural decision here.

Google login and e-mail/password recovery were **deferred out of M15 by the founder
(2026-07-19)**; this ADR covers only the local multi-account vault + switch reset.

### Fixed constraints (verified in code)

- **Single-token seam today.** `TokenStorage { get/set/clear }` (`packages/client-core/
  src/token-storage.ts`) holds exactly ONE token; both `apps/*/stores/auth-store.ts` read
  it on boot, call `setAuthToken(token)`, then `getMe()`. There is no notion of a second
  account anywhere.
- **The realtime client already models connect/disconnect cleanly.** `RealtimeClient`
  (`packages/client-core/src/realtime-client.ts`) has `connect(token)`, `disconnect()`,
  `reconnectNow()`; `disconnect()` nulls the token and stops backoff. Perfect for a
  token swap — tear the old socket down, connect the new.
- **The voice engine has a hard teardown.** `VoiceEngine.leave()` (contract: "must ALWAYS
  reach idle") and `dispose()` (`packages/media/src/engine.ts`) release the LiveKit room,
  mic, screen tracks and audio worklets. Single-active-session (memory) means the old
  account must LEAVE its room before the new identity does anything.
- **A normalize-untrusted-blob precedent exists.** `normalizeParticipantVolumes`
  (`packages/media/src/participant-volume.ts`) repairs a corrupt/legacy persisted blob
  into a clean shape and never throws. The vault reuses that discipline for its own,
  more sensitive (token-bearing) blob.
- **`User` shape** (`packages/types`): `{ id, username, displayName, avatarUrl: string|null }`
  — exactly the display projection the switcher needs to cache per account.

Nothing here touches a §33 human-approval item (no app-name / auth-method / LiveKit /
framework / DB-provider change — the auth *method* is unchanged; we store more of the
same tokens) or a §35 non-negotiable (no media over WS; the roles model is untouched).

## Decision

Add a shared, framework-free **`@demli/client-core/account-vault`** module with three
parts, then wire it per-platform in the next wave (frontend-ui). The domain shape and the
reset ORDER are fixed here; the I/O and the effects are injected by each app (§23 — shared
model in the shared package, platform glue in the app).

### 1. Vault model (`account-vault/vault-model.ts`)

```ts
type AccountId = UserId; // one record PER USER — a re-login dedups by overwrite

interface StoredAccount {
  accountId: AccountId;
  token: string;                 // opaque session token, validated server-side
  username: string;              // cached User projection for the switcher UI …
  displayName: string;
  avatarUrl: string | null;      // … refreshed from getMe on switch (profileRefresh)
  lastUsedAt: number;            // epoch ms; orders the switcher, drives LRU eviction
}

interface AccountVaultData {
  accounts: Record<AccountId, StoredAccount>; // keyed → dedup is structural
  activeAccountId: AccountId | null;          // null = signed out of all
}
```

- **accountId === userId.** Keying the map by user id makes "same account overwrites"
  (re-login, refreshed token) free and impossible to get wrong — the founder's "no
  duplicate rows" requirement is a type-level invariant, not a runtime check.
- **`normalizeAccountVault` / `normalizeStoredAccount`** repair an untrusted blob: drop
  records with no `accountId`/`token`, coerce garbage fields, use the record's OWN
  `accountId` (not the map key, which a tamperer could spoof), and CLEAR a dangling
  `activeAccountId` that points at no surviving record (land on the picker, never a
  phantom session). Never throws → a corrupt vault degrades to empty, not a crash.
- **`MAX_STORED_ACCOUNTS = 8`**, a safety rail (a vault is a token hoard): adding a new
  account past the cap evicts the least-recently-used **non-active** record. Not a
  product surface; generous enough that no real user hits it.
- Pure reducers (`upsertAccount`, `setActiveAccountId`, `removeAccount`) + selectors
  (`listAccounts` MRU-sorted, `getActiveAccount`, `mostRecentAccountId`, …). No I/O, no
  clock — trivially testable, mirroring the `call-state.ts` reducer style.

### 2. Storage seam + relationship to `TokenStorage` (`account-vault/account-vault.ts`)

```ts
interface VaultStorage { get(): Promise<string|null>; set(v: string): Promise<void>; clear(): Promise<void>; }
```

Deals in serialized JSON strings — **the exact shape of the existing `TokenStorage`
seam** — so each platform reuses its encrypted store with almost no new code (desktop
safeStorage bridge, mobile SecureStore). Persist key: `ACCOUNT_VAULT_STORAGE_KEY =
"demli.account-vault"`. The `AccountVault` class caches the vault in memory (source of
truth after `load()`) and write-throughs every mutation; a `storage.set` failure leaves
the in-memory vault authoritative for the session (mirrors `TokenStorage`).

**The vault does NOT replace `TokenStorage`** — that would force a boot rewrite in
`apps/*` this wave, which is out of scope. Instead:

- **Vault = the registry** (which accounts exist, which is active).
- **`TokenStorage` = the active-session fast cache** the boot path already reads,
  kept in sync by the `activateToken` switch step (which writes the new token to BOTH
  `setAuthToken()` and `TokenStorage.set()`).
- **One-time migration** (platform glue, next wave): on first post-upgrade boot, if the
  vault is empty but `TokenStorage` holds a token whose `getMe()` succeeds, seed the vault
  with that account and mark it active. Existing single-account users upgrade silently —
  the same pattern the desktop auth-store already uses for its legacy-token migration.

### 3. The SWITCH-RESET CONTRACT (`account-vault/switch-reset.ts`) — the anti-zombie core

`ACCOUNT_SWITCH_STEPS` is an ordered, exported array; `runAccountSwitch(effects, opts)`
executes it. **The order IS the contract** and is asserted by tests. Three phases:

| # | Step | Phase | Owner (effect implemented by) |
|---|------|-------|-------------------------------|
| 1 | `endActiveCall` | teardown | dm-call controller + platform (optional; may fold into voice) |
| 2 | `voiceLeaveDispose` | teardown | `@demli/media` engine `leave()`→`dispose()` + platform glue |
| 3 | `realtimeDisconnect` | teardown | `RealtimeClient.disconnect()` + platform glue |
| 4 | **`activateToken`** | **pivot** | `AccountVault.setActive()` + `setAuthToken()` + `TokenStorage.set()` |
| 5 | `queryCacheClear` | bringup | platform `queryClient.clear()` |
| 6 | `storeReset` | bringup | platform — reset per-user zustand stores (reset surface below) |
| 7 | `realtimeConnect` | bringup | `RealtimeClient.connect(newToken)` + platform glue |
| 8 | `pushReregister` | bringup | `@demli/notifications` + platform (mobile; desktop no-op) |
| 9 | `profileRefresh` | bringup | platform `getMe()` → `AccountVault.upsert()` + auth-store `setUser()` |

**Why this order (the zombie-prevention invariants):**

- **Teardown (1–3) runs while the OLD token is still valid** — the voice engine needs it
  to leave the LiveKit room and let the gateway release the SFU participant; a `voice.*`
  leave frame can still ride the still-open socket. So **voice teardown precedes the WS
  disconnect** (2 before 3).
- **Everything before the pivot uses the old token; everything after uses the new.**
  `activateToken` (4) is the single flip point and the **only required step** — if it
  throws, `runAccountSwitch` aborts and bringup never runs (we could not obtain the new
  identity, so we do not tear the app into a half-switched state).
- **Purge before reconnect** — `queryCacheClear` + `storeReset` (5–6) MUST precede
  `realtimeConnect` (7), or the first events on the new socket land in stores/caches
  still holding the old user's data. This is exactly the leak the incident exposed.

**Best-effort + time-boxing.** Teardown and bringup steps are wrapped so a failure is
*recorded and skipped*, never fatal — a wedged `leave()` or a failed push re-register must
never strand the user on the old account. Teardown steps are additionally **time-boxed**
(`teardownTimeoutMs`, default 5 s) so a hung promise cannot block the pivot. `runAccountSwitch`
returns `{ ok, errors: {step,error}[] }` so the UI can show a soft warning ("switched, but
couldn't refresh notifications") without blocking the switch.

`runAccountSwitch` never imports zustand / TanStack Query / LiveKit — the platform passes
those as callbacks (identical seam to the dm-call controller). This is what makes the
contract shared, tested, and un-bypassable.

### 4. Flows (platform wiring, next wave)

- **Boot:** `vault.load()` → if `getActiveId()` set, seed the session from that record
  (or run the migration). Else show the switcher/login.
- **Add account:** keep the current session live → navigate to login → on success
  `vault.upsert(new)` then `runAccountSwitch(→ new)` (which tears the CURRENT account down
  and brings the new one up). You end up on the new account; the old stays stored.
- **Switch:** `runAccountSwitch` with `activateToken = vault.setActive(target) + token swap`.
- **Remove (çıkar):** `vault.remove(id)`. Removing a *non-active* account changes nothing
  live. Removing the *active* account clears the active id → the UI either switches to
  `vault.mostRecentId(removedId)` (via `runAccountSwitch`) or, if none remain, signs out.
  Whether to also call `POST /auth/logout` to invalidate that token server-side is platform
  policy (recommended for the active/explicit removal).
- **Sign out of everything:** `vault.clear()` + a full `runAccountSwitch`-style teardown.

### The `storeReset` surface (step 6) — named for the next wave

The platform's `storeReset` must reset every store keyed to the departing user:
voice-store, DM/call stores, unread/notification-mute caches, presence, and the
selected-group/channel navigation. Persisted, user-scoped-by-key stores
(participant-volume, keyed by userId) may stay — they are already partitioned. This list
is the acceptance checklist for frontend-ui; a store that survives the switch with the old
user's data is a zombie regression.

## Consequences

- The domain model gains `StoredAccount` / `AccountVaultData` in `packages/client-core`
  (transport-adjacent, framework-free) — NOT in `packages/types`, because these are a
  client-side persistence/session concept, not a wire DTO (the server never sees the
  vault; it only ever validates one bearer token per request). This keeps `packages/types`
  the pure wire domain (§23).
- The switch reset is now a single tested unit. A future step (e.g. "clear composer
  drafts") is added in ONE place, in order, with a test — not hunted across two apps.
- `TokenStorage` stays; the vault sits beside it. Zero boot rewrite this wave; the
  migration is additive and self-healing.
- `runAccountSwitch` returning partial errors means the UI can distinguish "switch failed"
  (pivot) from "switched with warnings" (a bringup hiccup) — better UX than all-or-nothing.

## Alternatives considered

- **Store all tokens under `TokenStorage` as a JSON array; drop the vault.** Rejected:
  `TokenStorage`'s single-string contract is consumed by boot on both platforms; overloading
  it into a multi-record blob silently changes that contract and invites the exact drift
  ADR 0002 warns about. A separate, explicitly-multi seam is clearer and keeps the old
  path working during migration.
- **Let each platform own its own switch cleanup.** Rejected outright — this is precisely
  what produced the zombie session. The whole value here is one shared, tested order.
- **A generic effect array the platform fills freely (no fixed step list).** Rejected:
  the ORDER is the safety property. A fixed, named, phase-tagged step list is what the test
  can assert and what a reviewer can eyeball; a free array cannot guarantee "purge before
  reconnect."
- **Put `StoredAccount` in `packages/types`.** Rejected: it is a client session/persistence
  type with no server counterpart; `types` is the wire domain (§23). client-core is the
  right home, alongside `TokenStorage`.
- **Bump `lastUsedAt` only on explicit switch, not on re-login.** Minor; chose to bump on
  any activation/upsert so the switcher's MRU order always reflects real recency.

## Downstream / follow-ups (named per §21)

- **frontend-ui** — desktop + mobile: implement `VaultStorage` over safeStorage /
  SecureStore, the account-switcher UI, the boot seed + one-time migration, and the nine
  switch effects (esp. the `storeReset` surface above). Parity is mandatory (both platforms).
- **database / realtime-backend** — M15 server side (migration 0014 identities/sessions,
  `/sessions` CRUD) is INDEPENDENT of this client vault and proceeds in parallel; the vault
  needs no server change to ship the local switcher.
- **security** — review token-at-rest (the vault now stores multiple tokens; confirm both
  platforms use the encrypted store, never plain localStorage) and confirm removal/logout
  invalidates server-side where required. Merge gate for the wiring wave.
- **qa-test** — add the "2 accounts, switch, no WS/cache bleed" smoke to the manual
  checklist and feature-parity.md at the wiring merge.
