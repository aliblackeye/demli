/**
 * Pick, crop and prepare a profile image (avatar or banner) for the inline
 * base64 upload endpoints (`POST /users/me/avatar` · `POST /users/me/banner`) —
 * the mobile half of the desktop's image-file pipeline (M16).
 *
 * Three steps, so the crop editor sits between picking and uploading:
 *
 *  1. {@link pickProfileSource} opens the OS picker and returns a SOURCE: a
 *     decoded, orientation-normalised working copy (longest edge ≤2048) with its
 *     true pixel size, or — for a GIF banner — the untouched original, which can
 *     stay animated.
 *  2. The editor (components/profile/ImageCropEditor) frames it.
 *  3. {@link exportProfileCrop} crops the working copy to the chosen rectangle,
 *     resizes to the server size (avatar 512², banner 1200×450 — the desktop's
 *     sizes), re-encodes (EXIF stripped, §28) and returns the draft; or
 *     {@link keepAnimatedBanner} reads a GIF banner through byte-for-byte.
 *
 * Nothing here uploads: the result is a DRAFT the profile screen holds until
 * Save (founder rule, M15). expo-image-manipulator + the legacy expo-file-system
 * reader only — no new native module, so this stays OTA-deliverable. Failures
 * throw a {@link ProfileImageError} carrying a catalog KEY (ADR 0009).
 */
import * as ImagePicker from "expo-image-picker";
import { readAsStringAsync } from "expo-file-system/legacy";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { localFileSize } from "./attachments/image-processing";
import { editingResize, outputSize, pixelCropRect, type CropRect, type Size } from "./image-crop";

export type ProfileImageKind = "avatar" | "banner";

/** Catalog key an image-prep failure can carry (mobile namespace). */
export type ProfileImageErrorKey =
  | "mobile:profile.imageUnreadable"
  | "mobile:profile.imageTooLargeAvatar"
  | "mobile:profile.imageTooLargeBanner"
  | "mobile:profile.imageInvalidType"
  | "mobile:imageEditor.errorEncode";

export class ProfileImageError extends Error {
  readonly key: ProfileImageErrorKey;
  constructor(key: ProfileImageErrorKey) {
    super(key);
    this.name = "ProfileImageError";
    this.key = key;
  }
}

/**
 * The upload-ready payload the api client wants: declared MIME + raw base64.
 * This object is sent to `/users/me/avatar` · `/users/me/banner` AS THE REQUEST
 * BODY, verbatim — so it must never grow a field the server does not expect.
 */
export interface PreparedProfileImage {
  mime: string;
  dataBase64: string;
}

/**
 * A prepared image held as a draft (M15 "nothing saves until you press Save").
 * `upload` is the exact request body; `previewUri` is a LOCAL file rendering the
 * same pixels, so a preview never pushes megabytes of base64 across the bridge
 * on every render (§27).
 */
export interface PickedProfileImage {
  upload: PreparedProfileImage;
  previewUri: string;
}

/**
 * What the editor frames. `uri` is the working copy (or, for `animated`, the
 * original GIF); `size` its true pixel size — the crop maths and the native
 * cropper must agree on the same bitmap, which is why the working copy is
 * re-rendered once on pick instead of trusting the picker's reported size
 * (EXIF-rotated photos report pre-rotation dimensions on some providers).
 */
export interface ProfileImageSource {
  kind: ProfileImageKind;
  uri: string;
  size: Size;
  /** The format the export keeps: PNG stays PNG (transparency), the rest JPEG. */
  format: "png" | "jpeg";
  /** A GIF: the working copy is its first frame; `originalUri` can stay animated. */
  gif: boolean;
  originalUri: string;
}

/** Server byte caps mirrored from the API validators. */
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const BANNER_MAX_BYTES = 5 * 1024 * 1024;

/** JPEG quality for the export — visually transparent, meaningfully smaller. */
const EXPORT_QUALITY = 0.9;
/** The working copy is an intermediate: keep it near-lossless. */
const WORKING_QUALITY = 0.95;

export function capFor(kind: ProfileImageKind): number {
  return kind === "avatar" ? AVATAR_MAX_BYTES : BANNER_MAX_BYTES;
}

function tooLargeKeyFor(kind: ProfileImageKind): ProfileImageErrorKey {
  return kind === "avatar" ? "mobile:profile.imageTooLargeAvatar" : "mobile:profile.imageTooLargeBanner";
}

/** Approximate decoded byte size of a base64 payload (ignoring padding). */
export function base64Bytes(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}

/**
 * Open the OS photo picker and decode the pick into an editable source, or
 * `null` when the user cancels. Accepts PNG / JPEG / WebP / GIF (a GIF avatar
 * becomes its first frame — avatars are still images everywhere in the app).
 */
