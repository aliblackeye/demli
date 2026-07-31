/**
 * Persistent offline send queue — the IMPERATIVE shell (M17).
 *
 * Owns everything the pure model in `outbox-model.ts` deliberately does not:
 * persistence, the ack deadline, and the drain loop. Every dependency is injected
 * (transport, storage, clock, timers) exactly like `dm-calls/call-controller.ts`,
 * so the whole thing is testable without a socket, a filesystem, or real time.
 *
 * PLATFORM SEAM
 * `OutboxStorage` is the only I/O contract, mirroring `VaultStorage`: desktop
 * backs it with `localStorage`, mobile with the `expo-file-system` JSON file the
 * drafts store already uses (SecureStore's ~2 KB per-value cap is far too small
 * for a message queue, and AsyncStorage would be a new native module and break
 * the OTA path).
 *
 * DRAIN CONTRACT
 * One item in flight at a time, oldest first (see `nextSendable`). The loop is
 * kicked by exactly three things — a new send, the connection coming online, and
 * an item settling — so there is no polling timer burning cycles while idle
 * (§27).
 *
 * ACCOUNT SAFETY
 * The queue is persisted per account (see `OutboxControllerDeps.storage`, which
 * callers scope per user). `clear()` must be called from the account-switch and
 * logout reset paths alongside the other per-user stores, or one account's
 * unsent messages would drain into the next session.
 */

import type { ChannelId } from "@demli/types";
import {
  allItems,
  emptyOutbox,
  enqueueItem,
  findItem,
  markAttemptFailed,
  markSending,
  nextSendable,
  removeChannel,
  removeItem,
  requeueInFlight,
  retryItem,
  sanitizeOutboxMap,
  type OutboxErrorKey,
  type OutboxItem,
  type OutboxMap,
} from "./outbox-model.js";

/**
 * Persistence seam — a single serialized blob, exactly like `VaultStorage`.
 * Implementations must be best-effort and MUST NOT throw: the in-memory queue
 * stays authoritative, and a storage failure may never lose a user's message.
 */
export interface OutboxStorage {
  get(): Promise<string | null>;
  set(value: string): Promise<void>;
  clear(): Promise<void>;
}

/**
 * How long to wait for the `message.created` echo before treating a dispatch as
 * failed. Matches the existing in-memory `SEND_TIMEOUT_MS` in both apps.
 */
export const OUTBOX_ACK_TIMEOUT_MS = 10_000;

