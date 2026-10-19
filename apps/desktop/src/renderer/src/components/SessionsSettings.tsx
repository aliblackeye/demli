import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LogOut, Monitor, MonitorSmartphone, Smartphone } from "lucide-react";
import type { SessionSummary } from "@demli/types";
import { Badge, Button, cn } from "@demli/ui";
import { EmptyState, FormErrorAlert } from "@demli/app-ui";
import { api } from "../lib/api-client";
import { localizeError } from "../lib/errors";
import { queryKeys } from "../lib/query-client";
import { logoutActiveAccount } from "../lib/account-manager";
import { useAppTranslation } from "../lib/i18n";
import { ConfirmDialog, InlineError, ListSkeleton } from "./settings-kit";

/**
 * "Oturumlar" — the active-sessions screen (M15). Lists every login session the
 * caller owns (device label + platform + "last seen"), flags the current one, and
 * lets the user close another session ("Çıkış yaptır") or every OTHER session at
 * once ("Diğer tüm oturumları kapat", behind a confirm). Closing the CURRENT
 * session logs THIS device out locally.
 *
 * Server contract: GET /sessions, DELETE /sessions/:id, DELETE /sessions/others.
 */

/** Localized "last seen" using the platform Intl formatter (no per-unit i18n keys). */
function formatLastSeen(iso: string, locale: string, t: ReturnType<typeof useAppTranslation>["t"]): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return "";
  const diffSec = Math.round((then - Date.now()) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 45) return t("desktop:sessions.justNow");
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, secs] of units) {
    if (abs >= secs) return rtf.format(Math.round(diffSec / secs), unit);
  }
  return t("desktop:sessions.justNow");
}

function SessionRow({
  session,
  locale,
  onRevoke,
  revoking,
}: {
  session: SessionSummary;
  locale: string;
  onRevoke: () => void;
  revoking: boolean;
}): JSX.Element {
  const { t } = useAppTranslation();
  const Icon = session.platform === "mobile" ? Smartphone : Monitor;
  const deviceName =
    session.deviceName ??
    (session.platform === "mobile"
      ? t("desktop:sessions.unknownMobile")
      : t("desktop:sessions.unknownDevice"));

  return (
    <li className="flex items-center gap-3 px-4 py-3 content-visibility-row">
      <span
        aria-hidden
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg",
          session.current ? "bg-accent-surface text-accent" : "bg-raised/60 text-fg-muted",
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-medium text-fg">
          <span className="truncate">{deviceName}</span>
          {session.current && (
            <Badge variant="success" className="shrink-0">
              {t("desktop:sessions.current")}
            </Badge>
          )}
        </p>
        <p className="mt-0.5 text-label text-fg-faint">
          {t("desktop:sessions.lastSeen", { when: formatLastSeen(session.lastSeenAt, locale, t) })}
        </p>
      </div>
      <Button
        variant={session.current ? "ghost" : "danger"}
        size="sm"
        loading={revoking}
        onClick={onRevoke}
        className="shrink-0"
      >
        <LogOut className="size-3.5" />
        {session.current ? t("desktop:sessions.signOutThis") : t("desktop:sessions.revoke")}
      </Button>
    </li>
  );
}

export function SessionsSettings(): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const locale = i18n.language;
  const queryClient = useQueryClient();
  const [confirmOthersOpen, setConfirmOthersOpen] = useState(false);

  const sessionsQuery = useQuery({
    queryKey: queryKeys.sessions,
    queryFn: () => api.listSessions(),
  });

  const revokeMutation = useMutation({
    mutationFn: (sessionId: string) => api.revokeSession(sessionId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: queryKeys.sessions }),
  });

  const revokeOthersMutation = useMutation({
    mutationFn: () => api.revokeOtherSessions(),
    onSuccess: () => {
      setConfirmOthersOpen(false);
      void queryClient.invalidateQueries({ queryKey: queryKeys.sessions });
    },
  });

  // The current device always first, then most recently seen.
  const sessions = useMemo(
    () =>
      [...(sessionsQuery.data?.sessions ?? [])].sort(
        (a, b) =>
          Number(b.current) - Number(a.current) ||
          new Date(b.lastSeenAt).getTime() - new Date(a.lastSeenAt).getTime(),
      ),
    [sessionsQuery.data],
  );
  const otherCount = sessions.filter((s) => !s.current).length;

  const onRevoke = (session: SessionSummary): void => {
    // Closing the CURRENT session = log this device out locally (the token is
    // about to become invalid server-side anyway).
    if (session.current) {
      void logoutActiveAccount();
      return;
    }
    revokeMutation.mutate(session.id);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm leading-relaxed text-fg-muted">{t("desktop:sessions.description")}</p>
        {otherCount > 0 && (
          <Button
            variant="secondary"
            size="sm"
            className="shrink-0"
            onClick={() => {
              revokeOthersMutation.reset();
              setConfirmOthersOpen(true);
            }}
          >
            {t("desktop:sessions.revokeOthers")}
          </Button>
        )}
      </div>

      {sessionsQuery.isLoading ? (
        <ListSkeleton rows={3} avatar="square" label={t("desktop:sessions.loading")} />
      ) : sessionsQuery.isError ? (
        <InlineError
          message={localizeError(sessionsQuery.error, t)}
          retryLabel={t("buttons.retry")}
          onRetry={() => void sessionsQuery.refetch()}
          retrying={sessionsQuery.isFetching}
        />
      ) : sessions.length === 0 ? (
        <EmptyState
          icon={<MonitorSmartphone className="size-6" />}
          title={t("desktop:sessions.empty")}
          className="py-10"
        />
      ) : (
        <ul className="overflow-hidden rounded-xl bg-surface [&>*+*]:shadow-[inset_0_1px_0_var(--color-stroke)]">
          {sessions.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              locale={locale}
              onRevoke={() => onRevoke(session)}
              revoking={revokeMutation.isPending && revokeMutation.variables === session.id}
            />
          ))}
        </ul>
      )}

      {/* A failed single revoke is said, not swallowed (§26). */}
      {revokeMutation.isError && (
        <FormErrorAlert>{localizeError(revokeMutation.error, t)}</FormErrorAlert>
      )}

      <ConfirmDialog
        open={confirmOthersOpen}
        onOpenChange={setConfirmOthersOpen}
        title={t("desktop:sessions.revokeOthers")}
        description={t("desktop:sessions.revokeOthersConfirm")}
        confirmLabel={t("desktop:sessions.revokeOthersConfirmCta")}
        cancelLabel={t("desktop:sessions.cancel")}
        closeLabel={t("buttons.close")}
        onConfirm={() => revokeOthersMutation.mutate()}
        pending={revokeOthersMutation.isPending}
        layer="settings"
        error={
          revokeOthersMutation.isError ? (
            <FormErrorAlert>{localizeError(revokeOthersMutation.error, t)}</FormErrorAlert>
          ) : undefined
        }
      />
    </div>
  );
}
