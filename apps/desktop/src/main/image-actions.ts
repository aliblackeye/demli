import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  type IpcMainInvokeEvent,
} from "electron";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  IMAGE_ACTION_CHANNELS,
  type ImageActionFailure,
  type ImageActionRequest,
  type ImageCopyResult,
  type ImageSaveResult,
} from "./image-actions-types";
import {
  extensionForMime,
  IMAGE_ACTION_MAX_BYTES,
  IMAGE_ACTION_MAX_NAME_INPUT,
  IMAGE_ACTION_MAX_URL_LENGTH,
  isAllowedImageUrl,
  isClipboardDecodableMime,
  isSavableImageMime,
  isWithinPixelBudget,
  resolveImageActionOrigins,
  sanitizeSaveFileName,
  sniffImageMime,
  SAVABLE_IMAGE_MIMES,
} from "./image-actions-policy";

/**
 * Image actions (main process): "save image as…" and "copy image" for a picture
 * shared in chat.
 *
 * Why main owns this (CLAUDE.md §9): both operations are privileged. Writing a
 * file needs a native save dialog and filesystem access; putting a real BITMAP
 * (not a URL, not a path) on the system clipboard needs `clipboard.writeImage`.
 * Neither may be handed to the renderer, so the renderer only names the image
 * it is already showing and main does the rest.
 *
 * Security posture (CLAUDE.md §9, §28) — every inbound value is untrusted:
 *   - The payload is zod-validated (`.strict()`), with a bounded URL, a MIME
 *     restricted to the API's four-image whitelist, and a bounded name.
 *   - The URL must pass `isAllowedImageUrl` — https only, no credentials, no
 *     private/loopback host, and an EXACT match against a build-pinned origin.
 *     A build that pinned none refuses everything (and hides the menu entries)
 *     rather than widening to the public internet. Redirects are followed
 *     manually, at most twice, and each hop is re-validated, so a 302 cannot
 *     walk us off the allow-list.
 *   - Before the clipboard path decodes anything, the image's own header must
 *     declare a size inside the pixel budget — the byte cap bounds the
 *     download, not the decompressed bitmap.
 *   - Concurrency is bounded: at most two downloads in flight and exactly one
 *     save dialog at a time, so a compromised renderer cannot pile either up.
 *   - The fetch sends no cookies/credentials and the response is read through a
 *     running byte counter, so a lying `Content-Length` cannot exhaust memory.
 *   - The bytes are magic-byte sniffed. Anything that is not really a PNG/JPEG/
 *     WebP/GIF is discarded before it can be written or copied.
 *   - Bytes NEVER travel back to the renderer. They go to the file the user
 *     picked in the dialog, or to the clipboard. Nothing else.
 *   - The destination path comes ONLY from the OS dialog. The renderer's
 *     `fileName` is a sanitized suggestion, so it cannot escape the directory
 *     the user chose.
 *   - Cancelling the dialog returns before any network request is made.
 */

/**
 * Origins the download allow-list accepts, baked in at build time from
 * DEMLI_STORAGE_ORIGIN / DEMLI_DOMAIN — see the `define` block in
 * electron.vite.config.ts. A packaged app has no environment of its own, so
 * this MUST be a build-time constant.
 *
 * EMPTY means the feature is OFF: `isAllowedImageUrl` refuses every URL and the
 * preload reports `saveSupported: false` / `copySupported: false`, so the menu
 * entries are not even rendered. See image-actions-policy.ts for why this is
 * fail-closed rather than "any public https host".
 */
declare const __DEMLI_IMAGE_ORIGINS__: string;

let allowedOrigins: string[] | null = null;

/**
 * Resolve (once) the allow-list. `process.env` is honoured for UNPACKAGED runs
 * only — see `resolveImageActionOrigins`, which owns that rule and its tests.
 */
function getAllowedOrigins(): string[] {
  if (allowedOrigins === null) {
    const baked =
      typeof __DEMLI_IMAGE_ORIGINS__ === "string" ? __DEMLI_IMAGE_ORIGINS__ : "";
    allowedOrigins = resolveImageActionOrigins(baked, process.env, app.isPackaged);
  }
  return allowedOrigins;
}

/** Reset the memoized allow-list. Test seam only. */
export function resetImageActionOriginsForTests(): void {
  allowedOrigins = null;
}

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

const requestSchema: z.ZodType<ImageActionRequest> = z
  .object({
    url: z.string().min(1).max(IMAGE_ACTION_MAX_URL_LENGTH),
    mime: z.string().refine(isSavableImageMime, "unsupported image mime"),
    fileName: z.string().max(IMAGE_ACTION_MAX_NAME_INPUT),
  })
  .strict();

/** How many redirects we will follow (each one re-validated). */
const MAX_REDIRECTS = 2;
/** Give up on a stalled storage host rather than hanging the menu forever. */
const REQUEST_TIMEOUT_MS = 20_000;

