import { useMemo } from "react";
import {
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Video,
} from "lucide-react";
import {
  Button,
  Skeleton,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  UserAvatar,
  cn,
  iconButtonVariants,
} from "@demli/ui";
import { EmptyState } from "@demli/app-ui";
import type { UserId } from "@demli/types";
import { isCallLive } from "@demli/client-core";
import type { RecentCall } from "../lib/api-client";
import { getCallController, useCallState } from "../lib/call-controller";
import { localizeError } from "../lib/errors";
import { InlineError } from "./settings-kit";
import { useAppTranslation, type AppTFunction } from "../lib/i18n";
import { formatDuration, formatMessageTimestamp } from "../lib/time";
import { useRecentCalls } from "../queries/call-queries";
import { useFriends, useOpenDm } from "../queries/social-queries";
import { UpdateBadge } from "./UpdateBadge";

/**
 * Home-surface center pane: the caller's cross-DM call history (Voice-UX #2).
 *
 * Read-only list fed by {@link useRecentCalls} (keyset-paged newest-first).
 * Clicking a row opens that DM; a per-row "call back" button re-initiates the
 * call with the SAME media, gated exactly like the DM-header buttons — disabled
 * for a non-friend (a DM survives an unfriend, ADR 0010) or while any call is
 * already live (the single call slot, §35). The gate is a UX guard only; the
 * server re-checks friendship + liveness authoritatively.
 *
 * A missed INCOMING call is emphasized in the danger color — only the person
 * who actually missed it sees the red.
 */
