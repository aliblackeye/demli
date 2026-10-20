/**
 * IPC contract for image format conversion (HEIC/HEIF → JPEG).
 *
 * The renderer has no native codec for HEIC; Chromium may crash when it touches
 * the raw bytes (Windows shell thumbnail + GPU codec). The main process can
 * decode HEIC through Electron's `nativeImage` (which delegates to the OS codec
 * — Windows HEIF Image Extensions, macOS CoreImage) and re-encode as JPEG.
 *
 * Security posture: the renderer sends raw bytes (ArrayBuffer), main decodes
 * them in isolation, and returns JPEG bytes. No filesystem path crosses the
 * boundary, no URL is followed, and the payload is capped.
 */

export const IMAGE_CONVERT_CHANNELS = {
  heicToJpeg: "demli:images:heic-to-jpeg",
} as const;

export type ImageConvertChannel =
  (typeof IMAGE_CONVERT_CHANNELS)[keyof typeof IMAGE_CONVERT_CHANNELS];

export type HeicToJpegResult =
  | { status: "converted"; jpegBytes: Uint8Array }
  | { status: "error"; reason: "unsupported" | "decode_failed" | "too_large" };

export interface ImageConvertBridge {
  heicToJpeg(heicBytes: Uint8Array): Promise<HeicToJpegResult>;
}
