import { AtSign, Bell, BellOff, BellRing, Clock } from "lucide-react";
import {
  ContextMenuItem,
  ContextMenuLabel,
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
 * (scope="channel") and a server rail button (scope="group").
 *
 * Two groups, because they are two different questions: a lasting MODE (mute
 * everything / let only @mentions through) and, under its own label, FOR HOW
 * LONG to mute everything (15m / 1h / 8h / until turned back on). Unmute is offered
 * only while this exact target has an active mute (migration 0013) — never as
 * a dead row (§35).
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

  const timed = [
    { key: "min15", label: t("desktop:mute.min15"), durationMs: MUTE_DURATIONS.min15 },
    { key: "hour1", label: t("desktop:mute.hour1"), durationMs: MUTE_DURATIONS.hour1 },
    { key: "hours8", label: t("desktop:mute.hours8"), durationMs: MUTE_DURATIONS.hours8 },
  ] as const;

  return (
    <ContextMenuSub>
      <ContextMenuSubTrigger>
        <BellOff className="size-4 shrink-0" />
        {t("desktop:mute.muteNotifications")}
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="w-56">
        <ContextMenuItem onSelect={() => setMute.mutate({ scope, targetId, mode: "all" })}>
          <BellOff className="size-4" />
          {t("desktop:mute.all")}
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => setMute.mutate({ scope, targetId, mode: "mentions" })}>
          <AtSign className="size-4" />
          {t("desktop:mute.mentionsOnly")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuLabel>{t("desktop:mute.forLabel")}</ContextMenuLabel>
        {timed.map((option) => (
          <ContextMenuItem
            key={option.key}
            onSelect={() =>
              setMute.mutate({ scope, targetId, mode: "all", durationMs: option.durationMs })
            }
          >
            <Clock className="size-4" />
            {option.label}
          </ContextMenuItem>
        ))}
        <ContextMenuItem onSelect={() => setMute.mutate({ scope, targetId, mode: "all" })}>
          <Bell className="size-4" />
          {t("desktop:mute.indefinite")}
        </ContextMenuItem>
        {isMuted && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={() => clearMute.mutate({ scope, targetId })}>
              <BellRing className="size-4" />
              {t("desktop:mute.unmute")}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
