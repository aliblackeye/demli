/**
 * Upload manager — the imperative side of the composer attachment tray
 * (ADR 0008 §5). Mobile mirror of the desktop's lib/attachments/manager.ts;
 * owns the full per-asset pipeline:
 *
 *   validate → (image: EXIF strip + downscale via expo-image-manipulator) →
 *   upload-url → PUT file (progress) → complete → ready
 *
 * State updates flow into stores/attachment-store.ts; the native UploadTask
 * handles live in a module map here, never in React state (CLAUDE.md §27).
 * Remove-before-send cancels the PUT and best-effort cancels the server row
 * (DELETE /attachments/:id).
 */

import { ATTACHMENT_MAX_PER_MESSAGE } from "@demli/config";
import type { Attachment, ChannelId } from "@demli/types";
import { ApiClientError, getApi } from "../clients";
import { commonErrorKey, type DraftError } from "../errors";
import { newId } from "../id";
import { useAttachmentStore, type DraftAttachment } from "../../stores/attachment-store";
import { AttachmentPipelineError } from "./errors";
import { localFileSize, processImageAsset } from "./image-processing";
import { putFileWithProgress, UploadCancelledError, type UploadHandle } from "./upload";
import { attachmentUrlResolver } from "./url-resolver";
import { formatBytes, maxBytesForKind, resolveAssetMime, validateAttachmentFile } from "./validate";

/**
 * One asset from expo-image-picker / expo-document-picker, normalized by the
 * composer before it reaches the pipeline.
 */
export interface PickedAsset {
  uri: string;
  /** Original filename when the picker knows it. */
  name?: string | null;
  /** Picker-reported MIME (may be missing on some Android providers). */
  mime?: string | null;
  /** Picker-reported byte size (falls back to a file stat). */
  sizeBytes?: number | null;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
}

interface DraftHandles {
  /** In-flight PUT, if any. */
  upload: UploadHandle | null;
  cancelled: boolean;
}

/** localId → non-serializable handles (never in the zustand store). */
const handles = new Map<string, DraftHandles>();

/**
 * Map a pipeline failure to a localizable {@link DraftError}. Pipeline errors
 * already carry their catalog key; API errors reuse the shared `common.errors.*`
 * mapping; anything else gets a generic user-facing line (a raw runtime message
 * is dev-only and must never reach the tray — CLAUDE.md §26).
 */
function toDraftError(err: unknown): DraftError {
  if (err instanceof AttachmentPipelineError) return err.draftError;
  if (err instanceof UploadCancelledError) return { key: "mobile:attachments.uploadCancelled" };
  if (err instanceof ApiClientError) {
    // Server-side NSFW moderation rejected the image (422). The code is additive
    // (not in the typed union) so match it as a string, tolerant of casing.
    // Moderation is fail-open today, so this is defensive; it tells the user to
    // post the image in an age-restricted (18+) channel (§26).
    if ((err.code as string).toLowerCase() === "nsfw_content_blocked") {
      return { key: "mobile:attachments.nsfwBlocked" };
    }
    return { key: commonErrorKey(err) };
  }
  return { key: "mobile:attachments.uploadFailed" };
}

function updateDraft(
  channelId: ChannelId,
  localId: string,
  patch: Partial<DraftAttachment>,
): void {
  useAttachmentStore.getState().updateDraft(channelId, localId, patch);
}

function findDraft(channelId: ChannelId, localId: string): DraftAttachment | undefined {
  return useAttachmentStore.getState().drafts[channelId]?.find((d) => d.localId === localId);
}

/**
 * Stage 2: upload the prepared file of an existing draft (also the retry path
 * — processing results are kept on the draft, so a retry re-uploads without
 * re-encoding).
 */
async function uploadDraft(channelId: ChannelId, localId: string): Promise<void> {
  const draft = findDraft(channelId, localId);
  const handle = handles.get(localId);
  if (!draft || !handle || !draft.localUri || handle.cancelled) return;

  updateDraft(channelId, localId, { status: "uploading", progress: 0, error: null });

  try {
    const ticket = await getApi().createAttachmentUploadUrl(channelId, {
      filename: draft.name || undefined,
      mime: draft.mime,
      sizeBytes: draft.sizeBytes,
    });
    if (handle.cancelled) throw new UploadCancelledError();

    const upload = putFileWithProgress({
      url: ticket.uploadUrl,
      fileUri: draft.localUri,
      contentType: draft.mime,
      onProgress: (fraction) => updateDraft(channelId, localId, { progress: fraction }),
    });
    handle.upload = upload;
    await upload.done;
    handle.upload = null;
    if (handle.cancelled) throw new UploadCancelledError();

    const { attachment } = await getApi().completeAttachment(ticket.attachmentId, {
      width: draft.width ?? undefined,
      height: draft.height ?? undefined,
      durationMs: draft.durationMs ?? undefined,
    });

    // The sender's own tiles render from the local file immediately — no
    // signed-URL round-trip for the optimistic echo.
    attachmentUrlResolver.setLocalUrl(attachment.id, draft.localUri);

    updateDraft(channelId, localId, { status: "ready", progress: 1, attachment });
  } catch (err) {
    if (err instanceof UploadCancelledError || handle.cancelled) return; // removeDraft cleaned up
    updateDraft(channelId, localId, { status: "error", error: toDraftError(err) });
  }
}

