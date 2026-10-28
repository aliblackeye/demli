import { useCallback, useEffect, useRef, useState } from "react";
import { ImageOff, Pause, Play, RotateCw } from "lucide-react";
import { Skeleton, cn } from "@demli/ui";
import { ActionMenu } from "@demli/app-ui";
import type { Attachment } from "@demli/types";
import { invalidateAttachmentUrl, useAttachmentUrl } from "../lib/attachment-urls";
import { useAppTranslation } from "../lib/i18n";
import { useInView } from "../hooks/useInView";
import { imageActionTarget, type ImageActionTarget } from "../lib/image-actions";
import { hasImageActions, ImageActionItems } from "./ImageActionItems";
import { useImageReveal } from "./useImageReveal";

const ALT_KEY = {
  image: "desktop:attachments.altImage",
  video: "desktop:attachments.altVideo",
  audio: "desktop:attachments.altAudio",
} as const satisfies Record<Attachment["kind"], string>;

/** Visual caps so one attachment never dominates the chat column. */
const MAX_WIDTH = 400;
const MAX_HEIGHT = 340;
/** Reserved box when an image/video has no known dimensions. */
const FALLBACK = { width: 280, height: 200 };
const AUDIO_WIDTH = 360;
const AUDIO_HEIGHT = 54;

/**
 * Reserve the on-screen box from METADATA (before any URL/bytes load) so the
 * virtualized list never reflows when the media later paints (CLAUDE.md §27).
 * Never upscales past the intrinsic size.
 */
