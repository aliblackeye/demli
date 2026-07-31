/**
 * The Watch Party queue — what is playing now and what comes next (M20 wave 3).
 *
 * ## The host / viewer split, again
 *
 * Everyone in the room SEES the queue: it is the answer to "what are we watching
 * after this?", which is a question a viewer has as much as a host. Nobody but
 * the host (or the server owner, the same override the player honours) gets a
 * mutation control, and a viewer gets no disabled twins of them — §35 forbids a
 * button that looks pressable and does nothing, and the gateway would refuse the
 * frame with `NOT_HOST` anyway. The absence IS the message; the panel header
 * says whose queue it is.
 *
 * ## Reordering has two inputs, not one
 *
 * Drag-and-drop is the fast path on a desktop with a mouse. It is NOT the only
 * path: every row also carries move-up / move-down buttons, which are real
 * focusable buttons in the tab order, so the queue is reorderable with a
 * keyboard alone and on a touch screen where HTML5 drag events do not exist.
 * Both feed the same {@link WatchQueuePanelProps.onReorder} with a full id list.
 *
 * ## Titles are text
 *
 * `title` and `channelTitle` come from YouTube by way of another user's search
 * and are bounded but otherwise untrusted. They are rendered as React children —
 * escaped text nodes — and never through markdown, `dangerouslySetInnerHTML`, or
 * a link. A queued row is not a place where somebody else's string gets to
 * become markup.
 */

import { memo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ListVideo,
  Play,
  Plus,
  Trash2,
  Music4,
} from "lucide-react";
import { Button, cn } from "@demli/ui";
import { useTranslation } from "@demli/i18n";
import {
  canMoveQueueItem,
  dropQueueItem,
  formatWatchDuration,
  moveQueueItem,
} from "./watchQueue";

/** One queued video, already joined to a display name for whoever added it. */
export interface WatchQueueEntry {
  itemId: string;
  videoId: string;
  /** Untrusted display text. Null when the adder supplied none (a raw link). */
  title: string | null;
  durationSeconds: number | null;
  /** Resolved display name of the adder — the caller owns the user lookup. */
  addedByName: string;
}

export interface WatchQueuePanelProps {
  /** The queue, in play order. Does NOT include the video playing right now. */
  items: readonly WatchQueueEntry[];
  /** What the room is watching at this moment, for the panel's top row. */
  nowPlaying: { videoId: string; title: string | null } | null;
  /**
   * Host, or the server owner override. Gates whether ANY mutation control is
   * rendered — this is cosmetic, exactly like every other client-side permission
   * check, and the gateway re-decides every frame.
   */
  canControl: boolean;
  /** Jump straight to this item (`watch.queue_play`). */
  onPlayNow: (itemId: string) => void;
  /** Drop this item (`watch.queue_remove`). */
  onRemove: (itemId: string) => void;
  /**
   * The FULL desired order (`watch.queue_reorder`). The server takes a complete
   * list rather than a delta, so both reorder inputs produce one of these.
   */
  onReorder: (itemIds: string[]) => void;
  /** Open the picker (`watch.queue_add` happens after a video is chosen). */
  onAdd: () => void;
  /** Rendered above the list when the last add was refused, e.g. a full queue. */
  notice?: string | null;
  className?: string;
}

