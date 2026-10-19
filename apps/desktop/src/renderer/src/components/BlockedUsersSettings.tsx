import { ShieldOff } from "lucide-react";
import { Button, UserAvatar } from "@demli/ui";
import { EmptyState } from "@demli/app-ui";
import { localizeError } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { useBlocks } from "../queries/social-queries";
import { useUiStore } from "../stores/ui-store";
import { InlineError, ListSkeleton, SettingsLabel } from "./settings-kit";

/**
 * "Blocked users" settings section (M18) — the list of everyone the signed-in
 * user has blocked, with a one-click unblock (confirmed by {@link BlockUserDialog}).
 *
 * Deliberately one-directional: the API exposes only "who I blocked", never "who
 * blocked me", and this screen must not imply the latter exists. Nothing here
 * reveals whether the listed user has also blocked back.
 *
 * The section title is the settings layer's own heading, so it is not repeated
 * here; the description says what a block does.
 */
export function BlockedUsersSettings(): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const { data: blocks, isPending, error, refetch, isFetching } = useBlocks();
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
    <div className="space-y-5">
      <p className="text-sm leading-relaxed text-fg-muted">{t("desktop:block.settingsDescription")}</p>

      {isPending && <ListSkeleton rows={3} label={t("desktop:moderationLog.loading")} />}

      {error && (
        <InlineError
          message={localizeError(error, t)}
          retryLabel={t("buttons.retry")}
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      )}

      {blocks && blocks.length === 0 && (
        <EmptyState
          icon={<ShieldOff className="size-6" />}
          title={t("desktop:block.settingsEmpty")}
          className="py-10"
        />
      )}

      {blocks && blocks.length > 0 && (
        <div className="space-y-2">
          <SettingsLabel>{t("desktop:block.settingsCount", { count: blocks.length })}</SettingsLabel>
          <ul className="overflow-hidden rounded-xl bg-surface [&>*+*]:shadow-[inset_0_1px_0_var(--color-stroke)]">
            {blocks.map(({ user, createdAt }) => (
              <li
                key={user.id}
                className="flex items-center gap-3 px-4 py-3 transition-colors motion-hover content-visibility-row hover:bg-raised/40"
              >
                <UserAvatar name={user.displayName} colorSeed={user.id} src={user.avatarUrl} size="sm" />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="min-w-0 truncate text-sm font-medium text-fg">{user.displayName}</span>
                  <span className="min-w-0 truncate text-label text-fg-faint">
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
        </div>
      )}
    </div>
  );
}
