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
        // A white wash, not a surface tone: the strip sits inside the composer,
        // which is `surface` at rest and `raised` while focused — a toned card
        // would vanish into one of the two. A failed upload takes the danger wash.
        "relative flex w-48 shrink-0 items-center gap-2.5 rounded-lg p-2 animate-pop-in-fast",
        "transition-colors motion-hover",
        failed ? "bg-danger/12" : "bg-wash",
      )}
    >
      {/* Thumbnail / kind glyph */}
      <div className="relative size-11 shrink-0 overflow-hidden rounded-md bg-rail/40">
        {draft.previewUrl ? (
          <img
            src={draft.previewUrl}
            alt=""
            className={cn(
              "size-full object-cover transition-opacity",
              uploading && "opacity-50",
            )}
          />
        ) : (
          <div className="flex size-full items-center justify-center">
            <KindIcon draft={draft} />
          </div>
        )}
        {uploading && (
          <div className="absolute inset-0 flex items-center justify-center bg-rail/40">
            <Loader2 className="size-4 animate-spin text-fg-display" aria-hidden />
          </div>
        )}
        {failed && (
          <div className="absolute inset-0 flex items-center justify-center bg-rail/50">
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
          <p className="mt-0.5 line-clamp-2 text-2xs leading-tight text-danger" title={errorText}>
            {errorText}
          </p>
        ) : draft.status === "uploading" ? (
          <div className="mt-1 flex items-center gap-2">
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-label={t("desktop:attachments.uploadProgress", { percent: pct })}
              className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-wash-strong"
            >
              {/* scaleX, not width: the bar moves on the compositor (§27). */}
              <div
                className="h-full w-full origin-left rounded-full bg-accent transition-transform motion-fast"
                style={{ transform: `scaleX(${pct / 100})` }}
              />
            </div>
            <span className="shrink-0 text-2xs tabular-nums text-fg-faint">{pct}%</span>
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
            className="cursor-pointer rounded-md p-1 text-fg-faint transition-colors motion-hover hover:bg-wash hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            <RotateCw className="size-3.5" aria-hidden />
          </button>
        )}
        <button
          type="button"
          onClick={onRemove}
          aria-label={t("desktop:attachments.removeName", { name: draft.name })}
          className="cursor-pointer rounded-md p-1 text-fg-faint transition-colors motion-hover hover:bg-wash hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        >
          <X className="size-3.5" aria-hidden />
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
      role="group"
      className="mb-1 flex gap-2 overflow-x-auto pb-1"
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
