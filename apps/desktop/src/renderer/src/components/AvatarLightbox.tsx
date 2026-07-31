import { useCallback, useEffect, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { Minus, Plus, RotateCcw, X } from "lucide-react";
import { Dialog, DialogBareContent, DialogClose, DialogTitle, UserAvatar, cn } from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";

const MIN_ZOOM = 1;
const MAX_ZOOM = 5;
const ZOOM_STEP = 0.5;

/**
 * Full-viewport avatar viewer — "tap the avatar, see it big, and be able to move
 * around inside it" (founder).
 *
 * A plain lightbox is not enough here: avatars are square crops of photos people
 * actually want to look at, so this one ZOOMS (wheel, +/− buttons, double-click)
 * and PANS by dragging once zoomed in. Panning is clamped to the image's own
 * bounds, so you can never drag the picture off-screen and lose it — the
 * failure mode that makes hand-rolled pan viewers feel broken.
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
  const { t } = useAppTranslation();
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragFrom = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);

  // Reset on every open so the viewer never re-opens mid-pan at 5× on a corner
  // of the previous person's face.
  useEffect(() => {
    if (open) {
      setZoom(1);
      setOffset({ x: 0, y: 0 });
      dragFrom.current = null;
    }
  }, [open]);

  /**
   * Keep the panned image overlapping its frame. The visible overflow at scale
   * `z` is half the extra size in each axis, so clamping to ±that keeps an edge
   * from ever crossing the frame's centre line.
   */
  const clamp = useCallback((next: { x: number; y: number }, z: number) => {
    const frame = frameRef.current;
    if (!frame) return next;
    const maxX = (frame.clientWidth * (z - 1)) / 2;
    const maxY = (frame.clientHeight * (z - 1)) / 2;
    return {
      x: Math.min(maxX, Math.max(-maxX, next.x)),
      y: Math.min(maxY, Math.max(-maxY, next.y)),
    };
  }, []);

  const applyZoom = useCallback(
    (next: number) => {
      const z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Number(next.toFixed(2))));
      setZoom(z);
      // Re-clamp the current pan against the NEW scale, so zooming out never
      // leaves the image parked off-centre with empty space beside it.
      setOffset((prev) => clamp(z === MIN_ZOOM ? { x: 0, y: 0 } : prev, z));
    },
    [clamp],
  );

  const onWheel = (event: WheelEvent<HTMLDivElement>): void => {
    if (!url) return;
    applyZoom(zoom + (event.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP));
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (!url || zoom === MIN_ZOOM) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragFrom.current = { x: event.clientX, y: event.clientY, ox: offset.x, oy: offset.y };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const from = dragFrom.current;
    if (!from) return;
    setOffset(
      clamp({ x: from.ox + (event.clientX - from.x), y: from.oy + (event.clientY - from.y) }, zoom),
    );
  };

  const endDrag = (): void => {
    dragFrom.current = null;
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBareContent
        className="fixed inset-0 z-50 flex items-center justify-center p-6 sm:p-12 animate-fade-in"
        onClick={(event) => {
          if (event.target === event.currentTarget) onOpenChange(false);
        }}
      >
        <div className="absolute inset-0 -z-10 bg-black/85" aria-hidden />
        <DialogTitle className="sr-only">{name}</DialogTitle>

        <div
          ref={frameRef}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onDoubleClick={() => applyZoom(zoom >= MAX_ZOOM ? MIN_ZOOM : zoom + 1)}
          className={cn(
            "relative flex size-[min(80vw,80vh)] items-center justify-center overflow-hidden rounded-2xl",
            "bg-black/40 shadow-2xl",
            url && zoom > MIN_ZOOM ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
          )}
        >
          {url ? (
            <img
              src={url}
              alt={name}
              draggable={false}
              className="size-full select-none object-cover"
              style={{
                transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
                // No transition while dragging — a tweened pan lags the pointer.
                transition: dragFrom.current ? "none" : "transform 140ms ease-out",
              }}
            />
          ) : (
            // The `url == null` branch of this very ternary — the user has no
            // avatar image, which is why the lightbox is showing initials at all.
            // Passing `url` here would be passing a value already known to be null.
            <UserAvatar
              name={name}
              colorSeed={colorSeed}
              src={null}
              size="lg"
              className="size-2/3 text-4xl"
            />
          )}
        </div>

        {url && (
          <div className="absolute bottom-6 flex items-center gap-1 rounded-full bg-black/60 p-1 backdrop-blur-sm">
            <LightboxButton
              label={t("desktop:profileCard.zoomOut")}
              onClick={() => applyZoom(zoom - ZOOM_STEP)}
              disabled={zoom <= MIN_ZOOM}
            >
              <Minus className="size-4" />
            </LightboxButton>
            <span className="min-w-12 text-center text-xs tabular-nums text-white/80">
              {Math.round(zoom * 100)}%
            </span>
            <LightboxButton
              label={t("desktop:profileCard.zoomIn")}
              onClick={() => applyZoom(zoom + ZOOM_STEP)}
              disabled={zoom >= MAX_ZOOM}
            >
              <Plus className="size-4" />
            </LightboxButton>
            <LightboxButton
              label={t("desktop:profileCard.zoomReset")}
              onClick={() => applyZoom(MIN_ZOOM)}
              disabled={zoom === MIN_ZOOM && offset.x === 0 && offset.y === 0}
            >
              <RotateCcw className="size-4" />
            </LightboxButton>
          </div>
        )}

        <DialogClose
          aria-label={t("buttons.close")}
          className="absolute right-4 top-4 cursor-pointer rounded-lg bg-black/50 p-2 text-white/80 transition-colors hover:bg-black/70 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70"
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
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "grid size-8 cursor-pointer place-items-center rounded-full text-white/80 transition-colors",
        "hover:bg-white/10 hover:text-white disabled:cursor-default disabled:opacity-35 disabled:hover:bg-transparent",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/70",
      )}
    >
      {children}
    </button>
  );
}
