import { useEffect, useRef, useState } from "react";
import { ImageUp, Smile, Trash2, Upload } from "lucide-react";
import { Button, Field, IconButton, Input, Skeleton, cn } from "@demli/ui";
import { EmptyState, FormErrorAlert } from "@demli/app-ui";
import {
  CUSTOM_EMOJI_MAX_BYTES,
  CUSTOM_EMOJI_MAX_PER_GROUP,
  CUSTOM_EMOJI_MIMES,
  CUSTOM_EMOJI_NAME_MAX_LENGTH,
  isCustomEmojiMime,
  isCustomEmojiName,
} from "@demli/config";
import type { CustomEmoji, GroupId, UserId } from "@demli/types";
import { ApiClientError } from "../../lib/api-client";
import { localizeError } from "../../lib/errors";
import { useAppTranslation, type AppTFunction } from "../../lib/i18n";
import {
  useCreateCustomEmoji,
  useCustomEmojiMap,
  useCustomEmojis,
  useDeleteCustomEmoji,
} from "../../queries/chat-queries";
import { useAuthStore } from "../../stores/auth-store";
import { useChatStore } from "../../stores/chat-store";
import { ConfirmDialog, InlineError } from "../settings-kit";

/** Human-readable byte cap for the copy ("256 KB"). */
const MAX_KB = Math.round(CUSTOM_EMOJI_MAX_BYTES / 1024);

/**
 * Localize an emoji upload/delete failure.
 *
 * The emoji codes are deliberately NOT part of `ApiClientErrorCode` (they stay
 * additive server-side), so the runtime `code` string is compared here. Every
 * branch has its own catalog key because the user CAN act on each difference —
 * rename, shrink, convert, or delete something first.
 */
function emojiErrorText(err: unknown, t: AppTFunction): string {
  const code = err instanceof ApiClientError ? (err.code as string) : null;
  switch (code) {
    case "INVALID_EMOJI":
      return t("desktop:emoji.invalid");
    case "EMOJI_TOO_LARGE":
      return t("desktop:emoji.tooLarge", { max: MAX_KB });
    case "EMOJI_NAME_TAKEN":
      return t("desktop:emoji.nameTaken");
    case "EMOJI_LIMIT":
      return t("desktop:emoji.limit", { max: CUSTOM_EMOJI_MAX_PER_GROUP });
    case "EMOJI_DISABLED":
      return t("desktop:emoji.disabled");
    default:
      return t("desktop:emoji.error");
  }
}

