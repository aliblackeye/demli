import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Monitor, Smartphone, LogOut } from "lucide-react";
import type { SessionSummary } from "@demli/types";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@demli/ui";
import { FormErrorAlert } from "@demli/app-ui";
import { api, friendlyErrorMessage } from "../lib/api-client";
import { queryKeys } from "../lib/query-client";
import { logoutActiveAccount } from "../lib/account-manager";
import { useAppTranslation } from "../lib/i18n";

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
    <li className="flex items-center gap-3 rounded-lg border border-stroke bg-surface px-4 py-3">
      <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-raised text-fg-muted">
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-medium text-fg">
          <span className="truncate">{deviceName}</span>
          {session.current && (
            <span className="shrink-0 rounded-full bg-online/15 px-2 py-0.5 text-badge font-semibold uppercase tracking-wide text-online">
              {t("desktop:sessions.current")}
            </span>
          )}
        </p>
        <p className="mt-0.5 text-xs text-fg-faint">
          {t("desktop:sessions.lastSeen", { when: formatLastSeen(session.lastSeenAt, locale, t) })}
        </p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        disabled={revoking}
        onClick={onRevoke}
        className="shrink-0 text-fg-muted hover:text-danger"
      >
        {revoking ? <Loader2 className="size-4 animate-spin" /> : <LogOut className="size-4" />}
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

  const sessions = sessionsQuery.data?.sessions ?? [];
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
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => setConfirmOthersOpen(true)}
          >
            {t("desktop:sessions.revokeOthers")}
          </Button>
        )}
      </div>

      {sessionsQuery.isLoading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-fg-faint">
          <Loader2 className="size-4 animate-spin" />
          {t("desktop:sessions.loading")}
        </div>
      ) : sessionsQuery.isError ? (
        <div className="rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
          {friendlyErrorMessage(sessionsQuery.error)}
        </div>
      ) : sessions.length === 0 ? (
        <p className="py-6 text-sm text-fg-faint">{t("desktop:sessions.empty")}</p>
      ) : (
        <ul className="space-y-2">
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

      <Dialog open={confirmOthersOpen} onOpenChange={setConfirmOthersOpen}>
        <DialogContent aria-describedby="revoke-others-desc" className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("desktop:sessions.revokeOthers")}</DialogTitle>
            <DialogDescription id="revoke-others-desc">
              {t("desktop:sessions.revokeOthersConfirm")}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            {revokeOthersMutation.isError && (
              <FormErrorAlert>{friendlyErrorMessage(revokeOthersMutation.error)}</FormErrorAlert>
            )}
          </DialogBody>
          <DialogFooter>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setConfirmOthersOpen(false)}
              disabled={revokeOthersMutation.isPending}
            >
              {t("desktop:sessions.cancel")}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => revokeOthersMutation.mutate()}
              disabled={revokeOthersMutation.isPending}
            >
              {revokeOthersMutation.isPending && <Loader2 className="size-4 animate-spin" />}
              {t("desktop:sessions.revokeOthersConfirmCta")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
