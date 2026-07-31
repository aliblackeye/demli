/**
 * Shared screen-capture contract.
 *
 * This is the ONLY module that crosses the main <-> preload <-> renderer
 * boundary for screen capture. It contains pure TypeScript types plus the IPC
 * channel-name constants, and it imports NOTHING from `electron` or `node`.
 * That keeps it safe to import from:
 *   - the main process (`capture.ts`)              — values + types
 *   - the preload bridge (`preload/index.ts`)      — values + types
 *   - the renderer (later, via a type-only import) — types only
 *
 * Do not add electron/node imports here, or the renderer bundle will break.
 */

/**
 * IPC channel names for the capture feature. Single source of truth — never
 * hard-code these strings anywhere else (CLAUDE.md §23: no magic strings).
 */
export const CAPTURE_CHANNELS = {
  /** renderer -> main (invoke): enumerate capturable sources. */
  listSources: "demli:capture:list-sources",
  /** renderer -> main (invoke): arm the source served by the next getDisplayMedia(). */
  selectSource: "demli:capture:select-source",
  /** renderer -> main (invoke): clear any armed selection (cancel / cleanup). */
  clearSelection: "demli:capture:clear-selection",
  /** main -> renderer (send): fired when the display-media handler actually serves a source. */
  displaySourceServed: "demli:capture:display-source-served",
} as const;

export type CaptureChannel =
  (typeof CAPTURE_CHANNELS)[keyof typeof CAPTURE_CHANNELS];

export type CaptureSourceKind = "screen" | "window";

/**
 * Minimal, sanitized description of a capturable source, shown in our own
 * in-app picker. Only the fields the picker needs are exposed — never the raw
 * `DesktopCapturerSource` (which carries native handles / more surface).
 */
export interface CaptureSource {
  /** Opaque desktopCapturer id, e.g. "screen:0:0" or "window:12345:0". */
  id: string;
  /** Human-readable label: monitor name or window title. */
  name: string;
  kind: CaptureSourceKind;
  /**
   * Small PNG data URL for the picker grid. Empty string when no thumbnail is
   * available (e.g. a minimized window).
   */
  thumbnailDataUrl: string;
  /**
   * Optional app-icon data URL. Reserved: not populated while window icons are
   * disabled (`fetchWindowIcons: false`). Kept in the type so the picker can
   * adopt icons later without a contract change.
   */
  appIconDataUrl?: string;
}

/** Options the renderer may pass when enumerating sources. */
export interface ListSourcesOptions {
  /**
   * Desired thumbnail width in px. Main clamps this to a safe range
   * ({@link THUMBNAIL_WIDTH_BOUNDS}); height follows a 16:9 ratio.
   */
  maxThumbnailWidth?: number;
}

/** Safe clamp bounds the main process enforces on requested thumbnail width. */
export const THUMBNAIL_WIDTH_BOUNDS = {
  min: 96,
  max: 480,
  default: 320,
} as const;

/** What audio (if any) main will try to capture alongside the screen video. */
export type CaptureAudioMode = "loopback" | "none";

/**
 * Renderer's request to arm a source for the *next* getDisplayMedia() call.
 * The selection is single-shot: it is consumed the moment the display-media
 * handler fires, so it must be re-armed before every share.
 */
export interface CaptureSelectionRequest {
  /** Must equal the id of a source returned by a prior listSources() call. */
  sourceId: string;
  /**
   * Whether to also capture system/loopback audio (the film's sound). Only
   * honoured on Windows; see {@link CaptureSelectionResult.loopbackSupported}.
   */
  audio: boolean;
}

/** Result of arming a selection. */
export interface CaptureSelectionResult {
  ok: true;
  sourceId: string;
  /** The audio mode main will attempt when the handler fires. */
  audio: CaptureAudioMode;
  /**
   * True only on win32 when audio was requested. When false, any requested
   * audio was downgraded to "none" (loopback is Windows-only in this build).
   */
  loopbackSupported: boolean;
}

/**
 * main -> renderer notification, emitted right after the display-media handler
 * serves a source. Lets the renderer learn what audio mode was *attempted* so
 * it can reconcile against the actual MediaStream tracks it receives (loopback
 * success is only observable renderer-side — see the report's fallback note).
 */
export interface DisplaySourceServedEvent {
  sourceId: string;
  /** The audio mode handed to Chromium: "loopback" or "none". */
  audio: CaptureAudioMode;
}
