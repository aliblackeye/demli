/**
 * "Save image" / "Copy image" for a picture shared in chat — the MOBILE half
 * (founder: "atılan görseli indirme ve görüntüyü kopyalama da olsun. seçtiği
 * dizine indirsin").
 *
 * Every rule lives next door in ./policy (pure, unit-tested); this file is only
 * the native plumbing. It is also the seam where the two mobile platforms stop
 * being the same, and we do NOT pretend otherwise (CLAUDE.md §35):
 *
 *  - SAVE on ANDROID picks a real DIRECTORY. `StorageAccessFramework` opens the
 *    system folder picker, the user chooses where the file goes, and the app
 *    never asks for READ/WRITE_EXTERNAL_STORAGE — the grant is scoped to the one
 *    folder they picked. That is the founder's ask, literally.
 *  - SAVE on iOS cannot do that. iOS has no directory grant of this shape, so
 *    the honest equivalent is the system share sheet over the downloaded file,
 *    from which "Save Image" / "Save to Files" is one tap. Different flow, same
 *    outcome; the difference is written down in docs/product/feature-parity.md
 *    rather than papered over.
 *  - COPY goes through `expo-clipboard.setImageAsync`, which takes a base64
 *    PNG/JPEG and decodes it to a real bitmap natively. WebP and GIF are refused
 *    UP FRONT (policy.isClipboardCopyableMime) because handing them over does
 *    not throw — it silently leaves the clipboard empty, which is the one
 *    outcome worse than an error message.
 *
 * NO NEW DEPENDENCY. expo-file-system, expo-clipboard and React Native's own
 * `Share` are all already linked into the shipped APK, so this whole feature is
 * OTA-shippable — it does not move `runtimeVersion` and does not need a new
 * build (CLAUDE.md §32).
 *
 * Every exported function is TOTAL: it returns a typed {@link ImageActionResult}
 * and never throws, so a caller can never leak a native error message to a user
 * (§26).
 */

import { Platform, Share } from "react-native";
import * as Clipboard from "expo-clipboard";
import { File, Paths } from "expo-file-system";
import { StorageAccessFramework, writeAsStringAsync } from "expo-file-system/legacy";
import { API_URL } from "@/lib/server-config";
import {
  IMAGE_ACTION_MAX_BYTES,
  extensionForMime,
  imageSaveFileName,
  imageSourceKind,
  isClipboardCopyableMime,
  isSavableImageMime,
  parseAllowedOrigins,
  sanitizeSaveFileName,
  sniffImageMimeFromBase64,
  type ImageActionResult,
  type ImageSourceKind,
} from "./policy";

/**
 * What a caller names when it wants an image saved or copied. Built by
 * {@link imageActionTarget} from the attachment DTO the row is already
 * rendering plus the signed URL the resolver already handed it — there is no
 * path by which a caller supplies a URL of its own choosing.
 */
export interface ImageActionTarget {
  /** The signed https URL the `<Image>` is displaying. */
  url: string;
  /** The attachment's declared MIME; the BYTES are re-checked after download. */
  mime: string;
  /** Suggested file name; sanitized before it reaches the filesystem. */
  fileName: string;
}

/**
 * Origins the app may download an image from.
 *
 * `EXPO_PUBLIC_STORAGE_ORIGIN` pins the storage host at build time (the same
 * value the desktop build passes as `DEMLI_STORAGE_ORIGIN`). The API origin
 * is always included, because avatars and banners are served from it. When the
 * env is unset the list still carries the API origin — but that means the pin is
 * partial, so `isAllowedImageUrl`'s documented fallback applies via an EMPTY
 * list rather than a list that would wrongly reject every attachment. See the
 * note there for why the residual power is bounded.
 */
