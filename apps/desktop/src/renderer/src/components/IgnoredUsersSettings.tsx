import { EyeOff, Loader2 } from "lucide-react";
import { Button, UserAvatar } from "@demli/ui";
import { EmptyState, FormErrorAlert } from "@demli/app-ui";
import { localizeError } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { useIgnores, useUnignoreUser } from "../queries/social-queries";

/**
 * "Ignored users" settings section (ADR 0019 §4) — everyone the signed-in user
 * is ignoring, with a one-click undo.
 *
 * Sits BESIDE the blocked list, never merged with it, because the two are
 * different promises and the copy has to keep them apart: a block is symmetric,
 * cuts sends and hides history server-side; an ignore is silent, one-directional
 * and changes nothing for the other person — it only mutes notifications and
 * folds their messages away for the ignorer, who can still expand any of them.
 *
 * No confirmation dialog, unlike unblocking: un-ignoring restores nothing and
 * severs nothing, so a prompt would be ceremony around a reversible toggle.
 */
export function IgnoredUsersSettings(): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const { data: ignores, isPending, error, refetch } = useIgnores();
  const unignore = useUnignoreUser();

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
        <h2 className="text-base font-semibold text-fg">{t("desktop:ignore.settingsTitle")}</h2>
        <p className="mt-1 text-xs leading-relaxed text-fg-muted">
          {t("desktop:ignore.settingsDescription")}
        </p>
        {/* The one sentence that keeps ignore and block from blurring together. */}
        <p className="mt-1.5 text-xs leading-relaxed text-fg-faint">
          {t("desktop:ignore.settingsVsBlock")}
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

      {ignores && ignores.length === 0 && (
        <EmptyState icon={<EyeOff className="size-6" />} title={t("desktop:ignore.settingsEmpty")} />
      )}

      {ignores && ignores.length > 0 && (
        <>
          <p className="text-2xs font-semibold uppercase tracking-wider text-fg-faint">
            {t("desktop:ignore.settingsCount", { count: ignores.length })}
          </p>
          <ul className="divide-y divide-stroke overflow-hidden rounded-lg border border-stroke bg-surface">
            {ignores.map(({ user, createdAt }) => (
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
                    @{user.username} ·{" "}
                    {t("desktop:ignore.ignoredSince", { date: formatDate(createdAt) })}
                  </span>
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={unignore.isPending}
                  onClick={() => unignore.mutate(user.id)}
                >
                  {t("desktop:userMenu.unignore")}
                </Button>
              </li>
            ))}
          </ul>
          {unignore.error && <FormErrorAlert>{localizeError(unignore.error, t)}</FormErrorAlert>}
        </>
      )}
    </div>
  );
}
