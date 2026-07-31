/**
 * "Scroll the open message list to this message" seam (M17 — pin board). Mobile
 * twin of the desktop renderer's lib/message-jump.ts.
 *
 * The FlatList ref, the loaded-page window and the flash state all live INSIDE
 * ChatThread, so the pin sheet needs a way to ask for a jump without reaching
 * into that component.
 *
 * Deliberately a module-level emitter rather than a store field (§27): a jump is
 * a one-shot COMMAND, not state. In Zustand it would re-render every subscriber
 * and leave a stale "last jumped id" that a remount would replay.
 */

type JumpListener = (messageId: string) => void;

const listeners = new Set<JumpListener>();

/** Ask the mounted thread to scroll to `messageId`. No-op if it is not loaded. */
export function requestMessageJump(messageId: string): void {
  for (const listener of [...listeners]) listener(messageId);
}

/** Subscribe the mounted thread. Returns the unsubscribe function. */
export function onMessageJump(listener: JumpListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
