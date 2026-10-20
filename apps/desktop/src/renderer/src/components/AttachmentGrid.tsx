import { useCallback, useRef, useState } from "react";
import type { Attachment, AttachmentId } from "@demli/types";
import { AttachmentTile, type ResolvedImage } from "./AttachmentTile";
import { ImageLightbox, type LightboxImage } from "./ImageLightbox";

/** Width budget of a multi-image grid — the same column a single tile is capped to. */
const GRID_WIDTH = 400;
/** Gutter between grid cells (px) — matches the `gap-1` below. */
const GRID_GAP = 4;

/**
 * Fixed cell size for `count` pictures laid out in a grid: two side by side for
 * 2 and 4, three across for everything else. Cells are square and their size is
 * known from the COUNT alone, so the row's height is final before any byte loads
 * — the virtualizer never reflows (CLAUDE.md §27).
 */
function gridCell(count: number): { columns: number; size: number } {
  const columns = count === 2 || count === 4 ? 2 : 3;
  const size = Math.floor((GRID_WIDTH - GRID_GAP * (columns - 1)) / columns);
  return { columns, size };
}

/**
 * Renders a message's attachments (0..N) plus the shared image viewer.
 *
 *   - one picture/video  → a single tile at its own aspect ratio (metadata box);
 *   - several            → an even grid of square cells (2 across for 2/4, else 3);
 *   - audio              → compact players stacked under the visuals.
 *
 * The viewer opens on the clicked picture and pages through every picture of
 * the message that has resolved, in order. `localUrls` supplies object URLs for
 * an optimistic (still-sending) message so it shows its own bytes without a
 * signed-URL round trip.
 */
export function AttachmentGrid({
  channelId,
  attachments,
  localUrls,
}: {
  channelId: string;
  attachments: Attachment[];
  localUrls?: Record<AttachmentId, string>;
}): JSX.Element | null {
  // Every picture reports its resolved URL here as soon as it has one, so the
  // viewer can page between them without re-signing anything. A ref, not state:
  // it is read only when the viewer opens.
  const resolvedRef = useRef(new Map<string, ResolvedImage>());
  const onImageReady = useCallback((attachmentId: string, image: ResolvedImage) => {
    resolvedRef.current.set(attachmentId, image);
  }, []);
  // The gallery outlives `open` so the viewer can play its exit fade with the
  // picture still in it.
  const [viewer, setViewer] = useState<{ images: LightboxImage[]; index: number } | null>(null);
  const [viewerOpen, setViewerOpen] = useState(false);

  if (attachments.length === 0) return null;

  const visual = attachments.filter((a) => a.kind !== "audio");
  const audio = attachments.filter((a) => a.kind === "audio");
  const cell = visual.length > 1 ? gridCell(visual.length) : null;

  const open = (attachmentId: string, image: ResolvedImage): void => {
    resolvedRef.current.set(attachmentId, image);
    // Gallery = this message's images that are on screen, in message order.
    const ordered: { id: string; image: ResolvedImage }[] = [];
    for (const attachment of visual) {
      if (attachment.kind !== "image") continue;
      const entry = resolvedRef.current.get(attachment.id);
      if (entry) ordered.push({ id: attachment.id, image: entry });
    }
    const index = Math.max(0, ordered.findIndex((entry) => entry.id === attachmentId));
    setViewer({ images: ordered.map((entry) => entry.image), index });
    setViewerOpen(true);
  };

  return (
    <div className="mt-1.5 flex flex-col gap-2">
      {visual.length > 0 && (
        <div
          className="flex flex-wrap gap-1"
          style={cell ? { width: cell.columns * cell.size + (cell.columns - 1) * GRID_GAP } : undefined}
        >
          {visual.map((attachment) => (
            <AttachmentTile
              key={attachment.id}
              channelId={channelId}
              attachment={attachment}
              localUrl={localUrls?.[attachment.id]}
              box={cell ? { width: cell.size, height: cell.size } : undefined}
              onOpenImage={open}
              onImageReady={onImageReady}
            />
          ))}
        </div>
      )}
      {audio.map((attachment) => (
        <AttachmentTile
          key={attachment.id}
          channelId={channelId}
          attachment={attachment}
          localUrl={localUrls?.[attachment.id]}
        />
      ))}
      <ImageLightbox
        open={viewerOpen && viewer !== null}
        onOpenChange={setViewerOpen}
        url={null}
        alt=""
        images={viewer?.images}
        startIndex={viewer?.index ?? 0}
      />
    </div>
  );
}
