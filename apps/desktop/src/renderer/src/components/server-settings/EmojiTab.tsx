import { useRef, useState } from "react";
import { Loader2, Trash2, Upload } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  cn,
} from "@demli/ui";
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
import { useAppTranslation, type AppTFunction } from "../../lib/i18n";
import {
  useCreateCustomEmoji,
  useCustomEmojiMap,
  useCustomEmojis,
  useDeleteCustomEmoji,
} from "../../queries/chat-queries";
import { useAuthStore } from "../../stores/auth-store";
import { useChatStore } from "../../stores/chat-store";

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
  const { data, isPending } = useCustomEmojis(groupId);
  const urls = useCustomEmojiMap(groupId);
  const create = useCreateCustomEmoji(groupId);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [name, setName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);

  const emojis = data?.emojis ?? [];
  const maxPerGroup = data?.maxPerGroup ?? CUSTOM_EMOJI_MAX_PER_GROUP;
  const full = emojis.length >= maxPerGroup;
  const normalizedName = name.trim().toLowerCase();
  const nameValid = isCustomEmojiName(normalizedName);
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

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-sm text-fg-muted">{t("desktop:emoji.hint")}</p>
        <span className="shrink-0 text-xs tabular-nums text-fg-faint">
          {t("desktop:emoji.count", { used: emojis.length, max: maxPerGroup })}
        </span>
      </div>

      {/* Upload form. Disabled — not hidden — when the group is full, with the
          reason spelled out, so the affordance is never silently inert (§35). */}
      <div className="rounded-lg border border-stroke bg-raised/40 p-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="min-w-[9rem] flex-1">
            <span className="mb-1 block text-xs font-medium text-fg-muted">
              {t("desktop:emoji.name")}
            </span>
            <div className="flex items-center rounded-md border border-stroke bg-app px-2">
              <span className="select-none text-sm text-fg-faint">:</span>
              <input
                value={name}
                disabled={full}
                maxLength={CUSTOM_EMOJI_NAME_MAX_LENGTH}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("desktop:emoji.namePlaceholder")}
                aria-label={t("desktop:emoji.name")}
                className="min-w-0 flex-1 bg-transparent py-1.5 text-sm text-fg placeholder:text-fg-faint focus:outline-none"
              />
              <span className="select-none text-sm text-fg-faint">:</span>
            </div>
          </label>

          <input
            ref={fileInputRef}
            type="file"
            accept={CUSTOM_EMOJI_MIMES.join(",")}
            className="hidden"
            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
          />
          <Button
            variant="secondary"
            disabled={full}
            onClick={() => fileInputRef.current?.click()}
          >
            <Upload className="size-4" />
            {file ? file.name : t("desktop:emoji.pickFile")}
          </Button>
          <Button disabled={!canSubmit} onClick={submit}>
            {create.isPending && <Loader2 className="size-4 animate-spin" />}
            {t("desktop:emoji.upload")}
          </Button>
        </div>

        <p className="mt-2 text-2xs text-fg-faint">
          {t("desktop:emoji.nameHint")} · {t("desktop:emoji.tooLarge", { max: MAX_KB })} · PNG
          {" / "}
          WebP
        </p>
        {full && (
          <p className="mt-1 text-xs text-idle">
            {t("desktop:emoji.limit", { max: maxPerGroup })}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-1 text-xs text-danger">
            {error}
          </p>
        )}
      </div>

      {isPending ? (
        <div className="flex justify-center py-8">
          <Loader2 className="size-4 animate-spin text-fg-faint" />
        </div>
      ) : emojis.length === 0 ? (
        <p className="py-8 text-center text-sm text-fg-muted">{t("desktop:emoji.empty")}</p>
      ) : (
        <ul className="divide-y divide-stroke/60 rounded-lg border border-stroke">
          {emojis.map((emoji) => (
            <EmojiRow
              key={emoji.id}
              groupId={groupId}
              emoji={emoji}
              url={urls.get(emoji.name)}
              isOwner={isOwner}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

/** One emoji row: preview, shortcode, uploader, and a gated remove. */
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
  const [error, setError] = useState<string | null>(null);

  // Server rule: the uploader may remove their own; anyone else needs owner.
  // §35 — someone who cannot delete never sees the button.
  const canDelete = isOwner || (currentUserId !== undefined && emoji.createdBy === currentUserId);

  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-raised/60">
        {url ? (
          <img src={url} alt="" draggable={false} className="size-6 object-contain" />
        ) : (
          <Loader2 className="size-3.5 animate-spin text-fg-faint" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate font-mono text-[13px] text-fg">:{emoji.name}:</p>
        <p className="truncate text-2xs text-fg-faint">
          {uploader?.displayName ?? t("desktop:chat.unknownUser")} ·{" "}
          {Math.max(1, Math.round(emoji.sizeBytes / 1024))} KB
        </p>
        {error && (
          <p role="alert" className="text-2xs text-danger">
            {error}
          </p>
        )}
      </div>

      {canDelete && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("desktop:emoji.delete")}
          disabled={remove.isPending}
          onClick={() => setConfirming(true)}
          className={cn("shrink-0 text-fg-faint hover:text-danger")}
        >
          <Trash2 className="size-4" />
        </Button>
      )}

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("desktop:emoji.deleteConfirmTitle")}</DialogTitle>
            <DialogDescription>
              {t("desktop:emoji.deleteConfirmBody", { name: emoji.name })}
            </DialogDescription>
          </DialogHeader>
          <DialogBody>
            <div className="mt-2 flex gap-2">
              <Button
                variant="danger"
                disabled={remove.isPending}
                className="flex-1"
                onClick={() => {
                  setError(null);
                  remove.mutate(emoji.id, {
                    onSuccess: () => setConfirming(false),
                    onError: (err) => {
                      setConfirming(false);
                      setError(emojiErrorText(err, t));
                    },
                  });
                }}
              >
                {t("buttons.delete")}
              </Button>
              <Button
                variant="secondary"
                disabled={remove.isPending}
                className="flex-1"
                onClick={() => setConfirming(false)}
              >
                {t("buttons.cancel")}
              </Button>
            </div>
          </DialogBody>
        </DialogContent>
      </Dialog>
    </li>
  );
}
