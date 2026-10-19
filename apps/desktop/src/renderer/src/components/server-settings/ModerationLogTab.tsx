import { useMemo } from "react";
import { ScrollText } from "lucide-react";
import { Badge, Button, UserAvatar } from "@demli/ui";
import { EmptyState } from "@demli/app-ui";
import { Trans } from "@demli/i18n";
import type { GroupId, ModerationActionEntry, ModerationActionType } from "@demli/types";
import { localizeError } from "../../lib/errors";
import { useAppTranslation } from "../../lib/i18n";
import { useModerationLog } from "../../queries/chat-queries";
import { InlineError, ListSkeleton, SettingsLabel } from "../settings-kit";

/** One catalog key per action, so a new action type is a compile error here. */
const ACTION_KEY = {
  kick: "desktop:moderationLog.action.kick",
  ban: "desktop:moderationLog.action.ban",
  unban: "desktop:moderationLog.action.unban",
  voice_disconnect: "desktop:moderationLog.action.voice_disconnect",
  // Migration 0020 (ADR 0019): a timeout is a temporary, self-clearing mute —
  // logged like every other moderation action so the audit trail stays complete.
  timeout: "desktop:moderationLog.action.timeout",
  timeout_remove: "desktop:moderationLog.action.timeout_remove",
} as const satisfies Record<ModerationActionType, string>;

const ACTION_LABEL_KEY = {
  kick: "desktop:moderationLog.actionLabel.kick",
  ban: "desktop:moderationLog.actionLabel.ban",
  unban: "desktop:moderationLog.actionLabel.unban",
  voice_disconnect: "desktop:moderationLog.actionLabel.voice_disconnect",
  timeout: "desktop:moderationLog.actionLabel.timeout",
  timeout_remove: "desktop:moderationLog.actionLabel.timeout_remove",
} as const satisfies Record<ModerationActionType, string>;

/**
 * Tone per action, so a scan down the log reads severity before words: removals
 * in the danger wash, the temporary mute in warning, the undo actions neutral.
 */
const ACTION_TONE = {
  kick: "danger",
  ban: "danger",
  unban: "neutral",
  voice_disconnect: "warning",
  timeout: "warning",
  timeout_remove: "neutral",
} as const satisfies Record<ModerationActionType, "danger" | "warning" | "neutral">;

function LogRow({ entry }: { entry: ModerationActionEntry }): JSX.Element {
  const { t, i18n } = useAppTranslation();

  // `actor` is nullable by contract: purging a moderator's account nulls the FK
  // rather than destroying the record of what was done. Never render "undefined".
  const actorName = entry.actor?.displayName ?? t("desktop:moderationLog.unknownActor");
  const targetName = entry.target?.displayName ?? t("desktop:moderationLog.unknownTarget");

  const when = useMemo(() => {
    const date = new Date(entry.action.createdAt);
    if (Number.isNaN(date.getTime())) return "";
    const opts: Intl.DateTimeFormatOptions = {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    };
    try {
      return new Intl.DateTimeFormat(i18n.language, opts).format(date);
    } catch {
      return new Intl.DateTimeFormat("en", opts).format(date);
    }
  }, [entry.action.createdAt, i18n.language]);

  return (
    <li className="flex items-start gap-3 px-4 py-3 transition-colors motion-hover content-visibility-row hover:bg-raised/40">
      <UserAvatar
        name={actorName}
        colorSeed={entry.actor?.id ?? entry.action.targetId}
        src={entry.actor?.avatarUrl}
        size="sm"
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <p className="text-sm leading-snug text-fg-muted">
          <Trans
            t={t}
            i18nKey={ACTION_KEY[entry.action.action]}
            values={{ actor: actorName, target: targetName }}
            components={{ strong: <span className="font-medium text-fg" /> }}
          />
        </p>
        {entry.action.reason && (
          <p className="mt-1.5 break-words rounded-md bg-raised/50 px-2.5 py-1.5 text-label text-fg-muted">
            <span className="font-medium text-fg-faint">{t("desktop:moderationLog.reason")}:</span>{" "}
            {entry.action.reason}
          </p>
        )}
        <p className="mt-1 text-2xs text-fg-faint">
          <time dateTime={entry.action.createdAt}>{when}</time>
        </p>
      </div>
      <Badge variant={ACTION_TONE[entry.action.action]} className="mt-0.5 shrink-0">
        {t(ACTION_LABEL_KEY[entry.action.action])}
      </Badge>
    </li>
  );
}

/**
 * "Audit log" tab (M18): every kick / ban / unban / voice-disconnect performed in
 * this server, newest first, keyset-paged behind a "load more".
 *
 * Authority is owner ∨ KICK_MEMBERS — the SAME gate as the ban list ("whoever may
 * moderate may see what has been moderated"). The parent hides the tab entirely
 * for anyone else, so this component is only ever mounted for a permitted viewer;
 * the API re-checks regardless.
 */
export function ModerationLogTab({ groupId }: { groupId: GroupId }): JSX.Element {
  const { t } = useAppTranslation();
  const {
    data,
    isPending,
    error,
    refetch,
    isFetching,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useModerationLog(groupId);

  const entries = useMemo(() => (data?.pages ?? []).flatMap((page) => page.entries), [data]);

  return (
    <div className="space-y-4">
      <p className="text-sm leading-relaxed text-fg-muted">{t("desktop:moderationLog.description")}</p>

      {isPending && <ListSkeleton rows={4} action={false} label={t("desktop:moderationLog.loading")} />}

      {error && (
        <InlineError
          message={localizeError(error, t)}
          retryLabel={t("buttons.retry")}
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      )}

      {!isPending && !error && entries.length === 0 && (
        <EmptyState
          icon={<ScrollText className="size-6" />}
          title={t("desktop:moderationLog.empty")}
          className="py-10"
        />
      )}

      {entries.length > 0 && (
        <div className="space-y-3">
          <SettingsLabel>{t("desktop:settingsUi.logEntryCount", { count: entries.length })}</SettingsLabel>
          <ul className="overflow-hidden rounded-xl bg-surface [&>*+*]:shadow-[inset_0_1px_0_var(--color-stroke)]">
            {entries.map((entry) => (
              <LogRow key={entry.action.id} entry={entry} />
            ))}
          </ul>
          {/* Only rendered while there IS another page — no button that would
              silently do nothing at the end of the log (§35). */}
          {hasNextPage && (
            <div className="flex justify-center">
              <Button variant="secondary" size="sm" loading={isFetchingNextPage} onClick={() => void fetchNextPage()}>
                {t("desktop:moderationLog.loadMore")}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
