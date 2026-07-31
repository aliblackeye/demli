import { useState } from "react";
import type { Attachment, AttachmentId } from "@demli/types";
import type { ImageActionTarget } from "../lib/image-actions";
import { AttachmentTile } from "./AttachmentTile";
import { ImageLightbox } from "./ImageLightbox";

/**
 * Renders a message's attachments (0..N) as a wrapping row of aspect-ratio-
 * reserved tiles, plus the shared image lightbox. `localUrls` supplies object
 * URLs for an optimistic (still-sending) message so it shows its own bytes
 * without a signed-URL round trip.
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
  // `actions` is the save/copy payload for the OPEN image, carried over from the
  // tile that opened it so the lightbox never has to re-derive (or re-sign) it.
  const [lightbox, setLightbox] = useState<{
    url: string;
    alt: string;
    actions: ImageActionTarget | null;
  } | null>(null);

  if (attachments.length === 0) return null;

  return (
    <div className="mt-1.5 flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <AttachmentTile
          key={attachment.id}
          channelId={channelId}
          attachment={attachment}
          localUrl={localUrls?.[attachment.id]}
          onOpenImage={(url, alt, actions) => setLightbox({ url, alt, actions })}
        />
      ))}
      <ImageLightbox
        open={lightbox !== null}
        onOpenChange={(open) => {
          if (!open) setLightbox(null);
        }}
        url={lightbox?.url ?? null}
        alt={lightbox?.alt ?? ""}
        actions={lightbox?.actions ?? null}
      />
    </div>
  );
}
