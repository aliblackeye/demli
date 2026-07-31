/**
 * Native pickers → normalized PickedAsset[] (ADR 0008 §5).
 *
 * - Photos/videos: expo-image-picker (the OS photo picker — no storage
 *   permission needed on modern Android/iOS).
 * - Audio: expo-document-picker filtered to the whitelisted audio MIMEs.
 *
 * EXIF never leaves this layer: the picker is asked for no EXIF and image
 * bytes are re-encoded (metadata dropped) in image-processing.ts regardless.
 */

import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import type { PickedAsset } from "./manager";
import { AUDIO_MIMES } from "./validate";

/** Photos + videos from the system media library. */
export async function pickMediaAssets(selectionLimit: number): Promise<PickedAsset[]> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images", "videos"],
    allowsMultipleSelection: true,
    selectionLimit,
    quality: 1, // re-encode/downscale is ours (image-processing.ts)
    exif: false,
  });
  if (result.canceled) return [];
  return result.assets.map((asset) => ({
    uri: asset.uri,
    name: asset.fileName ?? null,
    mime: asset.mimeType ?? null,
    sizeBytes: asset.fileSize ?? null,
    width: asset.width || null,
    height: asset.height || null,
    durationMs: asset.duration ?? null, // ms for videos, null otherwise
  }));
}

/** Audio files via the document picker (whitelisted MIMEs only). */
export async function pickAudioAssets(): Promise<PickedAsset[]> {
  const result = await DocumentPicker.getDocumentAsync({
    type: [...AUDIO_MIMES],
    multiple: true,
    copyToCacheDirectory: true, // content:// → readable file:// for the upload
  });
  if (result.canceled) return [];
  return result.assets.map((asset) => ({
    uri: asset.uri,
    name: asset.name || null,
    mime: asset.mimeType ?? null,
    sizeBytes: asset.size ?? null,
    width: null,
    height: null,
    durationMs: null, // document picker reports no duration; the tile falls back to player metadata
  }));
}
