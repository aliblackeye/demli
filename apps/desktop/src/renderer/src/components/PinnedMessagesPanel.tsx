import { useState } from "react";
import { Pin, PinOff, RotateCw } from "lucide-react";
import {
  Button,
  Skeleton,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  UserAvatar,
  cn,
} from "@demli/ui";
import { PINS_MAX_PER_CHANNEL } from "@demli/config";
import type { ChannelId, GroupId, PinnedMessage } from "@demli/types";
import { ApiClientError } from "../lib/api-client";
import { useAppTranslation, type AppTFunction } from "../lib/i18n";
import { localizeError } from "../lib/errors";
import { requestMessageJump } from "../lib/message-jump";
import { formatMessageTimestamp } from "../lib/time";
import { usePins, useTogglePin } from "../queries/chat-queries";
import { useAuthStore } from "../stores/auth-store";
import { useChatStore } from "../stores/chat-store";
import { canPinMessage, useCanManageMessages } from "../lib/pin-permissions";
import { MessageMarkdown } from "@demli/app-ui";

/**
 * The channel header's pin affordance (M17) — the channel's pin board.
 *
 * A Popover rather than a docked panel: the board is capped at
 * `PINS_MAX_PER_CHANNEL`, is read far less often than the message list, and
 * docking it would steal width from the chat on every channel. The list query is
 * `enabled` only while the popover is OPEN (§27), so a channel whose pins are
 * never opened never issues the request; realtime `message.pinned/unpinned`
 * already invalidates the cache, so an open board updates live.
 */