/**
 * How many image downloads may be in flight at once, across all windows.
 *
 * A human clicks one menu entry at a time; this bound exists for the other
 * caller — a compromised renderer, which can invoke the channel in a loop and
 * would otherwise have main hold N × 10 MB of buffered body plus N sockets. Two
 * is generous for the real workflow (copy one image while another saves).
 */
const MAX_CONCURRENT_DOWNLOADS = 2;

let activeDownloads = 0;

/**
 * Discard a response body we are not going to read. Without this an undici
 * response (a 3xx we redirect past, or a body we reject on its headers) keeps
 * its socket checked out of the pool until GC — a slow leak a hostile renderer
 * can drive on purpose.
 */
async function discardBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body may already be errored/closed; nothing to clean up.
  }
}

type DownloadOutcome =
  | { ok: true; bytes: Uint8Array; mime: string }
  | { ok: false; reason: ImageActionFailure };

/**
 * Read a response body with a hard byte cap. Streaming (rather than
 * `arrayBuffer()`) is what makes the cap real: a server that under-reports
 * `Content-Length` cannot make us buffer 2 GB.
 */
async function readCappedBody(response: Response): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > IMAGE_ACTION_MAX_BYTES) {
    // Refused on its headers — the body is never read, so release the socket.
    await discardBody(response);
    return null;
  }

  const body = response.body;
  if (!body) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.byteLength > IMAGE_ACTION_MAX_BYTES ? null : buffer;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > IMAGE_ACTION_MAX_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/**
 * Download one image from an allow-listed URL. Never throws; every failure maps
 * to an {@link ImageActionFailure}. Bounded by {@link MAX_CONCURRENT_DOWNLOADS}.
 */
async function downloadImage(request: ImageActionRequest): Promise<DownloadOutcome> {
  if (activeDownloads >= MAX_CONCURRENT_DOWNLOADS) {
    console.warn("[image-actions] refused: too many image downloads in flight");
    return { ok: false, reason: "download_failed" };
  }
  activeDownloads += 1;
  try {
    return await downloadImageUnbounded(request);
  } finally {
    activeDownloads -= 1;
  }
}

async function downloadImageUnbounded(request: ImageActionRequest): Promise<DownloadOutcome> {
  const origins = getAllowedOrigins();
  let target = request.url;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!isAllowedImageUrl(target, origins)) return { ok: false, reason: "blocked_url" };

    let response: Response;
    try {
      response = await fetch(target, {
        method: "GET",
        // No ambient credentials: this must never become an authenticated
        // request on the user's behalf.
        credentials: "omit",
        cache: "no-store",
        // Follow redirects OURSELVES so each hop is re-validated (undici hands
        // back the 3xx with a readable Location under "manual").
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      return { ok: false, reason: "download_failed" };
    }

    if (response.status >= 300 && response.status < 400) {
      // The 3xx body is never read — release its socket before the next hop.
      await discardBody(response);
      const location = response.headers.get("location");
      if (!location) return { ok: false, reason: "download_failed" };
      try {
        target = new URL(location, target).toString();
      } catch {
        return { ok: false, reason: "blocked_url" };
      }
      continue;
    }

    if (!response.ok) {
      await discardBody(response);
      return { ok: false, reason: "download_failed" };
    }

    const served = (response.headers.get("content-type") ?? "").split(";")[0]?.trim() ?? "";
    if (served && !isSavableImageMime(served)) {
      await discardBody(response);
      return { ok: false, reason: "unsupported_type" };
    }

    const bytes = await readCappedBody(response).catch(() => null);
    if (bytes === null) return { ok: false, reason: "too_large" };

    // The bytes are the only trustworthy statement about what this file is.
    const sniffed = sniffImageMime(bytes);
    if (!sniffed) return { ok: false, reason: "download_failed" };

    return { ok: true, bytes, mime: sniffed };
  }

  return { ok: false, reason: "blocked_url" };
}

/** The window that asked, so the dialog is modal to it (never a stray sheet). */
function windowFor(event: IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(event.sender);
}

/**
 * Only the TOP frame of one of our own windows may run an image action.
 *
 * These two handlers write a file and touch the system clipboard — the most
 * privileged pair in the app — so they get a sender check the read-only
 * handlers do not need. A sub-frame is refused outright: nothing in our UI is
 * framed, so a request from one could only come from injected content.
 */
function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  if (!BrowserWindow.fromWebContents(event.sender)) return false;
  const frame = event.senderFrame;
  // `senderFrame` is null when the frame is already gone; the window check above
  // has then already decided, so treat it as fine rather than dropping a
  // legitimate late reply.
  return frame === null || frame.parent === null;
}

/** Human-facing dialog filter for one image type, plus an "all images" entry. */
function saveFilters(mime: string): Electron.FileFilter[] {
  const extension = extensionForMime(mime);
  const all = [...new Set(SAVABLE_IMAGE_MIMES.map(extensionForMime))];
  return [
    { name: extension.toUpperCase(), extensions: [extension] },
    { name: "Image", extensions: all },
  ];
}

