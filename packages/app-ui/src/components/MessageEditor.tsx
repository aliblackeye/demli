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
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { MESSAGE_MAX_LENGTH } from "@demli/config";
import { deserializeMentions, friendlyErrorMessage, serializeMentions } from "@demli/client-core";
import { useTranslation } from "@demli/i18n";
import { Kbd, cn } from "@demli/ui";

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
  const hintId = useId();
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
    <div className="mt-1 animate-fade-in">
      <textarea
        ref={ref}
        value={value}
        rows={1}
        maxLength={MESSAGE_MAX_LENGTH}
        disabled={pending}
        aria-label={t("desktop:chat.editingAria")}
        aria-invalid={error ? true : undefined}
        aria-describedby={hintId}
        onChange={(e) => {
          setValue(e.target.value);
          if (error) setError(null);
        }}
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
          // The composer's field recipe, so editing in place reads as the same
          // input: raised tone (it is focused from the first frame), coral caret,
          // a faint coral inner trace; the danger wash replaces it on an error.
          "w-full resize-none rounded-lg bg-raised px-3.5 py-2.5 text-sm leading-[1.45] text-fg caret-accent",
          "shadow-[inset_0_0_0_1px_var(--color-accent-glow)] transition-[background-color,box-shadow] motion-hover",
          "placeholder:text-fg-faint focus:outline-none",
          "aria-[invalid=true]:bg-danger/12 aria-[invalid=true]:shadow-none",
          "disabled:opacity-60",
          "max-h-80 overflow-y-auto",
        )}
      />
      <div id={hintId} className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-2xs text-fg-faint">
        {error ? (
          <span role="alert" className="text-label text-danger">
            {error}
          </span>
        ) : (
          <>
            <Kbd>Esc</Kbd>
            <button
              type="button"
              onClick={onCancel}
              className="rounded-sm font-medium text-fg-muted transition-colors motion-hover hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {t("buttons.cancel")}
            </button>
            <span aria-hidden className="text-fg-subtle">
              ·
            </span>
            <Kbd>Enter</Kbd>
            <button
              type="button"
              onClick={save}
              disabled={!canSave}
              className="rounded-sm font-medium text-accent transition-colors motion-hover hover:text-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-default disabled:opacity-40"
            >
              {t("buttons.save")}
            </button>
            <span aria-hidden className="text-fg-subtle">
              ·
            </span>
            <span>{t("desktop:chat.editHint")}</span>
          </>
        )}
      </div>
    </div>
  );
}
