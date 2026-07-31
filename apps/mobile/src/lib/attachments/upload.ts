/**
 * Raw-bytes PUT to a signed storage URL with progress + cancel (ADR 0008 §5).
 * Uses expo-file-system's UploadTask (binary content mode) so the file streams
 * from disk — the bytes never pass through JS or React state (CLAUDE.md §27).
 */

import { File, UploadTask, UploadType } from "expo-file-system";
import { AttachmentPipelineError } from "./errors";

/** Thrown when an upload is cancelled via {@link UploadHandle.cancel}. */
export class UploadCancelledError extends Error {
  constructor() {
    super("Upload cancelled.");
    this.name = "UploadCancelledError";
  }
}

export interface UploadHandle {
  /** Resolves on HTTP 2xx; rejects with UploadCancelledError on cancel. */
  done: Promise<void>;
  cancel(): void;
}

/**
 * PUT the file at `fileUri` to the signed `url`. `onProgress` receives a
 * 0..1 fraction. Non-2xx responses reject (the signed-URL token is in the
 * query string; the storage backend answers 4xx when it expired).
 */
export function putFileWithProgress(options: {
  url: string;
  fileUri: string;
  contentType: string;
  onProgress: (fraction: number) => void;
}): UploadHandle {
  let cancelled = false;

  const task = new UploadTask(new File(options.fileUri), options.url, {
    httpMethod: "PUT",
    uploadType: UploadType.BINARY_CONTENT,
    headers: { "Content-Type": options.contentType },
    onProgress: ({ bytesSent, totalBytes }) => {
      if (totalBytes > 0) {
        options.onProgress(Math.max(0, Math.min(1, bytesSent / totalBytes)));
      }
    },
  });

  const done = task
    .uploadAsync()
    .then((result) => {
      if (cancelled) throw new UploadCancelledError();
      if (result.status < 200 || result.status >= 300) {
        throw new AttachmentPipelineError({ key: "mobile:attachments.uploadRejected" });
      }
    })
    .catch((err: unknown) => {
      if (cancelled) throw new UploadCancelledError();
      if (err instanceof Error) throw err;
      throw new AttachmentPipelineError({ key: "mobile:attachments.uploadFailed" });
    });

  return {
    done,
    cancel: () => {
      cancelled = true;
      task.cancel();
    },
  };
}
