/**
 * "Scroll the open message list to this message" seam (M17 — pin board).
 *
 * The virtualizer, the loaded-page window and the flash-highlight state all live
 * INSIDE MessageList, so anything outside it (the pin panel, later: search
 * results, notification deep-links) needs a way to ask for a jump without
 * reaching into that component.
 *
 * Deliberately a module-level emitter rather than a store field (§27): a jump is
 * a one-shot COMMAND, not state. Putting it in Zustand would give every
 * subscriber a re-render per jump and leave a stale "last jumped id" hanging
 * around that a remount would replay. Here the only listener is the mounted
 * MessageList, and publishing costs zero renders anywhere else.
 */

import type { MessageId } from "@demli/types";

type JumpListener = (messageId: MessageId) => void;

const listeners = new Set<JumpListener>();

/**
 * Ask the mounted message list to scroll to (and briefly flash) `messageId`.
 * A no-op when no list is mounted, or when the list cannot find the message.
 */
export function requestMessageJump(messageId: MessageId): void {
  for (const listener of [...listeners]) listener(messageId);
}

/** Subscribe the mounted message list. Returns the unsubscribe function. */
export function onMessageJump(listener: JumpListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
