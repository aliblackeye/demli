/**
 * Web implementation of the {@link ImagesBridge} — "save image" / "copy image"
 * for a picture shared in chat, using only browser APIs.
 *
 * The two surfaces are honestly different and we do NOT pretend otherwise
 * (CLAUDE.md §35 — no dead buttons, no fake parity):
 *
 *  - SAVE. Electron opens a native "save as" dialog and the user picks the
 *    directory. A browser cannot do that unless it has the File System Access
 *    API, so we use it when present (`showSaveFilePicker` — Chromium; a real
 *    directory picker, and cancelling is a silent no-op exactly like desktop)
 *    and otherwise fall back to an `<a download>` on a blob URL, which lands in
 *    whatever download folder the browser is configured with. That fallback is
 *    a browser constraint, not something we can code around.
 *  - COPY. Needs `ClipboardItem` + `navigator.clipboard.write`, which older
 *    Safari and Firefox do not have. {@link webCopyImageSupported} feature-
 *    detects it and the bridge reports `copySupported: false`, so the UI never
 *    renders an entry that cannot work.
 *
 * The bytes are fetched by the page itself (same signed URL the `<img>` already
 * loaded); this file adds no new network permission, and no credentials are
 * sent. Every method is total and non-throwing — a failure returns a typed
 * reason the UI localizes, never a raw error (CLAUDE.md §26).
 */
import type {
  ImageActionRequest,
  ImageCopyResult,
  ImageSaveResult,
  ImagesBridge,
} from "./bridge-types";
import {
  isPixelCountWithinBudget,
  isWithinPixelBudget,
  sniffImageMime,
} from "./image-bytes";

/** Same 10 MB cap the API enforces on upload (packages/config ATTACHMENT_LIMITS). */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** Leading bytes read for the magic-number + dimension checks. */
const HEADER_SLICE_BYTES = 64 * 1024;

/** The clipboard format every engine that supports image copy agrees on. */
const CLIPBOARD_MIME = "image/png";

/**
 * Minimal shape of the File System Access API's save picker. Declared locally
 * because it is not in the DOM lib for our TS target, and accessed through a
 * feature check so a browser without it simply takes the fallback path.
 */
interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: { description?: string; accept: Record<string, string[]> }[];
  }) => Promise<{
    createWritable: () => Promise<{
      write: (data: Blob) => Promise<void>;
      close: () => Promise<void>;
    }>;
    name?: string;
  }>;
}

/**
 * True when this browser can put a real image on the system clipboard.
 *
 * `scope` is injectable so the check is unit-testable in a node environment
 * (there is no jsdom harness in this package).
 */
export function webCopyImageSupported(scope: unknown = globalThis): boolean {
  const global = scope as {
    ClipboardItem?: unknown;
    navigator?: { clipboard?: { write?: unknown } };
    isSecureContext?: boolean;
  };
  if (typeof global.ClipboardItem !== "function") return false;
  if (typeof global.navigator?.clipboard?.write !== "function") return false;
  // The async clipboard API is secure-context only; treat "unknown" as fine so
  // engines that do not expose the flag are not falsely excluded.
  return global.isSecureContext !== false;
}

/** Read the first {@link HEADER_SLICE_BYTES} of a blob as bytes. */
async function headerBytes(blob: Blob): Promise<Uint8Array> {
  const slice = blob.slice(0, HEADER_SLICE_BYTES);
  return new Uint8Array(await slice.arrayBuffer());
}

/**
 * Fetch the image bytes as a Blob, or null on any failure (CORS, CSP, 404, cap,
 * or bytes that are not really one of the four whitelisted image formats).
 *
 * The magic-byte check matters even though the page fetched the same URL its
 * `<img>` already loaded: the response type is a claim by the server, and a save
 * turns that claim into a FILE ON THE USER'S DISK named `something.png`. Trust
 * the bytes, exactly like the desktop main process does.
 */
async function fetchImageBlob(url: string): Promise<Blob | null> {
  try {
    const response = await fetch(url, { credentials: "omit", cache: "no-store" });
    if (!response.ok) return null;
    const blob = await response.blob();
    if (blob.size === 0 || blob.size > MAX_IMAGE_BYTES) return null;
    if (!sniffImageMime(await headerBytes(blob))) return null;
    return blob;
  } catch {
    return null;
  }
}