function allowedOrigins(): string[] {
  const pinned = parseAllowedOrigins(process.env["EXPO_PUBLIC_STORAGE_ORIGIN"]);
  // No storage pin → no meaningful allow-list; fall back to the "public https
  // host" rule rather than to "API origin only", which would break every
  // attachment (they are served from Supabase, not from api.getdemli.com).
  if (pinned.length === 0) return [];
  const api = parseAllowedOrigins(API_URL);
  for (const origin of api) if (!pinned.includes(origin)) pinned.push(origin);
  return pinned;
}

/**
 * The directories WE write into, and therefore the only ones a `file://` action
 * URI may point inside. Both are app-private on Android — no other app, and no
 * part of the shared storage the user browses, is reachable through them.
 */
function localRoots(): string[] {
  return [Paths.cache.uri, Paths.document.uri];
}

/** Build the action payload for one image attachment and its resolved URL. */
export function imageActionTarget(
  attachment: { id: string; mime: string; createdAt: string },
  url: string,
): ImageActionTarget {
  return { url, mime: attachment.mime, fileName: imageSaveFileName(attachment) };
}

/**
 * Can this surface put an image on the clipboard at all? False for WebP/GIF, so
 * the sheet omits the row entirely instead of rendering one that cannot work
 * (§35). The honest error still exists for the case where a file's real bytes
 * turn out to differ from the declared MIME.
 */
export function canCopyImage(mime: string): boolean {
  return isClipboardCopyableMime(mime);
}

/** A unique cache file name, so two concurrent actions cannot collide. */
function cacheFileName(mime: string): string {
  const stamp = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  return `demli-img-${stamp}.${extensionForMime(mime)}`;
}

/** Delete a cache file, ignoring any failure — a leftover temp file is not an error. */
function discard(file: File): void {
  try {
    file.delete();
  } catch {
    // Already gone, or the OS reclaimed it. Nothing to recover.
  }
}

interface Materialized {
  file: File;
  /** The real MIME, from the magic number — never the declared one. */
  mime: string;
  /** The file's contents as base64 (the format both write paths need). */
  base64: string;
  /**
   * True when WE created this file for this action and must delete it after.
   * False for a local source: that file is the sender's own upload cache, which
   * the URL resolver still serves as that tile's render URL — deleting it would
   * blank the picture the user is looking at.
   */
  ephemeral: boolean;
}

/**
 * Get the bytes on disk and validate what actually arrived.
 *
 * Order matters: the byte cap is checked BEFORE the file is read into JS, so an
 * oversized body cannot be turned into a 100 MB string in the app's heap; and
 * the format is decided by the magic number, not by the DTO or a response
 * header, so nothing but a real PNG/JPEG/WebP/GIF ever reaches the folder the
 * user chose or the system clipboard.
 */
async function materialize(
  target: ImageActionTarget,
  source: ImageSourceKind,
): Promise<Materialized | null> {
  let file: File;
  const ephemeral = source === "remote";

  if (source === "local") {
    file = new File(target.url);
  } else {
    const destination = new File(Paths.cache, cacheFileName(target.mime));
    try {
      file = await File.downloadFileAsync(target.url, destination, { idempotent: true });
    } catch {
      discard(destination);
      return null;
    }
  }

  try {
    if (!file.exists || file.size === null || file.size <= 0 || file.size > IMAGE_ACTION_MAX_BYTES) {
      if (ephemeral) discard(file);
      return null;
    }
    const base64 = await file.base64();
    const mime = sniffImageMimeFromBase64(base64);
    if (mime === null || !isSavableImageMime(mime)) {
      if (ephemeral) discard(file);
      return null;
    }
    return { file, mime, base64, ephemeral };
  } catch {
    if (ephemeral) discard(file);
    return null;
  }
}

/** Drop the working copy — only ever the one this action created. */
function release(materialized: Materialized): void {
  if (materialized.ephemeral) discard(materialized.file);
}

