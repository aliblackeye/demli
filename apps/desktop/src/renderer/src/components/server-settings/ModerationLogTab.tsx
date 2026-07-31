import { useMemo } from "react";
import { Loader2, ScrollText } from "lucide-react";
import { Button, UserAvatar } from "@demli/ui";
import { EmptyState, FormErrorAlert } from "@demli/app-ui";
import { Trans } from "@demli/i18n";
import type { GroupId, ModerationActionEntry, ModerationActionType } from "@demli/types";
import { localizeError } from "../../lib/errors";
import { useAppTranslation } from "../../lib/i18n";
import { useModerationLog } from "../../queries/chat-queries";

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
    <li className="flex items-start gap-3 px-3 py-2.5">
      <UserAvatar
        name={actorName}
        colorSeed={entry.actor?.id ?? entry.action.targetId}
        src={entry.actor?.avatarUrl}
        size="sm"
        className="mt-0.5"
      />
      <div className="min-w-0 flex-1">
        <p className="text-[13px] leading-snug text-fg-muted">
          <Trans
            t={t}
            i18nKey={ACTION_KEY[entry.action.action]}
            values={{ actor: actorName, target: targetName }}
            components={{ strong: <span className="font-medium text-fg" /> }}
          />
        </p>
        {entry.action.reason && (
          <p className="mt-0.5 break-words text-2xs text-fg-faint">
            {t("desktop:moderationLog.reason")}: {entry.action.reason}
          </p>
        )}
        <p className="mt-0.5 text-2xs text-fg-faint">{when}</p>
      </div>
      <span className="shrink-0 rounded bg-raised px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-fg-faint">
        {t(ACTION_LABEL_KEY[entry.action.action])}
      </span>
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
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
  } = useModerationLog(groupId);

  const entries = useMemo(
    () => (data?.pages ?? []).flatMap((page) => page.entries),
    [data],
  );

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-fg">{t("desktop:moderationLog.title")}</h3>
        <p className="mt-1 text-xs leading-relaxed text-fg-muted">
          {t("desktop:moderationLog.description")}
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

      {!isPending && !error && entries.length === 0 && (
        <EmptyState
          icon={<ScrollText className="size-6" />}
          title={t("desktop:moderationLog.empty")}
        />
      )}

      {entries.length > 0 && (
        <>
          <ul className="divide-y divide-stroke overflow-hidden rounded-lg border border-stroke bg-surface">
            {entries.map((entry) => (
              <LogRow key={entry.action.id} entry={entry} />
            ))}
          </ul>
          {/* Only rendered while there IS another page — no button that would
              silently do nothing at the end of the log (§35). */}
          {hasNextPage && (
            <Button
              variant="secondary"
              size="sm"
              disabled={isFetchingNextPage}
              onClick={() => void fetchNextPage()}
            >
              {isFetchingNextPage && <Loader2 className="size-4 animate-spin" />}
              {t("desktop:moderationLog.loadMore")}
            </Button>
          )}
        </>
      )}
    </div>
  );
}
