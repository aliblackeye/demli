import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type WheelEvent } from "react";
import { Minus, Plus, RotateCcw, X } from "lucide-react";
import { Dialog, DialogBareContent, DialogClose, DialogDescription, DialogTitle, UserAvatar, cn } from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.5;
/** Arrow-key pan step while zoomed (Shift = coarse). */
const PAN_STEP = 40;

interface View {
  zoom: number;
  x: number;
  y: number;
}

const RESTING: View = { zoom: MIN_ZOOM, x: 0, y: 0 };

/**
 * Full-viewport avatar viewer — "tap the avatar, see it big, and be able to move
 * around inside it" (founder).
 *
 * It ZOOMS (wheel about the cursor, ± buttons, double-click, + − keys) and PANS
 * by dragging or with the arrow keys once zoomed in. Panning is clamped to the
 * image's own bounds, so the picture can never be dragged off-screen and lost —
 * the failure mode that makes hand-rolled pan viewers feel broken.
 *
 * Motion: the scrim fades and the frame pops (the shared CSS keyframes, which
 * Radix awaits on close so the exit plays too); button / wheel / key zoom
 * travels on the fast step, a drag follows the pointer with no easing at all.
 * The global reduced-motion guard flattens every one of them.
 *
 * Built on the same Radix Dialog shell as {@link ImageLightbox} (focus trap,
 * Esc, backdrop click). Falls back to the initials {@link UserAvatar} when the
 * user has no photo, so the affordance behaves consistently for everyone rather
 * than silently doing nothing on half the roster.
 */