/** Debounce on persistence — a burst of queued sends writes the blob once. */
export const OUTBOX_PERSIST_DEBOUNCE_MS = 250;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface OutboxControllerDeps {
  /**
   * Dispatch one item over the GATEWAY (never REST — only the gateway path
   * carries the nonce that makes a replay idempotent). Returns false when the
   * socket is not open, which the controller reads as "still offline".
   */
  send: (item: OutboxItem) => boolean;
  /** Per-account persistence. Omit for an in-memory queue (tests). */
  storage?: OutboxStorage;
  /**
   * Called when items are dropped because their channel is gone (deleted, or
   * access lost). The UI must tell the user — these messages will never be sent.
   */
  onChannelGone?: (channelId: ChannelId, dropped: OutboxItem[]) => void;
  /** Notified on every state change so a platform store can mirror the queue. */
  onChange?: (map: OutboxMap) => void;
  setTimer?: (cb: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
  ackTimeoutMs?: number;
}

export interface OutboxController {
  getState(): OutboxMap;
  subscribe(listener: (map: OutboxMap) => void): () => void;
  /** Rehydrate from storage. Call once at startup, before the first drain. */
  hydrate(): Promise<void>;
  /** Queue a send. Returns the item; a duplicate nonce is a no-op. */
  enqueue(item: Omit<OutboxItem, "status" | "attempts" | "errorKey">): OutboxItem;
  /** The connection status changed — drives the drain. */
  setOnline(online: boolean): void;
  /** The server confirmed this nonce (`message.created` echo). */
  confirm(channelId: ChannelId, nonce: string): void;
  /** The gateway rejected this nonce (`error.raised`). */
  reject(channelId: ChannelId, nonce: string, errorKey?: OutboxErrorKey): void;
  /** User pressed Retry on a failed item. */
  retry(channelId: ChannelId, nonce: string): void;
  /** User discarded a failed item. */
  discard(channelId: ChannelId, nonce: string): void;
  /** The channel is gone — drop its queue and notify. */
  dropChannel(channelId: ChannelId): void;
  /** Wipe the queue and its persisted blob (logout / account switch). */
  clear(): Promise<void>;
  dispose(): void;
}

export function createOutboxController(deps: OutboxControllerDeps): OutboxController {
  const setTimer = deps.setTimer ?? ((cb: () => void, ms: number) => setTimeout(cb, ms));
  const clearTimer = deps.clearTimer ?? ((handle: TimerHandle) => clearTimeout(handle));
  const ackTimeoutMs = deps.ackTimeoutMs ?? OUTBOX_ACK_TIMEOUT_MS;

  let map: OutboxMap = emptyOutbox;
  let online = false;
  let disposed = false;
  let ackTimer: TimerHandle | null = null;
  let persistTimer: TimerHandle | null = null;
  const listeners = new Set<(map: OutboxMap) => void>();

  function notify(): void {
    const snapshot = map;
    for (const listener of [...listeners]) listener(snapshot);
    deps.onChange?.(snapshot);
  }

  /**
   * Commit a new map. Same-reference short-circuit (the `call-controller`
   * convention) so a no-op transition neither notifies nor rewrites storage.
   */
  function commit(next: OutboxMap): void {
    if (next === map) return;
    map = next;
    schedulePersist();
    notify();
  }

  function schedulePersist(): void {
    if (!deps.storage || disposed) return;
    if (persistTimer !== null) clearTimer(persistTimer);
    persistTimer = setTimer(() => {
      persistTimer = null;
      void persistNow();
    }, OUTBOX_PERSIST_DEBOUNCE_MS);
  }

  async function persistNow(): Promise<void> {
    if (!deps.storage) return;
    try {
      await deps.storage.set(JSON.stringify(map));
    } catch {
      // In-memory stays authoritative — a storage failure must never lose or
      // block a message (the AccountVault.persist convention).
    }
  }

  function clearAckTimer(): void {
    if (ackTimer === null) return;
    clearTimer(ackTimer);
    ackTimer = null;
  }

  /**
   * Dispatch the next item, if any. Re-entrant-safe: `markSending` puts the item
   * into `sending`, and `nextSendable` returns null while anything is in flight,
   * so a nested call cannot double-dispatch.
   */
  function drain(): void {
    if (disposed || !online) return;
    const item = nextSendable(map);
    if (!item) return;

    // Count the attempt BEFORE dispatching — a send whose outcome is never
    // observed has still consumed a try (see the model's markSending doc).
    commit(markSending(map, item.channelId, item.nonce));
    const dispatched = findItem(map, item.channelId, item.nonce);
    if (!dispatched) return;

    let accepted = false;
    try {
      accepted = deps.send(dispatched);
    } catch {
      accepted = false;
    }

    if (!accepted) {
      // The socket closed between the status update and this dispatch. Treat it
      // as offline rather than a real failure and stop draining; reconnect will
      // kick it again.
      online = false;
      commit(markAttemptFailed(map, item.channelId, item.nonce, "offline"));
      return;
    }

    clearAckTimer();
    ackTimer = setTimer(() => {
      ackTimer = null;
      // No echo in time. Back to `queued` if attempts remain (the model decides),
      // then keep draining so one stuck message cannot block the queue forever.
      commit(markAttemptFailed(map, item.channelId, item.nonce, "timeout"));
      drain();
    }, ackTimeoutMs);
  }

  return {
    getState() {
      return map;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async hydrate() {
      if (!deps.storage) return;
      let raw: string | null = null;
      try {
        raw = await deps.storage.get();
      } catch {
        raw = null;
      }
      if (!raw) return;
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        // Corrupt blob: start empty rather than failing startup.
        return;
      }
      // `sanitizeOutboxMap` also re-queues anything persisted as `sending` — the
      // app died mid-send, so that item was never confirmed.
      const restored = sanitizeOutboxMap(parsed);
      if (allItems(restored).length === 0) return;
      map = restored;
      notify();
      drain();
    },

    enqueue(input) {
      const item: OutboxItem = { ...input, status: "queued", attempts: 0, errorKey: null };
      const next = enqueueItem(map, item);
      // Unchanged ⇒ the nonce was already queued (double-tap / hydration race).
      if (next === map) return findItem(map, item.channelId, item.nonce) ?? item;
      commit(next);
      drain();
      return item;
    },

    setOnline(nextOnline) {
      if (nextOnline === online) return;
      online = nextOnline;
      if (!online) {
        // The socket dropped. Anything in flight was never confirmed, so put it
        // back in the queue — safe because the nonce makes the replay idempotent.
        clearAckTimer();
        commit(requeueInFlight(map));
        return;
      }
      drain();
    },

    confirm(channelId, nonce) {
      const existing = findItem(map, channelId, nonce);
      if (!existing) return;
      clearAckTimer();
      commit(removeItem(map, channelId, nonce));
      drain();
    },

    reject(channelId, nonce, errorKey = "rejected") {
      const existing = findItem(map, channelId, nonce);
      if (!existing) return;
      clearAckTimer();
      commit(markAttemptFailed(map, channelId, nonce, errorKey));
      drain();
    },

    retry(channelId, nonce) {
      commit(retryItem(map, channelId, nonce));
      drain();
    },

    discard(channelId, nonce) {
      const existing = findItem(map, channelId, nonce);
      if (existing?.status === "sending") clearAckTimer();
      commit(removeItem(map, channelId, nonce));
      drain();
    },

    dropChannel(channelId) {
      const { map: next, removed } = removeChannel(map, channelId);
      if (removed.length === 0) return;
      if (removed.some((item) => item.status === "sending")) clearAckTimer();
      commit(next);
      deps.onChannelGone?.(channelId, removed);
      drain();
    },

    async clear() {
      clearAckTimer();
      if (persistTimer !== null) {
        clearTimer(persistTimer);
        persistTimer = null;
      }
      map = emptyOutbox;
      notify();
      if (!deps.storage) return;
      try {
        await deps.storage.clear();
      } catch {
        // Best-effort, as everywhere else.
      }
    },

    dispose() {
      disposed = true;
      clearAckTimer();
      if (persistTimer !== null) {
        clearTimer(persistTimer);
        persistTimer = null;
      }
      listeners.clear();
    },
  };
}

/** Convenience re-export so consumers import the queue from one path. */
export type { OutboxErrorKey, OutboxItem, OutboxMap };
