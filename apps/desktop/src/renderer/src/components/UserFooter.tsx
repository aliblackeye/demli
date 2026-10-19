import {
  Headphones,
  HeadphoneOff,
  LogOut,
  Mic,
  MicOff,
  MonitorSmartphone,
  Settings,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Hint,
  IconButton,
  UserAvatar,
  cn,
} from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";
import { useAuthStore } from "../stores/auth-store";
import { useChatStore } from "../stores/chat-store";
import { useVoiceStore } from "../stores/voice-store";
import { useUiStore } from "../stores/ui-store";
import { logoutActiveAccount } from "../lib/account-manager";
import { AccountSwitcher } from "./AccountSwitcher";
import { ProfileCard } from "./ProfileCard";
import { StatusPicker } from "./StatusPicker";

/** Hover/press wash for the two pressable regions of the bar (they sit on `surface`). */
const BAR_PRESSABLE = cn(
  "cursor-pointer rounded-lg transition-colors motion-hover",
  "hover:bg-wash active:bg-wash-strong data-[state=open]:bg-wash",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
);

/**
 * Identity + voice controls bar shared by the server (ChannelSidebar) and home
 * (HomeSidebar) second columns — the landing's `KullaniciCubugu`: one surface
 * pill (radius 16) floating at the bottom of the column island, avatar + name +
 * handle, then mic / deafen / settings.
 *
 * Mic off and deafened are DANGER states (design doc §1.4): the glyph swaps to
 * its slashed form AND the button takes the pink wash, so "you are muted" is
 * recognisable by shape and by colour, not colour alone.
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
    <div className="shrink-0 px-2 pb-2">
      {/* Width budget at the 240px column: 8px gutters + 4px pill padding leave
          216px; avatar 32 + three 28px controls = 116, so the identity block
          gets ~100px (the name and custom status stay readable instead of being
          cut to four characters). */}
      <div className="flex h-[52px] items-center rounded-xl bg-surface p-1">
        {/* Avatar opens the user's OWN profile card (founder: "sol-alt avatar →
            profil kartı"); the name block still opens the status / accounts menu. */}
        {currentUser ? (
          <ProfileCard userId={currentUser.id}>
            <button
              type="button"
              aria-label={t("desktop:footer.viewProfile")}
              // No padding to wash (every px goes to the name), so the avatar's
              // own tone answers hover/press/open — the rail tiles' language.
              className={cn(
                "shrink-0 cursor-pointer rounded-full transition-[filter] motion-hover",
                "hover:brightness-115 active:brightness-95 data-[state=open]:brightness-115",
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
          <span className="shrink-0">
            {/* The signed-out / not-yet-loaded branch: there is no user record at all
                here (the branch condition IS `currentUser == null`), so there is no
                avatar to resolve — initials are the only thing that can be drawn. */}
            <UserAvatar name={t("desktop:footer.you")} src={null} size="sm" presence={presence} />
          </span>
        )}

        <DropdownMenu>
          {/* The custom status can outrun the ~85px line; the hint carries it
              whole (and renders nothing when there is no status). */}
          <Hint label={currentUser?.customStatus ?? null}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={t("desktop:footer.userMenu")}
                className={cn(
                  BAR_PRESSABLE,
                  "ml-1 flex min-w-0 flex-1 items-center px-1.5 py-1 text-left",
                )}
              >
                <span className="min-w-0 flex-1 leading-tight">
                  <span className="block truncate text-label font-semibold text-fg">
                    {currentUser?.displayName ?? t("desktop:footer.you")}
                  </span>
                  <span className="block truncate text-2xs text-fg-faint">
                    {currentUser?.customStatus ?? `@${currentUser?.username ?? t("desktop:footer.youHandle")}`}
                  </span>
                </span>
              </button>
            </DropdownMenuTrigger>
          </Hint>
          <DropdownMenuContent align="start" side="top" sideOffset={10} className="w-64">
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

        <IconButton
          variant={micEnabled ? "ghost" : "danger"}
          size="xs"
          label={micEnabled ? t("desktop:voice.mute") : t("desktop:voice.unmute")}
          pressed={!micEnabled}
          active={false}
          onClick={toggleMic}
        >
          {micEnabled ? <Mic aria-hidden /> : <MicOff aria-hidden />}
        </IconButton>
        <IconButton
          variant={deafened ? "danger" : "ghost"}
          size="xs"
          label={deafened ? t("desktop:voice.undeafen") : t("desktop:voice.deafen")}
          pressed={deafened}
          active={false}
          onClick={toggleDeafen}
        >
          {deafened ? <HeadphoneOff aria-hidden /> : <Headphones aria-hidden />}
        </IconButton>
        <IconButton
          variant="ghost"
          size="xs"
          label={t("desktop:settings.title")}
          onClick={() => openSettings()}
        >
          <Settings aria-hidden />
        </IconButton>
      </div>
    </div>
  );
}
