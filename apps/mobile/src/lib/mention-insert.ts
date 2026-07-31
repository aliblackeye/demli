/**
 * "Type `@Name` into the open composer" seam — mobile's twin of the desktop
 * app-ui `requestMentionInsert`, and the same shape as `lib/message-jump.ts`.
 *
 * The user action sheet's "Mention" row has to reach a composer whose text,
 * caret and `pendingMentions` all live inside {@link Composer}'s own state. A
 * module-level emitter is the honest seam: a mention insert is a one-shot
 * COMMAND, not state. Held in Zustand it would re-render every subscriber and
 * leave a stale "last mentioned user" that a remount would replay into the
 * user's message (§27).
 *
 * The payload is the SAME `{ id, label }` pair the autocomplete picker produces,
 * so an inserted mention serializes to `<@id>` on send exactly like a typed one
 * — the sheet is another way to pick, never a second mention format.
 */

export interface MentionInsertRequest {
  /** The user to mention; becomes `<@id>` on the wire. */
  userId: string;
  /** The name to type — already nickname-resolved by the caller (ADR 0019 §2). */
  label: string;
}

type MentionListener = (request: MentionInsertRequest) => void;

const listeners = new Set<MentionListener>();

/**
 * Ask the mounted composer to insert `@label` at its caret. A no-op when no
 * composer is mounted, which is the correct outcome: the sheet closes and
 * nothing misleading happens.
 */
export function requestMentionInsert(request: MentionInsertRequest): void {
  for (const listener of [...listeners]) listener(request);
}

/** Subscribe the mounted composer. Returns the unsubscribe function. */
export function onMentionInsert(listener: MentionListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
