import {
  AlertCircle,
  FileAudio,
  FileImage,
  FileVideo,
  Loader2,
  RotateCw,
  X,
} from "lucide-react";
import { cn } from "@demli/ui";
import type { AttachmentDraft } from "../hooks/useAttachmentDrafts";
import { formatBytes } from "../lib/attachment-media";
import { useAppTranslation } from "../lib/i18n";

function KindIcon({ draft }: { draft: AttachmentDraft }): JSX.Element {
  if (draft.kind === "video") return <FileVideo className="size-6 text-fg-muted" aria-hidden />;
  if (draft.kind === "audio") return <FileAudio className="size-6 text-fg-muted" aria-hidden />;
  return <FileImage className="size-6 text-fg-muted" aria-hidden />;
}

function DraftCard({
  draft,
  onRemove,
  onRetry,
}: {
  draft: AttachmentDraft;
  onRemove: () => void;
  onRetry: () => void;
}): JSX.Element {
  const { t } = useAppTranslation();
  const uploading = draft.status === "uploading" || draft.status === "processing";
  const failed = draft.status === "error";
  const pct = Math.round((draft.progress || 0) * 100);
  const errorText = draft.error
    ? t(draft.error.key, draft.error.params)
    : t("desktop:attachments.uploadFailedShort");

  return (
    <div
      className={cn(
        "relative flex w-44 shrink-0 items-center gap-2.5 rounded-lg border bg-raised p-2",
        failed ? "border-danger/40" : "border-stroke",
      )}
    >
      {/* Thumbnail / kind glyph */}
      <div className="relative size-11 shrink-0 overflow-hidden rounded-md bg-base">
        {draft.previewUrl ? (
          <img
            src={draft.previewUrl}
            alt=""
            className={cn(
              "size-full object-cover transition-opacity",
              uploading && "opacity-60",
            )}
          />
        ) : (
          <div className="flex size-full items-center justify-center">
            <KindIcon draft={draft} />
          </div>
        )}
        {uploading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/30">
            <Loader2 className="size-4 animate-spin text-white" aria-hidden />
          </div>
        )}
        {failed && (
          <div className="absolute inset-0 flex items-center justify-center bg-danger/20">
            <AlertCircle className="size-5 text-danger" aria-hidden />
          </div>
        )}
      </div>

      {/* Meta */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-fg" title={draft.name}>
          {draft.name}
        </p>
        {failed ? (
          <p className="mt-0.5 truncate text-2xs text-danger" title={errorText}>
            {errorText}
          </p>
        ) : draft.status === "uploading" ? (
          <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-base">
            <div
              className="h-full rounded-full bg-accent transition-[width] motion-instant"
              style={{ width: `${pct}%` }}
            />
          </div>
        ) : draft.status === "processing" ? (
          <p className="mt-0.5 text-2xs text-fg-faint">
            {t("desktop:attachments.preparing")}
          </p>
        ) : (
          <p className="mt-0.5 text-2xs text-fg-faint">{formatBytes(draft.sizeBytes)}</p>
        )}
      </div>

      {/* Actions */}
      <div className="flex shrink-0 items-center gap-0.5 self-start">
        {failed && draft.retryable && (
          <button
            type="button"
            onClick={onRetry}
            aria-label={t("desktop:attachments.retryName", { name: draft.name })}
            className="cursor-pointer rounded p-1 text-fg-faint transition-colors hover:bg-white/[0.06] hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
          >
            <RotateCw className="size-3.5" />
          </button>
        )}
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("desktop:attachments.removeName", { name: draft.name })}
          className="cursor-pointer rounded p-1 text-fg-faint transition-colors hover:bg-white/[0.06] hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
        >
          <X className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

export function AttachmentPreviewStrip({
  drafts,
  onRemove,
  onRetry,
}: {
  drafts: AttachmentDraft[];
  onRemove: (localId: string) => void;
  onRetry: (localId: string) => void;
}): JSX.Element | null {
  const { t } = useAppTranslation();
  if (drafts.length === 0) return null;
  return (
    <div
      className="mb-2 flex gap-2 overflow-x-auto pb-1"
      aria-label={t("desktop:attachments.pendingCount", { count: drafts.length })}
    >
      {drafts.map((draft) => (
        <DraftCard
          key={draft.localId}
          draft={draft}
          onRemove={() => onRemove(draft.localId)}
          onRetry={() => onRetry(draft.localId)}
        />
      ))}
    </div>
  );
}