export function AvatarLightbox({
  open,
  onOpenChange,
  url,
  name,
  colorSeed,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The avatar image URL, or null → the initials fallback (no zoom needed). */
  url: string | null | undefined;
  name: string;
  colorSeed: string;
}): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const [view, setView] = useState<View>(RESTING);
  const [dragging, setDragging] = useState(false);
  const dragFrom = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const percent = new Intl.NumberFormat(i18n.language, { style: "percent", maximumFractionDigits: 0 });

  // Reset on every open so the viewer never re-opens mid-pan at 5× on a corner
  // of the previous person's face.
  useEffect(() => {
    if (open) {
      setView(RESTING);
      dragFrom.current = null;
      setDragging(false);
    }
  }, [open]);

  /**
   * Keep the panned image overlapping its frame. The visible overflow at scale
   * `z` is half the extra size in each axis, so clamping to ±that keeps an edge
   * from ever crossing into the frame.
   */
  const clamp = useCallback((next: View): View => {
    const frame = frameRef.current;
    const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(next.zoom.toFixed(2))));
    if (!frame || zoom === MIN_ZOOM) return { zoom, x: 0, y: 0 };
    const maxX = (frame.clientWidth * (zoom - 1)) / 2;
    const maxY = (frame.clientHeight * (zoom - 1)) / 2;
    return {
      zoom,
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    };
  }, []);

  /**
   * Zoom to `zoom`, keeping the point under `anchor` (px from the frame centre)
   * still — so the wheel zooms into what the cursor is on, not the middle.
   */
  const zoomTo = useCallback(
    (zoom: number, anchor = { x: 0, y: 0 }) => {
      setView((prev) => {
        const target = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
        const ratio = target / prev.zoom;
        return clamp({
          zoom: target,
          x: anchor.x - (anchor.x - prev.x) * ratio,
          y: anchor.y - (anchor.y - prev.y) * ratio,
        });
      });
    },
    [clamp],
  );

  const anchorOf = (clientX: number, clientY: number): { x: number; y: number } => {
    const rect = frameRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: clientX - rect.left - rect.width / 2, y: clientY - rect.top - rect.height / 2 };
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>): void => {
    if (!url) return;
    zoomTo(view.zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP), anchorOf(event.clientX, event.clientY));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (!url || view.zoom === MIN_ZOOM || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragFrom.current = { x: event.clientX, y: event.clientY, ox: view.x, oy: view.y };
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const from = dragFrom.current;
    if (!from) return;
    setView((prev) =>
      clamp({ zoom: prev.zoom, x: from.ox + (event.clientX - from.x), y: from.oy + (event.clientY - from.y) }),
    );
  };

  const endDrag = (): void => {
    dragFrom.current = null;
    setDragging(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!url) return;
    const step = event.shiftKey ? PAN_STEP * 3 : PAN_STEP;
    const pans: Record<string, { x: number; y: number }> = {
      // Arrows move the PICTURE, the same direction the crop editor uses.
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const pan = pans[event.key];
    if (pan && view.zoom > MIN_ZOOM) {
      event.preventDefault();
      setView((prev) => clamp({ zoom: prev.zoom, x: prev.x + pan.x, y: prev.y + pan.y }));
    } else if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomTo(view.zoom + ZOOM_STEP);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomTo(view.zoom - ZOOM_STEP);
    } else if (event.key === "0") {
      event.preventDefault();
      setView(RESTING);
    }
  };

  const zoomed = view.zoom > MIN_ZOOM;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBareContent
        className={cn(
          "group fixed inset-0 z-50 flex items-center justify-center p-6 sm:p-12",
          "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out",
        )}
        onKeyDown={onKeyDown}
        onClick={(event) => {
          if (event.target === event.currentTarget) onOpenChange(false);
        }}
      >
        {/* Scrim: the page tone at 85% plus the scrim blur. */}
        <div className="pointer-events-none absolute inset-0 -z-10 bg-rail/85 backdrop-blur-sm" aria-hidden />
        <DialogTitle className="sr-only">{name}</DialogTitle>
        <DialogDescription className="sr-only">{t("desktop:imageEditor.stageHelp")}</DialogDescription>

        <div
          ref={frameRef}
          data-testid="avatar-lightbox-frame"
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={(event) =>
            zoomTo(view.zoom >= MAX_ZOOM ? MIN_ZOOM : view.zoom + 1, anchorOf(event.clientX, event.clientY))
          }
          className={cn(
            "relative flex size-[min(80vw,80vh)] touch-none items-center justify-center overflow-hidden rounded-card bg-app",
            "group-data-[state=open]:animate-pop-in group-data-[state=closed]:animate-pop-out",
            url && zoomed ? (dragging ? "cursor-grabbing" : "cursor-grab") : url ? "cursor-zoom-in" : "cursor-default",
          )}
        >
          {url ? (
            <img
              src={url}
              alt={name}
              draggable={false}
              className="size-full select-none object-cover"
              style={{
                transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.zoom})`,
                // No easing while dragging — a tweened pan lags the pointer.
                transition: dragging
                  ? "none"
                  : "transform var(--motion-duration-fast) var(--motion-ease-standard)",
              }}
            />
          ) : (
            // The `url == null` branch of this very ternary — the user has no
            // avatar image, which is why the lightbox is showing initials at all.
            // Passing `url` here would be passing a value already known to be null.
            <UserAvatar name={name} colorSeed={colorSeed} src={null} size="2xl" />
          )}
        </div>

        {url && (
          <div className="absolute bottom-6 flex items-center gap-0.5 rounded-pill p-1 surface-glass">
            <LightboxButton
              label={t("desktop:profileCard.zoomOut")}
              onClick={() => zoomTo(view.zoom - ZOOM_STEP)}
              disabled={view.zoom <= MIN_ZOOM}
            >
              <Minus className="size-4" />
            </LightboxButton>
            <span className="min-w-14 text-center text-xs font-medium tabular-nums text-fg" aria-live="polite">
              {percent.format(view.zoom)}
            </span>
            <LightboxButton
              label={t("desktop:profileCard.zoomIn")}
              onClick={() => zoomTo(view.zoom + ZOOM_STEP)}
              disabled={view.zoom >= MAX_ZOOM}
            >
              <Plus className="size-4" />
            </LightboxButton>
            <LightboxButton
              label={t("desktop:profileCard.zoomReset")}
              onClick={() => setView(RESTING)}
              disabled={view.zoom === MIN_ZOOM && view.x === 0 && view.y === 0}
            >
              <RotateCcw className="size-4" />
            </LightboxButton>
          </div>
        )}

        <DialogClose
          aria-label={t("buttons.close")}
          className={cn(
            "absolute right-4 top-4 grid size-10 cursor-pointer place-items-center rounded-full surface-glass text-fg-muted",
            "transition-colors motion-hover hover:bg-raised hover:text-fg active:bg-raised-pressed",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
          )}
        >
          <X className="size-5" />
        </DialogClose>
      </DialogBareContent>
    </Dialog>
  );
}

function LightboxButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "grid size-9 cursor-pointer place-items-center rounded-full text-fg-muted transition-colors motion-hover",
        "hover:bg-wash hover:text-fg active:bg-wash-strong",
        "disabled:pointer-events-none disabled:opacity-40",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
      )}
    >
      {children}
    </button>
  );
}