export async function pickProfileSource(kind: ProfileImageKind): Promise<ProfileImageSource | null> {
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: false,
    // Cropping is ours (the system cropper has no circle and no 8:3 frame).
    allowsEditing: false,
    quality: 1,
    exif: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;

  const mime = (asset.mimeType ?? "").toLowerCase();
  // Some Android providers report no MIME: treat it as a still and let the
  // decode below fail loudly if it is not an image at all.
  const supported = mime === "" || ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mime);
  if (!supported) throw new ProfileImageError("mobile:profile.imageInvalidType");
  const gif = mime === "image/gif";

  try {
    const ctx = ImageManipulator.manipulate(asset.uri);
    let ref = await ctx.renderAsync();
    const fit = editingResize({ width: ref.width, height: ref.height });
    if (fit) ref = await ctx.resize({ width: fit.width, height: fit.height }).renderAsync();
    const format = mime === "image/png" ? "png" : "jpeg";
    const saved = await ref.saveAsync({
      format: format === "png" ? SaveFormat.PNG : SaveFormat.JPEG,
      compress: WORKING_QUALITY,
    });
    if (!saved.width || !saved.height) throw new Error("empty decode");
    return {
      kind,
      uri: saved.uri,
      size: { width: saved.width, height: saved.height },
      format,
      gif,
      originalUri: asset.uri,
    };
  } catch (err) {
    if (err instanceof ProfileImageError) throw err;
    throw new ProfileImageError("mobile:profile.imageUnreadable");
  }
}

/**
 * Crop the source's working copy to `rect` (source pixels), resize to the
 * server size and encode it into a draft. If a pathological PNG lands over the
 * cap, it steps down to JPEG, then to a smaller edge, before giving up with a
 * message that tells the user what to do (zoom in / pick another image).
 */
export async function exportProfileCrop(
  source: ProfileImageSource,
  rect: CropRect,
): Promise<PickedProfileImage> {
  const kind = source.kind;
  const crop = pixelCropRect(rect, source.size);
  const target = outputSize(crop, kind);
  const cap = capFor(kind);

  const attempts: { format: "png" | "jpeg"; scale: number }[] =
    source.format === "png"
      ? [
          { format: "png", scale: 1 },
          { format: "jpeg", scale: 1 },
          { format: "jpeg", scale: 0.75 },
        ]
      : [
          { format: "jpeg", scale: 1 },
          { format: "jpeg", scale: 0.75 },
        ];

  for (const attempt of attempts) {
    let saved;
    try {
      const ref = await ImageManipulator.manipulate(source.uri)
        .crop({ originX: crop.x, originY: crop.y, width: crop.width, height: crop.height })
        .resize({
          width: Math.round(target.width * attempt.scale),
          height: Math.round(target.height * attempt.scale),
        })
        .renderAsync();
      saved = await ref.saveAsync({
        format: attempt.format === "png" ? SaveFormat.PNG : SaveFormat.JPEG,
        compress: EXPORT_QUALITY,
        base64: true,
      });
    } catch {
      throw new ProfileImageError("mobile:profile.imageUnreadable");
    }
    const base64 = saved.base64 ?? "";
    if (base64.length === 0) throw new ProfileImageError("mobile:profile.imageUnreadable");
    if (base64Bytes(base64) <= cap) {
      return {
        upload: { mime: attempt.format === "png" ? "image/png" : "image/jpeg", dataBase64: base64 },
        previewUri: saved.uri,
      };
    }
  }
  throw new ProfileImageError("mobile:imageEditor.errorEncode");
}

/**
 * Keep a GIF banner moving: its bytes pass through untouched (a re-encode would
 * freeze it), so it must already fit the 5 MB cap. The card shows its centre.
 */
export async function keepAnimatedBanner(source: ProfileImageSource): Promise<PickedProfileImage> {
  const cap = capFor("banner");
  const size = localFileSize(source.originalUri);
  if (size > cap) throw new ProfileImageError(tooLargeKeyFor("banner"));
  let base64: string;
  try {
    base64 = await readAsStringAsync(source.originalUri, { encoding: "base64" });
  } catch {
    throw new ProfileImageError("mobile:profile.imageUnreadable");
  }
  if (base64.length === 0) throw new ProfileImageError("mobile:profile.imageUnreadable");
  if (base64Bytes(base64) > cap) throw new ProfileImageError(tooLargeKeyFor("banner"));
  return { upload: { mime: "image/gif", dataBase64: base64 }, previewUri: source.originalUri };
}

/** A GIF small enough to stay animated as a banner (the editor offers the choice only then). */
export function gifFitsBannerCap(source: ProfileImageSource): boolean {
  const size = localFileSize(source.originalUri);
  return size > 0 && size <= capFor("banner");
}
