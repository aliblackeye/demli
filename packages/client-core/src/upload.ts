/**
 * Direct-to-storage binary upload (ADR 0008 §3, step 2). Shared by desktop and
 * mobile — framework-, store-, and DOM-only-global-free (uses `XMLHttpRequest`
 * and `Blob`, both present in the browser, the Electron renderer, and React
 * Native).
 *
 * The API only signs and records; the raw bytes go straight from the client to
 * Supabase Storage via a signed PUT. `fetch` cannot report upload progress, so
 * this uses `XMLHttpRequest` to drive a real progress bar in the composer's
 * preview strip. The signed URL carries its own auth token in the query string,
 * so NO Authorization header is attached here.
 */

/** Upload progress tick. `total` is 0 while the browser has not sized the body. */
export interface UploadProgress {
  loaded: number;
  total: number;
}

export interface UploadToSignedUrlOptions {
  /** Called as bytes flush; drives the preview-strip progress bar. */
  onProgress?: (progress: UploadProgress) => void;
  /** Abort the in-flight PUT (channel switch / draft removed). */
  signal?: AbortSignal;
  /**
   * `Content-Type` to send with the PUT. Defaults to `body.type`. Must match the
   * mime declared to `createAttachmentUploadUrl` (the API stores it).
   */
  contentType?: string;
}

/**
 * A failed direct upload. `status` is the storage response status for a non-2xx
 * (0 for a transport/CORS error); `aborted` is true when the caller cancelled.
 * Distinct from `ApiClientError` because this hop does not touch our API.
 */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly aborted: boolean = false,
  ) {
    super(message);
    this.name = "UploadError";
  }
}

/**
 * PUT `body` to a signed upload `url`, resolving on a 2xx and rejecting with an
 * {@link UploadError} otherwise (or on abort). Reports progress via
 * `options.onProgress`.
 */
export function uploadToSignedUrl(
  url: string,
  body: Blob,
  options: UploadToSignedUrlOptions = {},
): Promise<void> {
  const { onProgress, signal, contentType } = options;

  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new UploadError("Upload cancelled.", 0, true));
      return;
    }

    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url, true);
    xhr.setRequestHeader("Content-Type", contentType ?? body.type ?? "application/octet-stream");

    const onAbort = (): void => xhr.abort();
    if (signal) signal.addEventListener("abort", onAbort);

    const cleanup = (): void => {
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    if (onProgress) {
      xhr.upload.onprogress = (event: ProgressEvent): void => {
        onProgress({
          loaded: event.loaded,
          total: event.lengthComputable ? event.total : 0,
        });
      };
    }

    xhr.onload = (): void => {
      cleanup();
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new UploadError(`Upload failed (HTTP ${xhr.status}).`, xhr.status));
      }
    };

    xhr.onerror = (): void => {
      cleanup();
      reject(new UploadError("Upload failed. Check your connection and try again.", 0));
    };

    xhr.onabort = (): void => {
      cleanup();
      reject(new UploadError("Upload cancelled.", 0, true));
    };

    xhr.send(body);
  });
}
