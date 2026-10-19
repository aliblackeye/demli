import { useCallback, useEffect, useRef, useState, type PointerEvent, type WheelEvent } from "react";
import { ChevronLeft, ChevronRight, Copy, Download, ImageOff, Maximize2, Minus, Plus, X } from "lucide-react";
import { Dialog, DialogBareContent, DialogClose, DialogTitle, cn } from "@demli/ui";
import { ActionMenu } from "@demli/app-ui";
import { useAppTranslation } from "../lib/i18n";
import {
  canCopyImage,
  canSaveImage,
  copyImage,
  saveImage,
  type ImageActionTarget,
} from "../lib/image-actions";
import { ImageActionItems } from "./ImageActionItems";

/** One picture the viewer can show. `actions` = save/copy payload, or null. */
export interface LightboxImage {
  url: string;
  alt: string;
  actions: ImageActionTarget | null;
}

/** Zoom range. 1 = "fit": the picture as large as the viewport allows. */
const MIN_SCALE = 1;
const MAX_SCALE = 5;
/** Multiplier for one zoom-button press or +/- key press. */
const STEP = 1.5;
/** Pixels one arrow-key press pans a zoomed picture. */
const PAN_STEP = 60;

const clampScale = (scale: number): number => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

/** Shared look for the controls floating over the dimmed backdrop: strong glass, no border. */
const OVERLAY_BUTTON_CLASS = cn(
  "flex size-10 cursor-pointer items-center justify-center rounded-lg surface-glass-strong text-fg-muted",
  "transition-colors motion-hover hover:bg-raised hover:text-fg active:bg-raised-pressed",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
  "disabled:pointer-events-none disabled:opacity-40",
);

interface View {
  scale: number;
  x: number;
  y: number;
}

const FIT: View = { scale: 1, x: 0, y: 0 };

/**
 * Full-viewport image viewer. Radix Dialog gives focus-trapping, Esc-to-close
 * and aria wiring; the image URL is the already-resolved signed URL from the
 * tile that opened it (no extra fetch). Clicking the dimmed backdrop, the close
 * button, or pressing Esc closes it.
 *
 * M16: a real viewer, not a poster.
 *   - Zoom: wheel (anchored under the cursor), double-click (fit ⇄ 2×), the
 *     −/+/fit pill, or the + − 0 keys. Range fit … 5×.
 *   - Pan: drag a zoomed picture, or the arrow keys.
 *   - Gallery: when the message carries several images, ← → (and the side
 *     arrows) step through them; the counter says where you are.
 * Motion is a fade for the backdrop and the standard pop for the picture; a
 * button/key zoom eases on the standard step, while wheel and drag track the
 * input directly (an eased transform under a moving pointer feels like lag).
 * The global reduced-motion guard flattens every one of them.
 *
 * When `actions` is present the enlarged view also carries VISIBLE save/copy
 * buttons next to the close control, and the picture itself keeps the same
 * right-click / long-press menu as the tile. The buttons matter: at this size
 * the image is the whole screen, and a hidden context menu would be the only way
 * to act on it — including on touch, where there is no right-click at all.
 */
