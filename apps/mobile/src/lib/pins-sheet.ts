/**
 * "Open the pin board" seam (M17).
 *
 * On mobile the header lives in the ROUTE (expo-router `Stack.Screen`
 * `headerRight`) while the channel id, the thread and the sheet live in
 * `<ChatThread>`. Rather than lifting sheet state into every route — three
 * copies of the same `useState` — the header publishes a one-shot command here
 * and the mounted thread opens its own sheet.
 *
 * Same reasoning as lib/message-jump.ts: a one-shot COMMAND does not belong in a
 * store (§27) — nothing needs to observe "is the sheet open" from outside.
 */

type OpenListener = () => void;

const listeners = new Set<OpenListener>();

/** Ask the mounted thread to show its pin board. */
export function openPinsSheet(): void {
  for (const listener of [...listeners]) listener();
}

/** Subscribe the mounted thread. Returns the unsubscribe function. */
export function onOpenPinsSheet(listener: OpenListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
