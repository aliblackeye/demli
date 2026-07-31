/**
 * Composer attachment drafts + upload lifecycle (ADR 0008 §3, client side).
 *
 * Owns the per-file pipeline for one channel: validate → process (EXIF strip +
 * downscale for images) → request a signed upload URL → PUT the bytes with
 * progress → `complete`. State is per-channel; switching channels aborts any
 * in-flight uploads and CANCELS uploaded-but-unsent attachments so they don't
 * orphan in storage.
 *
 * The composer reads `drafts` to render the preview strip and `readyIds` to
 * decide what to send; `clearDrafts()` is called after a successful send (the
 * ids are now linked, so it must NOT cancel them).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiClientError, UploadError, uploadToSignedUrl } from "@demli/client-core";
import type { Attachment, AttachmentId } from "@demli/types";
import { api } from "../lib/api-client";
import { useUiStore } from "../stores/ui-store";
import {
  ATTACHMENT_ACCEPT,
  processAttachment,
  validateAttachment,
  type AttachmentRejectReason,
} from "../lib/attachment-media";
import { errorKey, type CommonErrorKey } from "../lib/errors";
import type { AttachmentLimitKind } from "@demli/config";
import { ATTACHMENT_MAX_PER_MESSAGE } from "@demli/config";

export { ATTACHMENT_ACCEPT };

export type DraftStatus = "processing" | "uploading" | "ready" | "error";

/** i18n keys a failed draft can carry (shared `common` errors + attachment-local). */
export type DraftErrorKey =
  | CommonErrorKey
  | "desktop:attachments.typeNotAllowed"
  | "desktop:attachments.tooLarge"
  | "desktop:attachments.uploadCancelled"
  | "desktop:attachments.processFailed"
  | "desktop:attachments.uploadFailed"
  | "desktop:attachments.nsfwBlocked";

/**
 * A localizable draft failure: a catalog KEY (+ optional interpolation params),
 * resolved by the preview strip at render — never a frozen English string, so a
 * live locale switch re-translates it (ADR 0009).
 */
export interface DraftError {
  key: DraftErrorKey;
  params?: Record<string, string | number>;
}

export interface AttachmentDraft {
  /** Client-only key for React + the controller/state maps. */
  localId: string;
  /** The picked file — kept so a failed upload can be retried. */
  file: File;
  name: string;
  kind: AttachmentLimitKind;
  /** Bytes shown in the strip (upload bytes once processed, else original). */
  sizeBytes: number;
  /** Object URL for an image preview thumbnail; revoked on removal. */
  previewUrl: string | null;
  status: DraftStatus;
  /** 0..1 while uploading (0 when the length is not computable). */
  progress: number;
  /** Set on status "error" — a catalog key + params, localized at render. */
  error: DraftError | null;
  /** False for a validation reject (retrying can't help — remove only). */
  retryable: boolean;
  /** Set as soon as the upload URL is reserved (needed to cancel on removal). */
  attachmentId?: AttachmentId;
  /** The completed metadata DTO (status "ready" only) — sent to the message. */
  attachment?: Attachment;
  width?: number;
  height?: number;
  durationMs?: number;
}

export interface UseAttachmentDrafts {
  drafts: AttachmentDraft[];
  /** Completed attachment DTOs, in strip order — the message send payload. */
  readyAttachments: Attachment[];
  /** True while any draft is still processing or uploading. */
  hasPending: boolean;
  /** True when at least one draft exists (any status). */
  hasDrafts: boolean;
  addFiles: (files: Iterable<File>) => void;
  removeDraft: (localId: string) => void;
  retryDraft: (localId: string) => void;
  /**
   * Drop all drafts WITHOUT cancelling — call after a successful send. Pass the
   * set of preview object-URLs handed to the optimistic message so they are NOT
   * revoked here (the outbox now owns them; it revokes on echo/discard).
   */
  clearDrafts: (preserveUrls?: Set<string>) => void;
}

