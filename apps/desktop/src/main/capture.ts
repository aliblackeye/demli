import {
  desktopCapturer,
  ipcMain,
  session,
  webContents,
  type DesktopCapturerSource,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents,
} from "electron";
import { z } from "zod";
import {
  CAPTURE_CHANNELS,
  THUMBNAIL_WIDTH_BOUNDS,
  type CaptureSelectionResult,
  type CaptureSource,
  type CaptureSourceKind,
} from "./capture-types";
import type { ShareGrant } from "./process-audio-policy";

/**
 * Screen-capture (main process).
 *
 * Secure capture path for the "watch a film together" use case: the renderer
 * shows OUR own picker (fed by {@link enumerateSources}), arms a source via
 * {@link CAPTURE_CHANNELS.selectSource}, then calls `getDisplayMedia()`. That
 * request is served by our `setDisplayMediaRequestHandler`, which supplies the
 * chosen source as VIDEO ONLY.
 *
 * Endpoint loopback (`audio: "loopback"`) is never armed: it records the whole
 * output device, including Demli's own playback of the people in the call, so
 * they would hear themselves (M16 H1). Share sound comes from the process
 * capture instead (`process-audio.ts`).
 *
 * Security posture (CLAUDE.md §9, §28):
 *   - Every IPC payload is validated (zod) before use.
 *   - A source id from the renderer is only accepted if it matches an id we
 *     ourselves just enumerated; arbitrary ids are rejected.
 *   - The selection is single-shot and remembers which webContents armed it, so
 *     one renderer cannot ride another's pending selection.
 *   - The raw DesktopCapturerSource never leaves main; the renderer only ever
 *     sees the minimal {@link CaptureSource} shape.
 */

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** 16:9 thumbnails keep the picker grid tidy and the payload small. */
const THUMBNAIL_ASPECT = 9 / 16;
/** Hard cap on how many sources we return, so a machine with hundreds of
 *  windows can't bloat the IPC payload. Screens are ranked first. */
const MAX_SOURCES = 60;

// ---------------------------------------------------------------------------
// IPC payload schemas
// ---------------------------------------------------------------------------

const listSourcesSchema = z
  .object({
    maxThumbnailWidth: z.number().finite().positive().optional(),
  })
  .strict()
  .optional();

const selectSourceSchema = z
  .object({
    sourceId: z.string().min(1).max(256),
  })
  .strict();

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** Ids from the most recent enumeration — the allow-list for selectSource. */
let lastEnumeratedIds = new Set<string>();

interface PendingSelection {
  sourceId: string;
  /** id of the webContents that armed this selection (single-shot owner). */
  webContentsId: number;
}

/** The single armed selection, consumed by the next display-media request. */
let pendingSelection: PendingSelection | null = null;

/**
 * Per webContents: the source it last picked and whether that share was served.
 * Process-audio capture is only allowed against one of these (see
 * `processAudioStartAllowed`), so share sound can only ever be recorded for a
 * share the user started in that same window. Released on clearSelection (the
 * share ended or failed), a new pick, and any reload / navigation / crash.
 */
const shareGrants = new Map<number, ShareGrant>();
/** webContents ids whose reset listeners are wired (once per sender). */
const grantResetWired = new Set<number>();

/** The share grant of a webContents, or null. Read by process-audio. */
export function shareGrantFor(webContentsId: number): ShareGrant | null {
  return shareGrants.get(webContentsId) ?? null;
}

function releaseShareGrant(webContentsId: number): void {
  shareGrants.delete(webContentsId);
  if (pendingSelection?.webContentsId === webContentsId) pendingSelection = null;
}

/**
 * Call `onReset` whenever the page in `contents` goes away without the
 * webContents itself being destroyed (main-frame navigation / reload, renderer
 * crash) and when it is destroyed. Shared with process-audio so both modules
 * drop per-page state on exactly the same events.
 */
export function onRendererReset(contents: WebContents, onReset: () => void): void {
  contents.on("did-start-navigation", (details) => {
    if (details.isMainFrame && !details.isSameDocument) onReset();
  });
  contents.on("render-process-gone", () => onReset());
  contents.once("destroyed", () => onReset());
}

/** Guard so we register IPC handlers exactly once across re-activations. */
let ipcRegistered = false;

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

function clampThumbnailWidth(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return THUMBNAIL_WIDTH_BOUNDS.default;
  }
  return Math.min(
    THUMBNAIL_WIDTH_BOUNDS.max,
    Math.max(THUMBNAIL_WIDTH_BOUNDS.min, Math.round(requested)),
  );
}

function kindOf(source: DesktopCapturerSource): CaptureSourceKind {
  return source.id.startsWith("screen:") ? "screen" : "window";
}

/** Screens first (the film-sharing primary case), then windows. */
function sourceRank(source: DesktopCapturerSource): number {
  return kindOf(source) === "screen" ? 0 : 1;
}

/**
 * Enumerate capturable sources and map them to the minimal, sanitized shape.
 * Refreshes the {@link lastEnumeratedIds} allow-list as a side effect.
 */
