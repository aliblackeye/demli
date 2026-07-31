/**
 * The ONE floating overlay on the video stage — draggable, corner-snapping, and
 * small enough not to block what is behind it.
 *
 * It has TWO subjects and only ever one box (founder: "iki ayrı sürüklenebilir
 * kutu yapma"):
 *
 *  1. SELF-VIEW (the default, K4). While a tile is focused/fullscreen your own
 *     tile is off the stage, so this is where you watch yourself: bottom-right by
 *     default, draggable, corner preference remembered.
 *     When the camera is OFF it does NOT disappear — it becomes an explicit
 *     "camera off" rectangle with your avatar. That is the founder's literal
 *     requirement ("kameram açık değilse de kamera gözükmediği haliyle bir
 *     dikdörtgen belirsin ki kameramın açık olmadığını anlayayım"), and it is the
 *     honest design too: a missing overlay is indistinguishable from a broken
 *     one, so the state has to be shown rather than implied by absence (§35).
 *
 *  2. A PINNED CAMERA. While watching a broadcast the user can pin one specific
 *     camera here from the camera panel; the overlay switches subject, keeping
 *     the same position, drag layer and toggle.
 *
 * It REUSES CameraTile / LocalCameraTile for the actual <video> — so the shown
 * camera is attached exactly once (VideoStage excludes its tile from the
 * filmstrip while it is up) and we never create a duplicate LiveKit subscription
 * or a second getUserMedia stream.
 *
 * Position is stored as a fraction of free travel (0..1) in the video-stage-store
 * so it survives window/stage resizes. During a drag we render from live pixels
 * for smoothness and only commit to the store on release (snapped to the nearest
 * corner) — one store write per drag, not per frame (CLAUDE.md §27).
 */

import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { VideoOff, X } from "lucide-react";
import { Button, UserAvatar, cn } from "@demli/ui";
import type { CameraSource } from "@demli/media";
import { useAppTranslation } from "../lib/i18n";
import { useElementSize, type Size } from "../hooks/useElementSize";
import { useAuthStore } from "../stores/auth-store";
import { CameraTile } from "./CameraTile";
import { LocalCameraTile } from "./LocalCameraTile";

const MARGIN = 12;
const clamp = (n: number, min: number, max: number): number =>
  n < min ? min : n > max ? max : n;

export interface CameraPipProps {
  /**
   * The camera to render, or `null` for the self-view with the camera OFF (which
   * renders the explicit "camera off" placeholder rather than nothing).
   */
  source: CameraSource | null;
  /** True when the subject is YOU — drives the placeholder and the label. */
  self: boolean;
  /** Measured size of the stage container the overlay is clamped within. */
  containerSize: Size;
  /** Position as a fraction of free travel (0 = top/left, 1 = bottom/right). */
  x: number;
  y: number;
  /** Commit a new position (already snapped to a corner). */
  onMove: (x: number, y: number) => void;
  /** Turn the overlay off. */
  onClose: () => void;
}

/**
 * The camera-off self-view: a real rectangle that STATES the camera is off.
 * Identity-first (avatar + name) so it reads as "you", with the crossed-camera
 * glyph and caption carrying the state.
 */
function SelfViewCameraOff(): JSX.Element {
  const { t } = useAppTranslation();
  const me = useAuthStore((s) => s.user);
  const name = me?.displayName ?? t("desktop:voice.you");
  return (
    <div
      data-testid="self-view-camera-off"
      className={cn(
        "flex h-full w-full flex-col items-center justify-center gap-1.5",
        "rounded-lg border border-stroke-strong bg-rail",
        // Same warm identity ramp as a camera-off participant tile, dimmed for a
        // 220px box so the caption stays the loudest thing in it.
        "bg-[radial-gradient(120%_95%_at_30%_12%,rgba(245,84,22,0.10)_0%,rgba(12,4,3,0.9)_60%,var(--color-rail)_100%)]",
      )}
    >
      <UserAvatar name={name} colorSeed={me?.id ?? name} src={me?.avatarUrl ?? null} size="md" />
      <div className="flex items-center gap-1 px-2">
        <VideoOff className="size-3 shrink-0 text-fg-muted" />
        <span className="truncate text-[11px] font-medium text-fg-muted">
          {t("desktop:stage.selfViewCameraOff")}
        </span>
      </div>
    </div>
  );
}

export function CameraPip({
  source,
  self,
  containerSize,
  x,
  y,
  onMove,
  onClose,
}: CameraPipProps): JSX.Element {
  const { t } = useAppTranslation();
  const { ref: sizeRef, size: pipSize } = useElementSize<HTMLDivElement>();
  // Live pixel position while dragging (null when idle → position from x/y props).
  const [live, setLive] = useState<{ left: number; top: number } | null>(null);
  const drag = useRef<{ startX: number; startY: number; startLeft: number; startTop: number } | null>(
    null,
  );

  const pipW = pipSize.width || 220;
  const pipH = pipSize.height || 124;
  const freeW = Math.max(containerSize.width - pipW - MARGIN * 2, 0);
  const freeH = Math.max(containerSize.height - pipH - MARGIN * 2, 0);

  // Resting position derived from the stored fractions; overridden by `live`
  // mid-drag for frame-perfect tracking.
  const restLeft = MARGIN + x * freeW;
  const restTop = MARGIN + y * freeH;
  const left = live ? live.left : restLeft;
  const top = live ? live.top : restTop;

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>): void => {
    // Ignore drags that start on the close button.
    if ((e.target as HTMLElement).closest("[data-pip-close]")) return;
    e.preventDefault();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startY: e.clientY, startLeft: left, startTop: top };
    setLive({ left, top });
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d) return;
    const nextLeft = clamp(d.startLeft + (e.clientX - d.startX), MARGIN, MARGIN + freeW);
    const nextTop = clamp(d.startTop + (e.clientY - d.startY), MARGIN, MARGIN + freeH);
    setLive({ left: nextLeft, top: nextTop });
  };

  const endDrag = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    const el = e.currentTarget as HTMLElement;
    if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    // Snap to the nearest corner: round the current fraction to 0 or 1.
    const fx = freeW > 0 ? clamp((left - MARGIN) / freeW, 0, 1) : 0;
    const fy = freeH > 0 ? clamp((top - MARGIN) / freeH, 0, 1) : 0;
    setLive(null);
    onMove(Math.round(fx), Math.round(fy));
  };

  const tile =
    source === null ? (
      <SelfViewCameraOff />
    ) : source.kind === "camera-local" ? (
      <LocalCameraTile deviceId={source.deviceId} className="h-full w-full" />
    ) : (
      <CameraTile camera={source.camera} className="h-full w-full" />
    );

  return (
    <div
      ref={sizeRef}
      role="group"
      data-testid="stage-pip"
      data-pip-subject={self ? "self" : "camera"}
      aria-label={self ? t("desktop:stage.selfViewLabel") : t("desktop:stage.pipLabel")}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      style={{ left, top }}
      className={cn(
        // aspect-video gives the overlay a definite height (the camera tiles fill
        // it with h-full and no longer carry their own aspect ratio).
        "absolute z-20 aspect-video w-[220px] max-w-[45%] cursor-move touch-none select-none",
        "rounded-lg shadow-2xl ring-1 ring-black/60",
        live && "opacity-95",
      )}
    >
      {tile}
      <Button
        data-pip-close
        variant="secondary"
        size="icon-sm"
        aria-label={self ? t("desktop:stage.selfViewOff") : t("desktop:stage.pipOff")}
        onClick={onClose}
        className="absolute right-1 top-1 size-6 bg-black/60 text-white hover:bg-black/80"
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
