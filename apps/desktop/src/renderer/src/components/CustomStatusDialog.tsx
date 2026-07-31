import { useEffect, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  cn,
} from "@demli/ui";
import {
  buildCustomStatusInput,
  type CustomStatusExpiry,
} from "@demli/client-core";
import { CUSTOM_STATUS_MAX_LENGTH } from "@demli/config";
import { FormErrorAlert } from "@demli/app-ui";
import { localizeError } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { useSetCustomStatus } from "../queries/social-queries";
import { useAuthStore } from "../stores/auth-store";
import { useUiStore } from "../stores/ui-store";

/**
 * The duration choices, their labels, and the request body all come from
 * `@demli/client-core` — this dialog only renders them.
 *
 * It used to own a private `minutesFor` and a hand-copied `128`. Mobile then
 * grew the same editor, the shared module was written for it, and this file was
 * left behind: two implementations of one rule, which is how the "today" choice
 * ends up clearing at different moments on a phone and a laptop. The shared one
 * additionally caps at the server's own ceiling, so a badly-wrong device clock
 * produces an honest rejection instead of a number the schema refuses outright.
 */
type Expiry = CustomStatusExpiry;

const EXPIRY_LABEL = {
  never: "desktop:customStatus.never",
  "30m": "desktop:customStatus.minutes30",
  "1h": "desktop:customStatus.hour1",
  today: "desktop:customStatus.today",
} as const satisfies Record<Expiry, string>;

/**
 * "Set a custom status" (M18) — a short free-text line shown under the user's
 * name, with an optional auto-clear.
 *
 * The text is stored and rendered as PLAIN TEXT: it goes out raw and comes back
 * escaped by React as a JSX child everywhere it is shown (roster row, profile
 * card, user footer). It is never fed to the markdown renderer or to
 * `dangerouslySetInnerHTML` — a status line is not a message and must not be able
 * to inject formatting or markup (§28).
 */
export function CustomStatusDialog(): JSX.Element {
  const { t } = useAppTranslation();
  const open = useUiStore((s) => s.customStatusDialogOpen);
  const setOpen = useUiStore((s) => s.setCustomStatusDialogOpen);
  const me = useAuthStore((s) => s.user);

  const setCustomStatus = useSetCustomStatus();
  const { reset } = setCustomStatus;

  const [text, setText] = useState("");
  const [expiry, setExpiry] = useState<Expiry>("never");

  // Seed from the CURRENT value each time the dialog opens, so "edit" really
  // edits. Read imperatively from the store rather than through the subscribed
  // `me` value on purpose: as a dependency it would re-seed — and so wipe what
  // the user is typing — on any unrelated update to their own user record.
  useEffect(() => {
    if (!open) {
      reset();
      return;
    }
    setText(useAuthStore.getState().user?.customStatus ?? "");
    setExpiry("never");
  }, [open, reset]);

  const busy = setCustomStatus.isPending;

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
    setCustomStatus.mutate(buildCustomStatusInput(text, expiry), {
      onSuccess: () => setOpen(false),
    });
  };

  const clear = (): void => {
    if (busy) return;
    setCustomStatus.mutate({ text: null }, { onSuccess: () => setOpen(false) });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("desktop:customStatus.dialogTitle")}</DialogTitle>
          <DialogDescription>{t("desktop:customStatus.dialogDescription")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <form onSubmit={submit}>
            {setCustomStatus.error && (
              <FormErrorAlert className="mb-3">
                {localizeError(setCustomStatus.error, t)}
              </FormErrorAlert>
            )}

            <Input
              value={text}
              onChange={(event) => setText(event.target.value)}
              maxLength={CUSTOM_STATUS_MAX_LENGTH}
              autoFocus
              placeholder={t("desktop:customStatus.textPlaceholder")}
              aria-label={t("desktop:customStatus.textLabel")}
            />
            <p className="mt-1.5 text-2xs text-fg-faint">
              {text.length}/{CUSTOM_STATUS_MAX_LENGTH}
            </p>

            <fieldset className="mt-4">
              <legend className="pb-2 text-2xs font-semibold uppercase tracking-wider text-fg-faint">
                {t("desktop:customStatus.clearAfter")}
              </legend>
              <div
                role="radiogroup"
                aria-label={t("desktop:customStatus.clearAfter")}
                className="flex flex-wrap gap-1.5"
              >
                {(["never", "30m", "1h", "today"] as Expiry[]).map((value) => {
                  const on = expiry === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setExpiry(value)}
                      className={cn(
                        "cursor-pointer rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors motion-instant",
                        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
                        on
                          ? "border-accent/60 bg-accent/10 text-fg"
                          : "border-stroke bg-raised text-fg-muted hover:text-fg",
                      )}
                    >
                      {t(EXPIRY_LABEL[value])}
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <div className="mt-5 flex gap-2">
              <Button type="submit" disabled={busy} className="flex-1">
                {busy && <Loader2 className="size-4 animate-spin" />}
                {t("desktop:customStatus.save")}
              </Button>
              {/* Only offered when there IS something to clear — an always-on
                  "Clear" next to an empty field would do nothing (§35). */}
              {(me?.customStatus ?? null) !== null && (
                <Button variant="secondary" disabled={busy} onClick={clear} className="flex-1">
                  {t("desktop:customStatus.clear")}
                </Button>
              )}
            </div>
          </form>
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
