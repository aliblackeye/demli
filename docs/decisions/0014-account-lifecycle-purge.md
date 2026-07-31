# ADR 0014 — Account Lifecycle: 14-Day Freeze, Anonymizing Purge, Set-Once Birthdate (M15)

**Status:** accepted (shipped 2026-07-26, migration 0018)
**Date:** 2026-07-26

## Context

M15 adds account deletion and a date of birth to the identity model. Two constraints
shaped the design:

- **Foreign keys forbid a real DELETE.** `messages.author_id` and
  `friend_groups.owner_id` reference `users.id` with RESTRICT semantics. Hard-deleting
  a user who ever sent a message or owns a server either fails outright or — if those
  FKs were changed to CASCADE — destroys shared message history and whole servers that
  other members still use.
- **A frozen account has no valid session.** Deletion revokes all sessions, so a
  "reactivate my account" flow cannot be an authenticated endpoint — there is no token
  left to authenticate with.

## Decision

- **Delete = freeze.** `DELETE /users/me` soft-deletes: stamps `deleted_at` and
  `purge_at = now + 14 days` (`ACCOUNT_FREEZE_DAYS`), revokes all sessions, and hides
  the row from auth, member lists, and search. Idempotent — repeating refreshes the window.
- **Reactivation rides the login flow.** A plain login on a frozen account inside the
  window is refused with `ACCOUNT_FROZEN` (carrying `purgeAt`); re-sending the same
  credentials with `reactivate: true` clears the freeze and signs the user in. No
  separate endpoint (impossible — see constraint above).
- **Purge = PII anonymization, not row deletion.** An hourly job
  (`apps/api/src/lib/account-purge.ts` → `usersRepo.purgeExpired`) scrubs every account
  whose `purge_at` has elapsed: username → `deleted_<id>`, display name → "Deleted
  User", avatar/banner/bio/birthdate/email/Google link/password hash nulled, friend
  code regenerated. `deleted_at` stays (row remains hidden), `purge_at` is cleared
  (never reprocessed). Authored rows keep referential integrity as a "Deleted User"
  tombstone.
- **Birthdate is set-once.** Optional at register, settable once later in settings;
  any second write returns `409 BIRTHDATE_LOCKED`. The raw date is me-only; other
  users only ever see the derived `isAdult` flag (which drives the NSFW gate, ADR 0015).

## Consequences

- "Destroy after 14 days" means personal data destroyed, tombstone kept — a
  founder-facing interpretation, noted in the handoff.
- Message history and server ownership survive a member's deletion; the author shows
  as "Deleted User".
- Reactivation is only possible inside the 14-day window; after the purge the account
  is unrecoverable and unfindable (friend code regenerated).
- The purge job is a boot-started interval (unref'd, failure-logged) — no external cron.

## Alternatives considered

- **Physical row DELETE** — fails on RESTRICT FKs, or with CASCADE destroys other
  people's history and servers. Rejected.
- **Dedicated authenticated reactivation endpoint** — impossible; frozen accounts have
  no session. Rejected.
- **Immediate hard purge (no freeze window)** — no recovery from an accidental or
  rage-quit deletion. Rejected; 14 days is a grace window long enough to change your mind.
- **Freely editable birthdate** — would let a minor flip the 18+ gate at will.
  Set-once with a locked 409 keeps the derived `isAdult` trustworthy.
