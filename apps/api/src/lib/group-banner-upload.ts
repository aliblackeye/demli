/**
 * Server-banner upload validation (M20) — the API-side authority over what may
 * become a server's banner.
 *
 * This is the PROFILE banner's rule set applied to a group, deliberately and
 * exactly: same inline-base64 transport, same MIME whitelist (GIF allowed, SVG
 * forbidden — stored-XSS), same 5 MB cap, same magic-byte verification, same
 * pixel-budget guard, same public bucket. The ONLY differences are the storage
 * prefix (`group-banners/<groupId>/…`) and the error codes, which are
 * group-specific so the client can say "server banner" rather than "your banner".
 *
 * A server banner is seen by every member of the server rather than by whoever
 * opens one profile, so if the two rule sets were ever going to differ, this is
 * the one that would need to be STRICTER — never looser. Keeping them identical
 * and sharing {@link decodeImageUpload} is what stops them drifting apart.
 */

import { randomUUID } from "node:crypto";
import type { GroupId } from "@demli/types";
import { decodeImageUpload, type BannerMime } from "./banner-upload.js";

/** File extension per whitelisted banner MIME. */
const GROUP_BANNER_EXTENSIONS: Record<BannerMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

/**
 * Bucket-relative object key for a server's banner:
 * `group-banners/<groupId>/<uuid>.<ext>`. The random UUID means each upload is a
 * new object, so a public CDN never serves a stale image after a change; the
 * previous object is best-effort deleted by the caller.
 */
export function buildGroupBannerStoragePath(groupId: GroupId, mime: BannerMime): string {
  return `group-banners/${groupId}/${randomUUID()}.${GROUP_BANNER_EXTENSIONS[mime]}`;
}

/**
 * Decode + fully validate an inline server-banner upload. Returns the verified
 * bytes and the narrowed MIME, or throws the appropriate `ApiError`.
 *
 * Identical rules to the profile banner — see {@link decodeImageUpload} for the
 * order and the reasoning — with `INVALID_GROUP_BANNER` /
 * `GROUP_BANNER_TOO_LARGE` codes so the UI can name the right subject.
 */
export function decodeGroupBannerUpload(input: {
  mime: string;
  dataBase64: string;
}): { bytes: Uint8Array; mime: BannerMime } {
  return decodeImageUpload(input, {
    invalidCode: "INVALID_GROUP_BANNER",
    tooLargeCode: "GROUP_BANNER_TOO_LARGE",
    subject: "server banner",
  });
}
