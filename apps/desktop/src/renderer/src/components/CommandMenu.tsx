import { useEffect, useMemo } from "react";
import { Command } from "cmdk";
import {
  Hash,
  Headphones,
  HeadphoneOff,
  LogIn,
  Mic,
  MicOff,
  PhoneCall,
  Plus,
  Search,
  Settings,
  Settings2,
  UserPlus,
  Users,
  Volume2,
} from "lucide-react";
import { isChatCapableChannel } from "@demli/types";
import { Kbd, cn, seedColor } from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";
import { useGroupDetails, useGroups } from "../queries/chat-queries";
import { useChatStore } from "../stores/chat-store";
import { useVoiceStore } from "../stores/voice-store";
import { joinVoiceChannel, openChannelChat } from "../lib/channel-actions";
import { useUiStore } from "../stores/ui-store";

const itemClass = cn(
  "flex cursor-pointer select-none items-center gap-2.5 rounded-md px-2.5 py-2",
  "text-sm text-fg-muted",
  "data-[selected=true]:bg-accent data-[selected=true]:text-on-accent",
);

const groupClass = cn(
  "[&_[cmdk-group-heading]]:px-2.5 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3",
  "[&_[cmdk-group-heading]]:text-2xs [&_[cmdk-group-heading]]:font-semibold",
  "[&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wider",
  "[&_[cmdk-group-heading]]:text-fg-faint",
);

