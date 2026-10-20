import { useEffect, useState } from "react";
import { m } from "framer-motion";
import { Check } from "lucide-react";
import { Button, Checkbox, RadioGroup, RadioItem, Skeleton } from "@demli/ui";
import { FormErrorAlert, springs } from "@demli/app-ui";
import type { ChannelId, GroupId, RoleId } from "@demli/types";
import { errorKey, type CommonErrorKey } from "../../lib/errors";
import { useAppTranslation } from "../../lib/i18n";
import { useChannelRoles, useRoles, useSetChannelRoles } from "../../queries/chat-queries";
import { ROLE_COLOR_FALLBACK } from "./shared";

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
    <section aria-labelledby="channel-visibility-title" className="space-y-3">
      <header className="space-y-1">
        <h3 id="channel-visibility-title" className="text-sm font-semibold text-fg">
          {t("desktop:visibility.title")}
        </h3>
        <p className="text-label text-fg-faint">{t("desktop:visibility.note")}</p>
      </header>

      {error && <FormErrorAlert>{t(error)}</FormErrorAlert>}

      <RadioGroup
        value={mode}
        onValueChange={(next) => {
          setMode(next as Mode);
          setSaved(false);
        }}
        aria-labelledby="channel-visibility-title"
        className="rounded-xl bg-surface p-1"
      >
        <RadioItem value="public" label={t("desktop:visibility.everyone")} description={t("desktop:visibility.everyoneDesc")} />
        <RadioItem
          value="restricted"
          label={t("desktop:visibility.selectedRoles")}
          description={t("desktop:visibility.selectedRolesDesc")}
        />
      </RadioGroup>

      {mode === "restricted" && (
        <m.div
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0, transition: springs.position }}
          className="space-y-2.5 rounded-xl bg-surface px-4 py-3"
        >
          {isPending && (
            <div aria-hidden className="space-y-2.5">
              <Skeleton shape="line" height={12} className="w-28" />
              <Skeleton shape="line" height={12} className="w-20" />
            </div>
          )}
          {roles?.length === 0 && <p className="text-label text-fg-faint">{t("desktop:visibility.noRoles")}</p>}
          {roles?.map((role) => (
            <Checkbox
              key={role.id}
              checked={selected.has(role.id)}
              onCheckedChange={() => toggle(role.id)}
              label={
                <span className="inline-flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: role.color ?? ROLE_COLOR_FALLBACK }}
                  />
                  {role.name}
                </span>
              }
              className="flex"
            />
          ))}
        </m.div>
      )}

      <div className="flex items-center gap-3">
        <Button variant="secondary" size="sm" onClick={onSave} loading={setChannelRoles.isPending}>
          {t("desktop:visibility.save")}
        </Button>
        {saved && !setChannelRoles.isPending && (
          <span role="status" className="inline-flex items-center gap-1 text-label font-medium text-success">
            <Check aria-hidden className="size-3.5" />
            {t("desktop:visibility.saved")}
          </span>
        )}
      </div>
    </section>
  );
}
