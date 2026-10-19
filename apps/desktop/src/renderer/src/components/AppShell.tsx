import { useEffect } from "react";
import { TooltipProvider } from "@demli/ui";
import { AppShell as AppShellFrame } from "@demli/app-ui";
import { useGroups, useGroupDetails } from "../queries/chat-queries";
import { useNotificationMutes } from "../queries/notification-queries";
import { useChatStore } from "../stores/chat-store";
import { useVoiceStore } from "../stores/voice-store";
import { useVideoStageStore } from "../stores/video-stage-store";
import { useIsMobileViewport } from "../hooks/useMediaQuery";
import { GroupRail } from "./GroupRail";
import { ChannelSidebar } from "./ChannelSidebar";
import { MemberSidebar } from "./MemberSidebar";
import { HomeSidebar } from "./HomeSidebar";
import { GroupChatMemberSidebar } from "./GroupChatMemberSidebar";
import { AppCenter } from "./AppCenter";
import { MobileShell } from "./MobileShell";
import { CommandMenu } from "./CommandMenu";
import { ChannelInviteDialog } from "./ChannelInviteDialog";
import { InviteDialog } from "./InviteDialog";
import { AddServerDialog } from "./AddServerDialog";
import { DownloadAppDialog } from "./DownloadAppDialog";
import { CreateChannelDialog } from "./CreateChannelDialog";
import { CreateGroupChatDialog } from "./CreateGroupChatDialog";
import { AddGroupMemberDialog } from "./AddGroupMemberDialog";
import { ServerSettingsDialog } from "./ServerSettingsDialog";
import { LeaveServerDialog } from "./LeaveServerDialog";
import { ChannelSettingsDialog } from "./ChannelSettingsDialog";
import { DeviceSettingsDialog } from "./DeviceSettingsDialog";
import { CategoryDialogs } from "./CategoryDialogs";
import { BlockUserDialog } from "./BlockUserDialog";
import { CustomStatusDialog } from "./CustomStatusDialog";
import { MemberDialogs } from "./MemberDialogs";
import { GroupChatInviteDialog } from "./GroupChatInviteDialog";
import { SettingsShell } from "./SettingsShell";
import { InAppNotificationToast } from "./InAppNotificationToast";
import { PushToTalkListener } from "./PushToTalkListener";
import { DesktopShellDataProvider } from "./DesktopShellDataProvider";
import { ShellNudges } from "./ShellNudges";
import { TraySyncController } from "./TraySyncController";

/** Keeps the active server group/channel selection consistent with server data. */
function useSelectionSync(): void {
  const { data: groups } = useGroups();
  const activeView = useChatStore((s) => s.activeView);
  const activeGroupId = useChatStore((s) => s.activeGroupId);
  const { data: details } = useGroupDetails(activeGroupId);

  // Select the first server when none is selected (or it disappeared). Runs in
  // the background regardless of surface — setActiveGroup does not change the
  // view, so it never yanks the user out of the home surface.
  useEffect(() => {
    if (!groups) return;
    const valid = activeGroupId !== null && groups.some((g) => g.id === activeGroupId);
    if (valid) return;
    const first = groups[0];
    if (first) {
      useChatStore.getState().setActiveGroup(first.id);
    } else if (activeGroupId !== null) {
      // No servers left (left / deleted the last one). Clear the dangling
      // selection and fall back to home so we never keep showing a server the
      // user is no longer in (task #49).
      useChatStore.getState().dropServerSelection();
    }
  }, [groups, activeGroupId]);

  // Once the active server's channels load, validate/repair the channel pick —
  // only while the server surface is showing, so it never clobbers the channel
  // id the home surface points at a group's stream.
  useEffect(() => {
    if (activeView !== "server") return;
    if (details && details.group.id === activeGroupId) {
      useChatStore.getState().ensureChannelSelection(details.channels);
    }
  }, [activeView, details, activeGroupId]);
}

/**
 * Root-level overlays shared by BOTH layouts (dialogs, command menu, settings,
 * push-to-talk listener). Rendered as siblings of the shell so they never
 * participate in the column/drawer layout. Kept inside DesktopShellDataProvider
 * so any overlay that reads shell data still resolves it.
 */
function AppShellOverlays(): JSX.Element {
  return (
    <>
      <CommandMenu />
      <InviteDialog />
      {/* Same reason as the M18 overlays below: it is opened from a channel
          row's context menu, which Radix unmounts the instant an entry fires. */}
      <ChannelInviteDialog />
      <AddServerDialog />
      <DownloadAppDialog />
      <CreateChannelDialog />
      <CreateGroupChatDialog />
      <AddGroupMemberDialog />
      <ServerSettingsDialog />
      <LeaveServerDialog />
      <ChannelSettingsDialog />
      <DeviceSettingsDialog />
      {/* M18 overlays: channel categories, the block confirmation, the custom
          status editor and group-DM invite links. Mounted here (not next to their
          triggers) so a menu closing never unmounts the dialog it just opened. */}
      <CategoryDialogs />
      <BlockUserDialog />
      {/* The user context menu's own dialogs (note, the two nickname layers,
          kick, ban) — same reason: Radix unmounts a context menu the instant an
          entry is selected. */}
      <MemberDialogs />
      <CustomStatusDialog />
      <GroupChatInviteDialog />
      <SettingsShell />
      {/* Fallback notification surface: paints ONLY when no OS toast is
          available (web without notification permission, or an engine with no
          Notification API). Renders nothing otherwise — see the component. */}
      <InAppNotificationToast />
      <PushToTalkListener />
    </>
  );
}

