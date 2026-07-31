/**
 * Keeps the Windows system-tray icon in step with the app (founder request: the
 * tray must show a muted mic, a deafened headset, and a red dot when something is
 * unread). Renders nothing — it is the wiring between the two renderer state
 * sources and the validated `window.demli.system` bridge.
 *
 * WHERE THE TWO SIGNALS COME FROM, and why these sources and not others:
 *
 *   unread — `useShellData().homeUnread` + each `groups[].unread`, i.e. EXACTLY
 *     the aggregate the group rail already paints its badges from. Deriving a
 *     second app-wide unread rule here would guarantee the day the tray dot and
 *     the rail badge disagree, and the mute semantics (a fully muted server
 *     contributes nothing, a mentions-muted one only on a mention) are already
 *     resolved in that data — see lib/server-unread.ts. This is also why the
 *     component lives inside DesktopShellDataProvider rather than at the app root.
 *
 *   voice — `useVoiceStore`, which mirrors the packages/media engine state
 *     (CLAUDE.md §11's single source of truth). Read through three NARROW
 *     selectors, not one object selector: a live call ticks speaking flags,
 *     connection quality and participant lists constantly, and selecting the
 *     whole state would re-render this component on every one of them (§27).
 *     DM calls drive the same engine, so this covers them too with no extra wiring.
 *
 * Change detection lives in lib/tray-sync.ts, not in the effect deps alone — the
 * deps stop the effect re-running, but the sync is what guarantees no duplicate
 * IPC when the provider hands us a new object carrying the same values.
 */
import { useEffect } from "react";
import { useShellData } from "@demli/app-ui";
import { traySync } from "../lib/tray-sync";
import { useVoiceStore } from "../stores/voice-store";

export function TraySyncController(): null {
  const { groups, homeUnread } = useShellData();
  // Any badge the rail would show: the home surface (DMs + group chats) or any
  // server. `.some()` short-circuits and runs over a handful of servers, so it is
  // cheaper than memoising it.
  const hasUnread =
    homeUnread.unread || groups.some((group) => group.unread.unread);

  // `status !== "idle"` rather than `=== "connected"`: joining and reconnecting
  // are still a call the user is in, and the mic/deafen state is already live and
  // meaningful there. Out of a session entirely, the engine keeps micEnabled /
  // deafened as PREFERENCES for the next join, so main deliberately ignores them
  // (main/tray-icon-variant.ts) — this flag is what tells it to.
  const inVoiceSession = useVoiceStore((s) => s.status !== "idle");
  const micEnabled = useVoiceStore((s) => s.micEnabled);
  const deafened = useVoiceStore((s) => s.deafened);

  useEffect(() => {
    traySync.pushUnread(hasUnread);
  }, [hasUnread]);

  useEffect(() => {
    traySync.pushVoice({ inVoiceSession, micEnabled, deafened });
  }, [inVoiceSession, micEnabled, deafened]);

  // Sign-out unmounts the shell while the tray keeps living in the notification
  // area. Without this the icon would sit there showing the previous session's
  // unread dot (or a muted mic) until the app quits.
  useEffect(() => () => traySync.reset(), []);

  return null;
}
