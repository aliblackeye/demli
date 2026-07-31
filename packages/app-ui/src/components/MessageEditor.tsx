/**
 * MessageEditor — the SINGLE-SOURCE in-place editor for a message body (CLAUDE.md
 * §8), shared by the desktop renderer and (Phase 4) the web app. Mirrors the
 * composer textarea ergonomics: auto-resize, Enter saves, Shift+Enter inserts a
 * newline, Escape cancels. The edit is committed via the `onSave` slot
 * (PATCH /messages/:id over the shared client); the resulting `message.updated`
 * broadcast reconciles the cache, so this component just reports pending/error
 * and exits on success.
 *
 * Mentions: the stored `<@id>` encoding is shown as friendly `@Name` while
 * editing and re-serialized to `<@id>` on save (a mention deleted while editing
 * simply drops). Name lookup is not a store dependency here — the surface passes
 * `resolveMentionName` so this stays presentational; new mentions are added from
 * the composer, not here.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MESSAGE_MAX_LENGTH } from "@demli/config";
import { deserializeMentions, friendlyErrorMessage, serializeMentions } from "@demli/client-core";
import { useTranslation } from "@demli/i18n";
import { cn } from "@demli/ui";

const MAX_HEIGHT_PX = 320;

export function MessageEditor({
  initialValue,
  onSave,
  onCancel,
  resolveMentionName,
}: {
  initialValue: string;
  /** Persist the edit; resolves on success (row exits edit mode), rejects on error. */
  onSave: (content: string) => Promise<void>;
  onCancel: () => void;
  /** Resolve a mentioned user id to a display name (or null when unknown). */
  resolveMentionName: (userId: string) => string | null;
}): JSX.Element {
  const { t } = useTranslation(["common", "desktop"]);
  // De-serialize once at mount: `<@id>` → `@Name`, remembering the ids so save
  // can round-trip them back. Names come from the surface's users directory
  // (already loaded for a message you can see).
  const [seed] = useState(() => deserializeMentions(initialValue, resolveMentionName));
  const [value, setValue] = useState(seed.text);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  /** The edit as it would be stored (mentions rewritten to `<@id>`). */
  const serialized = serializeMentions(value, seed.mentions);

  // Auto-resize to fit content (capped, then scrolls) — matches the composer.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [value]);

  // Focus + place the caret at the end when editing opens.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  const trimmed = serialized.trim();
  const unchanged = trimmed === initialValue.trim();
  const canSave = trimmed.length > 0 && !unchanged && !pending;

  const save = (): void => {
    if (trimmed.length === 0) {
      // An emptied message is a delete, not an edit — the server rejects blank
      // content. Keep it simple: require the confirm-delete affordance instead.
      setError(t("desktop:chat.editEmpty"));
      return;
    }
    if (unchanged) {
      onCancel();
      return;
    }
    setPending(true);
    setError(null);
    onSave(trimmed).then(
      () => {
        /* success: the row leaves edit mode via the parent */
      },
      (err: unknown) => {
        setPending(false);
        setError(friendlyErrorMessage(err));
      },
    );
  };

  return (
    <div className="mt-0.5">
      <textarea
        ref={ref}
        value={value}
        rows={1}
        maxLength={MESSAGE_MAX_LENGTH}
        disabled={pending}
        aria-label={t("desktop:chat.editingAria")}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            if (canSave || (trimmed.length > 0 && unchanged)) save();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        className={cn(
          "w-full resize-none rounded-md border border-stroke bg-raised px-3 py-2 text-sm leading-[1.45] text-fg",
          "placeholder:text-fg-faint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
          "max-h-80 overflow-y-auto",
        )}
      />
      {/* Safari 12 has no flex `gap`; `space-x-2` reproduces the control gutter. */}
      <div className="mt-1 flex items-center space-x-2 text-2xs text-fg-faint">
        {error ? (
          <span className="text-danger">{error}</span>
        ) : (
          <>
            <button
              type="button"
              onClick={onCancel}
              className="rounded-sm text-fg-muted hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70"
            >
              {t("buttons.cancel")}
            </button>
            <span aria-hidden>·</span>
            <button
              type="button"
              onClick={save}
              disabled={!canSave}
              className="rounded-sm font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70 disabled:opacity-40 disabled:hover:no-underline"
            >
              {t("buttons.save")}
            </button>
            <span aria-hidden>·</span>
            <span>{t("desktop:chat.editHint")}</span>
          </>
        )}
      </div>
    </div>
  );
}
