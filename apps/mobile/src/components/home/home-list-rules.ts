/**
 * Pure state rules for the Home shell's two lists — which state a list is in,
 * and what a channel row's unread badge says. Kept free of React / React Native
 * so node unit tests pin every branch (home-list-rules.test.ts); the components
 * only render what these return.
 */
import { UNREAD_UNKNOWN_BADGE, unreadBadgeText } from "@demli/client-core";
import type { NotificationMuteMode } from "@demli/types";

// ---------------------------------------------------------------------------
// DM list (Home entry of the rail)
// ---------------------------------------------------------------------------

/** Which list failed, for the partial-failure band above a list that still has rows. */
export type DmListBand = "dms" | "groups" | "both" | null;

export type DmListStates = {
  /** Draw the skeleton (and no rows): the DMs are not in yet, or nothing is. */
  skeleton: boolean;
  /** With zero rows: an honest error, or the welcoming empty state. */
  empty: "error" | "empty";
  /** Rows are on screen but one of the two sources failed — say which. */
  band: DmListBand;
};

/**
 * The DM list mixes two queries (DMs, group chats). It must never claim "no
 * direct messages" while the DMs are still loading, and never hide a failed
 * load just because the other source produced rows.
 *
 * `*Pending` is TanStack's `isPending` (no data yet, not errored); `*Failed` is
 * `isError` (which is also true for a failed refetch over cached data).
 */
export function dmListStates({
  dmsPending,
  dmsFailed,
  groupsPending,
  groupsFailed,
  rowCount,
}: {
  dmsPending: boolean;
  dmsFailed: boolean;
  groupsPending: boolean;
  groupsFailed: boolean;
  rowCount: number;
}): DmListStates {
  // DMs lead the list: until they land, group chats alone would be a half list
  // the DMs then shove down. With nothing at all yet, wait for both.
  const skeleton = dmsPending || (rowCount === 0 && groupsPending);
  const anyFailed = dmsFailed || groupsFailed;
  const empty = anyFailed ? "error" : "empty";
  const band: DmListBand =
    skeleton || rowCount === 0 || !anyFailed
      ? null
      : dmsFailed && groupsFailed
        ? "both"
        : dmsFailed
          ? "dms"
          : "groups";
  return { skeleton, empty, band };
}

// ---------------------------------------------------------------------------
// Server channel list
// ---------------------------------------------------------------------------

/**
 * The uncategorized "Text channels" section: its rows, an empty state, or
 * nothing at all. The empty state says "this server has no text channels", so
 * it may only appear when that is TRUE of the whole server — a server that keeps
 * every text channel inside categories simply has no uncategorized text section.
 */
export function uncategorizedTextSection(
  uncategorizedTextCount: number,
  channels: readonly { kind: string }[],
): "list" | "empty" | "omit" {
  if (uncategorizedTextCount > 0) return "list";
  return channels.some((c) => c.kind === "text") ? "omit" : "empty";
}

export type ChannelRowBadge = { text: string; tone: "accent" | "neutral" } | null;

/**
 * A channel row's unread COUNT badge — the desktop ChannelItem's rule, so the
 * two surfaces (and the rail tile, which already speaks it) send one signal:
 *
 *  - coral only for a mention; a plain unread is the neutral chip;
 *  - only a genuine number — an uncounted unread ("1+") keeps the pip alone;
 *  - none for a "mentions"-muted channel: its raw count includes the muted
 *    messages, so it would be a number the user asked not to be told.
 *
 * `unread` is the row's already mute-filtered unread flag (what lights the pip).
 */
export function channelRowBadge({
  unread,
  mention,
  unreadCount,
  muteMode,
}: {
  unread: boolean;
  mention: boolean;
  unreadCount: number;
  muteMode: NotificationMuteMode | null;
}): ChannelRowBadge {
  if (!unread || muteMode === "mentions") return null;
  const text = unreadBadgeText(unreadCount, true);
  if (text === null || text === UNREAD_UNKNOWN_BADGE) return null;
  return { text, tone: mention ? "accent" : "neutral" };
}
