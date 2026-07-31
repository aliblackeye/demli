/**
 * Pick + prepare a profile image (avatar or banner) for the inline base64 upload
 * endpoints (`POST /users/me/avatar` · `POST /users/me/banner`), the mobile
 * counterpart of the desktop's `fileToUpload()` (M15).
 *
 * - Avatar: PNG/JPEG/WebP, ≤2 MB. Always re-encoded (EXIF strip — privacy first,
 *   §28) and downscaled until it fits the cap, then emitted as base64.
 * - Banner: adds animated GIF and a 5 MB cap. GIFs pass through byte-for-byte (a
 *   re-encode would freeze the animation) and are read straight to base64; still
 *   images take the same re-encode path as avatars.
 *
 * Re-encoding rides expo-image-manipulator (already used by the attachment
 * pipeline); GIF base64 reads use the legacy expo-file-system string reader. No
 * new native module, so this stays OTA-deliverable. Failures throw a
 * {@link ProfileImageError} carrying a catalog KEY the caller localizes at render
 * (ADR 0009) — never a frozen English string.
 */
import * as ImagePicker from "expo-image-picker";
import { readAsStringAsync } from "expo-file-system/legacy";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { localFileSize } from "./attachments/image-processing";
import { MAX_IMAGE_EDGE_PX, MIN_IMAGE_EDGE_PX, scaleToFitEdge } from "./attachments/validate";

export type ProfileImageKind = "avatar" | "banner";