export function ImageLightbox({
  open,
  onOpenChange,
  url,
  alt,
  actions = null,
  images,
  startIndex = 0,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Single-image form (kept for existing callers): the picture to show. */
  url: string | null;
  alt: string;
  actions?: ImageActionTarget | null;
  /** Gallery form: every picture of the message, in order. Overrides `url`. */
  images?: LightboxImage[];
  /** Which of `images` opens first. */
  startIndex?: number;
}): JSX.Element | null {
  const { t } = useAppTranslation();
  const gallery: LightboxImage[] =
    images && images.length > 0 ? images : url ? [{ url, alt, actions }] : [];
  const [index, setIndex] = useState(startIndex);
  const [view, setView] = useState<View>(FIT);
  const [eased, setEased] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [broken, setBroken] = useState(false);
  const [dragging, setDragging] = useState(false);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; x: number; y: number } | null>(null);

  // Each open starts at the picture that was clicked, fitted.
  useEffect(() => {
    if (open) setIndex(Math.min(Math.max(0, startIndex), Math.max(0, gallery.length - 1)));
    // `gallery.length` is read at open time only — a gallery does not change
    // while its viewer is up.
  }, [open, startIndex]);

  const current = gallery[index] ?? gallery[0];
  const currentUrl = current?.url ?? null;

  // A new picture is a new canvas: back to fit, and to the loading state.
  useEffect(() => {
    setView(FIT);
    setLoaded(false);
    setBroken(false);
  }, [currentUrl]);

  /** Zoom to `nextScale`, keeping the point `(px, py)` (stage-centre relative) fixed. */
  const zoomAt = useCallback((nextScale: number, px: number, py: number, ease: boolean) => {
    setEased(ease);
    setView((prev) => {
      const scale = clampScale(nextScale);
      if (scale === MIN_SCALE) return FIT;
      const ratio = scale / prev.scale;
      return { scale, x: px - (px - prev.x) * ratio, y: py - (py - prev.y) * ratio };
    });
  }, []);

  const step = useCallback(
    (direction: 1 | -1) => {
      if (gallery.length < 2) return;
      setIndex((i) => (i + direction + gallery.length) % gallery.length);
    },
    [gallery.length],
  );

  if (!current) return null;

  const showSave = current.actions !== null && canSaveImage();
  const showCopy = current.actions !== null && canCopyImage();
  // Without this the right-click wrapper would still open an EMPTY popup on a
  // surface where neither action is available (same gate AttachmentTile uses).
  const showMenu = current.actions !== null && (showSave || showCopy);
  const zoomed = view.scale > MIN_SCALE;
  const multiple = gallery.length > 1;

  /** Stage-centre-relative coordinates of a pointer/wheel event. */
  const relative = (clientX: number, clientY: number): { px: number; py: number } => {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect) return { px: 0, py: 0 };
    return { px: clientX - (rect.left + rect.width / 2), py: clientY - (rect.top + rect.height / 2) };
  };

  const onWheel = (event: WheelEvent<HTMLDivElement>): void => {
    if (!loaded || broken) return;
    const { px, py } = relative(event.clientX, event.clientY);
    // Exponential so a trackpad's many small deltas and a wheel's few large
    // ones zoom at the same perceived rate.
    zoomAt(view.scale * Math.exp(-event.deltaY * 0.0015), px, py, false);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (!zoomed || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: view.x,
      y: view.y,
    };
    setEased(false);
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setView((prev) => ({
      ...prev,
      x: drag.x + (event.clientX - drag.startX),
      y: drag.y + (event.clientY - drag.startY),
    }));
  };

  const endDrag = (event: PointerEvent<HTMLDivElement>): void => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomAt(view.scale * STEP, 0, 0, true);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomAt(view.scale / STEP, 0, 0, true);
    } else if (event.key === "0") {
      event.preventDefault();
      zoomAt(MIN_SCALE, 0, 0, true);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const direction = event.key === "ArrowLeft" ? 1 : -1;
      if (zoomed) {
        setEased(true);
        setView((prev) => ({ ...prev, x: prev.x + direction * PAN_STEP }));
      } else {
        step(event.key === "ArrowLeft" ? -1 : 1);
      }
    } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && zoomed) {
      event.preventDefault();
      const direction = event.key === "ArrowUp" ? 1 : -1;
      setEased(true);
      setView((prev) => ({ ...prev, y: prev.y + direction * PAN_STEP }));
    }
  };

  const image = (
    <img
      key={current.url}
      src={current.url}
      alt={current.alt}
      draggable={false}
      onLoad={() => setLoaded(true)}
      onError={() => setBroken(true)}
      className={cn(
        "max-h-full max-w-full select-none rounded-lg object-contain",
        "transition-opacity motion-standard",
        loaded ? "opacity-100" : "opacity-0",
      )}
    />
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogBareContent
        className={cn(
          "fixed inset-0 z-50 flex flex-col",
          "data-[state=open]:animate-fade-in data-[state=closed]:animate-fade-out",
        )}
        onKeyDown={onKeyDown}
        aria-describedby={undefined}
      >
        {/* The near-black veil keeps the picture the only lit thing on screen. */}
        <div className="absolute inset-0 -z-10 bg-rail/90 backdrop-blur-sm" aria-hidden />
        <DialogTitle className="sr-only">
          {current.alt || t("desktop:attachments.imagePreview")}
        </DialogTitle>

        {/* Top bar: position on the left, actions + close on the right. */}
        <div className="relative z-10 flex shrink-0 items-center justify-between p-4">
          <span
            aria-live="polite"
            className={cn(
              "flex h-8 items-center rounded-pill surface-glass-strong px-3 text-xs font-medium tabular-nums text-fg-muted",
              !multiple && "invisible",
            )}
          >
            {t("desktop:attachments.position", { index: index + 1, total: gallery.length })}
          </span>
          <div className="flex items-center gap-2">
            {showSave && current.actions && (
              <OverlayButton
                label={t("desktop:attachments.saveImage")}
                onClick={() => current.actions && void saveImage(current.actions)}
              >
                <Download className="size-5" />
              </OverlayButton>
            )}
            {showCopy && current.actions && (
              <OverlayButton
                label={t("desktop:attachments.copyImage")}
                onClick={() => current.actions && void copyImage(current.actions)}
              >
                <Copy className="size-5" />
              </OverlayButton>
            )}
            <DialogClose aria-label={t("buttons.close")} title={t("buttons.close")} className={OVERLAY_BUTTON_CLASS}>
              <X className="size-5" />
            </DialogClose>
          </div>
        </div>

        {/* Stage: wheel zoom, drag pan, double-click fit ⇄ 2×. A click on the
            empty backdrop (not the picture) closes, like before. */}
        <div
          ref={stageRef}
          className={cn(
            "relative flex min-h-0 flex-1 items-center justify-center overflow-hidden px-16",
            zoomed ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-default",
          )}
          onClick={(event) => {
            if (event.target === event.currentTarget && !zoomed) onOpenChange(false);
          }}
          onWheel={onWheel}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {broken ? (
            <div role="alert" className="flex flex-col items-center gap-3 text-center animate-fade-in">
              <div className="flex size-12 items-center justify-center rounded-xl bg-surface">
                <ImageOff className="size-6 text-fg-muted" aria-hidden />
              </div>
              <p className="text-sm text-fg-muted">{t("desktop:attachments.openFailed")}</p>
            </div>
          ) : (
            <>
              {!loaded && (
                <div
                  role="status"
                  aria-label={t("desktop:attachments.loading")}
                  className="absolute size-24 animate-pulse rounded-xl bg-wash-strong"
                />
              )}
              <div
                className={cn(
                  "flex max-h-full max-w-full items-center justify-center will-change-transform animate-pop-in",
                  eased && "transition-transform motion-standard",
                )}
                style={{
                  transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`,
                  // Fill the stage so `max-h/max-w-full` on the img fit the viewport.
                  height: "100%",
                  width: "100%",
                }}
                onDoubleClick={(event) => {
                  const { px, py } = relative(event.clientX, event.clientY);
                  zoomAt(zoomed ? MIN_SCALE : 2, px, py, true);
                }}
              >
                {showMenu && current.actions ? (
                  <ActionMenu contentClassName="w-52" menu={<ImageActionItems target={current.actions} />}>
                    <div className="flex max-h-full max-w-full">{image}</div>
                  </ActionMenu>
                ) : (
                  image
                )}
              </div>
            </>
          )}

          {multiple && (
            <>
              <OverlayButton
                label={t("desktop:attachments.previousImage")}
                onClick={() => step(-1)}
                className="absolute left-4 top-1/2 -translate-y-1/2"
              >
                <ChevronLeft className="size-5" />
              </OverlayButton>
              <OverlayButton
                label={t("desktop:attachments.nextImage")}
                onClick={() => step(1)}
                className="absolute right-4 top-1/2 -translate-y-1/2"
              >
                <ChevronRight className="size-5" />
              </OverlayButton>
            </>
          )}
        </div>

        {/* Zoom pill + the one-line how-to. */}
        <div className="relative z-10 flex shrink-0 flex-col items-center gap-2 p-4">
          <div className="flex items-center gap-1 rounded-xl surface-glass-strong p-1">
            <ZoomButton
              label={t("desktop:attachments.zoomOut")}
              disabled={!zoomed || broken}
              onClick={() => zoomAt(view.scale / STEP, 0, 0, true)}
            >
              <Minus className="size-4" />
            </ZoomButton>
            <span
              className="w-12 text-center text-xs font-medium tabular-nums text-fg"
              aria-live="polite"
            >
              {t("desktop:attachments.zoomLevel", { percent: Math.round(view.scale * 100) })}
            </span>
            <ZoomButton
              label={t("desktop:attachments.zoomIn")}
              disabled={view.scale >= MAX_SCALE || broken || !loaded}
              onClick={() => zoomAt(view.scale * STEP, 0, 0, true)}
            >
              <Plus className="size-4" />
            </ZoomButton>
            <ZoomButton
              label={t("desktop:attachments.zoomFit")}
              disabled={!zoomed}
              onClick={() => zoomAt(MIN_SCALE, 0, 0, true)}
            >
              <Maximize2 className="size-4" />
            </ZoomButton>
          </div>
          <p className="text-2xs text-fg-faint">{t("desktop:attachments.lightboxHint")}</p>
        </div>
      </DialogBareContent>
    </Dialog>
  );
}

function OverlayButton({
  label,
  onClick,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  className?: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(OVERLAY_BUTTON_CLASS, className)}
    >
      {children}
    </button>
  );
}

function ZoomButton({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled: boolean;
  children: JSX.Element;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex size-8 cursor-pointer items-center justify-center rounded-lg text-fg-muted",
        "transition-colors motion-hover hover:bg-wash hover:text-fg active:bg-wash-strong",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        "disabled:pointer-events-none disabled:opacity-40",
      )}
    >
      {children}
    </button>
  );
}
