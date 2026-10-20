import { EyeOff, Info } from "lucide-react";
import { Button, UserAvatar } from "@demli/ui";
import { EmptyState, FormErrorAlert } from "@demli/app-ui";
import { localizeError } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { useIgnores, useUnignoreUser } from "../queries/social-queries";
import { InlineError, ListSkeleton, SettingsLabel, SettingsNote } from "./settings-kit";

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
  const { data: ignores, isPending, error, refetch, isFetching } = useIgnores();
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
    <div className="space-y-5">
      <div className="space-y-2">
        <p className="text-sm leading-relaxed text-fg-muted">{t("desktop:ignore.settingsDescription")}</p>
        {/* The one sentence that keeps ignore and block from blurring together. */}
        <SettingsNote icon={Info}>{t("desktop:ignore.settingsVsBlock")}</SettingsNote>
      </div>

      {isPending && <ListSkeleton rows={3} label={t("desktop:moderationLog.loading")} />}

      {error && (
        <InlineError
          message={localizeError(error, t)}
          retryLabel={t("buttons.retry")}
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      )}

      {ignores && ignores.length === 0 && (
        <EmptyState
          icon={<EyeOff className="size-6" />}
          title={t("desktop:ignore.settingsEmpty")}
          className="py-10"
        />
      )}

      {ignores && ignores.length > 0 && (
        <div className="space-y-2">
          <SettingsLabel>{t("desktop:ignore.settingsCount", { count: ignores.length })}</SettingsLabel>
          <ul className="overflow-hidden rounded-xl bg-surface [&>*+*]:shadow-[inset_0_1px_0_var(--color-stroke)]">
            {ignores.map(({ user, createdAt }) => (
              <li
                key={user.id}
                className="flex items-center gap-3 px-4 py-3 transition-colors motion-hover content-visibility-row hover:bg-raised/40"
              >
                <UserAvatar name={user.displayName} colorSeed={user.id} src={user.avatarUrl} size="sm" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="min-w-0 truncate text-sm font-medium text-fg">{user.displayName}</span>
                  <span className="min-w-0 truncate text-label text-fg-faint">
                    @{user.username} · {t("desktop:ignore.ignoredSince", { date: formatDate(createdAt) })}
                  </span>
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={unignore.isPending && unignore.variables === user.id}
                  disabled={unignore.isPending}
                  onClick={() => unignore.mutate(user.id)}
                >
                  {t("desktop:userMenu.unignore")}
                </Button>
              </li>
            ))}
          </ul>
          {unignore.error && <FormErrorAlert>{localizeError(unignore.error, t)}</FormErrorAlert>}
        </div>
      )}
    </div>
  );
}
