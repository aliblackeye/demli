/**
 * The unread count badge moved to @demli/app-ui (Phase 1) so the shared rail
 * and sidebars can use it. Re-exported here so the desktop-only, voice-coupled
 * ChannelItem keeps its `./UnreadCountBadge` import unchanged.
 */
export { UnreadCountBadge } from "@demli/app-ui";