let ipcRegistered = false;

/**
 * True while a native save dialog is open.
 *
 * One modal at a time is the honest model of the interaction: the user can only
 * answer one "save as…" sheet, and a renderer that invokes the channel in a loop
 * would otherwise stack dozens of them, each pinning its window. A second
 * request while one is open is treated as `canceled` — the SILENT outcome — so
 * the real user (who is looking at the dialog they opened) is never shown an
 * error for a request they did not make.
 */
let saveDialogOpen = false;

/**
 * Register the image-action IPC. Idempotent — safe to call once after
 * `app.whenReady()`.
 */
export function registerImageActions(): void {
  if (ipcRegistered) {
    return;
  }
  ipcRegistered = true;

  ipcMain.handle(
    IMAGE_ACTION_CHANNELS.save,
    async (event: IpcMainInvokeEvent, raw: unknown): Promise<ImageSaveResult> => {
      if (!isTrustedSender(event)) {
        console.warn("[image-actions] save refused: untrusted sender");
        return { status: "error", reason: "blocked_url" };
      }
      const parsed = requestSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn("[image-actions] invalid save payload; ignored");
        return { status: "error", reason: "unsupported_type" };
      }
      const request = parsed.data;

      // Refuse up front, before the user is shown a dialog for something we
      // would never download anyway.
      if (!isAllowedImageUrl(request.url, getAllowedOrigins())) {
        console.warn("[image-actions] save refused: url outside the storage allow-list");
        return { status: "error", reason: "blocked_url" };
      }

      if (saveDialogOpen) {
        console.warn("[image-actions] save ignored: a save dialog is already open");
        return { status: "canceled" };
      }

      const suggested = sanitizeSaveFileName(request.fileName, request.mime);
      const owner = windowFor(event);
      const options: Electron.SaveDialogOptions = {
        defaultPath: suggested,
        filters: saveFilters(request.mime),
        properties: ["createDirectory", "showOverwriteConfirmation"],
      };

      // Ask FIRST: cancelling must cost nothing and must stay silent.
      let choice: Electron.SaveDialogReturnValue;
      saveDialogOpen = true;
      try {
        choice = owner
          ? await dialog.showSaveDialog(owner, options)
          : await dialog.showSaveDialog(options);
      } finally {
        saveDialogOpen = false;
      }
      if (choice.canceled || !choice.filePath) return { status: "canceled" };

      const download = await downloadImage(request);
      if (!download.ok) return { status: "error", reason: download.reason };

      try {
        await writeFile(choice.filePath, download.bytes);
      } catch {
        return { status: "error", reason: "write_failed" };
      }

      // Report the name the OS actually used, not our suggestion.
      const parts = choice.filePath.split(/[/\\]/);
      return { status: "saved", fileName: parts[parts.length - 1] ?? suggested };
    },
  );

  ipcMain.handle(
    IMAGE_ACTION_CHANNELS.copy,
    async (event: IpcMainInvokeEvent, raw: unknown): Promise<ImageCopyResult> => {
      if (!isTrustedSender(event)) {
        console.warn("[image-actions] copy refused: untrusted sender");
        return { status: "error", reason: "blocked_url" };
      }
      const parsed = requestSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn("[image-actions] invalid copy payload; ignored");
        return { status: "error", reason: "unsupported_type" };
      }
      const request = parsed.data;

      if (!isAllowedImageUrl(request.url, getAllowedOrigins())) {
        console.warn("[image-actions] copy refused: url outside the storage allow-list");
        return { status: "error", reason: "blocked_url" };
      }

      const download = await downloadImage(request);
      if (!download.ok) return { status: "error", reason: download.reason };

      // WebP/GIF decode to an EMPTY nativeImage — say so instead of silently
      // clearing the user's clipboard (CLAUDE.md §26).
      if (!isClipboardDecodableMime(download.mime)) {
        return { status: "error", reason: "unsupported_format" };
      }

      // Decompression bomb: read the size out of the HEADER before any decoder
      // touches the bytes. A 40000×40000 PNG is a few hundred KB on the wire and
      // ~6 GB of RGBA in this process (see IMAGE_ACTION_MAX_PIXELS).
      if (!isWithinPixelBudget(download.bytes)) {
        console.warn("[image-actions] copy refused: image exceeds the decode pixel budget");
        return { status: "error", reason: "unsupported_format" };
      }

      try {
        const image = nativeImage.createFromBuffer(Buffer.from(download.bytes));
        if (image.isEmpty()) return { status: "error", reason: "unsupported_format" };
        clipboard.writeImage(image);
      } catch {
        return { status: "error", reason: "clipboard_failed" };
      }
      return { status: "copied" };
    },
  );
}
