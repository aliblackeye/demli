import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { Button, cn } from "@demli/ui";
import { FormErrorAlert } from "@demli/app-ui";
import type { ChannelId, GroupId, RoleId } from "@demli/types";
import { errorKey, type CommonErrorKey } from "../../lib/errors";
import { useAppTranslation } from "../../lib/i18n";
import { useChannelRoles, useRoles, useSetChannelRoles } from "../../queries/chat-queries";

type Mode = "public" | "restricted";

/**
 * "Who can see this channel" — public (all members) or restricted to selected
 * roles (ADR 0007). Maps onto PUT /channels/:id/access (`[]` = public). Owner ∨
 * MANAGE_CHANNELS; the parent only renders this for permitted viewers.
 */
export function ChannelVisibilitySection({
  groupId,
  channelId,
}: {
  groupId: GroupId;
  channelId: ChannelId;
}): JSX.Element {
  const { t } = useAppTranslation();
  const { data: roles } = useRoles(groupId);
  const { data: accessRoleIds, isPending } = useChannelRoles(channelId);
  const setChannelRoles = useSetChannelRoles(groupId, channelId);

  const [mode, setMode] = useState<Mode>("public");
  const [selected, setSelected] = useState<Set<RoleId>>(new Set());
  const [error, setError] = useState<CommonErrorKey | null>(null);
  const [saved, setSaved] = useState(false);

  // Seed once per channel from the server's current access list.
  useEffect(() => {
    if (!accessRoleIds) return;
    setMode(accessRoleIds.length > 0 ? "restricted" : "public");
    setSelected(new Set(accessRoleIds));
    setError(null);
    setSaved(false);
  }, [channelId, accessRoleIds]);

  const toggle = (roleId: RoleId): void => {
    setSaved(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  };

  const onSave = (): void => {
    if (setChannelRoles.isPending) return;
    setError(null);
    const roleIds = mode === "public" ? [] : [...selected];
    setChannelRoles.mutate(roleIds, {
      onSuccess: () => setSaved(true),
      onError: (err) => setError(errorKey(err)),
    });
  };

  return (
    <div className="mt-6 space-y-3 border-t border-stroke pt-5">
      <div>
        <p className="text-sm font-semibold text-fg">{t("desktop:visibility.title")}</p>
        <p className="mt-0.5 text-2xs text-fg-faint">{t("desktop:visibility.note")}</p>
      </div>

      {error && (
        <FormErrorAlert>{t(error)}</FormErrorAlert>
      )}

      <div className="space-y-1.5">
        {(["public", "restricted"] as Mode[]).map((value) => (
          <label
            key={value}
            className="flex cursor-pointer items-start gap-2.5 rounded-md border border-stroke bg-raised/40 p-2.5 transition-colors hover:bg-raised has-[:checked]:border-accent/50 has-[:checked]:bg-accent/[0.06]"
          >
            <input
              type="radio"
              name="channel-visibility"
              value={value}
              checked={mode === value}
              onChange={() => {
                setMode(value);
                setSaved(false);
              }}
              className="mt-0.5 size-4 shrink-0 accent-accent"
            />
            <span className="min-w-0">
              <span className="block text-[13px] font-medium text-fg">
                {value === "public"
                  ? t("desktop:visibility.everyone")
                  : t("desktop:visibility.selectedRoles")}
              </span>
              <span className="block text-2xs text-fg-faint">
                {value === "public"
                  ? t("desktop:visibility.everyoneDesc")
                  : t("desktop:visibility.selectedRolesDesc")}
              </span>
            </span>
          </label>
        ))}
      </div>

      {mode === "restricted" && (
        <div className="space-y-px rounded-md border border-stroke p-1">
          {isPending && (
            <p className="px-2 py-1.5 text-2xs text-fg-faint">
              {t("desktop:serverSettings.loading")}
            </p>
          )}
          {roles?.length === 0 && (
            <p className="px-2 py-1.5 text-2xs text-fg-faint">
              {t("desktop:visibility.noRoles")}
            </p>
          )}
          {roles?.map((role) => {
            const on = selected.has(role.id);
            return (
              <button
                key={role.id}
                type="button"
                role="checkbox"
                aria-checked={on}
                onClick={() => toggle(role.id)}
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-fg-muted transition-colors hover:bg-white/[0.04]"
              >
                <span
                  className={cn(
                    "flex size-4 shrink-0 items-center justify-center rounded border",
                    on ? "border-accent bg-accent text-on-accent" : "border-stroke-strong",
                  )}
                >
                  {on && <Check className="size-3" strokeWidth={3} />}
                </span>
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ backgroundColor: role.color ?? "#95a5a6" }}
                />
                <span className="min-w-0 truncate">{role.name}</span>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button size="sm" onClick={onSave} disabled={setChannelRoles.isPending}>
          {setChannelRoles.isPending && <Loader2 className="size-3.5 animate-spin" />}
          {t("desktop:visibility.save")}
        </Button>
        {saved && !setChannelRoles.isPending && (
          <span className="text-2xs text-online">{t("desktop:visibility.saved")}</span>
        )}
      </div>
    </div>
  );
}
