/**
 * Native image pipeline for uploads (ADR 0008 §5, security review §28) — the
 * mobile counterpart of the desktop's canvas pipeline. React Native has no
 * canvas, so re-encoding goes through expo-image-manipulator instead:
 *
 * - EXIF STRIP: every re-encodable image (png/jpeg/webp) is decoded and
 *   re-rendered natively; the saved result is a freshly encoded bitmap that
 *   carries NO source metadata — including GPS geotags. The manipulator bakes
 *   the EXIF orientation into the pixels on load, so dropping the rotation
 *   flag cannot sideways-flip the photo.
 * - DOWNSCALE: images longer than MAX_IMAGE_EDGE_PX (or over the byte cap) are
 *   scaled down, iteratively if needed, until they fit the cap.
 * - GIFs pass through untouched (a re-encode would freeze the animation); an
 *   over-cap GIF was already rejected by validation.
 * - WebP input is re-encoded to JPEG: `SaveFormat.WEBP` is not reliably
 *   writable on iOS, and a cross-platform pipeline must not fork per OS.
 */

import { File } from "expo-file-system";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { AttachmentPipelineError } from "./errors";
import {
  MAX_IMAGE_EDGE_PX,
  MIN_IMAGE_EDGE_PX,
  isReencodableImageMime,
  maxBytesForKind,
  scaleToFitEdge,
} from "./validate";

export interface ProcessedImage {
  /** Local file URI of the upload-ready bytes. */
  uri: string;
  mime: string;
  width: number | null;
  height: number | null;
  sizeBytes: number;
}

/** JPEG re-encode quality — visually transparent, meaningfully smaller. */
const REENCODE_QUALITY = 0.88;

/** Output format+MIME for a re-encodable input MIME. */
function saveTargetFor(mime: string): { format: SaveFormat; mime: string } {
  if (mime === "image/png") return { format: SaveFormat.PNG, mime: "image/png" };
  // jpeg and webp both save as JPEG (see module doc).
  return { format: SaveFormat.JPEG, mime: "image/jpeg" };
}

/** Size in bytes of a local file (0 when unreadable — caller treats as error). */
export function localFileSize(uri: string): number {
  try {
    return new File(uri).size;
  } catch {
    return 0;
  }
}

/**
 * Re-render `uri` at the given target width (aspect preserved by the
 * manipulator) and save it as `format`. Returns the new local file.
 */
async function reencode(
  uri: string,
  targetWidth: number | null,
  format: SaveFormat,
): Promise<{ uri: string; width: number; height: number }> {
  const context = ImageManipulator.manipulate(uri);
  if (targetWidth !== null) context.resize({ width: targetWidth });
  const image = await context.renderAsync();
  const result = await image.saveAsync({ compress: REENCODE_QUALITY, format });
  return { uri: result.uri, width: result.width, height: result.height };
}

/**
 * Prepare a picked image for upload. Re-encodable images are always re-encoded
 * (EXIF strip is unconditional — privacy first), downscaling as needed until
 * the result fits the byte cap. GIFs are returned byte-identical.
 *
 * `width`/`height` are the picker-reported dimensions (may be 0/undefined —
 * the first render pass fills them in).
 *
 * Throws a user-friendly Error when the image cannot be read or cannot be
 * brought under the cap.
 */
export async function processImageAsset(input: {
  uri: string;
  mime: string;
  width?: number | null;
  height?: number | null;
}): Promise<ProcessedImage> {
  if (!isReencodableImageMime(input.mime)) {
    // GIF (or any future pass-through image): measure only.
    const sizeBytes = localFileSize(input.uri);
    if (sizeBytes <= 0) {
      throw new AttachmentPipelineError({ key: "mobile:attachments.imageUnreadable" });
    }
    return {
      uri: input.uri,
      mime: input.mime,
      width: input.width || null,
      height: input.height || null,
      sizeBytes,
    };
  }

  const cap = maxBytesForKind("image");
  const target = saveTargetFor(input.mime);

  // First pass: cap the longest edge when the picker told us the dimensions;
  // otherwise render as-is and learn them from the result.
  let targetWidth: number | null = null;
  if (input.width && input.height) {
    const fitted = scaleToFitEdge(input.width, input.height, MAX_IMAGE_EDGE_PX);
    if (fitted.width !== Math.round(input.width)) targetWidth = fitted.width;
  }

  let result: { uri: string; width: number; height: number };
  try {
    result = await reencode(input.uri, targetWidth, target.format);
  } catch {
    throw new AttachmentPipelineError({ key: "mobile:attachments.imageUnreadable" });
  }

  // Shrink by steps until the bytes fit the cap (mirrors the desktop loop).
  for (;;) {
    // Oversized natural dimensions the picker did not report: clamp now.
    if (Math.max(result.width, result.height) > MAX_IMAGE_EDGE_PX) {
      const fitted = scaleToFitEdge(result.width, result.height, MAX_IMAGE_EDGE_PX);
      result = await reencode(result.uri, fitted.width, target.format);
      continue;
    }
    const sizeBytes = localFileSize(result.uri);
    if (sizeBytes <= 0) {
      throw new AttachmentPipelineError({ key: "mobile:attachments.imageUnreadable" });
    }
    if (sizeBytes <= cap) {
      return {
        uri: result.uri,
        mime: target.mime,
        width: result.width,
        height: result.height,
        sizeBytes,
      };
    }
    const next = scaleToFitEdge(
      result.width,
      result.height,
      Math.floor(Math.max(result.width, result.height) * 0.7),
    );
    if (Math.max(next.width, next.height) < MIN_IMAGE_EDGE_PX) {
      throw new AttachmentPipelineError({ key: "mobile:attachments.imageTooLarge" });
    }
    result = await reencode(result.uri, next.width, target.format);
  }
}
