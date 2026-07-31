import { AlertCircle, RotateCw } from "lucide-react";
import { cn } from "@demli/ui";
import { ActionMenu } from "@demli/app-ui";
import type { Attachment } from "@demli/types";
import { useAttachmentUrl } from "../lib/attachment-urls";
import { useAppTranslation } from "../lib/i18n";
import { useInView } from "../hooks/useInView";
import { imageActionTarget, type ImageActionTarget } from "../lib/image-actions";
import { hasImageActions, ImageActionItems } from "./ImageActionItems";

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
function displayBox(attachment: Attachment): { width: number; height: number } {
  if (attachment.kind === "audio") return { width: AUDIO_WIDTH, height: AUDIO_HEIGHT };
  const { width, height } = attachment;
  if (!width || !height) return FALLBACK;
  const scale = Math.min(MAX_WIDTH / width, MAX_HEIGHT / height, 1);
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

export interface AttachmentTileProps {
  channelId: string;
  attachment: Attachment;
  /**
   * Optimistic local object URL (an outbox message rendering its own just-picked
   * bytes). When present, the signed-URL fetch is skipped entirely.
   */
  localUrl?: string;
  onOpenImage?: (url: string, alt: string, actions: ImageActionTarget | null) => void;
}

export function AttachmentTile({
  channelId,
  attachment,
  localUrl,
  onOpenImage,
}: AttachmentTileProps): JSX.Element {
  const { t } = useAppTranslation();
  const { ref, inView } = useInView<HTMLDivElement>();
  const { status, url, retry } = useAttachmentUrl(
    channelId,
    attachment.id,
    inView && !localUrl,
  );

  const resolvedUrl = localUrl ?? (status === "ready" ? url : undefined);
  const box = displayBox(attachment);
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

  // Audio renders as a compact player rather than a media box.
  if (attachment.kind === "audio") {
    return (
      <div
        ref={ref}
        className="flex items-center rounded-lg border border-stroke bg-raised px-3"
        style={{ width: box.width, height: box.height }}
      >
        {resolvedUrl ? (
          <audio src={resolvedUrl} controls preload="none" className="h-9 w-full" />
        ) : status === "error" && !localUrl ? (
          <TileError onRetry={retry} />
        ) : (
          <div className="h-2 w-full animate-pulse rounded-full bg-base" />
        )}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className="relative overflow-hidden rounded-lg border border-stroke bg-base"
      style={{ width: box.width, height: box.height }}
    >
      {resolvedUrl ? (
        attachment.kind === "video" ? (
          <video
            src={resolvedUrl}
            controls
            preload="metadata"
            className="size-full bg-black object-contain"
          />
        ) : (
          <ImageSurface
            url={resolvedUrl}
            alt={alt}
            actionTarget={actionTarget}
            onOpen={() => onOpenImage?.(resolvedUrl, alt, actionTarget)}
          />
        )
      ) : status === "error" && !localUrl ? (
        <TileError onRetry={retry} />
      ) : (
        <div
          className="size-full animate-pulse bg-raised"
          aria-label={t("desktop:attachments.loading")}
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
 */
function ImageSurface({
  url,
  alt,
  actionTarget,
  onOpen,
}: {
  url: string;
  alt: string;
  actionTarget: ImageActionTarget | null;
  onOpen: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const button = (
    <button
      type="button"
      onClick={onOpen}
      className="size-full cursor-zoom-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70"
      aria-label={t("desktop:attachments.openImage")}
    >
      <img src={url} alt={alt} loading="lazy" className="size-full object-cover" />
    </button>
  );

  if (!actionTarget) return button;

  return (
    <ActionMenu contentClassName="w-52" menu={<ImageActionItems target={actionTarget} />}>
      {button}
    </ActionMenu>
  );
}

function TileError({ onRetry }: { onRetry: () => void }): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <div className="flex size-full flex-col items-center justify-center gap-2 p-3 text-center">
      <AlertCircle className="size-5 text-fg-faint" aria-hidden />
      <p className="text-xs text-fg-muted">{t("desktop:attachments.loadFailed")}</p>
      <button
        type="button"
        onClick={onRetry}
        className={cn(
          "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-accent",
          "hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        )}
      >
        <RotateCw className="size-3.5" />
        {t("desktop:chat.retry")}
      </button>
    </div>
  );
}