export async function enumerateSources(
  maxThumbnailWidth?: number,
): Promise<CaptureSource[]> {
  const width = clampThumbnailWidth(maxThumbnailWidth);
  const height = Math.max(1, Math.round(width * THUMBNAIL_ASPECT));

  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    fetchWindowIcons: false,
    thumbnailSize: { width, height },
  });

  const ordered = [...sources]
    .sort((a, b) => sourceRank(a) - sourceRank(b))
    .slice(0, MAX_SOURCES);

  lastEnumeratedIds = new Set(ordered.map((s) => s.id));

  return ordered.map((source) => ({
    id: source.id,
    name: source.name,
    kind: kindOf(source),
    thumbnailDataUrl: source.thumbnail.isEmpty()
      ? ""
      : source.thumbnail.toDataURL(),
  }));
}

/**
 * True when `id` is in the most recent enumeration allow-list. Shared with the
 * process-audio module (`process-audio.ts`) so a process-loopback capture can
 * ONLY be armed against a source WE enumerated — never a renderer-spoofed id.
 */
export function isEnumeratedSourceId(id: string): boolean {
  return lastEnumeratedIds.has(id);
}

// ---------------------------------------------------------------------------
// Display-media request handler
// ---------------------------------------------------------------------------

function notifyServed(webContentsId: number, sourceId: string): void {
  const target = webContents.fromId(webContentsId);
  if (target && !target.isDestroyed()) {
    target.send(CAPTURE_CHANNELS.displaySourceServed, { sourceId });
  }
}

/**
 * Serve a renderer's getDisplayMedia() from the armed selection. Denies (by
 * calling back with `{}`) when nothing is armed, the source vanished, or an
 * error occurs — the renderer surfaces that as a rejected getDisplayMedia().
 */
async function handleDisplayMediaRequest(
  callback: (streams: Electron.Streams) => void,
): Promise<void> {
  // Single-shot: consume the selection immediately so a stale one can't be
  // reused by a later, unrelated request.
  const selection = pendingSelection;
  pendingSelection = null;

  if (!selection) {
    callback({}); // deny — renderer must arm a source first
    return;
  }

  try {
    // Fetch a LIVE DesktopCapturerSource for the armed id. Thumbnails are not
    // needed here, so request 0x0 to skip that work.
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      fetchWindowIcons: false,
      thumbnailSize: { width: 0, height: 0 },
    });
    const source = sources.find((s) => s.id === selection.sourceId);
    if (!source) {
      callback({}); // the window/screen closed between arm and request
      return;
    }

    callback({ video: source });
    const grant = shareGrants.get(selection.webContentsId);
    if (grant && grant.sourceId === selection.sourceId) grant.served = true;
    notifyServed(selection.webContentsId, selection.sourceId);
  } catch {
    // Never throw across the Electron boundary — deny gracefully. The renderer
    // sees a rejected getDisplayMedia() and can retry (e.g. video-only).
    callback({});
  }
}

function registerDisplayMediaHandler(targetSession: Session): void {
  targetSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      void handleDisplayMediaRequest(callback);
    },
    // We render our own in-app picker; never fall back to the OS system picker.
    { useSystemPicker: false },
  );
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

function registerIpcHandlers(): void {
  if (ipcRegistered) {
    return;
  }
  ipcRegistered = true;

  ipcMain.handle(
    CAPTURE_CHANNELS.listSources,
    async (_event: IpcMainInvokeEvent, rawOptions: unknown) => {
      const parsed = listSourcesSchema.safeParse(rawOptions);
      if (!parsed.success) {
        throw new Error("capture: invalid listSources options");
      }
      return enumerateSources(parsed.data?.maxThumbnailWidth);
    },
  );

  ipcMain.handle(
    CAPTURE_CHANNELS.selectSource,
    async (
      event: IpcMainInvokeEvent,
      rawRequest: unknown,
    ): Promise<CaptureSelectionResult> => {
      const parsed = selectSourceSchema.safeParse(rawRequest);
      if (!parsed.success) {
        throw new Error("capture: invalid selectSource request");
      }
      const { sourceId } = parsed.data;

      // Only accept an id we ourselves just enumerated. Blocks arbitrary /
      // spoofed source ids from the renderer.
      if (!lastEnumeratedIds.has(sourceId)) {
        throw new Error("capture: unknown source id — call listSources() first");
      }

      const senderId = event.sender.id;
      pendingSelection = { sourceId, webContentsId: senderId };
      shareGrants.set(senderId, { sourceId, armedAt: Date.now(), served: false });
      if (!grantResetWired.has(senderId)) {
        grantResetWired.add(senderId);
        onRendererReset(event.sender, () => releaseShareGrant(senderId));
        event.sender.once("destroyed", () => grantResetWired.delete(senderId));
      }
      return { ok: true, sourceId };
    },
  );

  // The renderer calls this when a pick did not become a share AND when a live
  // share ends, so it also ends the sender's right to capture share sound.
  ipcMain.handle(CAPTURE_CHANNELS.clearSelection, async (event: IpcMainInvokeEvent) => {
    pendingSelection = null;
    releaseShareGrant(event.sender.id);
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Wire up screen capture. Call once, after `app.whenReady()`, from the main
 * process. Registers the display-media handler on the default session (the one
 * the main window uses) and the validated IPC handlers.
 */
export function registerScreenCapture(): void {
  registerDisplayMediaHandler(session.defaultSession);
  registerIpcHandlers();
}