/** Map a rejected file (from {@link validateAttachment}) to a catalog key. */
function rejectToDraftError(reason: AttachmentRejectReason): DraftError {
  return reason.kind === "tooLarge"
    ? { key: "desktop:attachments.tooLarge", params: { limit: reason.limit } }
    : { key: "desktop:attachments.typeNotAllowed" };
}

/**
 * Turn an upload-pipeline failure into a localizable {@link DraftError}. API
 * errors reuse the shared `common.errors.*` mapping; the raw messages from a
 * local processing failure (canvas encode, metadata read) are dev-only and get a
 * generic user-facing line.
 */
function friendlyUploadError(err: unknown): { error: DraftError; disabled: boolean } {
  if (err instanceof ApiClientError) {
    // NSFW-classified image rejected on a non-NSFW channel (M18, HTTP 422). The
    // wire code is additive (not in the typed union — like other purely-runtime
    // codes), so match it as a string and tolerate either casing the API picks.
    const rawCode = (err.code as string).toLowerCase();
    if (rawCode === "nsfw_content_blocked") {
      return { error: { key: "desktop:attachments.nsfwBlocked" }, disabled: false };
    }
    return { error: { key: errorKey(err) }, disabled: err.code === "ATTACHMENTS_DISABLED" };
  }
  if (err instanceof UploadError) {
    return {
      error: {
        key: err.aborted
          ? "desktop:attachments.uploadCancelled"
          : "desktop:attachments.uploadFailed",
      },
      disabled: false,
    };
  }
  return { error: { key: "desktop:attachments.processFailed" }, disabled: false };
}