function WatchQueuePanelImpl({
  items,
  nowPlaying,
  canControl,
  onPlayNow,
  onRemove,
  onReorder,
  onAdd,
  notice = null,
  className,
}: WatchQueuePanelProps): JSX.Element {
  const { t } = useTranslation(["desktop"]);
  /**
   * The row currently being dragged. State, not a ref, because the row it names
   * renders differently (a lifted look) while it travels — and this only changes
   * on dragstart/dragend, so it costs one render per gesture, not per frame.
   */
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);

  const ids = items.map((item) => item.itemId);

  const move = (itemId: string, delta: -1 | 1): void => {
    if (!canMoveQueueItem(ids, itemId, delta)) return;
    onReorder(moveQueueItem(ids, itemId, delta));
  };

  const finishDrag = (targetId: string | null): void => {
    const dragged = draggingId;
    setDraggingId(null);
    setDropTargetId(null);
    if (dragged === null || targetId === null || dragged === targetId) return;
    onReorder(dropQueueItem(ids, dragged, targetId));
  };

  return (
    <aside
      aria-label={t("desktop:watchParty.queueTitle")}
      className={cn(
        "flex h-full min-h-0 w-full flex-col gap-2 rounded-xl border border-stroke bg-rail/60 p-2",
        className,
      )}
    >
      <header className="flex shrink-0 items-center gap-2 px-1">
        <ListVideo className="size-4 shrink-0 text-accent" aria-hidden />
        <h3 className="min-w-0 flex-1 truncate text-xs font-semibold text-fg">
          {t("desktop:watchParty.queueTitle")}
        </h3>
        <span className="shrink-0 rounded-full bg-raised px-1.5 py-0.5 text-2xs tabular-nums text-fg-muted">
          {items.length}
        </span>
        {canControl && (
          <Button
            variant="secondary"
            size="icon-sm"
            aria-label={t("desktop:watchParty.queueAdd")}
            onClick={onAdd}
          >
            <Plus className="size-4" />
          </Button>
        )}
      </header>

      {notice !== null && (
        <p
          role="alert"
          className="shrink-0 rounded-lg border border-danger/40 bg-danger/10 px-2 py-1.5 text-2xs leading-relaxed text-fg"
        >
          {notice}
        </p>
      )}

      {nowPlaying !== null && (
        <div className="shrink-0 rounded-lg border border-accent/40 bg-accent/10 px-2 py-1.5">
          <p className="text-2xs font-semibold uppercase tracking-wide text-accent">
            {t("desktop:watchParty.queueNowPlaying")}
          </p>
          <p className="mt-0.5 line-clamp-2 text-xs leading-snug text-fg">
            {nowPlaying.title ?? t("desktop:watchParty.queueUntitled")}
          </p>
        </div>
      )}

      {items.length === 0 ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-3 text-center">
          <Music4 className="size-6 text-fg-faint" aria-hidden />
          <p className="text-2xs leading-relaxed text-fg-muted">
            {canControl
              ? t("desktop:watchParty.queueEmptyHost")
              : t("desktop:watchParty.queueEmptyViewer")}
          </p>
        </div>
      ) : (
        <ol className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {items.map((item, index) => {
            const duration = formatWatchDuration(item.durationSeconds);
            const title = item.title ?? t("desktop:watchParty.queueUntitled");
            return (
              <li
                key={item.itemId}
                // Draggable only for the host: a viewer dragging a row it cannot
                // reorder would be a gesture that silently fails.
                draggable={canControl}
                onDragStart={
                  canControl
                    ? (e) => {
                        setDraggingId(item.itemId);
                        e.dataTransfer.effectAllowed = "move";
                        // Firefox refuses to start a drag without payload. The
                        // id travels in component state (the drop handler reads
                        // it there); this is only the required non-empty set.
                        e.dataTransfer.setData("text/plain", item.itemId);
                      }
                    : undefined
                }
                onDragOver={
                  canControl
                    ? (e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        if (dropTargetId !== item.itemId) setDropTargetId(item.itemId);
                      }
                    : undefined
                }
                onDrop={
                  canControl
                    ? (e) => {
                        e.preventDefault();
                        finishDrag(item.itemId);
                      }
                    : undefined
                }
                onDragEnd={canControl ? () => finishDrag(null) : undefined}
                className={cn(
                  "group relative flex items-start gap-2 rounded-lg border border-transparent px-1.5 py-1.5 transition-colors",
                  "hover:bg-raised/70",
                  draggingId === item.itemId && "opacity-50",
                  dropTargetId === item.itemId &&
                    draggingId !== null &&
                    draggingId !== item.itemId &&
                    "border-accent/60 bg-accent/10",
                )}
              >
                <span className="mt-0.5 w-4 shrink-0 text-right text-2xs tabular-nums text-fg-faint">
                  {index + 1}
                </span>

                <div className="min-w-0 flex-1">
                  {/* Untrusted text, rendered as a text node. Never a link, never
                      markdown — see this file's header. */}
                  <p className="line-clamp-2 text-xs leading-snug text-fg">{title}</p>
                  <p className="mt-0.5 truncate text-2xs text-fg-faint">
                    {duration === null
                      ? t("desktop:watchParty.queueAddedBy", { name: item.addedByName })
                      : `${duration} · ${t("desktop:watchParty.queueAddedBy", {
                          name: item.addedByName,
                        })}`}
                  </p>
                </div>

                {canControl && (
                  // ABSOLUTE, not a flex sibling. Laid out in the row these four
                  // buttons take ~110px of a 256px panel permanently — even at
                  // `opacity-0`, layout still reserves them — which crushed the
                  // host's titles to two words while a viewer, who has no
                  // buttons, read the full line. The host is the person who most
                  // needs to read what is queued, so the controls float over the
                  // row's right edge on hover/focus instead of taxing every row.
                  <div
                    className={cn(
                      "absolute right-1.5 top-1 flex items-center gap-0.5 rounded-md",
                      "border border-stroke bg-raised px-0.5 py-0.5 shadow-sm",
                      "opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100",
                    )}
                  >
                    {/* Move buttons are the KEYBOARD path — real buttons in the
                        tab order, so drag-and-drop is never the only way. They
                        are omitted at the ends rather than disabled. */}
                    {canMoveQueueItem(ids, item.itemId, -1) && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("desktop:watchParty.queueMoveUp", { title })}
                        onClick={() => move(item.itemId, -1)}
                      >
                        <ArrowUp className="size-3.5" />
                      </Button>
                    )}
                    {canMoveQueueItem(ids, item.itemId, 1) && (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t("desktop:watchParty.queueMoveDown", { title })}
                        onClick={() => move(item.itemId, 1)}
                      >
                        <ArrowDown className="size-3.5" />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("desktop:watchParty.queuePlayNow", { title })}
                      onClick={() => onPlayNow(item.itemId)}
                    >
                      <Play className="size-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={t("desktop:watchParty.queueRemove", { title })}
                      onClick={() => onRemove(item.itemId)}
                      className="text-danger hover:text-danger"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </aside>
  );
}

/**
 * Memoized (§27): this sits next to a player whose parent re-renders on every 5 s
 * heartbeat and on every presence tick, and none of that changes the queue. With
 * a stable `items` reference from the store, the panel re-renders on a real
 * `watch.queue_updated` frame and on nothing else.
 */
export const WatchQueuePanel = memo(WatchQueuePanelImpl);