/** Strip the `data:*;base64,` prefix a FileReader data URL carries. */
function base64Of(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/**
 * Server settings → Emoji (M17). Upload, list and remove a server's custom
 * emoji, which members then use as `:name:` in any message of that server.
 *
 * The limits shown here are IMPORTED from @demli/config, never re-typed, so
 * the copy can never drift from what the API enforces (§23). The client
 * pre-validates name / MIME / size purely for a fast, friendly reject — the
 * server re-validates the real bytes (magic-byte sniff) and is authoritative.
 *
 * The uploader accepts a click OR a dropped file, previews the picked image at
 * the size it will render in a message, and validates the shortcode as it is
 * typed (the same rule the API runs).
 */
export function EmojiTab({
  groupId,
  isOwner,
}: {
  groupId: GroupId;
  /** Server owner — may delete ANY emoji, not just their own uploads. */
  isOwner: boolean;
}): JSX.Element {
  const { t } = useAppTranslation();
  const { data, isPending, isError, error: loadError, refetch, isFetching } = useCustomEmojis(groupId);
  const urls = useCustomEmojiMap(groupId);
  const create = useCreateCustomEmoji(groupId);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // One object URL per picked file, revoked when it is replaced or unmounted.
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const emojis = data?.emojis ?? [];
  const maxPerGroup = data?.maxPerGroup ?? CUSTOM_EMOJI_MAX_PER_GROUP;
  const full = emojis.length >= maxPerGroup;
  const normalizedName = name.trim().toLowerCase();
  const nameValid = isCustomEmojiName(normalizedName);
  const nameError = normalizedName.length > 0 && !nameValid ? t("validation.pattern.emojiName") : undefined;
  const canSubmit = !full && file !== null && nameValid && !create.isPending;

  const pickFile = (picked: File | null): void => {
    setError(null);
    if (!picked) {
      setFile(null);
      return;
    }
    // Local pre-checks mirroring the server's gates, so an obviously bad file
    // never costs a round trip.
    if (!isCustomEmojiMime(picked.type)) {
      setFile(null);
      setError(t("desktop:emoji.invalid"));
      return;
    }
    if (picked.size > CUSTOM_EMOJI_MAX_BYTES) {
      setFile(null);
      setError(t("desktop:emoji.tooLarge", { max: MAX_KB }));
      return;
    }
    setFile(picked);
    // Seed the shortcode from the filename — the common case is "shrug.png".
    if (name.trim().length === 0) {
      const stem = picked.name.replace(/\.[^.]+$/, "").toLowerCase();
      const cleaned = stem.replace(/[^a-z0-9_]/g, "_").slice(0, CUSTOM_EMOJI_NAME_MAX_LENGTH);
      if (isCustomEmojiName(cleaned)) setName(cleaned);
    }
  };

  const submit = (): void => {
    if (!file || !nameValid) return;
    setError(null);
    const reader = new FileReader();
    reader.onerror = () => setError(t("desktop:emoji.error"));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      if (!result) {
        setError(t("desktop:emoji.error"));
        return;
      }
      create.mutate(
        { name: normalizedName, mime: file.type, dataBase64: base64Of(result) },
        {
          onSuccess: () => {
            setName("");
            setFile(null);
            if (fileInputRef.current) fileInputRef.current.value = "";
          },
          onError: (err) => setError(emojiErrorText(err, t)),
        },
      );
    };
    reader.readAsDataURL(file);
  };

  const usedRatio = Math.min(1, emojis.length / Math.max(1, maxPerGroup));

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-4">
        <p className="text-sm leading-relaxed text-fg-muted">{t("desktop:emoji.hint")}</p>
        <div className="w-52 shrink-0 space-y-1.5 text-right">
          <span className="whitespace-nowrap text-label tabular-nums text-fg-faint">
            {t("desktop:emoji.count", { used: emojis.length, max: maxPerGroup })}
          </span>
          <div
            role="meter"
            aria-valuemin={0}
            aria-valuemax={maxPerGroup}
            aria-valuenow={emojis.length}
            aria-label={t("desktop:emoji.count", { used: emojis.length, max: maxPerGroup })}
            className="h-1 overflow-hidden rounded-full bg-raised"
          >
            <div
              className={cn(
                "h-full w-full origin-left rounded-full transition-transform motion-standard",
                full ? "bg-warning" : "bg-accent",
              )}
              style={{ transform: `scaleX(${usedRatio})` }}
            />
          </div>
        </div>
      </div>

      {/* Upload card. Disabled — not hidden — when the group is full, with the
          reason spelled out, so the affordance is never silently inert (§35). */}
      <section className="space-y-4 rounded-xl bg-surface p-4">
        <button
          type="button"
          disabled={full}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(event) => {
            if (full) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (!full) pickFile(event.dataTransfer.files?.[0] ?? null);
          }}
          className={cn(
            "flex w-full cursor-pointer items-center gap-4 rounded-lg px-4 py-4 text-left",
            "transition-[background-color,box-shadow] motion-hover",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface",
            "disabled:cursor-not-allowed disabled:opacity-40",
            dragging
              ? "bg-accent-surface shadow-[inset_0_0_0_1.5px_rgb(255_132_100/0.6)]"
              : "bg-raised/40 shadow-[inset_0_0_0_1.5px_var(--color-stroke)] hover:bg-raised/70",
          )}
        >
          <span
            aria-hidden
            className={cn(
              "flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg",
              preview ? "bg-app" : dragging ? "bg-accent-surface text-accent" : "bg-raised text-fg-muted",
            )}
          >
            {preview ? (
              <img src={preview} alt="" draggable={false} className="size-8 object-contain" />
            ) : (
              <ImageUp className="size-5" />
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-fg">
              {file
                ? t("desktop:settingsUi.emojiPickedFile", { name: file.name })
                : dragging
                  ? t("desktop:settingsUi.emojiDropActive")
                  : t("desktop:settingsUi.emojiDrop")}
            </span>
            <span className="mt-0.5 block text-label text-fg-faint">
              {file ? t("desktop:settingsUi.emojiReplace") : t("desktop:settingsUi.emojiLimits", { max: MAX_KB })}
            </span>
          </span>
          <span className="shrink-0 text-label font-medium text-accent-hover">{t("desktop:emoji.pickFile")}</span>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={CUSTOM_EMOJI_MIMES.join(",")}
          className="hidden"
          tabIndex={-1}
          onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
        />

        <form
          className="flex flex-wrap items-start gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (canSubmit) submit();
          }}
        >
          <Field
            label={t("desktop:emoji.name")}
            error={nameError}
            help={t("desktop:emoji.nameHint")}
            className="min-w-[12rem] flex-1"
          >
            <Input
              value={name}
              disabled={full}
              maxLength={CUSTOM_EMOJI_NAME_MAX_LENGTH}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("desktop:emoji.namePlaceholder")}
              spellCheck={false}
              // A field inside the surface card sits one step DARKER (a well),
              // or it would vanish into the card's own tone.
              className="bg-app font-mono text-label hover:bg-app/70"
            />
          </Field>
          <Button type="submit" variant="accent" disabled={!canSubmit} loading={create.isPending} className="mt-[22px]">
            <Upload className="size-4" />
            {t("desktop:emoji.upload")}
          </Button>
        </form>

        {full && <p className="text-label text-warning">{t("desktop:settingsUi.emojiFull")}</p>}
        {error && <FormErrorAlert>{error}</FormErrorAlert>}
      </section>

      {isPending ? (
        <ul aria-hidden className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <li key={i} className="flex items-center gap-3 rounded-xl bg-surface p-3">
              <Skeleton shape="rect" width={40} height={40} />
              <div className="flex-1 space-y-2">
                <Skeleton shape="line" height={12} className="w-20" />
                <Skeleton shape="line" height={10} className="w-14" />
              </div>
            </li>
          ))}
        </ul>
      ) : isError ? (
        <InlineError
          message={localizeError(loadError, t)}
          retryLabel={t("buttons.retry")}
          onRetry={() => void refetch()}
          retrying={isFetching}
        />
      ) : emojis.length === 0 ? (
        <EmptyState icon={<Smile className="size-6" />} title={t("desktop:emoji.empty")} className="py-10" />
      ) : (
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {emojis.map((emoji) => (
            <EmojiRow key={emoji.id} groupId={groupId} emoji={emoji} url={urls.get(emoji.name)} isOwner={isOwner} />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One emoji card: preview, shortcode, uploader + size, and a gated remove. */
function EmojiRow({
  groupId,
  emoji,
  url,
  isOwner,
}: {
  groupId: GroupId;
  emoji: CustomEmoji;
  url: string | undefined;
  isOwner: boolean;
}): JSX.Element {
  const { t } = useAppTranslation();
  const currentUserId = useAuthStore((s) => s.user?.id) as UserId | undefined;
  const uploader = useChatStore((s) => s.users[emoji.createdBy]);
  const remove = useDeleteCustomEmoji(groupId);
  const [confirming, setConfirming] = useState(false);

  // Server rule: the uploader may remove their own; anyone else needs owner.
  // §35 — someone who cannot delete never sees the button.
  const canDelete = isOwner || (currentUserId !== undefined && emoji.createdBy === currentUserId);

  return (
    <li className="group flex items-center gap-3 rounded-xl bg-surface p-3 transition-colors motion-hover hover:bg-raised/60">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-app">
        {url ? (
          <img src={url} alt="" draggable={false} className="size-7 object-contain" />
        ) : (
          <Skeleton shape="rect" width={28} height={28} />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-label text-fg">:{emoji.name}:</p>
        <p className="truncate text-2xs text-fg-faint">
          {uploader?.displayName ?? t("desktop:chat.unknownUser")} · {Math.max(1, Math.round(emoji.sizeBytes / 1024))} KB
        </p>
      </div>

      {canDelete && (
        <IconButton
          variant="ghost"
          size="sm"
          label={t("desktop:emoji.delete")}
          disabled={remove.isPending}
          onClick={() => {
            remove.reset();
            setConfirming(true);
          }}
          className="opacity-60 hover:bg-danger-surface hover:text-danger group-hover:opacity-100 focus-visible:opacity-100"
        >
          <Trash2 />
        </IconButton>
      )}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t("desktop:emoji.deleteConfirmTitle")}
        description={t("desktop:emoji.deleteConfirmBody", { name: emoji.name })}
        confirmLabel={t("buttons.delete")}
        cancelLabel={t("buttons.cancel")}
        closeLabel={t("buttons.close")}
        pending={remove.isPending}
        onConfirm={() => remove.mutate(emoji.id, { onSuccess: () => setConfirming(false) })}
        error={remove.isError ? <FormErrorAlert>{emojiErrorText(remove.error, t)}</FormErrorAlert> : undefined}
      />
    </li>
  );
}
