/**
 * Shared "save / copy a chat image" contract (M17 — attachment actions).
 *
 * Pure TypeScript types plus the IPC channel-name constants, importing NOTHING
 * from `electron` or `node` — mirroring the other `*-types.ts` modules. Safe to
 * import from:
 *   - the main process (`image-actions.ts`)     — values + types
 *   - the preload bridge (`preload/index.ts`)   — values + types
 *   - the renderer (via a type-only import)     — types only
 *
 * Do not add electron/node imports here, or the renderer bundle will break.
 *
 * Security posture (CLAUDE.md §9, §28): the renderer may show an image but has
 * no filesystem and no clipboard-image access. It therefore ASKS main to (a)
 * open a native "save as" dialog and write the bytes the user approved, or (b)
 * put the decoded image on the system clipboard. Main re-validates the whole
 * payload with zod, refuses any URL outside the pinned storage origins, refuses
 * any MIME outside the image whitelist, caps the download, and never lets a
 * renderer-supplied string influence the destination path (the path comes from
 * the user's dialog choice alone). See `image-actions-policy.ts` for the rules
 * and their unit tests.
 */

/**
 * IPC channel names for image actions. Single source of truth — never hard-code
 * these strings anywhere else (CLAUDE.md §23: no magic strings).
 */
export const IMAGE_ACTION_CHANNELS = {
  /** renderer -> main (invoke): "save as…" a chat image the user right-clicked. */
  save: "demli:images:save",
  /** renderer -> main (invoke): put a chat image on the system clipboard. */
  copy: "demli:images:copy",
} as const;

export type ImageActionChannel =
  (typeof IMAGE_ACTION_CHANNELS)[keyof typeof IMAGE_ACTION_CHANNELS];

/**
 * A request to act on ONE already-visible image.
 *
 * - `url` — the short-lived signed read URL the renderer already resolved for
 *   the tile. Main re-validates it against the allowed storage origins; it is
 *   never used as a path and never followed off-allowlist (redirects included).
 * - `mime` — the attachment's declared image MIME. Main cross-checks it against
 *   the response's own content type AND the bytes' magic number, so a lie here
 *   cannot make us write an executable with a `.png` name.
 * - `fileName` — a SUGGESTED name for the save dialog only. Sanitized in main
 *   (traversal / drive letters / control chars / reserved device names) before
 *   it is offered, and the real destination is whatever the user picks.
 */
export interface ImageActionRequest {
  url: string;
  mime: string;
  fileName: string;
}

/**
 * Why an action could not complete. All are non-fatal and map to a plain
 * user-facing sentence in the renderer (CLAUDE.md §26 — never a raw error).
 */
export type ImageActionFailure =
  /** The URL is not an https URL on an allowed storage origin. */
  | "blocked_url"
  /** The declared or served type is not a whitelisted image MIME. */
  | "unsupported_type"
  /** Network error, non-200, or a body that failed the magic-byte check. */
  | "download_failed"
  /** The body exceeded the per-image byte cap. */
  | "too_large"
  /** The bytes are a valid image we cannot hand to the OS clipboard (webp/gif). */
  | "unsupported_format"
  /** The clipboard write itself failed. */
  | "clipboard_failed"
  /** The file could not be written to the chosen path. */
  | "write_failed";

/**
 * Result of a save. `canceled` is a first-class, SILENT outcome: dismissing the
 * dialog is a normal user choice, not an error, and the UI must say nothing.
 */
export type ImageSaveResult =
  | { status: "saved"; fileName: string }
  | { status: "canceled" }
  | { status: "error"; reason: ImageActionFailure };

/** Result of a clipboard copy. */
export type ImageCopyResult =
  | { status: "copied" }
  | { status: "error"; reason: ImageActionFailure };

/**
 * The minimal image-actions surface exposed on `window.demli.images`.
 *
 * Both flags are SYNCHRONOUS capability booleans, not promises: the UI reads
 * them during render to decide whether each entry exists at all. A surface that
 * cannot perform an action must not show a dead button (CLAUDE.md §35).
 *
 * - `saveSupported` — is the feature usable on this build at all? False on a
 *   desktop build that pinned NO storage origin: main then refuses every URL
 *   (fail-closed allow-list, see image-actions-policy.ts), so both entries are
 *   hidden instead of failing on click. Always true on web.
 * - `copySupported` — can this surface put an image on the system CLIPBOARD?
 *   Desktop: same as `saveSupported` (the OS clipboard is always there, but the
 *   bytes still have to be downloadable). Web: feature-detects `ClipboardItem` +
 *   `navigator.clipboard.write`, which older Safari/Firefox lack.
 */
export interface ImagesBridge {
  readonly saveSupported: boolean;
  readonly copySupported: boolean;
  save(request: ImageActionRequest): Promise<ImageSaveResult>;
  copy(request: ImageActionRequest): Promise<ImageCopyResult>;
}
