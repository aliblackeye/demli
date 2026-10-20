/**
 * Keyboard edit + composer-focus commands (M16), as module-level emitters.
 *
 * Discord's "↑ in an empty composer edits your last message" crosses three
 * components that share no state: the composer (which sees the key), the list
 * (which knows which row is the viewer's last message, and can scroll it into
 * the virtualized window) and the row (which owns the in-place editor's local
 * state). Routing that through a store would re-render the thread on every
 * keystroke (§27), so — exactly like {@link ./mention-insert} — each hop is a
 * tiny emitter:
 *
 *   composer ──requestEditLastMessage(channelId)──▶ MessageList
 *   MessageList ──requestMessageEdit(messageId)──▶ that MessageRow
 *   MessageRow (editor closed) ──requestComposerFocus(channelId)──▶ composer
 *
 * Rows register only while they are mounted AND editable, so the per-message
 * map holds at most the ~50 own rows in the virtual window.
 */

type EditLastListener = (channelId: string) => boolean;

const editLastListeners = new Set<EditLastListener>();

/**
 * Ask the mounted thread for `channelId` to open its newest own message in the
 * editor. Returns true when a list took the request (there IS such a message),
 * so the composer only swallows the ↑ key when something actually happens.
 */
export function requestEditLastMessage(channelId: string): boolean {
  let handled = false;
  for (const listener of editLastListeners) {
    if (listener(channelId)) handled = true;
  }
  return handled;
}

/** Subscribe a thread to edit-last requests. Returns the unsubscribe fn. */
export function onEditLastRequest(listener: EditLastListener): () => void {
  editLastListeners.add(listener);
  return () => {
    editLastListeners.delete(listener);
  };
}

const messageEditListeners = new Map<string, () => void>();

/** Open `messageId`'s in-place editor if its row is mounted. True when it was. */
export function requestMessageEdit(messageId: string): boolean {
  const listener = messageEditListeners.get(messageId);
  if (!listener) return false;
  listener();
  return true;
}

/** Register a mounted, editable row. Returns the unsubscribe fn. */
export function onMessageEditRequest(messageId: string, listener: () => void): () => void {
  messageEditListeners.set(messageId, listener);
  return () => {
    if (messageEditListeners.get(messageId) === listener) messageEditListeners.delete(messageId);
  };
}

type ComposerFocusListener = (channelId: string) => void;

const composerFocusListeners = new Set<ComposerFocusListener>();

/** Hand keyboard focus back to the composer of `channelId` (after an edit closes). */
export function requestComposerFocus(channelId: string): void {
  for (const listener of composerFocusListeners) listener(channelId);
}

/** Subscribe a composer to focus requests. Returns the unsubscribe fn. */
export function onComposerFocusRequest(listener: ComposerFocusListener): () => void {
  composerFocusListeners.add(listener);
  return () => {
    composerFocusListeners.delete(listener);
  };
}
