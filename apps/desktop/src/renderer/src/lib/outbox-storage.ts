/**
 * Desktop persistence for the offline send queue (M17) — the `OutboxStorage`
 * seam from `@demli/client-core`. Mirrors lib/draft-storage.ts: one JSON blob
 * in `localStorage`, best-effort and self-healing (a corrupt blob just means an
 * empty queue; the model's `sanitizeOutboxMap` drops anything unusable).
 *
 * PER ACCOUNT. The key carries the user id because a queue holds unsent messages
 * authored BY that user: sharing one blob across accounts would let account A's
 * unsent message drain out of account B's session (ADR 0013 store-reset rule).
 *
 * The interface is async only because mobile's file API is; here every call
 * resolves immediately.
 */

import type { OutboxStorage } from "@demli/client-core";
import type { UserId } from "@demli/types";

const KEY_PREFIX = "demli.outbox.v1.";

function storageKey(userId: UserId): string {
  return `${KEY_PREFIX}${userId}`;
}

/** An `OutboxStorage` bound to one account's blob. */
export function createOutboxStorage(userId: UserId): OutboxStorage {
  const key = storageKey(userId);
  return {
    get() {
      try {
        return Promise.resolve(localStorage.getItem(key));
      } catch {
        return Promise.resolve(null);
      }
    },
    set(value) {
      try {
        localStorage.setItem(key, value);
      } catch {
        // Over quota / unavailable — the in-memory queue stays authoritative and
        // a message is never lost, it just won't survive a restart.
      }
      return Promise.resolve();
    },
    clear() {
      try {
        localStorage.removeItem(key);
      } catch {
        // Best-effort, as everywhere else.
      }
      return Promise.resolve();
    },
  };
}
