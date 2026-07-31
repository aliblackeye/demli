/**
 * sidebar-visibility — which channel rows a sidebar section actually paints.
 *
 * Two personal view preferences hide channels, and the founder asked for both in
 * the same breath:
 *
 *   COLLAPSE      — "kanallar collapse edildiğinde hangi kanal seçili duruyorsa
 *                   sadece orası gözükmeli". A collapsed section is not empty: it
 *                   keeps the channel you are looking at.
 *   HIDE MUTED    — "susturulan kanalları gizle", the empty-area menu's toggle.
 *
 * They are ONE rule, not two, and that is the whole point of this module. Both
 * hide rows, and both must make the same exception: the channel the user is
 * currently reading, and the voice room their microphone is in, NEVER disappear.
 * Written twice, those exceptions drift — the collapse path remembers to keep the
 * live voice room and the mute path does not, and a user who mutes the room they
 * are talking in watches it vanish from under them. One function, one exception
 * list, applied to categories and to the uncategorized Text/Voice sections alike.
 *
 * That last clause also settles the M18 overlap the task warned about: a
 * collapsed CATEGORY used to drop its channels outright, so collapsing the
 * category you were reading in took your own selection off screen. It now obeys
 * exactly the same rule as the Text/Voice sections, so the two collapse
 * affordances cannot disagree about what "collapsed" means.
 *
 * Framework-free and in client-core so the React Native channel list can share
 * it rather than growing a second copy (same reason as `channel-order.ts`).
 */

import type { Channel, ChannelId } from "@demli/types";

/**
 * The channels that are exempt from every hide rule.
 *
 * Both are "where the user currently IS", in the two independent senses a
 * Demli user can be somewhere: `activeChannelId` is the conversation on
 * screen, `connectedVoiceChannelId` is the room their microphone is in. They are
 * routinely different rows — reading #general while talking in 🔊lobby is the
 * normal case — so keeping only one of them would still lose a place the user
 * is actively occupying.
 */
export interface PinnedSidebarChannels {
  /** The channel whose conversation fills the center, or null. */
  activeChannelId: ChannelId | null;
  /** The voice room this client is connected to (any non-idle status), or null. */
  connectedVoiceChannelId: ChannelId | null;
}

/** Whether a channel is exempt from hiding because the user is in it. */
export function isPinnedSidebarChannel(
  channelId: ChannelId,
  pinned: PinnedSidebarChannels,
): boolean {
  return channelId === pinned.activeChannelId || channelId === pinned.connectedVoiceChannelId;
}

export interface SidebarVisibilityOptions {
  /** This section's collapse state. Collapsed → only pinned channels survive. */
  collapsed: boolean;
  /** The "hide muted channels" view preference is on. */
  hideMuted: boolean;
  /**
   * Channels the viewer muted INDIVIDUALLY (channel-scope mute only).
   *
   * Deliberately not the effective mute mode: a server-scope mute makes every
   * one of its channels "muted", and feeding that in would empty the entire
   * sidebar the moment someone mutes a server — turning a per-channel tidy-up
   * into "my server disappeared".
   */
  mutedChannelIds: ReadonlySet<ChannelId>;
  pinned: PinnedSidebarChannels;
}

/**
 * Filter one section's channels down to what it should paint.
 *
 * Returns the SAME array instance when nothing is hidden, so an untouched
 * sidebar does not hand React a fresh array on every render (§27) and the
 * overwhelmingly common case — nothing collapsed, nothing muted — costs one
 * boolean check rather than a walk.
 */
export function visibleSidebarChannels(
  channels: readonly Channel[],
  options: SidebarVisibilityOptions,
): readonly Channel[] {
  const { collapsed, hideMuted, mutedChannelIds, pinned } = options;
  if (!collapsed && (!hideMuted || mutedChannelIds.size === 0)) return channels;
  return channels.filter((channel) => {
    if (isPinnedSidebarChannel(channel.id, pinned)) return true;
    if (collapsed) return false;
    return !mutedChannelIds.has(channel.id);
  });
}

/**
 * Whether a collapsed section has anything left to show.
 *
 * Used to decide between "render the surviving row" and "render nothing at all"
 * — the founder's "seçili kanal o bölümde değilse bölüm tamamen kapanır".
 */
export function hasVisibleChannels(
  channels: readonly Channel[],
  options: SidebarVisibilityOptions,
): boolean {
  return visibleSidebarChannels(channels, options).length > 0;
}
