import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { Film, ImageOff, ImagePlus, Info, Minus, Move, Plus, RotateCcw } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  IconButton,
  Kbd,
  Skeleton,
  Slider,
  UserAvatar,
  cn,
} from "@demli/ui";
import {
  CROP_ASPECT,
  MAX_ZOOM,
  MIN_ZOOM,
  clampCropState,
  cropRect,
  imageTransform,
  initialCropState,
  isInitialCrop,
  panCrop,
  zoomCrop,
  type CropKind,
  type CropState,
  type Point,
  type Size,
} from "../lib/image-crop";
import {
  CROP_INPUT_ACCEPT,
  UPLOAD_MAX_BYTES,
  decodeImage,
  exportCrop,
  inspectImageFile,
  keepOriginal,
  releaseImage,
  renderCrop,
  type ExportedImage,
  type ImageFileProblem,
  type InspectedImage,
} from "../lib/image-file";
import { useAppTranslation } from "../lib/i18n";
import { ProfileIdentityPreview } from "./ProfileCard";

/** Who the preview is drawn for — the signed-in user, with their CURRENT other image. */
export interface ImageCropIdentity {
  name: string;
  username: string;
  seed: string;
  avatarUrl: string | null | undefined;
  bannerUrl: string | null | undefined;
}

export interface ImageCropDialogProps {
  kind: CropKind;
  /** The picked file; non-null opens the editor. */
  file: File | null;
  /** Cancel / Esc / backdrop: nothing is kept (founder: cancel discards). */
  onCancel: () => void;
  /** The exported image, ready to become the settings draft. */
  onApply: (image: ExportedImage) => void;
  identity: ImageCropIdentity;
}

/** Breathing room between the stage edge and the mask. */
const STAGE_PAD = 24;
/** Arrow-key nudge in screen px (Shift = coarse). */
const NUDGE = 8;
const NUDGE_COARSE = 40;
/** One keyboard / button zoom step (multiplicative, so it feels even at any zoom). */
const ZOOM_FACTOR = 1.15;
/** Live preview resolution (2× the largest preview draw size). */
const PREVIEW_SIZE: Record<CropKind, Size> = {
  avatar: { width: 160, height: 160 },
  banner: { width: 640, height: 240 },
};

const PROBLEM_KEY = {
  type: "desktop:imageEditor.errorType",
  size: "desktop:imageEditor.errorSize",
  pixels: "desktop:imageEditor.errorPixels",
  decode: "desktop:imageEditor.errorDecode",
  encode: "desktop:imageEditor.errorEncode",
  animatedTooLarge: "desktop:imageEditor.errorAnimatedTooLarge",
} as const satisfies Record<ImageFileProblem, string>;

type Phase =
  | { kind: "loading" }
  | { kind: "error"; problem: ImageFileProblem }
  | { kind: "ready"; inspected: InspectedImage; img: HTMLImageElement; natural: Size };

/** How a change should travel on screen: direct manipulation never animates. */
type Travel = "none" | "nudge" | "spring";

const TRAVEL_STYLE: Record<Travel, string | undefined> = {
  none: undefined,
  nudge: "transform var(--motion-duration-fast) var(--motion-ease-standard)",
  spring: "transform var(--motion-duration-spring) var(--motion-ease-spring)",
};

/** Mask rectangle (stage px) for a stage size. */
function maskFor(kind: CropKind, stage: Size): Size & { left: number; top: number } {
  const availW = Math.max(0, stage.width - STAGE_PAD * 2);
  const availH = Math.max(0, stage.height - STAGE_PAD * 2);
  const aspect = CROP_ASPECT[kind];
  let width = availW;
  let height = width / aspect;
  if (height > availH) {
    height = availH;
    width = height * aspect;
  }
  return {
    width,
    height,
    left: (stage.width - width) / 2,
    top: (stage.height - height) / 2,
  };
}