/** Stage 1: validate + process one picked asset, then hand off to upload. */
async function ingestAsset(channelId: ChannelId, asset: PickedAsset): Promise<void> {
  const localId = newId();
  const mime = resolveAssetMime(asset.mime, asset.name ?? asset.uri);
  const sizeBytes = asset.sizeBytes ?? localFileSize(asset.uri);
  const verdict = mime
    ? validateAttachmentFile({ mime, sizeBytes })
    : ({ ok: false, error: { key: "mobile:attachments.typeNotAllowed" } } as const);

  const base: DraftAttachment = {
    localId,
    channelId,
    name: asset.name || "attachment",
    mime: mime ?? (asset.mime || "application/octet-stream"),
    kind: verdict.ok ? verdict.kind : "image",
    sizeBytes,
    width: asset.width || null,
    height: asset.height || null,
    durationMs: asset.durationMs ?? null,
    localUri: null,
    status: "processing",
    progress: 0,
    attachment: null,
    error: null,
  };

  if (!verdict.ok || !mime) {
    useAttachmentStore
      .getState()
      .addDraft({ ...base, status: "error", error: verdict.ok ? null : verdict.error });
    return;
  }

  useAttachmentStore.getState().addDraft(base);
  handles.set(localId, { upload: null, cancelled: false });

  try {
    let patch: Partial<DraftAttachment>;

    if (verdict.kind === "image") {
      const processed = await processImageAsset({
        uri: asset.uri,
        mime,
        width: asset.width,
        height: asset.height,
      });
      patch = {
        localUri: processed.uri,
        mime: processed.mime,
        width: processed.width,
        height: processed.height,
        sizeBytes: processed.sizeBytes,
      };
    } else {
      // Audio/video upload as-is; metadata comes from the picker (the server
      // sanity-clamps whatever we report).
      patch = { localUri: asset.uri };
    }

    // Authoritative final-size check (the downscale path may still be over cap
    // for absurd inputs; audio/video were checked pre-processing).
    const finalSize = patch.sizeBytes ?? sizeBytes;
    const cap = maxBytesForKind(verdict.kind);
    if (finalSize <= 0) {
      throw new AttachmentPipelineError({ key: "mobile:attachments.fileUnreadable" });
    }
    if (finalSize > cap) {
      throw new AttachmentPipelineError({
        key: "mobile:attachments.tooLargeMax",
        params: { cap: formatBytes(cap) },
      });
    }

    if (handles.get(localId)?.cancelled) return;
    updateDraft(channelId, localId, patch);
    await uploadDraft(channelId, localId);
  } catch (err) {
    if (handles.get(localId)?.cancelled) return;
    updateDraft(channelId, localId, { status: "error", error: toDraftError(err) });
  }
}

/**
 * Add picked assets to a channel's pending tray. Assets beyond the per-message
 * cap are surfaced as errored drafts, not silently dropped (CLAUDE.md §26).
 */
export function addAssetsToChannel(channelId: ChannelId, assets: Iterable<PickedAsset>): void {
  const existing = useAttachmentStore.getState().drafts[channelId]?.length ?? 0;
  let slot = existing;
  for (const asset of assets) {
    if (slot >= ATTACHMENT_MAX_PER_MESSAGE) {
      useAttachmentStore.getState().addDraft({
        localId: newId(),
        channelId,
        name: asset.name || "attachment",
        mime: asset.mime || "application/octet-stream",
        kind: "image",
        sizeBytes: asset.sizeBytes ?? 0,
        width: null,
        height: null,
        durationMs: null,
        localUri: null,
        status: "error",
        progress: 0,
        attachment: null,
        error: {
          key: "mobile:attachments.maxPerMessage",
          params: { max: ATTACHMENT_MAX_PER_MESSAGE },
        },
      });
      continue;
    }
    slot += 1;
    void ingestAsset(channelId, asset);
  }
}

/** Remove a draft: cancel an in-flight PUT and cancel the server row if any. */
export function removeDraft(channelId: ChannelId, localId: string): void {
  const draft = findDraft(channelId, localId);
  const handle = handles.get(localId);

  if (handle) {
    handle.cancelled = true;
    handle.upload?.cancel();
  }
  handles.delete(localId);
  // Ready-but-unsent uploads are cancelled server-side (bytes purged); a
  // failure is fine — the orphan sweep is the backstop.
  const attachmentId = draft?.attachment?.id;
  if (attachmentId) {
    void getApi()
      .cancelAttachment(attachmentId)
      .catch(() => undefined);
  }

  useAttachmentStore.getState().removeDraft(channelId, localId);
}

/** Retry a failed draft. Re-uses the processed file when it survived. */
export function retryDraft(channelId: ChannelId, localId: string): void {
  const draft = findDraft(channelId, localId);
  if (!draft?.localUri || !handles.has(localId)) {
    // Processing itself failed — nothing to retry with; the user re-adds.
    return;
  }
  void uploadDraft(channelId, localId);
}

/**
 * Consume the channel's ready drafts for a send: removes them from the tray
 * and returns their server metadata (uploader-owned, ready, unlinked ids).
 */
export function takeReadyAttachments(channelId: ChannelId): Attachment[] {
  const ready = useAttachmentStore.getState().takeReadyDrafts(channelId);
  const attachments: Attachment[] = [];
  for (const draft of ready) {
    handles.delete(draft.localId);
    if (draft.attachment) attachments.push(draft.attachment);
    // localUri intentionally NOT deleted: the url resolver serves it as the
    // sender's render URL for the echoed message (cache files are cheap and
    // cleared by the OS).
  }
  return attachments;
}