export function RecentCallsView(): JSX.Element {
  const { t } = useAppTranslation();
  const {
    data,
    isPending,
    error,
    refetch,
    isFetching,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useRecentCalls();
  const { data: friends } = useFriends();
  const call = useCallState();
  const openDm = useOpenDm();

  // Lifted once (not per row, §27): the single busy flag + a friend-id set.
  const busy = isCallLive(call) || call.pending;
  const friendIds = useMemo(
    () => new Set((friends ?? []).map((f) => f.user.id)),
    [friends],
  );
  const calls = useMemo(() => data?.pages.flatMap((page) => page.calls) ?? [], [data]);

  return (
    <div className="flex min-w-0 flex-1 flex-col bg-app">
      <header className="flex h-16 shrink-0 items-center gap-3 border-b border-stroke px-4">
        <PhoneCall aria-hidden className="size-5 shrink-0 text-fg-faint" />
        <h1 className="shrink-0 font-display text-base font-medium text-fg-display">
          {t("desktop:recentCalls.title")}
        </h1>
        {/* Desktop app-update badge — the top-right corner on every surface. */}
        <div className="ml-auto flex shrink-0 items-center">
          <UpdateBadge />
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {isPending ? (
          <RecentCallsSkeleton />
        ) : error ? (
          <div className="px-4 pt-4">
            <InlineError
              message={localizeError(error, t)}
              retryLabel={t("buttons.retry")}
              onRetry={() => void refetch()}
              retrying={isFetching}
            />
          </div>
        ) : calls.length === 0 ? (
          <EmptyState
            icon={<PhoneCall className="size-6" />}
            title={t("desktop:recentCalls.emptyTitle")}
            body={t("desktop:recentCalls.emptyBody")}
          />
        ) : (
          <div className="px-4 pb-6 pt-3">
            <ul className="space-y-0.5">
              {calls.map((entry) => (
                <RecentCallRow
                  key={entry.id}
                  call={entry}
                  isFriend={friendIds.has(entry.peer.id)}
                  busy={busy}
                  onOpenDm={(peerId) => openDm.mutate(peerId)}
                />
              ))}
            </ul>
            {hasNextPage && (
              <div className="flex justify-center pt-4">
                <Button
                  variant="secondary"
                  size="sm"
                  loading={isFetchingNextPage}
                  onClick={() => void fetchNextPage()}
                >
                  {t("desktop:recentCalls.loadMore")}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Loading placeholder for the call history — a handful of row-shaped skeletons
 * (avatar + two text lines + a timestamp) matching {@link RecentCallRow}'s
 * geometry, so the list settles in place instead of flashing a spinner (founder
 * rule: skeletons, not spinners, for content).
 */
function RecentCallsSkeleton(): JSX.Element {
  const { t } = useAppTranslation();
  const rowWidths = ["w-28", "w-36", "w-24", "w-32", "w-40", "w-24"];
  return (
    <ul role="status" aria-label={t("desktop:recentCalls.loading")} className="space-y-0.5 px-4 pb-4 pt-3">
      {rowWidths.map((width, index) => (
        <li key={index} className="flex h-16 items-center gap-3 px-3">
          <Skeleton shape="circle" width={32} />
          <div className="min-w-0 flex-1">
            <Skeleton shape="line" height={14} className={width} />
            <Skeleton shape="line" height={12} className="mt-2 w-20" />
          </div>
          <Skeleton shape="line" height={12} className="w-10" />
        </li>
      ))}
      <span className="sr-only">{t("desktop:recentCalls.loading")}</span>
    </ul>
  );
}

/** True when the viewer MISSED an incoming call — the danger-color case. */
function isMissedIncoming(call: RecentCall): boolean {
  return call.status === "missed" && call.direction === "incoming";
}

/** Short localized summary of a call outcome (direction + duration, or status). */
function callSummary(call: RecentCall, t: AppTFunction): string {
  const duration = call.durationSeconds !== null ? formatDuration(call.durationSeconds) : null;
  switch (call.status) {
    case "ended": {
      const base =
        call.direction === "outgoing"
          ? t("desktop:recentCalls.directionOutgoing")
          : t("desktop:recentCalls.directionIncoming");
      return duration ? `${base} · ${duration}` : base;
    }
    case "missed":
      return call.direction === "incoming"
        ? t("desktop:recentCalls.statusMissed")
        : t("desktop:recentCalls.statusNoAnswer");
    case "declined":
      return t("desktop:recentCalls.statusDeclined");
    case "canceled":
      return t("desktop:recentCalls.statusCanceled");
    case "upgraded":
      return t("desktop:recentCalls.statusMovedToGroup");
    case "ringing":
    case "active":
      return t("desktop:recentCalls.statusOngoing");
    default:
      return "";
  }
}

function DirectionIcon({ call }: { call: RecentCall }): JSX.Element {
  if (isMissedIncoming(call)) return <PhoneMissed className="size-4 shrink-0 text-danger" />;
  if (call.direction === "outgoing")
    return <PhoneOutgoing className="size-4 shrink-0 text-fg-faint" />;
  return <PhoneIncoming className="size-4 shrink-0 text-fg-faint" />;
}

function RecentCallRow({
  call,
  isFriend,
  busy,
  onOpenDm,
}: {
  call: RecentCall;
  isFriend: boolean;
  busy: boolean;
  onOpenDm: (peerId: UserId) => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const missed = isMissedIncoming(call);
  const canCall = isFriend && !busy;
  const isVideo = call.media === "video";

  const callBack = (): void => {
    if (!canCall) return;
    void getCallController()?.startCall({ dmId: call.dmId, media: call.media });
  };

  const callHint = !isFriend
    ? t("desktop:recentCalls.notFriends")
    : busy
      ? t("desktop:recentCalls.busy")
      : isVideo
        ? t("desktop:recentCalls.callBackVideo")
        : t("desktop:recentCalls.callBack");

  const callButton = (
    <button
      type="button"
      aria-label={isVideo ? t("desktop:recentCalls.callBackVideo") : t("desktop:recentCalls.callBack")}
      disabled={!canCall}
      onClick={callBack}
      className={cn(
        iconButtonVariants({ variant: "solid", size: "md" }),
        "bg-raised text-fg hover:bg-accent hover:text-on-accent active:bg-accent-pressed active:text-on-accent",
        "opacity-0 transition-[opacity,background-color,color] motion-hover group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100",
      )}
    >
      {isVideo ? <Video /> : <Phone />}
    </button>
  );

  return (
    <li className="group flex h-16 items-center gap-2 rounded-lg px-3 transition-colors motion-hover content-visibility-row hover:bg-hover focus-within:bg-hover">
      <button
        type="button"
        aria-label={`${t("desktop:recentCalls.openConversation")}: ${call.peer.displayName}`}
        onClick={() => onOpenDm(call.peer.id)}
        className={cn(
          "flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg text-left",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        )}
      >
        <UserAvatar
          name={call.peer.displayName}
          colorSeed={call.peer.id}
          src={call.peer.avatarUrl}
          size="sm"
        />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            <DirectionIcon call={call} />
            <span
              className={cn(
                "truncate text-sm font-medium",
                missed ? "text-danger" : "text-fg",
              )}
            >
              {call.peer.displayName}
            </span>
            {isVideo ? (
              <Video className="size-3.5 shrink-0 text-fg-faint" />
            ) : (
              <Phone className="size-3.5 shrink-0 text-fg-faint" />
            )}
          </span>
          <span
            className={cn(
              "mt-0.5 block truncate text-label",
              missed ? "text-danger" : "text-fg-faint",
            )}
          >
            {callSummary(call, t)}
          </span>
        </span>
        <time dateTime={call.createdAt} className="shrink-0 text-label tabular-nums text-fg-faint">
          {formatMessageTimestamp(call.createdAt, t)}
        </time>
      </button>
      <Tooltip>
        <TooltipTrigger asChild>
          {canCall ? callButton : <span className="inline-flex">{callButton}</span>}
        </TooltipTrigger>
        <TooltipContent side="left">{callHint}</TooltipContent>
      </Tooltip>
    </li>
  );
}
