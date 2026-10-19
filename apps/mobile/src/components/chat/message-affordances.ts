/**
 * Which message affordances a thread offers, decided in one pure place so node
 * tests can pin the rules (§35: an affordance that cannot work is not shown).
 */

export interface MessageAffordanceInput {
  /** The viewer wrote the message. */
  isOwn: boolean;
  /** The message has text (an attachment-only message has nothing to edit or copy). */
  hasText: boolean;
  /** The viewer may pin / unpin it here. */
  canPin: boolean;
  /**
   * A DM whose peer the viewer blocked. Its composer is replaced by the
   * blocked notice, so nothing that WRITES through the composer may be
   * offered: a reply or edit draft would be stored with no field to show it,
   * then surface out of nowhere after an unblock.
   */
  blocked: boolean;
}

export interface MessageAffordances {
  /** Swipe-to-reply on the row, and Reply in the sheet. */
  reply: boolean;
  edit: boolean;
  copy: boolean;
  pin: boolean;
  delete: boolean;
}

export function messageAffordances(input: MessageAffordanceInput): MessageAffordances {
  const { isOwn, hasText, canPin, blocked } = input;
  return {
    reply: !blocked,
    edit: !blocked && isOwn && hasText,
    copy: hasText,
    pin: canPin,
    // Removing your own words never needs the composer.
    delete: isOwn,
  };
}

/**
 * Whether a reply or edit draft must be dropped: it belongs to this thread and
 * the thread's composer is gone (the peer is blocked).
 */
export function shouldDropDraft(
  draft: { channelId: string } | null,
  channelId: string,
  blocked: boolean,
): boolean {
  return blocked && draft !== null && draft.channelId === channelId;
}
