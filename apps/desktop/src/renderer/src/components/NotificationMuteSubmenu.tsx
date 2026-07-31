import { BellOff } from "lucide-react";
import {
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@demli/ui";
import type { NotificationMuteScope } from "@demli/types";
import { useAppTranslation } from "../lib/i18n";
import {
  MUTE_DURATIONS,
  useClearNotificationMute,
  useSetNotificationMute,
} from "../queries/notification-queries";

/**
 * The "Mute notifications" context-menu submenu, shared by a channel row
 * (scope="channel") and a server rail button (scope="group"). Picks a mode
 * (All / Only @mentions) or a timed "all" mute (15m / 1h / 8h / Indefinite), and
 * offers Unmute when the target is currently muted (migration 0013).
 */
export function NotificationMuteSubmenu({
  scope,
  targetId,
  isMuted,
}: {
  scope: NotificationMuteScope;
  targetId: string;
  /** Whether this exact target has an active mute — gates the Unmute item. */
  isMuted: boolean;
}): JSX.Element {
  const { t } = useAppTranslation();
  const setMute = useSetNotificationMute();
  const clearMute = useClearNotificationMute();

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <BellOff className="size-4 shrink-0" />
        {t("desktop:mute.muteNotifications")}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent>
        <ContextMenuItem onSelect={() => setMute.mutate({ scope, targetId, mode: "all" })}>
          {t("desktop:mute.all")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => setMute.mutate({ scope, targetId, mode: "mentions" })}>
          {t("desktop:mute.mentionsOnly")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() =>
            setMute.mutate({ scope, targetId, mode: "all", durationMs: MUTE_DURATIONS.min15 })
          }
        >
          {t("desktop:mute.min15")}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            setMute.mutate({ scope, targetId, mode: "all", durationMs: MUTE_DURATIONS.hour1 })
          }
        >
          {t("desktop:mute.hour1")}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            setMute.mutate({ scope, targetId, mode: "all", durationMs: MUTE_DURATIONS.hours8 })
          }
        >
          {t("desktop:mute.hours8")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => setMute.mutate({ scope, targetId, mode: "all" })}>
          {t("desktop:mute.indefinite")}
        </ContextMenuItem>
        {isMuted && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => clearMute.mutate({ scope, targetId })}>
              {t("desktop:mute.unmute")}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