/**
 * Desktop four-column shell (WIDE viewport, ≥ 900px): the single-source
 * @demli/app-ui `AppShell` frame fed the desktop product components —
 * byte-identical to the pre-responsive layout (GroupRail | Channel/Home sidebar |
 * Chat/VideoStage | Members). The Phase-2 desktop-only arms (video stage, voice
 * panel) live inside the slot fillers and never enter the shared frame.
 */
function DesktopShell(): JSX.Element {
  const memberSidebarOpen = useChatStore((s) => s.memberSidebarOpen);
  const isHome = useChatStore((s) => s.activeView === "home");
  const homeView = useChatStore((s) => s.homeView);
  const activeGroupChatId = useChatStore((s) => s.activeGroupChatId);

  // The member sidebar belongs to a server channel or a flat group chat only —
  // the Friends table and DMs carry their own header, no roster column.
  const showGroupChatMembers = isHome && homeView === "groupChat" && activeGroupChatId !== null;

  return (
    <AppShellFrame
      groupRail={<GroupRail />}
      sidebar={isHome ? <HomeSidebar /> : <ChannelSidebar />}
      center={<AppCenter />}
      memberSidebar={
        memberSidebarOpen &&
        (isHome ? showGroupChatMembers && <GroupChatMemberSidebar /> : <MemberSidebar />)
      }
    />
  );
}

/**
 * Root shell. Picks the layout by viewport width: the desktop four-column shell
 * on a wide viewport, the single-column {@link MobileShell} (drawers) on a narrow
 * one. The switch is width-only and the mobile threshold sits under Electron's
 * window minimum (see {@link useIsMobileViewport}), so the desktop app always
 * renders the wide layout — only a genuinely narrow web viewport (a phone) gets
 * mobile.
 *
 * Both layouts render the SAME product components (via the shared shell-data
 * provider) and share the SAME root-level overlays; only the navigation chrome
 * around the center differs. Session-level concerns (selection sync, notification
 * mutes, video-stage reset) stay here so they run in either layout.
 */
export function AppShell(): JSX.Element {
  const isMobile = useIsMobileViewport();
  useSelectionSync();
  // Load the caller's notification mutes once and seed the store lookup, so
  // ChannelItem / GroupRail paint mute state from app start (migration 0013).
  useNotificationMutes();

  // Reset the video-stage view knobs (focus / fullscreen / panel width / PiP)
  // when the voice session ENDS (status → idle), not when the VideoStage unmounts.
  // The center swaps VideoStage⇄ChatView as the user peeks at chat, so tying the
  // reset to the component's lifecycle would wipe the layout on every detour
  // (requirement #3). Keyed on the engine's voice status — mounted for the whole
  // authenticated session — it also resets after a DM call hangs up. A DM call
  // MINIMIZE keeps the engine connected, so the layout survives restore.
  const voiceStatus = useVoiceStore((s) => s.status);
  useEffect(() => {
    if (voiceStatus === "idle") useVideoStageStore.getState().reset();
  }, [voiceStatus]);

  return (
    <TooltipProvider delayDuration={350} skipDelayDuration={200}>
      {/* DesktopShellDataProvider feeds the shared shell-edge components (rail /
          channel & home sidebars / roster) their data via useShellData — needed
          by BOTH layouts, so it wraps the whole shell. It subscribes to the busy
          presence/unread slices and is handed the shell as STABLE children, so
          those ticks re-render only the sidebars (context consumers) and never
          the chat/video center. */}
      <DesktopShellDataProvider>
        {isMobile ? <MobileShell /> : <DesktopShell />}
        <AppShellOverlays />
        {/* Renders nothing: mirrors unread + own voice state onto the Windows
            tray icon. Must sit INSIDE the provider — it reads the very same
            unread aggregate the group rail badges use, so the tray dot and the
            rail can never disagree. */}
        <TraySyncController />
      </DesktopShellDataProvider>
      {/* The age-verify reminder and the web-only "get the app" pill. On the
          wide shell they sit in flow at the foot of the second column (see the
          sidebar bindings); on the narrow web shell they float above the
          composer. Either way they cover nothing — see ShellNudges. */}
      <ShellNudges placement="floating" />
    </TooltipProvider>
  );
}