/** Catalog key an image-prep failure can carry (mobile namespace). */
export type ProfileImageErrorKey =
  | "mobile:profile.imageUnreadable"
  | "mobile:profile.imageTooLargeAvatar"
  | "mobile:profile.imageTooLargeBanner"
  | "mobile:profile.imageInvalidType";

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
 * A picked image, ready to be held as a draft (M15 "nothing saves until you
 * press Save"). The two halves are deliberately separate:
 *
 * - `upload` is the exact request body and nothing more (see above);
 * - `previewUri` is a LOCAL file uri for rendering the draft. Previewing from
 *   the file instead of a `data:` URI matters on a phone: a 5 MB GIF banner is
 *   ~6.7 MB of base64, and pushing that string across the bridge to be decoded
 *   on every render is exactly the kind of thing §27 forbids. The file is a
 *   cache entry that lives as long as the draft does.
 */
export interface PickedProfileImage {
  upload: PreparedProfileImage;
  previewUri: string;
}

/** Server byte caps mirrored from the API validators. */
const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const BANNER_MAX_BYTES = 5 * 1024 * 1024;

/** JPEG re-encode quality — visually transparent, meaningfully smaller. */
const REENCODE_QUALITY = 0.88;

function capFor(kind: ProfileImageKind): number {
  return kind === "avatar" ? AVATAR_MAX_BYTES : BANNER_MAX_BYTES;
}

function tooLargeKeyFor(kind: ProfileImageKind): ProfileImageErrorKey {
  return kind === "avatar" ? "mobile:profile.imageTooLargeAvatar" : "mobile:profile.imageTooLargeBanner";
}

/** Approximate decoded byte size of a base64 payload (ignoring padding). */
function base64Bytes(base64: string): number {
  return Math.floor((base64.length * 3) / 4);
}

/** png stays png; jpeg/webp re-encode to jpeg (WebP write is unreliable on iOS). */
function saveTargetFor(mime: string): { format: SaveFormat; mime: string } {
  if (mime === "image/png") return { format: SaveFormat.PNG, mime: "image/png" };
  return { format: SaveFormat.JPEG, mime: "image/jpeg" };
}

/** Re-encode a still image to base64, downscaling until it fits `cap`. */
async function reencodeToBase64(
  uri: string,
  sourceMime: string,
  cap: number,
): Promise<PickedProfileImage> {
  const target = saveTargetFor(sourceMime);

  const render = async (width: number | null) => {
    const ctx = ImageManipulator.manipulate(uri);
    if (width !== null) ctx.resize({ width });
    const image = await ctx.renderAsync();
    return image.saveAsync({ compress: REENCODE_QUALITY, format: target.format, base64: true });
  };

  let result;
  try {
    result = await render(null);
  } catch {
    throw new ProfileImageError("mobile:profile.imageUnreadable");
  }

  for (;;) {
    const longest = Math.max(result.width, result.height);
    if (longest > MAX_IMAGE_EDGE_PX) {
      const fitted = scaleToFitEdge(result.width, result.height, MAX_IMAGE_EDGE_PX);
      result = await render(fitted.width);
      continue;
    }
    const base64 = result.base64 ?? "";
    if (base64.length === 0) throw new ProfileImageError("mobile:profile.imageUnreadable");
    if (base64Bytes(base64) <= cap) {
      // `result.uri` is the re-encoded cache file — the same pixels the upload
      // carries, so the draft preview shows exactly what Save would apply.
      return { upload: { mime: target.mime, dataBase64: base64 }, previewUri: result.uri };
    }
    const next = scaleToFitEdge(result.width, result.height, Math.floor(longest * 0.7));
    if (Math.max(next.width, next.height) < MIN_IMAGE_EDGE_PX) {
      throw new ProfileImageError(
        cap === AVATAR_MAX_BYTES ? "mobile:profile.imageTooLargeAvatar" : "mobile:profile.imageTooLargeBanner",
      );
    }
    result = await render(next.width);
  }
}

/**
 * Launch the OS photo picker for a profile image, prepare the bytes, and return
 * the upload payload plus a local preview uri — or `null` when the user cancels.
 * Throws a {@link ProfileImageError} for an unusable pick (unreadable file,
 * unsupported type, or a GIF banner that can't be brought under the cap).
 *
 * NOTHING is uploaded here: the caller holds the result as a DRAFT and ships it
 * from its single Save (founder rule, M15).
 */
export async function pickProfileImage(
  kind: ProfileImageKind,
): Promise<PickedProfileImage | null> {
  const allowGif = kind === "banner";
  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ["images"],
    allowsMultipleSelection: false,
    quality: 1, // re-encode/downscale is ours
    exif: false,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;

  const mime = (asset.mimeType ?? "").toLowerCase();
  const cap = capFor(kind);

  // Animated GIF (banner only): never re-encode — read the raw bytes to base64
  // and reject if it's over the cap (no downscale path for animation).
  if (mime === "image/gif") {
    if (!allowGif) throw new ProfileImageError("mobile:profile.imageInvalidType");
    const size = localFileSize(asset.uri);
    if (size > cap) throw new ProfileImageError(tooLargeKeyFor(kind));
    let base64: string;
    try {
      base64 = await readAsStringAsync(asset.uri, { encoding: "base64" });
    } catch {
      throw new ProfileImageError("mobile:profile.imageUnreadable");
    }
    if (base64.length === 0) throw new ProfileImageError("mobile:profile.imageUnreadable");
    if (base64Bytes(base64) > cap) throw new ProfileImageError(tooLargeKeyFor(kind));
    // Animated GIFs pass through byte-for-byte, so the picked file IS the preview.
    return { upload: { mime: "image/gif", dataBase64: base64 }, previewUri: asset.uri };
  }

  // Still image: png/jpeg/webp are re-encodable; anything else is unsupported.
  // The picker may not report a mime on some Android providers — treat a blank
  // mime as a re-encodable still (the re-encode both normalizes it and would
  // fail loudly on a truly unreadable file).
  const reencodable = mime === "" || mime === "image/png" || mime === "image/jpeg" || mime === "image/webp";
  if (!reencodable) throw new ProfileImageError("mobile:profile.imageInvalidType");
  return reencodeToBase64(asset.uri, mime || "image/jpeg", cap);
}
