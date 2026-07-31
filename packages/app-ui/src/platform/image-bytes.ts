/**
 * Image byte inspection, re-exported from `@demli/config`.
 *
 * The implementation MOVED to `packages/config/src/image-bytes.ts` so the API
 * could reach it too: the guard has to run on the server (an uploaded avatar or
 * banner is bytes a stranger chose) and a shared UI package is not importable
 * from `apps/api`. Keeping this module as a re-export means every existing
 * `platform/image-bytes` import in the web image actions keeps resolving, and
 * there is still exactly ONE implementation.
 */

export {
  IMAGE_HEADER_BYTES,
  MAX_IMAGE_PIXELS,
  isPixelCountWithinBudget,
  isWithinPixelBudget,
  readImageDimensions,
  sniffImageMime,
  type ImageSize,
} from "@demli/config";
