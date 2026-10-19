import { Check, MessageCircle, X } from "lucide-react";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  PresenceBadge,
} from "@demli/ui";
import { SELECTABLE_PRESENCE_STATUSES, type SelectablePresenceStatus } from "@demli/types";
import { useAppTranslation } from "../lib/i18n";
import { useSetCustomStatus } from "../queries/social-queries";
import { useAuthStore } from "../stores/auth-store";
import { useSelfPresenceStore } from "../stores/self-presence-store";
import { useUiStore } from "../stores/ui-store";
import { setSelfPresenceStatus } from "../realtime/connection";

// `as const` keeps the values as literal catalog keys so the typed `t()` accepts
// them (a plain `string` would not satisfy its key union).
const LABEL_KEY = {
  online: "desktop:presence.online",
  idle: "desktop:presence.idle",
  dnd: "desktop:presence.dnd",
  invisible: "desktop:presence.invisible",
} as const satisfies Record<SelectablePresenceStatus, string>;

/** Only dnd + invisible carry an explanation — their behavior is non-obvious. */
const DESC_KEY: Partial<
  Record<SelectablePresenceStatus, "desktop:presence.dndDesc" | "desktop:presence.invisibleDesc">
> = {
  dnd: "desktop:presence.dndDesc",
  invisible: "desktop:presence.invisibleDesc",
};

/**
 * The status picker for the bottom-left user menu (submenu of
 * {@link UserFooter}). Shows the current status on the trigger, and the four
 * selectable statuses — Online / Idle / Do Not Disturb / Invisible — each with
 * its colored dot and (for dnd/invisible) a one-line description. Selecting one
 * persists it, repaints the dot, and re-broadcasts to peers via
 * {@link setSelfPresenceStatus}.
 */
export function StatusPicker(): JSX.Element {
  const { t } = useAppTranslation();
  const meId = useAuthStore((s) => s.user?.id);
  const customStatus = useAuthStore((s) => s.user?.customStatus ?? null);
  const setCustomStatusDialogOpen = useUiStore((s) => s.setCustomStatusDialogOpen);
  const setCustomStatus = useSetCustomStatus();
  const current: SelectablePresenceStatus = useSelfPresenceStore((s) =>
    meId ? (s.statusByUser[meId] ?? "online") : "online",
  );

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="group gap-2.5">
        <PresenceBadge status={current} className="ring-transparent" />
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block text-label font-semibold text-fg group-data-[highlighted]:text-fg">
            {t("desktop:presence.menuLabel")}
          </span>
          {/* The trigger's second line prefers the custom status when there is
              one — that is the line peers actually see, so showing "Online" over
              it would misreport what the user is broadcasting. Plain text child,
              never markdown (§28). */}
          <span className="block truncate text-2xs text-fg-faint group-data-[highlighted]:text-fg-muted">
            {customStatus ?? t(LABEL_KEY[current])}
          </span>
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-64">
        {SELECTABLE_PRESENCE_STATUSES.map((status) => {
          const descKey = DESC_KEY[status];
          return (
            <DropdownMenuItem
              key={status}
              className="group items-start gap-2.5 py-2"
              onSelect={() => setSelfPresenceStatus(status)}
            >
              <PresenceBadge status={status} className="mt-1 ring-transparent" />
              <span className="min-w-0 flex-1 leading-tight">
                <span className="block text-label font-semibold text-fg group-data-[highlighted]:text-fg">
                  {t(LABEL_KEY[status])}
                </span>
                {descKey && (
                  <span className="mt-0.5 block text-2xs leading-snug text-fg-faint group-data-[highlighted]:text-fg-muted">
                    {t(descKey)}
                  </span>
                )}
              </span>
              {status === current && (
                <Check className="mt-0.5 size-4 shrink-0 text-accent group-data-[highlighted]:text-fg" />
              )}
            </DropdownMenuItem>
          );
        })}

        <DropdownMenuSeparator />

        {/* Custom status (M18) sits UNDER the four presence states:
            it is orthogonal to the dot (you can be idle with a status) and needs a
            text field, so it opens a dialog rather than toggling inline. */}
        <DropdownMenuItem
          className="group items-start gap-2.5 py-2"
          onSelect={() => setCustomStatusDialogOpen(true)}
        >
          <MessageCircle className="mt-0.5 size-4 shrink-0 text-fg-faint group-data-[highlighted]:text-fg" />
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block text-label font-semibold text-fg group-data-[highlighted]:text-fg">
              {customStatus ? t("desktop:customStatus.edit") : t("desktop:customStatus.set")}
            </span>
            {customStatus && (
              <span className="mt-0.5 block truncate text-2xs text-fg-faint group-data-[highlighted]:text-fg-muted">
                {customStatus}
              </span>
            )}
          </span>
        </DropdownMenuItem>
        {/* Only offered when there is a status to clear (§35). */}
        {customStatus && (
          <DropdownMenuItem
            className="group gap-2.5"
            disabled={setCustomStatus.isPending}
            onSelect={() => setCustomStatus.mutate({ text: null })}
          >
            <X className="size-4 shrink-0 text-fg-faint group-data-[highlighted]:text-fg" />
            <span className="text-label text-fg group-data-[highlighted]:text-fg">
              {t("desktop:customStatus.clear")}
            </span>
          </DropdownMenuItem>
        )}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}