/** Ctrl/Cmd+K command palette — group/channel switcher plus quick actions. */
export function CommandMenu(): JSX.Element {
  const { t } = useAppTranslation();
  const open = useUiStore((s) => s.commandMenuOpen);
  const setOpen = useUiStore((s) => s.setCommandMenuOpen);
  const setInviteDialogOpen = useUiStore((s) => s.setInviteDialogOpen);
  const setChannelSearchOpen = useUiStore((s) => s.setChannelSearchOpen);
  const setDeviceDialogOpen = useUiStore((s) => s.setDeviceDialogOpen);
  const openAddServer = useUiStore((s) => s.openAddServer);
  const openSettings = useUiStore((s) => s.openSettings);

  const activeGroupId = useChatStore((s) => s.activeGroupId);
  const activeView = useChatStore((s) => s.activeView);
  const openServer = useChatStore((s) => s.openServer);
  const toggleMemberSidebar = useChatStore((s) => s.toggleMemberSidebar);

  // "Invite people" and "Toggle member list" act on the server surface only; on
  // the home (friends/DM) surface they have nothing to target, so hide them (#16).
  const onServerSurface = activeView === "server";

  const { data: groups } = useGroups();
  const { data: details } = useGroupDetails(activeGroupId);
  const activeGroupName = groups?.find((g) => g.id === activeGroupId)?.name;

  const micEnabled = useVoiceStore((s) => s.micEnabled);
  const deafened = useVoiceStore((s) => s.deafened);
  const toggleMic = useVoiceStore((s) => s.toggleMic);
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(!useUiStore.getState().commandMenuOpen);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [setOpen]);

  const channels = details?.channels;
  // M20 — the palette mirrors the split the sidebar makes: the first group OPENS
  // a conversation (every chat-capable channel, voice included, because a voice
  // channel now has one), the second JOINS a voice room. Two verbs, two groups,
  // so "read what they said in Lobi" and "put my microphone in Lobi" are never
  // the same keystroke.
  const chatChannels = useMemo(
    () => (channels ?? []).filter((c) => isChatCapableChannel(c.kind)),
    [channels],
  );
  const voiceChannels = useMemo(
    () => (channels ?? []).filter((c) => c.kind === "voice"),
    [channels],
  );
  const otherGroups = useMemo(
    () => (groups ?? []).filter((g) => g.id !== activeGroupId),
    [groups, activeGroupId],
  );

  const runAction = (action: () => void): void => {
    action();
    setOpen(false);
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label={t("desktop:commandMenu.label")}
      loop
      overlayClassName={cn(
        "fixed inset-0 z-50 bg-black/60",
        "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out",
      )}
      contentClassName={cn(
        "fixed left-1/2 top-[16%] z-50 w-[560px] max-w-[calc(100vw-2rem)] -translate-x-1/2",
        "data-[state=open]:animate-pop-in data-[state=closed]:animate-pop-out",
      )}
      className="overflow-hidden rounded-xl border border-stroke-strong bg-overlay shadow-2xl"
    >
      <div className="flex items-center gap-2.5 border-b border-stroke px-3.5">
        <Search className="size-4 shrink-0 text-fg-faint" />
        <Command.Input
          placeholder={t("desktop:commandMenu.placeholder")}
          className="h-12 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-faint focus:outline-none"
        />
        <Kbd>Esc</Kbd>
      </div>
      <Command.List className="max-h-[min(360px,50vh)] overflow-y-auto p-1.5 pb-2.5">
        <Command.Empty className="py-9 text-center text-sm text-fg-muted">
          {t("desktop:commandMenu.empty")}
        </Command.Empty>

        <Command.Group heading={t("desktop:commandMenu.channels")} className={groupClass}>
          {chatChannels.map((channel) => (
            <Command.Item
              key={channel.id}
              value={`${activeGroupName ?? ""} ${channel.name} ${channel.id}`}
              onSelect={() => runAction(() => openChannelChat(channel))}
              className={itemClass}
            >
              {channel.kind === "voice" ? (
                <Volume2 className="size-4 shrink-0" />
              ) : (
                <Hash className="size-4 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate">{channel.name}</span>
              <span className="text-xs opacity-60">{activeGroupName}</span>
            </Command.Item>
          ))}
        </Command.Group>

        <Command.Group heading={t("desktop:sidebar.voiceChannels")} className={groupClass}>
          {voiceChannels.map((channel) => (
            <Command.Item
              key={channel.id}
              value={`join ${activeGroupName ?? ""} ${channel.name} ${channel.id}`}
              onSelect={() =>
                runAction(() => joinVoiceChannel(channel, activeGroupName ?? null))
              }
              className={itemClass}
            >
              <PhoneCall className="size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">
                {t("desktop:commandMenu.joinChannel", { channel: channel.name })}
              </span>
              <span className="text-xs opacity-60">{activeGroupName}</span>
            </Command.Item>
          ))}
        </Command.Group>

        {otherGroups.length > 0 && (
          <Command.Group heading={t("desktop:commandMenu.switchGroup")} className={groupClass}>
            {otherGroups.map((group) => (
              <Command.Item
                key={group.id}
                value={`switch group ${group.name} ${group.id}`}
                onSelect={() => runAction(() => openServer(group.id))}
                className={itemClass}
              >
                <span
                  aria-hidden
                  className="flex size-4 shrink-0 items-center justify-center rounded-md text-3xs font-bold text-white/90"
                  style={{ backgroundColor: seedColor(group.id) }}
                >
                  {group.name.charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate">{group.name}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        <Command.Group heading={t("desktop:commandMenu.actions")} className={groupClass}>
          <Command.Item
            value="toggle mute microphone"
            onSelect={() => runAction(toggleMic)}
            className={itemClass}
          >
            {micEnabled ? <MicOff className="size-4" /> : <Mic className="size-4" />}
            {micEnabled ? t("desktop:voice.mute") : t("desktop:voice.unmute")}
          </Command.Item>
          <Command.Item
            value="toggle deafen"
            onSelect={() => runAction(toggleDeafen)}
            className={itemClass}
          >
            {deafened ? <Headphones className="size-4" /> : <HeadphoneOff className="size-4" />}
            {deafened ? t("desktop:voice.undeafen") : t("desktop:voice.deafen")}
          </Command.Item>
          {onServerSurface && (
            <Command.Item
              value="search messages in channel find"
              onSelect={() => runAction(() => setChannelSearchOpen(true))}
              className={itemClass}
            >
              <Search className="size-4" />
              {t("desktop:search.commandAction")}
            </Command.Item>
          )}
          {onServerSurface && (
            <Command.Item
              value="invite people friends"
              onSelect={() => runAction(() => setInviteDialogOpen(true))}
              className={itemClass}
            >
              <UserPlus className="size-4" />
              {t("desktop:chat.invitePeople")}
            </Command.Item>
          )}
          <Command.Item
            value="create new group"
            onSelect={() => runAction(() => openAddServer("create"))}
            className={itemClass}
          >
            <Plus className="size-4" />
            {t("desktop:addServer.createTitle")}
          </Command.Item>
          <Command.Item
            value="join a group with an invite code or link"
            onSelect={() => runAction(() => openAddServer("join"))}
            className={itemClass}
          >
            <LogIn className="size-4" />
            {t("desktop:commandMenu.joinWithCode")}
          </Command.Item>
          {onServerSurface && (
            <Command.Item
              value="toggle member list sidebar"
              onSelect={() => runAction(toggleMemberSidebar)}
              className={itemClass}
            >
              <Users className="size-4" />
              {t("desktop:commandMenu.toggleMembers")}
            </Command.Item>
          )}
          <Command.Item
            value="voice device settings microphone output"
            onSelect={() => runAction(() => setDeviceDialogOpen(true))}
            className={itemClass}
          >
            <Settings2 className="size-4" />
            {t("desktop:voice.voiceSettings")}
          </Command.Item>
          <Command.Item
            value="open user settings"
            onSelect={() => runAction(() => openSettings())}
            className={itemClass}
          >
            <Settings className="size-4" />
            {t("desktop:commandMenu.openSettings")}
          </Command.Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}
