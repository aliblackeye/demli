/**
 * Main-process handler for HEIC/HEIF → JPEG conversion.
 *
 * Uses Electron's `nativeImage.createFromBuffer` which delegates to the OS
 * image codec (Windows HEIF Image Extensions / macOS CoreImage). If the codec
 * is not installed or the bytes are not a valid image, `nativeImage` returns an
 * empty image (isEmpty() === true) — no crash, no exception.
 *
 * The 20 MB cap mirrors the crop editor's CROP_INPUT_MAX_BYTES.
 */

import { ipcMain, nativeImage } from "electron";
import { IMAGE_CONVERT_CHANNELS, type HeicToJpegResult } from "./image-convert-types";

const MAX_INPUT_BYTES = 20 * 1024 * 1024;
const JPEG_QUALITY = 92;

export function registerImageConvert(): void {
  ipcMain.handle(
    IMAGE_CONVERT_CHANNELS.heicToJpeg,
    async (_event, rawBytes: unknown): Promise<HeicToJpegResult> => {
      if (
        !(rawBytes instanceof ArrayBuffer) &&
        !(rawBytes instanceof Uint8Array) &&
        !ArrayBuffer.isView(rawBytes)
      ) {
        return { status: "error", reason: "decode_failed" };
      }

      const bytes = rawBytes instanceof Uint8Array
        ? rawBytes
        : new Uint8Array(
            rawBytes instanceof ArrayBuffer
              ? rawBytes
              : rawBytes.buffer,
          );

      if (bytes.length > MAX_INPUT_BYTES) {
        return { status: "error", reason: "too_large" };
      }

      try {
        const img = nativeImage.createFromBuffer(Buffer.from(bytes));
        if (img.isEmpty()) {
          return { status: "error", reason: "unsupported" };
        }
        const jpegBuffer = img.toJPEG(JPEG_QUALITY);
        return {
          status: "converted",
          jpegBytes: new Uint8Array(jpegBuffer),
        };
      } catch {
        return { status: "error", reason: "decode_failed" };
      }
    },
  );
}