/**
 * Android: let the user pick a folder, then write the file into it.
 *
 * `requestDirectoryPermissionsAsync` is the system picker; backing out of it
 * returns `granted: false`, which is a CANCEL and must stay silent — dismissing
 * a picker is a choice, not a failure. `createFileAsync` takes the base name
 * without an extension and derives it from the MIME, which is exactly what we
 * want: the extension always matches the real bytes.
 */
async function saveViaStorageAccessFramework(
  image: Materialized,
  fileName: string,
): Promise<ImageActionResult> {
  let directoryUri: string;
  try {
    const permission = await StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!permission.granted) return { status: "canceled" };
    directoryUri = permission.directoryUri;
  } catch {
    return { status: "error", reason: "write_failed" };
  }

  const safe = sanitizeSaveFileName(fileName, image.mime);
  const baseName = safe.slice(0, safe.lastIndexOf(".")) || "image";

  try {
    const documentUri = await StorageAccessFramework.createFileAsync(
      directoryUri,
      baseName,
      image.mime,
    );
    await writeAsStringAsync(documentUri, image.base64, { encoding: "base64" });
  } catch {
    return { status: "error", reason: "write_failed" };
  }
  return { status: "saved" };
}

/**
 * iOS: hand the downloaded file to the system share sheet, from which "Save
 * Image" (Photos) and "Save to Files" are both one tap. Dismissing the sheet is
 * a cancel, same as backing out of the Android folder picker.
 *
 * The cache file must still exist while the sheet is up, so the caller deletes
 * it only after this resolves.
 */
async function saveViaShareSheet(image: Materialized): Promise<ImageActionResult> {
  try {
    const result = await Share.share({ url: image.file.uri });
    return result.action === Share.dismissedAction ? { status: "canceled" } : { status: "saved" };
  } catch {
    return { status: "error", reason: "write_failed" };
  }
}

/**
 * Save a chat image to the device. On Android the user picks the destination
 * folder; on iOS the share sheet stands in (see the file header).
 */
export async function saveImage(target: ImageActionTarget): Promise<ImageActionResult> {
  const source = imageSourceKind(target.url, {
    allowedOrigins: allowedOrigins(),
    localRoots: localRoots(),
  });
  if (source === null || !isSavableImageMime(target.mime)) {
    return { status: "error", reason: "not_allowed" };
  }

  const image = await materialize(target, source);
  if (!image) return { status: "error", reason: "download_failed" };

  try {
    return Platform.OS === "android"
      ? await saveViaStorageAccessFramework(image, target.fileName)
      : await saveViaShareSheet(image);
  } finally {
    // The bytes now live wherever the user put them; our working copy is spent.
    release(image);
  }
}

/**
 * Put a chat image on the system clipboard as a real image.
 *
 * The format gate runs twice on purpose: once on the DECLARED mime so the row
 * is never even offered for a WebP/GIF, and again on the SNIFFED mime so a file
 * whose bytes disagree with its DTO still produces the honest "this format can't
 * be copied" line instead of an empty clipboard.
 */
export async function copyImage(target: ImageActionTarget): Promise<ImageActionResult> {
  const source = imageSourceKind(target.url, {
    allowedOrigins: allowedOrigins(),
    localRoots: localRoots(),
  });
  if (source === null || !isSavableImageMime(target.mime)) {
    return { status: "error", reason: "not_allowed" };
  }
  if (!isClipboardCopyableMime(target.mime)) {
    return { status: "error", reason: "unsupported_format" };
  }

  const image = await materialize(target, source);
  if (!image) return { status: "error", reason: "download_failed" };

  try {
    if (!isClipboardCopyableMime(image.mime)) {
      return { status: "error", reason: "unsupported_format" };
    }
    await Clipboard.setImageAsync(image.base64);
    return { status: "copied" };
  } catch {
    return { status: "error", reason: "clipboard_failed" };
  } finally {
    release(image);
  }
}

export {
  imageActionNotice,
  type ImageActionFailure,
  type ImageActionNotice,
  type ImageActionNoticeKey,
  type ImageActionResult,
} from "./policy";