export function PinnedMessagesButton({
  channelId,
  groupId,
}: {
  channelId: ChannelId;
  /** Server context — enables the emoji/mention resolution inside pin previews. */
  groupId?: GroupId;
}): JSX.Element {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(false);
  const { data: pins, isPending, error, refetch, isFetching } = usePins(channelId, open);
  // Hoisted once for the whole board (§27) — never one roles/members
  // subscription per pinned row.
  const canManageMessages = useCanManageMessages(groupId ?? null);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("desktop:pins.open")}
              aria-pressed={open}
              className={cn(open && "bg-wash text-fg")}
            >
              <Pin className="size-[18px]" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t("desktop:pins.open")}</TooltipContent>
      </Tooltip>

      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={8}
        className="w-[380px] p-0"
        aria-label={t("desktop:pins.title")}
      >
        {/* No rule under the header: the board is one surface; the header is
            set apart by type weight and the list's own padding (Koyu Masa). */}
        <header className="flex items-center gap-2 px-4 pb-2 pt-3.5">
          <Pin className="size-4 shrink-0 text-accent" aria-hidden />
          <h2 className="font-display text-sm font-semibold text-fg-display">{t("desktop:pins.title")}</h2>
          {pins && pins.length > 0 && (
            <span className="ml-auto flex h-5 items-center rounded-pill bg-wash px-2 text-2xs font-medium tabular-nums text-fg-muted">
              {t("desktop:pins.count", { count: pins.length })}
            </span>
          )}
        </header>

        <div className="edge-fade-y max-h-[60vh] overflow-y-auto px-1.5 pb-1.5">
          {isPending && (
            <div role="status" aria-label={t("desktop:chat.loadingMessages")} className="space-y-1 p-1">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex gap-2.5 rounded-lg px-2.5 py-2.5">
                  <Skeleton shape="circle" width={32} />
                  <div className="min-w-0 flex-1 pt-0.5">
                    <Skeleton shape="line" width={96} height={10} />
                    <Skeleton shape="line" height={10} className={cn("mt-2", i === 1 ? "w-2/3" : "w-4/5")} />
                  </div>
                </div>
              ))}
            </div>
          )}
          {error && (
            <div role="alert" className="flex flex-col items-center gap-3 px-4 py-8 text-center">
              <p className="text-sm text-fg-muted">{t("desktop:pins.loadFailed")}</p>
              <p className="-mt-2 text-xs text-fg-faint">{localizeError(error, t)}</p>
              <Button variant="secondary" size="sm" loading={isFetching} onClick={() => void refetch()}>
                <RotateCw className="size-3.5" aria-hidden />
                {t("buttons.retry")}
              </Button>
            </div>
          )}
          {!isPending && !error && (pins?.length ?? 0) === 0 && (
            <div className="flex flex-col items-center px-6 py-8 text-center">
              <div className="flex size-11 items-center justify-center rounded-xl bg-raised">
                <Pin className="size-5 text-fg-muted" aria-hidden />
              </div>
              <p className="mt-3 text-sm font-medium text-fg">{t("desktop:pins.empty")}</p>
              <p className="mt-1 text-xs text-fg-faint">{t("desktop:pins.emptyHint")}</p>
            </div>
          )}
          {pins?.map((pin) => (
            <PinnedRow
              key={pin.message.id}
              pin={pin}
              channelId={channelId}
              groupId={groupId}
              canManageMessages={canManageMessages}
              onJump={() => {
                setOpen(false);
                requestMessageJump(pin.message.id);
              }}
            />
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** One entry on the board: author, when it was pinned, the body, and an unpin. */
function PinnedRow({
  pin,
  channelId,
  groupId,
  canManageMessages,
  onJump,
}: {
  pin: PinnedMessage;
  channelId: ChannelId;
  groupId?: GroupId;
  canManageMessages: boolean;
  onJump: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const author = useChatStore((s) => s.users[pin.message.authorId]);
  const pinner = useChatStore((s) => s.users[pin.pinnedBy]);
  const currentUserId = useAuthStore((s) => s.user?.id);
  const name = author?.displayName ?? t("desktop:chat.unknownUser");
  const pinnedByName = pinner?.displayName ?? t("desktop:chat.unknownUser");
  const canUnpin = canPinMessage(canManageMessages, pin.message.authorId, currentUserId);
  const toggle = useTogglePin(channelId);
  const [unpinError, setUnpinError] = useState<string | null>(null);

  return (
    // content-visibility-auto: pinned rows are markdown-rendered and up to
    // PINS_MAX_PER_CHANNEL of them mount at once — only paint what is on screen.
    // Hover restores `visible` so the absolute unpin button is never clipped.
    // Separated by spacing + a hover tone, never a rule. The wash (not a surface
    // tone) is what shows on the popover's own surface tone.
    <div className="group/pin content-visibility-auto relative rounded-lg transition-colors motion-hover hover:bg-wash">
      <button
        type="button"
        onClick={onJump}
        aria-label={t("desktop:pins.jumpTo")}
        className="flex w-full cursor-pointer gap-2.5 rounded-lg px-2.5 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      >
        <UserAvatar
          name={name}
          colorSeed={pin.message.authorId}
          src={author?.avatarUrl ?? null}
          size="sm"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-label font-semibold text-fg-display">{name}</span>
            <span className="shrink-0 text-2xs text-fg-faint">
              {formatMessageTimestamp(pin.message.createdAt, t)}
            </span>
          </div>
          <div className="line-clamp-4">
            <MessageMarkdown content={pin.message.content} groupId={groupId} className="text-fg" />
          </div>
          <p className="mt-1 text-2xs text-fg-faint">
            {t("desktop:pins.pinnedBy", { name: pinnedByName })}
          </p>
        </div>
      </button>

      {unpinError && (
        <p role="alert" className="px-2.5 pb-2 text-xs text-danger">
          {unpinError}
        </p>
      )}

      {/* §35: no dead affordance — the unpin only exists for someone allowed to. */}
      {canUnpin && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("desktop:pins.unpin")}
          disabled={toggle.isPending}
          onClick={() => {
            setUnpinError(null);
            toggle.mutate(
              { messageId: pin.message.id, pinned: true },
              { onError: (err) => setUnpinError(pinErrorText(err, t)) },
            );
          }}
          // Faded, never display-toggled: it is laid out at rest (no reflow on
          // hover) and reachable by Tab, where focus reveals it.
          className="absolute right-2 top-2 opacity-0 transition-opacity motion-hover group-hover/pin:opacity-100 focus-visible:opacity-100"
        >
          <PinOff className="size-3.5" aria-hidden />
        </Button>
      )}
    </div>
  );
}

/**
 * User-facing text for a failed pin/unpin.
 *
 * `PINS_FULL` is deliberately NOT in `ApiClientErrorCode` (it stays additive, see
 * the client-core note), so the code is compared as a runtime string. Everything
 * else collapses to one honest sentence — the user cannot act on the difference
 * between a 500 and a rejected payload here.
 */
export function pinErrorText(err: unknown, t: AppTFunction): string {
  const code = err instanceof ApiClientError ? (err.code as string) : null;
  if (code === "PINS_FULL" || code === "CONFLICT") {
    return t("desktop:pins.full", { max: PINS_MAX_PER_CHANNEL });
  }
  if (code === "FORBIDDEN" || code === "NETWORK" || code === "UNAUTHORIZED") {
    return localizeError(err, t);
  }
  return t("desktop:pins.error");
}

/** Compact "pinned" marker drawn on a pinned message row in the scrollback. */
export function PinnedMarker(): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <span
      className="mb-0.5 flex items-center gap-1 text-2xs font-medium text-fg-faint"
      aria-label={t("desktop:pins.title")}
    >
      <Pin className="size-3 shrink-0" aria-hidden />
      {t("desktop:pins.title")}
    </span>
  );
}