/**
 * The avatar / banner crop editor (M16).
 *
 * Pick → validate (type, size, real bytes, pixel budget) → decode → frame →
 * export at the size and format the server accepts → hand back a DRAFT. Nothing
 * is uploaded here: the account settings' unsaved-changes bar uploads on Save
 * (founder rule — "kaydetmediğim sürece kaydedilmemeli"), and Cancel throws the
 * pick away.
 *
 * Framing: drag to pan (pointer capture, so it keeps tracking outside the
 * stage), wheel / trackpad pinch / two-finger pinch to zoom about the point
 * under the pointer, slider and ± buttons, and a keyboard path (arrows nudge,
 * Shift coarse, + − zoom, 0 reset). The geometry (lib/image-crop) keeps the
 * mask filled at all times — no empty edge can ever be exported.
 *
 * The preview column draws the REAL card identity block (ProfileIdentityPreview)
 * and a message-row line with the crop as it is right now, rendered from a small
 * canvas on each animation frame the crop changes.
 *
 * Animated images: an animated banner can be kept moving (original bytes,
 * uncropped — a canvas can only export one frame) or cropped into a still; the
 * editor says which and why. An animated avatar is always a still (the server
 * refuses GIF avatars on purpose), and the editor says that too.
 */
export function ImageCropDialog({
  kind,
  file,
  onCancel,
  onApply,
  identity,
}: ImageCropDialogProps): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const open = file !== null;
  const percent = new Intl.NumberFormat(i18n.language, { style: "percent", maximumFractionDigits: 0 });
  // The file being edited. Starts as the picked one; "Choose another" swaps it
  // without closing the editor.
  const [current, setCurrent] = useState<File | null>(file);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [crop, setCrop] = useState<CropState>({ zoom: 1, center: { x: 0, y: 0 } });
  const [travel, setTravel] = useState<Travel>("none");
  const [dragging, setDragging] = useState(false);
  const [mode, setMode] = useState<"crop" | "keep">("crop");
  const [applying, setApplying] = useState(false);
  const [applyProblem, setApplyProblem] = useState<ImageFileProblem | null>(null);
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 });
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const stageRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pointers = useRef(new Map<number, Point>());
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const helpId = useId();

  useEffect(() => {
    if (file) setCurrent(file);
  }, [file]);

  // Load pipeline: inspect → decode. Each run owns its image and frees it.
  useEffect(() => {
    if (!open || !current) return;
    let cancelled = false;
    let decoded: HTMLImageElement | null = null;
    setPhase({ kind: "loading" });
    setApplyProblem(null);
    setPreviewUrl(null);
    void (async () => {
      const inspected = await inspectImageFile(current);
      if (cancelled) return;
      if (!inspected.ok) {
        setPhase({ kind: "error", problem: inspected.problem });
        return;
      }
      try {
        decoded = await decodeImage(inspected.image.bytes, inspected.image.mime);
      } catch {
        if (!cancelled) setPhase({ kind: "error", problem: "decode" });
        return;
      }
      if (cancelled) {
        releaseImage(decoded);
        return;
      }
      const natural = { width: decoded.naturalWidth, height: decoded.naturalHeight };
      setCrop(initialCropState(natural));
      setTravel("none");
      // An animated banner defaults to staying animated when the server will
      // take it as-is; over the cap it can only be cropped into a still.
      setMode(
        kind === "banner" &&
          inspected.image.animated &&
          inspected.image.bytes.length <= UPLOAD_MAX_BYTES.banner
          ? "keep"
          : "crop",
      );
      setPhase({ kind: "ready", inspected: inspected.image, img: decoded, natural });
    })();
    return () => {
      cancelled = true;
      releaseImage(decoded);
    };
  }, [open, current, kind]);

  // Measure the stage (dialog resize, narrow-viewport sheet).
  useLayoutEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = (): void => setStage({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [phase.kind]);

  const ready = phase.kind === "ready" ? phase : null;
  const natural = ready?.natural ?? null;
  const mask = maskFor(kind, stage);
  const maskSize: Size = { width: mask.width, height: mask.height };
  const measured = mask.width > 0 && mask.height > 0;
  const cropping = ready !== null && mode === "crop";

  // Latest geometry for the native wheel listener (attached once).
  const geometry = useRef({ natural, mask, cropping });
  geometry.current = { natural, mask, cropping };

  const update = useCallback(
    (next: (state: CropState, image: Size, maskArea: Size) => CropState, how: Travel) => {
      const { natural: image, mask: m, cropping: active } = geometry.current;
      if (!image || !active || m.width <= 0) return;
      setTravel(how);
      setCrop((state) => next(state, image, { width: m.width, height: m.height }));
    },
    [],
  );

  // Wheel / trackpad pinch. Native + non-passive: React's onWheel is passive,
  // so it could not stop the dialog body from scrolling under the zoom.
  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const onWheel = (event: WheelEvent): void => {
      const { mask: m, cropping: active } = geometry.current;
      if (!active) return;
      event.preventDefault();
      const rect = node.getBoundingClientRect();
      const anchor = {
        x: event.clientX - rect.left - (m.left + m.width / 2),
        y: event.clientY - rect.top - (m.top + m.height / 2),
      };
      // Trackpad pinch arrives as ctrl+wheel with small deltas — scale it up.
      const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0015));
      update((s, image, area) => zoomCrop(s, s.zoom * factor, image, area, anchor), "none");
    };
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => node.removeEventListener("wheel", onWheel);
  }, [phase.kind, update]);

  // Keep the state inside the mask when the mask itself changes size.
  useEffect(() => {
    if (!natural || !measured) return;
    setCrop((state) => clampCropState(state, natural, maskSize));
    // maskSize is derived from these two numbers.
  }, [natural, measured, mask.width, mask.height]);

  // Live preview: one small canvas render per animation frame the crop changes.
  useEffect(() => {
    if (!ready || !measured) return;
    if (mode === "keep") {
      setPreviewUrl(ready.img.src);
      return;
    }
    const frame = requestAnimationFrame(() => {
      const rect = cropRect(crop, ready.natural, maskSize);
      const canvas = renderCrop(ready.img, rect, PREVIEW_SIZE[kind]);
      setPreviewUrl(canvas.toDataURL("image/webp", 0.9));
    });
    return () => cancelAnimationFrame(frame);
    // maskSize is derived from mask.width/height.
  }, [ready, crop, mode, kind, measured, mask.width, mask.height]);

  const close = (): void => {
    if (applying) return;
    onCancel();
  };

  const apply = async (): Promise<void> => {
    if (!ready || applying || !measured) return;
    setApplyProblem(null);
    if (mode === "keep") {
      if (ready.inspected.bytes.length > UPLOAD_MAX_BYTES.banner) {
        setApplyProblem("animatedTooLarge");
        return;
      }
      onApply(keepOriginal(ready.inspected, ready.natural));
      return;
    }
    setApplying(true);
    const exported = await exportCrop(ready.img, cropRect(crop, ready.natural, maskSize), kind);
    setApplying(false);
    if (!exported) {
      setApplyProblem("encode");
      return;
    }
    onApply(exported);
  };

  const chooseAnother = (): void => inputRef.current?.click();

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (!cropping || (event.pointerType === "mouse" && event.button !== 0)) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()] as [Point, Point];
      pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), zoom: crop.zoom };
    }
    setDragging(true);
    setTravel("none");
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const next = { x: event.clientX, y: event.clientY };
    pointers.current.set(event.pointerId, next);
    if (pointers.current.size === 1) {
      const delta = { x: next.x - previous.x, y: next.y - previous.y };
      update((s, image, area) => panCrop(s, delta, image, area), "none");
      return;
    }
    const start = pinch.current;
    const node = stageRef.current;
    if (!start || !node || start.distance === 0) return;
    const [a, b] = [...pointers.current.values()] as [Point, Point];
    const rect = node.getBoundingClientRect();
    const anchor = {
      x: (a.x + b.x) / 2 - rect.left - (mask.left + mask.width / 2),
      y: (a.y + b.y) / 2 - rect.top - (mask.top + mask.height / 2),
    };
    const zoom = start.zoom * (Math.hypot(a.x - b.x, a.y - b.y) / start.distance);
    update((s, image, area) => zoomCrop(s, zoom, image, area, anchor), "none");
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>): void => {
    pointers.current.delete(event.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) setDragging(false);
  };

  const zoomBy = (factor: number): void =>
    update((s, image, area) => zoomCrop(s, s.zoom * factor, image, area), "nudge");

  const reset = (): void =>
    update((_s, image, area) => clampCropState(initialCropState(image), image, area), "spring");

  const onStageKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (!cropping) return;
    const step = event.shiftKey ? NUDGE_COARSE : NUDGE;
    const pans: Record<string, Point> = {
      ArrowLeft: { x: -step, y: 0 },
      ArrowRight: { x: step, y: 0 },
      ArrowUp: { x: 0, y: -step },
      ArrowDown: { x: 0, y: step },
    };
    const pan = pans[event.key];
    if (pan) {
      event.preventDefault();
      update((s, image, area) => panCrop(s, pan, image, area), "nudge");
      return;
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      zoomBy(ZOOM_FACTOR);
    } else if (event.key === "-" || event.key === "_") {
      event.preventDefault();
      zoomBy(1 / ZOOM_FACTOR);
    } else if (event.key === "0") {
      event.preventDefault();
      reset();
    }
  };

  const transform = ready && measured ? imageTransform(crop, ready.natural, maskSize) : null;
  const atInitial = ready && measured ? isInitialCrop(crop, ready.natural, maskSize) : true;
  const animatedBanner = kind === "banner" && ready?.inspected.animated === true;
  const animatedTooLarge =
    animatedBanner && (ready?.inspected.bytes.length ?? 0) > UPLOAD_MAX_BYTES.banner;
  const stillAvatarFromGif =
    kind === "avatar" && (ready?.inspected.mime === "image/gif" || ready?.inspected.animated === true);

  const avatarPreview = kind === "avatar" ? previewUrl : identity.avatarUrl;
  const bannerPreview = kind === "banner" ? previewUrl : identity.bannerUrl;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        closeLabel={t("buttons.close")}
        // Opened from inside the settings modal (z-[55]): lift the scrim with the card.
        overlayClassName="z-[58]"
        className="z-[58] max-w-3xl"
        onEscapeKeyDown={(event) => {
          if (applying) event.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {kind === "avatar" ? t("desktop:imageEditor.avatarTitle") : t("desktop:imageEditor.bannerTitle")}
          </DialogTitle>
          <DialogDescription>
            {kind === "avatar"
              ? t("desktop:imageEditor.avatarDescription")
              : t("desktop:imageEditor.bannerDescription")}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <input
            ref={inputRef}
            type="file"
            accept={CROP_INPUT_ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(event) => {
              const next = event.target.files?.[0];
              event.target.value = "";
              if (next) setCurrent(next);
            }}
          />

          <div className="grid gap-6 wide:grid-cols-[minmax(0,1fr)_17.5rem]">
            {/* ── Editor column ─────────────────────────────────────────── */}
            <div className="min-w-0 space-y-4">
              {phase.kind === "error" ? (
                <div
                  role="alert"
                  className="flex h-[320px] flex-col items-center justify-center gap-3 rounded-xl bg-rail px-6 text-center"
                >
                  <span className="grid size-12 place-items-center rounded-full bg-raised text-fg-muted">
                    <ImageOff className="size-6" aria-hidden />
                  </span>
                  <p className="font-display text-base font-medium text-fg-display">
                    {t("desktop:imageEditor.errorTitle")}
                  </p>
                  <p className="max-w-sm text-label text-fg-muted">{t(PROBLEM_KEY[phase.problem])}</p>
                  <Button variant="secondary" size="sm" onClick={chooseAnother} className="mt-1">
                    <ImagePlus className="size-4" aria-hidden />
                    {t("desktop:imageEditor.chooseAnother")}
                  </Button>
                </div>
              ) : (
                <>
                  {animatedBanner && (
                    <div className="space-y-3 rounded-xl bg-surface p-3">
                      <div className="flex items-start gap-2.5">
                        <Film className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden />
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-fg">{t("desktop:imageEditor.animatedTitle")}</p>
                          <p className="text-label text-fg-muted">
                            {animatedTooLarge
                              ? t("desktop:imageEditor.errorAnimatedTooLarge")
                              : t("desktop:imageEditor.animatedBody")}
                          </p>
                        </div>
                      </div>
                      <div role="radiogroup" aria-label={t("desktop:imageEditor.animatedTitle")} className="flex gap-1.5">
                        <ModeOption
                          checked={mode === "keep"}
                          disabled={animatedTooLarge}
                          onSelect={() => setMode("keep")}
                          label={t("desktop:imageEditor.keepAnimation")}
                        />
                        <ModeOption
                          checked={mode === "crop"}
                          onSelect={() => setMode("crop")}
                          label={t("desktop:imageEditor.cropStill")}
                        />
                      </div>
                    </div>
                  )}
                  {stillAvatarFromGif && (
                    <p className="flex items-start gap-2 rounded-xl bg-surface p-3 text-label text-fg-muted">
                      <Info className="mt-0.5 size-4 shrink-0 text-fg-faint" aria-hidden />
                      {t("desktop:imageEditor.gifAvatarNotice")}
                    </p>
                  )}

                  {/* The stage: dark field, the image, a scrim with the mask cut
                      out of it, and the mask's own outline. */}
                  <div
                    ref={stageRef}
                    role="group"
                    aria-label={t("desktop:imageEditor.stageLabel")}
                    aria-describedby={helpId}
                    aria-busy={phase.kind === "loading" || undefined}
                    tabIndex={cropping ? 0 : -1}
                    onKeyDown={onStageKeyDown}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerEnd}
                    onPointerCancel={onPointerEnd}
                    data-testid="crop-stage"
                    className={cn(
                      "group relative h-[320px] touch-none select-none overflow-hidden rounded-xl bg-rail",
                      "focus-visible:outline-none",
                      cropping ? (dragging ? "cursor-grabbing" : "cursor-grab") : "cursor-default",
                    )}
                  >
                    {phase.kind === "loading" || !ready || !transform ? (
                      <div
                        role="status"
                        aria-label={t("desktop:imageEditor.loading")}
                        className="absolute inset-0 grid place-items-center"
                      >
                        <Skeleton
                          shape={kind === "avatar" ? "circle" : "rect"}
                          width={mask.width || undefined}
                          height={mask.height || undefined}
                          className={kind === "banner" ? "rounded-lg" : undefined}
                        />
                      </div>
                    ) : mode === "keep" ? (
                      <img
                        src={ready.img.src}
                        alt=""
                        draggable={false}
                        className="pointer-events-none absolute select-none rounded-lg object-cover"
                        style={{ left: mask.left, top: mask.top, width: mask.width, height: mask.height }}
                      />
                    ) : (
                      <img
                        src={ready.img.src}
                        alt=""
                        draggable={false}
                        data-testid="crop-image"
                        className="pointer-events-none absolute left-0 top-0 max-w-none select-none"
                        style={{
                          width: ready.natural.width,
                          height: ready.natural.height,
                          transformOrigin: "0 0",
                          transform: `translate3d(${mask.left + transform.x}px, ${mask.top + transform.y}px, 0) scale(${transform.scale})`,
                          transition: TRAVEL_STYLE[travel],
                          willChange: "transform",
                        }}
                      />
                    )}
                    {/* Scrim with the mask cut out: one element, a 9999px spread
                        shadow in the scrim token. The outline lifts to coral while
                        the stage has keyboard focus or is being dragged. */}
                    {measured && phase.kind === "ready" && (
                      <div
                        aria-hidden
                        data-testid="crop-mask"
                        className={cn(
                          "pointer-events-none absolute shadow-[0_0_0_9999px_var(--color-scrim)]",
                          "outline outline-2 -outline-offset-1 transition-[outline-color] motion-hover",
                          kind === "avatar" ? "rounded-full" : "rounded-lg",
                          dragging
                            ? "outline-accent"
                            : "outline-stroke-strong group-focus-visible:outline-accent",
                        )}
                        style={{ left: mask.left, top: mask.top, width: mask.width, height: mask.height }}
                      />
                    )}
                  </div>

                  {/* Controls: zoom (− slider +) and Reset. */}
                  <div className="flex items-center gap-2">
                    <IconButton
                      variant="ghost"
                      size="sm"
                      label={t("desktop:imageEditor.zoomOut")}
                      disabled={!cropping || crop.zoom <= MIN_ZOOM}
                      onClick={() => zoomBy(1 / ZOOM_FACTOR)}
                    >
                      <Minus />
                    </IconButton>
                    <Slider
                      className="flex-1"
                      min={MIN_ZOOM}
                      max={MAX_ZOOM}
                      step={0.01}
                      value={crop.zoom}
                      disabled={!cropping}
                      aria-label={t("desktop:imageEditor.zoom")}
                      formatValue={(value) => percent.format(value)}
                      onValueChange={(value) =>
                        update((s, image, area) => zoomCrop(s, value, image, area), "none")
                      }
                    />
                    <IconButton
                      variant="ghost"
                      size="sm"
                      label={t("desktop:imageEditor.zoomIn")}
                      disabled={!cropping || crop.zoom >= MAX_ZOOM}
                      onClick={() => zoomBy(ZOOM_FACTOR)}
                    >
                      <Plus />
                    </IconButton>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!cropping || atInitial}
                      onClick={reset}
                    >
                      <RotateCcw className="size-3.5" aria-hidden />
                      {t("desktop:imageEditor.reset")}
                    </Button>
                  </div>
                  <p id={helpId} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-fg-faint">
                    <span className="sr-only">{t("desktop:imageEditor.stageHelp")}</span>
                    <span aria-hidden className="inline-flex items-center gap-1">
                      <Move className="size-3" />
                      <Kbd>←</Kbd>
                      <Kbd>→</Kbd>
                      <Kbd>↑</Kbd>
                      <Kbd>↓</Kbd>
                      {t("desktop:imageEditor.hintMove")}
                    </span>
                    <span aria-hidden className="inline-flex items-center gap-1">
                      <Kbd>+</Kbd>
                      <Kbd>−</Kbd>
                      {t("desktop:imageEditor.hintZoom")}
                    </span>
                    <span aria-hidden className="inline-flex items-center gap-1">
                      <Kbd>0</Kbd>
                      {t("desktop:imageEditor.hintReset")}
                    </span>
                  </p>
                  {applyProblem && (
                    <p role="alert" className="text-label text-danger">
                      {t(PROBLEM_KEY[applyProblem])}
                    </p>
                  )}
                </>
              )}
            </div>

            {/* ── Preview column ─────────────────────────────────────────── */}
            <section aria-label={t("desktop:imageEditor.previewHeading")} className="min-w-0 space-y-3">
              <p className="text-2xs font-semibold uppercase tracking-wider text-fg-faint">
                {t("desktop:imageEditor.previewCard")}
              </p>
              <ProfileIdentityPreview
                name={identity.name}
                username={identity.username}
                seed={identity.seed}
                avatarUrl={avatarPreview}
                bannerUrl={bannerPreview}
              />
              <p className="pt-1 text-2xs font-semibold uppercase tracking-wider text-fg-faint">
                {t("desktop:imageEditor.previewMessage")}
              </p>
              <MessageRowPreview name={identity.name} seed={identity.seed} avatarUrl={avatarPreview} />
              {kind === "avatar" && (
                <div
                  className="flex items-end gap-3 rounded-xl bg-app px-3 py-3"
                  style={{ "--avatar-ring": "var(--color-app)" } as CSSProperties}
                >
                  {(["xs", "sm", "md", "lg"] as const).map((size) => (
                    <UserAvatar
                      key={size}
                      name={identity.name}
                      colorSeed={identity.seed}
                      src={avatarPreview}
                      size={size}
                    />
                  ))}
                </div>
              )}
            </section>
          </div>
        </DialogBody>

        <DialogFooter className="items-center">
          {phase.kind === "ready" && (
            <Button variant="ghost" className="mr-auto" onClick={chooseAnother} disabled={applying}>
              <ImagePlus className="size-4" aria-hidden />
              {t("desktop:imageEditor.chooseAnother")}
            </Button>
          )}
          <Button variant="secondary" onClick={close} disabled={applying}>
            {t("buttons.cancel")}
          </Button>
          <Button
            variant="primary"
            loading={applying}
            disabled={phase.kind !== "ready" || !measured}
            onClick={() => void apply()}
          >
            {t("desktop:imageEditor.apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One choice of the animated-banner pair (keep moving / crop as a still). */
function ModeOption({
  checked,
  disabled = false,
  onSelect,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onSelect: () => void;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "cursor-pointer rounded-pill px-3 py-1.5 text-label font-medium transition-colors motion-hover",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        "disabled:pointer-events-none disabled:opacity-40",
        checked ? "bg-accent-surface text-accent-hover" : "bg-raised text-fg-muted hover:bg-raised-hover hover:text-fg",
      )}
    >
      {label}
    </button>
  );
}

/**
 * The header of a message row as the chat draws it (MessageRow: 40px avatar,
 * 14px semibold name, 11px meta) with a sample line under it — the second place
 * people will see the new avatar.
 */
function MessageRowPreview({
  name,
  seed,
  avatarUrl,
}: {
  name: string;
  seed: string;
  avatarUrl: string | null | undefined;
}): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <div
      className="flex space-x-3 rounded-xl bg-app px-3 py-2.5"
      style={{ "--avatar-ring": "var(--color-app)" } as CSSProperties}
    >
      <UserAvatar name={name} colorSeed={seed} src={avatarUrl} size="md" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline">
          <span className="truncate text-sm font-semibold text-fg">{name}</span>
          <span className="ml-2 shrink-0 text-2xs text-fg-faint">{t("desktop:imageEditor.previewTime")}</span>
        </div>
        <p className="text-sm text-fg">{t("desktop:imageEditor.previewSample")}</p>
      </div>
    </div>
  );
}
