import { type ReactNode } from "react";
import {
  Headphones,
  HeadphoneOff,
  LogOut,
  Mic,
  MicOff,
  Settings,
} from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  UserAvatar,
  cn,
} from "@demli/ui";
import { MonitorSmartphone } from "lucide-react";
import { useAppTranslation } from "../lib/i18n";
import { useAuthStore } from "../stores/auth-store";
import { useChatStore } from "../stores/chat-store";
import { useVoiceStore } from "../stores/voice-store";
import { useUiStore } from "../stores/ui-store";
import { logoutActiveAccount } from "../lib/account-manager";
import { AccountSwitcher } from "./AccountSwitcher";
import { ProfileCard } from "./ProfileCard";
import { StatusPicker } from "./StatusPicker";

function FooterIconButton({
  label,
  active = false,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-pressed={active}
          onClick={onClick}
          className={cn(active && "text-danger hover:text-danger")}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * Identity + voice controls footer shared by the server (ChannelSidebar) and
 * home (HomeSidebar) second columns.
 */
export function UserFooter(): JSX.Element {
  const { t } = useAppTranslation();
  const currentUser = useAuthStore((s) => s.user);
  const presence = useChatStore((s) =>
    currentUser ? (s.presence[currentUser.id] ?? "offline") : "offline",
  );
  const micEnabled = useVoiceStore((s) => s.micEnabled);
  const deafened = useVoiceStore((s) => s.deafened);
  const toggleMic = useVoiceStore((s) => s.toggleMic);
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
  const openSettings = useUiStore((s) => s.openSettings);

  return (
    <div className="flex h-[52px] shrink-0 items-center gap-1 border-t border-stroke bg-sidebar px-2">
      {/* Avatar opens the user's OWN profile card (founder: "sol-alt avatar →
          profil kartı"); the name block still opens the status / accounts menu. */}
      {currentUser ? (
        <ProfileCard userId={currentUser.id}>
          <button
            type="button"
            aria-label={t("desktop:footer.viewProfile")}
            className={cn(
              "shrink-0 cursor-pointer rounded-md p-1",
              "transition-colors motion-instant hover:bg-white/[0.04]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
            )}
          >
            <UserAvatar
              name={currentUser.displayName}
              colorSeed={currentUser.id}
              src={currentUser.avatarUrl}
              size="sm"
              presence={presence}
            />
          </button>
        </ProfileCard>
      ) : (
        <span className="shrink-0 p-1">
          {/* The signed-out / not-yet-loaded branch: there is no user record at all
              here (the branch condition IS `currentUser == null`), so there is no
              avatar to resolve — initials are the only thing that can be drawn. */}
          <UserAvatar name={t("desktop:footer.you")} src={null} size="sm" presence={presence} />
        </span>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={t("desktop:footer.userMenu")}
            className={cn(
              "flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-left",
              "transition-colors motion-instant hover:bg-white/[0.04]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
            )}
          >
            <span className="min-w-0 flex-1 leading-tight">
              <span className="block truncate text-[13px] font-semibold text-fg">
                {currentUser?.displayName ?? t("desktop:footer.you")}
              </span>
              <span className="block truncate text-2xs text-fg-faint">
                @{currentUser?.username ?? t("desktop:footer.youHandle")}
              </span>
            </span>
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-60">
          <StatusPicker />
          <DropdownMenuSeparator />
          <AccountSwitcher />
          <DropdownMenuItem onSelect={() => openSettings("profile")}>
            <Settings className="size-4" />
            {t("desktop:settings.title")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => openSettings("sessions")}>
            <MonitorSmartphone className="size-4" />
            {t("desktop:settings.nav.sessions")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem danger onSelect={() => void logoutActiveAccount()}>
            <LogOut className="size-4" />
            {t("desktop:settings.account.logout")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <FooterIconButton
        label={micEnabled ? t("desktop:voice.mute") : t("desktop:voice.unmute")}
        active={!micEnabled}
        onClick={toggleMic}
      >
        {micEnabled ? <Mic className="size-4" /> : <MicOff className="size-4" />}
      </FooterIconButton>
      <FooterIconButton
        label={deafened ? t("desktop:voice.undeafen") : t("desktop:voice.deafen")}
        active={deafened}
        onClick={toggleDeafen}
      >
        {deafened ? <HeadphoneOff className="size-4" /> : <Headphones className="size-4" />}
      </FooterIconButton>
      <FooterIconButton label={t("desktop:settings.title")} onClick={() => openSettings()}>
        <Settings className="size-4" />
      </FooterIconButton>
    </div>
  );
}
