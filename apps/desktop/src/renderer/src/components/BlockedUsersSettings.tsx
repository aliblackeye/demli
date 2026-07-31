import { Loader2, ShieldOff } from "lucide-react";
import { Button, UserAvatar } from "@demli/ui";
import { EmptyState, FormErrorAlert } from "@demli/app-ui";
import { localizeError } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { useBlocks } from "../queries/social-queries";
import { useUiStore } from "../stores/ui-store";

/**
 * "Blocked users" settings section (M18) — the list of everyone the signed-in
 * user has blocked, with a one-click unblock (confirmed by {@link BlockUserDialog}).
 *
 * Deliberately one-directional: the API exposes only "who I blocked", never "who
 * blocked me", and this screen must not imply the latter exists. Nothing here
 * reveals whether the listed user has also blocked back.
 */
export function BlockedUsersSettings(): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const { data: blocks, isPending, error, refetch } = useBlocks();
  const setBlockDialog = useUiStore((s) => s.setBlockDialog);

  const formatDate = (iso: string): string => {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const opts: Intl.DateTimeFormatOptions = { year: "numeric", month: "long", day: "numeric" };
    try {
      return new Intl.DateTimeFormat(i18n.language, opts).format(date);
    } catch {
      return new Intl.DateTimeFormat("en", opts).format(date);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-fg">{t("desktop:block.settingsTitle")}</h2>
        <p className="mt-1 text-xs leading-relaxed text-fg-muted">
          {t("desktop:block.settingsDescription")}
        </p>
      </div>

      {isPending && (
        <div role="status" className="flex items-center gap-2 py-4 text-sm text-fg-muted">
          <Loader2 className="size-4 animate-spin" />
          {t("desktop:moderationLog.loading")}
        </div>
      )}

      {error && (
        <div className="space-y-3">
          <FormErrorAlert>{localizeError(error, t)}</FormErrorAlert>
          <Button variant="secondary" size="sm" onClick={() => void refetch()}>
            {t("buttons.retry")}
          </Button>
        </div>
      )}

      {blocks && blocks.length === 0 && (
        <EmptyState icon={<ShieldOff className="size-6" />} title={t("desktop:block.settingsEmpty")} />
      )}

      {blocks && blocks.length > 0 && (
        <>
          <p className="text-2xs font-semibold uppercase tracking-wider text-fg-faint">
            {t("desktop:block.settingsCount", { count: blocks.length })}
          </p>
          <ul className="divide-y divide-stroke overflow-hidden rounded-lg border border-stroke bg-surface">
            {blocks.map(({ user, createdAt }) => (
              <li key={user.id} className="flex items-center gap-3 px-3 py-2.5">
                <UserAvatar
                  name={user.displayName}
                  colorSeed={user.id}
                  src={user.avatarUrl}
                  size="sm"
                />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="min-w-0 truncate text-sm font-medium text-fg">
                    {user.displayName}
                  </span>
                  <span className="min-w-0 truncate text-2xs text-fg-faint">
                    @{user.username} · {t("desktop:block.blockedSince", { date: formatDate(createdAt) })}
                  </span>
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setBlockDialog({
                      userId: user.id,
                      displayName: user.displayName,
                      blocked: true,
                    })
                  }
                >
                  {t("desktop:block.unblock")}
                </Button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
