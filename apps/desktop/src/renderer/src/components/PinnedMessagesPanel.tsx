import { useState } from "react";
import { Loader2, Pin, PinOff } from "lucide-react";
import {
  Button,
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
  const { data: pins, isPending, error } = usePins(channelId, open);
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
              className={cn(open && "bg-white/[0.06] text-fg")}
            >
              <Pin className="size-[18px]" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t("desktop:pins.open")}</TooltipContent>
      </Tooltip>

      <PopoverContent align="end" side="bottom" sideOffset={8} className="w-[380px] p-0">
        <header className="flex items-center gap-2 border-b border-stroke px-3 py-2.5">
          <Pin className="size-4 shrink-0 text-fg-faint" />
          <h2 className="text-sm font-semibold text-fg">{t("desktop:pins.title")}</h2>
          {pins && pins.length > 0 && (
            <span className="ml-auto text-xs tabular-nums text-fg-faint">
              {t("desktop:pins.count", { count: pins.length })}
            </span>
          )}
        </header>

        <div className="edge-fade-y max-h-[60vh] overflow-y-auto">
          {isPending && (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="size-4 animate-spin text-fg-faint" />
            </div>
          )}
          {error && (
            <p className="px-3 py-6 text-center text-sm text-danger">{localizeError(error, t)}</p>
          )}
          {!isPending && !error && (pins?.length ?? 0) === 0 && (
            <p className="px-3 py-8 text-center text-sm text-fg-muted">
              {t("desktop:pins.empty")}
            </p>
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
    <div className="group/pin content-visibility-auto relative border-b border-stroke/60 px-3 py-2.5 last:border-b-0 hover:bg-white/[0.025]">
      <button
        type="button"
        onClick={onJump}
        aria-label={t("desktop:pins.jumpTo")}
        className="flex w-full gap-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 rounded-md"
      >
        <UserAvatar
          name={name}
          colorSeed={pin.message.authorId}
          src={author?.avatarUrl ?? null}
          size="sm"
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[13px] font-semibold text-fg">{name}</span>
            <span className="shrink-0 text-2xs text-fg-faint">
              {formatMessageTimestamp(pin.message.createdAt, t)}
            </span>
          </div>
          <div className="line-clamp-4">
            <MessageMarkdown content={pin.message.content} groupId={groupId} className="text-fg/85" />
          </div>
          <p className="mt-1 text-2xs text-fg-faint">
            {t("desktop:pins.pinnedBy", { name: pinnedByName })}
          </p>
        </div>
      </button>

      {unpinError && (
        <p role="alert" className="mt-1 text-xs text-danger">
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
          className="absolute right-2 top-2 hidden group-hover/pin:flex focus-visible:flex"
        >
          <PinOff className="size-3.5" />
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