/**
 * Re-encode a blob to PNG through a canvas. Needed because the clipboard only
 * reliably accepts `image/png`, while attachments may be JPEG/WebP/GIF. The
 * source is a blob URL (same-origin), so the canvas is never tainted.
 *
 * The canvas is where a decompression bomb lands: `canvas.width/height` from a
 * 40000×40000 source allocates ~6.4 GB of RGBA. The size is therefore checked
 * TWICE — once from the file header before any decode, and once from the decoded
 * element, in case the header and the real frame disagree.
 */
async function toPngBlob(blob: Blob): Promise<Blob | null> {
  // Applies to the passthrough case too: the engine still decodes a PNG to put a
  // bitmap on the OS clipboard.
  if (!isWithinPixelBudget(await headerBytes(blob))) return null;
  if (blob.type === CLIPBOARD_MIME) return blob;
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = await loadImage(objectUrl);
    if (!image) return null;
    if (!isPixelCountWithinBudget(image.width, image.height)) return null;
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(image, 0, 0);
    return await new Promise<Blob | null>((resolve) => {
      canvas.toBlob((result) => resolve(result), CLIPBOARD_MIME);
    });
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** Decode an object URL into an <img>, or null when the browser cannot. */
function loadImage(objectUrl: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const element = new Image();
    element.onload = () => resolve(element);
    element.onerror = () => resolve(null);
    element.src = objectUrl;
  });
}

/** Click a synthetic `<a download>` on a blob URL — the classic browser save. */
function triggerBlobDownload(blob: Blob, fileName: string): void {
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = fileName;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  // Revoke on the next tick: revoking synchronously can abort the download in
  // some engines before it has read the blob.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}

/** True when a thrown value is the user dismissing a picker (not a failure). */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

async function saveViaFilePicker(
  picker: NonNullable<SaveFilePickerWindow["showSaveFilePicker"]>,
  request: ImageActionRequest,
  blob: Blob,
): Promise<ImageSaveResult> {
  let handle: Awaited<ReturnType<typeof picker>>;
  try {
    handle = await picker({
      suggestedName: request.fileName,
      types: [{ accept: { [request.mime]: [`.${request.fileName.split(".").pop() ?? "png"}`] } }],
    });
  } catch (error) {
    // Dismissing the picker is a normal choice — stay silent, exactly like the
    // desktop save dialog.
    if (isAbortError(error)) return { status: "canceled" };
    return { status: "error", reason: "write_failed" };
  }
  try {
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
  } catch {
    return { status: "error", reason: "write_failed" };
  }
  return { status: "saved", fileName: handle.name ?? request.fileName };
}

/**
 * Build the web {@link ImagesBridge}. Used by `createWebBridge`; exported on its
 * own so the desktop renderer's shared components can be exercised against it.
 */
export function createWebImagesBridge(): ImagesBridge {
  return {
    // The browser always has SOME way to save (a picker, or an <a download>),
    // and it fetches from the page's own origin policy — there is no
    // build-pinned allow-list to be missing, unlike desktop.
    saveSupported: true,
    copySupported: webCopyImageSupported(),

    async save(request: ImageActionRequest): Promise<ImageSaveResult> {
      const blob = await fetchImageBlob(request.url);
      if (!blob) return { status: "error", reason: "download_failed" };

      const picker = (globalThis as unknown as SaveFilePickerWindow).showSaveFilePicker;
      if (typeof picker === "function") {
        return saveViaFilePicker(picker.bind(globalThis), request, blob);
      }

      try {
        triggerBlobDownload(blob, request.fileName);
      } catch {
        return { status: "error", reason: "write_failed" };
      }
      return { status: "saved", fileName: request.fileName };
    },

    async copy(request: ImageActionRequest): Promise<ImageCopyResult> {
      if (!webCopyImageSupported()) {
        return { status: "error", reason: "unsupported_format" };
      }
      const blob = await fetchImageBlob(request.url);
      if (!blob) return { status: "error", reason: "download_failed" };

      const png = await toPngBlob(blob);
      if (!png) return { status: "error", reason: "unsupported_format" };

      try {
        await navigator.clipboard.write([new ClipboardItem({ [CLIPBOARD_MIME]: png })]);
      } catch {
        return { status: "error", reason: "clipboard_failed" };
      }
      return { status: "copied" };
    },
  };
}