export function displayBox(attachment: Attachment): { width: number; height: number } {
  if (attachment.kind === "audio") return { width: AUDIO_WIDTH, height: AUDIO_HEIGHT };
  const { width, height } = attachment;
  if (!width || !height) return FALLBACK;
  const scale = Math.min(MAX_WIDTH / width, MAX_HEIGHT / height, 1);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

/** What a tile reports up once its picture is on screen — the gallery entry. */
export interface ResolvedImage {
  url: string;
  alt: string;
  actions: ImageActionTarget | null;
}

export interface AttachmentTileProps {
  channelId: string;
  attachment: Attachment;
  /**
   * Optimistic local object URL (an outbox message rendering its own just-picked
   * bytes). When present, the signed-URL fetch is skipped entirely.
   */
  localUrl?: string;
  /** Open the viewer on THIS tile's picture. */
  onOpenImage?: (attachmentId: string, image: ResolvedImage) => void;
  /** Report this picture's resolved URL (the viewer's gallery is built from these). */
  onImageReady?: (attachmentId: string, image: ResolvedImage) => void;
  /**
   * A fixed cell size (the multi-image grid). Overrides the metadata box and
   * crops the picture to fill it (`object-cover`); a single tile keeps its own
   * aspect-ratio box. Either way the size is known before any byte loads.
   */
  box?: { width: number; height: number };
}

export function AttachmentTile({
  channelId,
  attachment,
  localUrl,
  onOpenImage,
  onImageReady,
  box: boxOverride,
}: AttachmentTileProps): JSX.Element {
  const { t } = useAppTranslation();
  const { ref, inView } = useInView<HTMLDivElement>();
  const { status, url, retry } = useAttachmentUrl(
    channelId,
    attachment.id,
    inView && !localUrl,
  );

  const resolvedUrl = localUrl ?? (status === "ready" ? url : undefined);
  const box = boxOverride ?? displayBox(attachment);

  /**
   * The URL resolved but its BYTES failed (expired signature, 403/404, network
   * drop mid-load). Without this the picture would sit at opacity 0 under a
   * pulse that never stops. Tracked per URL, so a fresh re-signed URL clears it.
   */
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  /** Bumped on retry so the media element remounts and re-requests its bytes. */
  const [attempt, setAttempt] = useState(0);
  const bytesFailed = resolvedUrl !== undefined && failedUrl === resolvedUrl;
  const markFailed = useCallback(() => {
    if (resolvedUrl) setFailedUrl(resolvedUrl);
  }, [resolvedUrl]);
  const retryBytes = useCallback(() => {
    if (!localUrl) {
      // Same cached URL would fail the same way: drop it and re-sign.
      invalidateAttachmentUrl(attachment.id);
      retry();
    }
    setFailedUrl(null);
    setAttempt((n) => n + 1);
  }, [localUrl, attachment.id, retry]);
  const alt = t(ALT_KEY[attachment.kind]);

  /**
   * Save/copy target for this tile, or null when the actions do not apply.
   *
   * `localUrl` is deliberately excluded: an optimistic (still-sending) tile
   * renders its own bytes from a `blob:` object URL, which the main process
   * cannot fetch and the allow-list would refuse anyway. That window lasts a
   * second or two; offering a menu that must fail would be worse than not
   * offering one (CLAUDE.md §35).
   */
  const actionTarget =
    attachment.kind === "image" && !localUrl && resolvedUrl && hasImageActions()
      ? imageActionTarget(attachment, resolvedUrl)
      : null;

  useEffect(() => {
    if (attachment.kind === "image" && resolvedUrl && !bytesFailed) {
      onImageReady?.(attachment.id, { url: resolvedUrl, alt, actions: actionTarget });
    }
    // `actionTarget` is derived from the same inputs; listing the URL is enough.
  }, [attachment.id, attachment.kind, resolvedUrl, bytesFailed, alt, onImageReady]);

  // Voice messages render as a compact bubble with play/pause and progress.
  if (attachment.kind === "audio" && attachment.isVoiceMessage) {
    return (
      <div ref={ref}>
        {bytesFailed ? (
          <div
            className="flex items-center rounded-xl bg-wash px-3"
            style={{ width: AUDIO_WIDTH, height: AUDIO_HEIGHT }}
          >
            <TileError onRetry={retryBytes} compact />
          </div>
        ) : resolvedUrl ? (
          <VoiceMessageBubble key={attempt} url={resolvedUrl} durationMs={attachment.durationMs} onError={markFailed} />
        ) : status === "error" && !localUrl ? (
          <div
            className="flex items-center rounded-xl bg-wash px-3"
            style={{ width: AUDIO_WIDTH, height: AUDIO_HEIGHT }}
          >
            <TileError onRetry={retry} compact />
          </div>
        ) : (
          <div
            className="flex items-center rounded-xl bg-wash px-3"
            style={{ width: AUDIO_WIDTH, height: AUDIO_HEIGHT }}
          >
            <div role="status" aria-label={t("desktop:attachments.loading")} className="w-full">
              <Skeleton shape="line" height={8} />
            </div>
          </div>
        )}
      </div>
    );
  }

  // Audio renders as a compact player rather than a media box.
  if (attachment.kind === "audio") {
    return (
      <div
        ref={ref}
        className="flex items-center rounded-xl bg-wash px-3"
        style={{ width: box.width, height: box.height }}
      >
        {bytesFailed ? (
          <TileError onRetry={retryBytes} compact />
        ) : resolvedUrl ? (
          <audio
            key={attempt}
            src={resolvedUrl}
            controls
            preload="none"
            onError={markFailed}
            className="h-9 w-full"
          />
        ) : status === "error" && !localUrl ? (
          <TileError onRetry={retry} compact />
        ) : (
          <div role="status" aria-label={t("desktop:attachments.loading")} className="w-full">
            <Skeleton shape="line" height={8} />
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      // Wash, not a surface tone: visible behind a loading/failed tile on the
      // row at rest AND hovered (the hovered row IS the surface tone).
      className="relative overflow-hidden rounded-xl bg-wash"
      style={{ width: box.width, height: box.height }}
    >
      {bytesFailed ? (
        <TileError onRetry={retryBytes} />
      ) : resolvedUrl ? (
        attachment.kind === "video" ? (
          <video
            key={attempt}
            src={resolvedUrl}
            onError={markFailed}
            controls
            preload="metadata"
            className={cn("size-full bg-rail", boxOverride ? "object-cover" : "object-contain")}
          />
        ) : (
          <ImageSurface
            key={attempt}
            url={resolvedUrl}
            onError={markFailed}
            alt={alt}
            actionTarget={actionTarget}
            onOpen={() => onOpenImage?.(attachment.id, { url: resolvedUrl, alt, actions: actionTarget })}
          />
        )
      ) : status === "error" && !localUrl ? (
        <TileError onRetry={retry} />
      ) : (
        <div
          role="status"
          aria-label={t("desktop:attachments.loading")}
          className="size-full animate-pulse bg-wash"
        />
      )}
    </div>
  );
}

/**
 * The clickable image itself, wrapped in the shared {@link ActionMenu} when the
 * save/copy actions apply. ActionMenu gives right-click on a mouse AND a
 * ~480 ms long-press on touch, so the narrow/web surface reaches the same menu.
 * With no target (optimistic tile, or a surface with no bridge) the plain button
 * is rendered unchanged — no wrapper, no behaviour change.
 *
 * The picture fades in once decoded over the pulsing placeholder — EXCEPT when
 * it is already decoded at mount (a cached image in a row the virtualized list
 * just re-mounted): that one is shown at once, so scrolling never replays a fade.
 */
function ImageSurface({
  url,
  alt,
  actionTarget,
  onOpen,
  onError,
}: {
  url: string;
  alt: string;
  actionTarget: ImageActionTarget | null;
  onOpen: () => void;
  /** The bytes failed — the tile swaps this surface for its error state. */
  onError: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const reveal = useImageReveal();
  const loaded = reveal.loaded;
  const { onError: revealError } = reveal;
  const handleError = useCallback(() => {
    revealError();
    onError();
  }, [revealError, onError]);

  const button = (
    <button
      type="button"
      onClick={onOpen}
      className="group/img relative size-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
      aria-label={t("desktop:attachments.openImage")}
    >
      {!loaded && <span aria-hidden className="absolute inset-0 animate-pulse bg-wash" />}
      <img
        ref={reveal.ref}
        src={url}
        alt={alt}
        loading="lazy"
        onLoad={reveal.onLoad}
        onError={handleError}
        className={cn(
          // The box is reserved from metadata at the picture's own aspect (single
          // tile) or is a fixed grid cell, so cover crops a single image only
          // when it has no recorded size (the fallback box).
          "size-full object-cover",
          reveal.animate && "transition-opacity motion-standard",
          loaded ? "opacity-100" : "opacity-0",
        )}
      />
      {/* Hover = a faint lift of the picture, tone only (no zoom, no motion). */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-fg-display/0 transition-colors motion-hover group-hover/img:bg-fg-display/[0.04]"
      />
    </button>
  );

  if (!actionTarget) return button;

  return (
    <ActionMenu contentClassName="w-52" menu={<ImageActionItems target={actionTarget} />}>
      {button}
    </ActionMenu>
  );
}

function formatVoiceDuration(ms: number | null): string {
  const totalSec = Math.max(0, Math.round((ms ?? 0) / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function VoiceMessageBubble({
  url,
  durationMs,
  onError,
}: {
  url: string;
  durationMs: number | null;
  onError: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(durationMs ? durationMs / 1000 : 0);

  const toggle = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (playing) {
      el.pause();
    } else {
      el.play();
    }
  }, [playing]);

  const seek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current;
    if (!el || !el.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    el.currentTime = ratio * el.duration;
  }, []);

  const displayDuration = playing || currentTime > 0
    ? formatVoiceDuration(currentTime * 1000)
    : formatVoiceDuration(durationMs);

  return (
    <div className="flex max-w-[280px] items-center gap-2.5 rounded-2xl bg-accent/10 px-3 py-2">
      <audio
        ref={audioRef}
        src={url}
        preload="metadata"
        onError={onError}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          setPlaying(false);
          setProgress(0);
          setCurrentTime(0);
        }}
        onLoadedMetadata={() => {
          const el = audioRef.current;
          if (el && el.duration && isFinite(el.duration)) setDuration(el.duration);
        }}
        onTimeUpdate={() => {
          const el = audioRef.current;
          if (!el || !el.duration) return;
          setProgress(el.currentTime / el.duration);
          setCurrentTime(el.currentTime);
        }}
      />
      <button
        type="button"
        onClick={toggle}
        aria-label={playing ? "Pause" : "Play"}
        className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-accent text-bg transition-colors hover:bg-accent-hover"
      >
        {playing ? <Pause className="size-4" /> : <Play className="size-4 ml-0.5" />}
      </button>
      <div className="min-w-0 flex-1">
        {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
        <div
          className="h-1.5 cursor-pointer rounded-full bg-accent/20"
          onClick={seek}
        >
          <div
            className="h-full rounded-full bg-accent transition-[width] duration-100"
            style={{ width: `${progress * 100}%` }}
          />
        </div>
        <p className="mt-1 text-2xs tabular-nums text-fg-muted">{displayDuration}</p>
      </div>
    </div>
  );
}

function TileError({ onRetry, compact = false }: { onRetry: () => void; compact?: boolean }): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <div
      role="alert"
      className={cn(
        "flex size-full items-center justify-center text-center",
        compact ? "flex-row gap-2" : "flex-col gap-2 p-3",
      )}
    >
      <ImageOff className="size-5 shrink-0 text-fg-faint" aria-hidden />
      <p className="text-xs text-fg-muted">{t("desktop:attachments.loadFailed")}</p>
      <button
        type="button"
        onClick={onRetry}
        className={cn(
          "inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md bg-raised px-2.5 text-xs font-medium text-fg",
          "transition-colors motion-hover hover:bg-raised-hover active:bg-raised-pressed",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
        )}
      >
        <RotateCw className="size-3.5" aria-hidden />
        {t("desktop:chat.retry")}
      </button>
    </div>
  );
}