export function useAttachmentDrafts(channelId: string): UseAttachmentDrafts {
  const [drafts, setDrafts] = useState<AttachmentDraft[]>([]);
  const markAttachmentsDisabled = useUiStore((s) => s.markAttachmentsDisabled);

  // Live mirrors for cleanup that must not re-run when drafts/channel change.
  const draftsRef = useRef<AttachmentDraft[]>([]);
  draftsRef.current = drafts;
  const controllers = useRef(new Map<string, AbortController>());

  const patch = useCallback((localId: string, next: Partial<AttachmentDraft>) => {
    setDrafts((prev) => prev.map((d) => (d.localId === localId ? { ...d, ...next } : d)));
  }, []);

  const runUpload = useCallback(
    async (localId: string, file: File) => {
      const controller = new AbortController();
      controllers.current.set(localId, controller);
      try {
        const processed = await processAttachment(file);
        if (controller.signal.aborted) return;
        patch(localId, {
          status: "uploading",
          progress: 0,
          sizeBytes: processed.blob.size,
          width: processed.width,
          height: processed.height,
          durationMs: processed.durationMs,
        });

        const grant = await api.createAttachmentUploadUrl(channelId, {
          mime: processed.mime,
          sizeBytes: processed.blob.size,
          filename: file.name,
        });
        if (controller.signal.aborted) return;
        // Record the id now so removal can cancel a mid-flight upload.
        patch(localId, { attachmentId: grant.attachmentId });

        await uploadToSignedUrl(grant.uploadUrl, processed.blob, {
          contentType: processed.mime,
          signal: controller.signal,
          onProgress: ({ loaded, total }) => {
            patch(localId, { progress: total > 0 ? loaded / total : 0 });
          },
        });
        if (controller.signal.aborted) return;

        const { attachment } = await api.completeAttachment(grant.attachmentId, {
          width: processed.width,
          height: processed.height,
          durationMs: processed.durationMs,
        });
        if (controller.signal.aborted) return;
        patch(localId, { status: "ready", progress: 1, error: null, attachment });
      } catch (err) {
        if (controller.signal.aborted) return;
        const { error, disabled } = friendlyUploadError(err);
        if (disabled) markAttachmentsDisabled();
        patch(localId, { status: "error", error });
      } finally {
        controllers.current.delete(localId);
      }
    },
    [channelId, patch, markAttachmentsDisabled],
  );

  const addFiles = useCallback(
    (files: Iterable<File>) => {
      const incoming = [...files];
      if (incoming.length === 0) return;

      // Read the committed length synchronously (not inside the updater) so the
      // state updater stays pure — StrictMode double-invokes updaters, and
      // scheduling uploads there would fire each one twice.
      const room = ATTACHMENT_MAX_PER_MESSAGE - draftsRef.current.length;
      const accepted = incoming.slice(0, Math.max(0, room));
      if (accepted.length === 0) return;

      const created: AttachmentDraft[] = [];
      const toUpload: Array<{ localId: string; file: File }> = [];
      for (const file of accepted) {
        const localId = crypto.randomUUID();
        const check = validateAttachment(file);
        if (!check.ok) {
          created.push({
            localId,
            file,
            name: file.name,
            kind: "image",
            sizeBytes: file.size,
            previewUrl: null,
            status: "error",
            progress: 0,
            error: rejectToDraftError(check.reason),
            retryable: false,
          });
          continue;
        }
        const previewUrl = check.kind === "image" ? URL.createObjectURL(file) : null;
        created.push({
          localId,
          file,
          name: file.name,
          kind: check.kind,
          sizeBytes: file.size,
          previewUrl,
          status: "processing",
          progress: 0,
          error: null,
          retryable: true,
        });
        toUpload.push({ localId, file });
      }

      setDrafts((prev) => [...prev, ...created]);
      for (const { localId, file } of toUpload) void runUpload(localId, file);
    },
    [runUpload],
  );

  const removeDraft = useCallback((localId: string) => {
    controllers.current.get(localId)?.abort();
    controllers.current.delete(localId);
    setDrafts((prev) => {
      const target = prev.find((d) => d.localId === localId);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      // Uploaded-but-unsent → cancel so it doesn't orphan in storage.
      if (target?.attachmentId) void api.cancelAttachment(target.attachmentId).catch(() => {});
      return prev.filter((d) => d.localId !== localId);
    });
  }, []);

  const retryDraft = useCallback(
    (localId: string) => {
      const target = draftsRef.current.find((d) => d.localId === localId);
      if (!target || !target.retryable) return;
      patch(localId, { status: "processing", progress: 0, error: null, attachmentId: undefined });
      void runUpload(localId, target.file);
    },
    [patch, runUpload],
  );

  const clearDrafts = useCallback((preserveUrls?: Set<string>) => {
    for (const controller of controllers.current.values()) controller.abort();
    controllers.current.clear();
    for (const draft of draftsRef.current) {
      if (draft.previewUrl && !preserveUrls?.has(draft.previewUrl)) {
        URL.revokeObjectURL(draft.previewUrl);
      }
    }
    setDrafts([]);
  }, []);

  // Channel switch / unmount: abort in-flight uploads, cancel uploaded-but-
  // unsent attachments, revoke previews, and drop the drafts.
  useEffect(() => {
    return () => {
      for (const controller of controllers.current.values()) controller.abort();
      controllers.current.clear();
      for (const draft of draftsRef.current) {
        if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
        if (draft.attachmentId) void api.cancelAttachment(draft.attachmentId).catch(() => {});
      }
      setDrafts([]);
    };
  }, [channelId]);

  const readyAttachments = useMemo(
    () =>
      drafts
        .filter((d) => d.status === "ready" && d.attachment)
        .map((d) => d.attachment as Attachment),
    [drafts],
  );
  const hasPending = useMemo(
    () => drafts.some((d) => d.status === "processing" || d.status === "uploading"),
    [drafts],
  );

  return {
    drafts,
    readyAttachments,
    hasPending,
    hasDrafts: drafts.length > 0,
    addFiles,
    removeDraft,
    retryDraft,
    clearDrafts,
  };
}
