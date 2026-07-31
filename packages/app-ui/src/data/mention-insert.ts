/**
 * "Type an @mention into the open composer" seam.
 *
 * The composer's text, caret and pending-mention list are component-local state
 * (MessageComposer owns them, deliberately — a keystroke must not fan out
 * through a store, §27). So the context menu's **Mention** entry, which lives
 * far away in the roster/profile card, needs a way to ASK for an insertion
 * without reaching into that component.
 *
 * Deliberately a module-level emitter rather than a store field, exactly like
 * `message-jump.ts`: an insertion is a one-shot COMMAND, not state. A Zustand
 * field would re-render every subscriber per mention and leave a stale "last
 * mentioned user" that a remount would replay, silently double-inserting.
 *
 * The payload carries the resolved LABEL as well as the id, because the
 * composer's wire transform (`serializeMentions`) matches on the literal
 * `@Label` token the user can see and edit. Sending only the id would insert
 * text the serializer could not later rewrite to `<@id>`, producing a mention
 * that looks right and pings nobody — worse than no feature at all (§35).
 */

/** What the menu asks the composer to insert. */
export interface MentionInsertRequest {
  /** The user to mention — becomes the `<@id>` wire form on send. */
  userId: string;
  /**
   * The name to type, WITHOUT the leading `@`. Already run through
   * `resolveUserName`, so a nicknamed person is mentioned by the name the
   * viewer actually sees.
   */
  label: string;
}

type MentionInsertListener = (request: MentionInsertRequest) => void;

const listeners = new Set<MentionInsertListener>();

/**
 * Ask the mounted composer to append `@label ` at its caret and remember the
 * mention for send-serialization. A no-op when no composer is mounted — which
 * is why the menu only offers "Mention" while a text channel is open.
 */
export function requestMentionInsert(request: MentionInsertRequest): void {
  for (const listener of [...listeners]) listener(request);
}

/** Subscribe the mounted composer. Returns the unsubscribe function. */
export function onMentionInsert(listener: MentionInsertListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
