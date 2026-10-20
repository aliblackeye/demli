import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from "react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  RadioGroup,
  RadioItem,
  UserAvatar,
} from "@demli/ui";
import {
  buildCustomStatusInput,
  customStatusExpiryMinutes,
  type CustomStatusExpiry,
} from "@demli/client-core";
import { CUSTOM_STATUS_MAX_LENGTH } from "@demli/config";
import { FormErrorAlert } from "@demli/app-ui";
import { localizeError } from "../lib/errors";
import { useAppTranslation } from "../lib/i18n";
import { useSetCustomStatus } from "../queries/social-queries";
import { useAuthStore } from "../stores/auth-store";
import { useChatStore } from "../stores/chat-store";
import { useUiStore } from "../stores/ui-store";
import { presenceLabel } from "./ProfileCard";

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

const EXPIRIES: Expiry[] = ["never", "30m", "1h", "today"];

/**
 * "Set a custom status" (M18) — a short free-text line shown under the user's
 * name, with an optional auto-clear.
 *
 * The preview under the field draws the line the way the member list does
 * (avatar with presence + name + status), and the selected auto-clear states
 * the exact clock time it will clear at — so neither "how will it look" nor
 * "when does Today end" is left to guess.
 *
 * The text is stored and rendered as PLAIN TEXT: it goes out raw and comes back
 * escaped by React as a JSX child everywhere it is shown (roster row, profile
 * card, user footer). It is never fed to the markdown renderer or to
 * `dangerouslySetInnerHTML` — a status line is not a message and must not be able
 * to inject formatting or markup (§28).
 */
export function CustomStatusDialog(): JSX.Element {
  const { t, i18n } = useAppTranslation();
  const open = useUiStore((s) => s.customStatusDialogOpen);
  const setOpen = useUiStore((s) => s.setCustomStatusDialogOpen);
  const me = useAuthStore((s) => s.user);
  // Own presence only — a one-user slice, so a roster tick never re-renders this.
  const myPresence = useChatStore((s) => (me ? s.presence[me.id] : undefined));

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
  const trimmed = text.trim();

  // "Clears at 18:00" for the chosen expiry, from the SAME minutes the request
  // will carry (shared rule), so the promise and the request cannot disagree.
  const clearsAt = useMemo(() => {
    const minutes = customStatusExpiryMinutes(expiry);
    if (minutes === undefined) return null;
    const at = new Date(Date.now() + minutes * 60_000);
    const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit" };
    try {
      return new Intl.DateTimeFormat(i18n.language, opts).format(at);
    } catch {
      return new Intl.DateTimeFormat("en", opts).format(at);
    }
  }, [expiry, i18n.language]);

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

  const name = me?.displayName ?? t("desktop:footer.you");

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && setOpen(next)}>
      <DialogContent closeLabel={t("buttons.close")}>
        <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
          <DialogHeader>
            <DialogTitle>{t("desktop:customStatus.dialogTitle")}</DialogTitle>
            <DialogDescription>{t("desktop:customStatus.dialogDescription")}</DialogDescription>
          </DialogHeader>
          <DialogBody className="space-y-5">
            {setCustomStatus.error && (
              <FormErrorAlert>{localizeError(setCustomStatus.error, t)}</FormErrorAlert>
            )}

            <Field
              label={t("desktop:customStatus.textLabel")}
              help={
                <span className={text.length >= CUSTOM_STATUS_MAX_LENGTH ? "text-danger" : undefined}>
                  {t("desktop:customStatus.count", { count: text.length, max: CUSTOM_STATUS_MAX_LENGTH })}
                </span>
              }
            >
              <Input
                value={text}
                onChange={(event) => setText(event.target.value)}
                maxLength={CUSTOM_STATUS_MAX_LENGTH}
                autoFocus
                placeholder={t("desktop:customStatus.textPlaceholder")}
              />
            </Field>

            {/* How the line reads in the member list. */}
            <div className="space-y-1.5">
              <p className="text-label font-medium text-fg-muted">
                {t("desktop:customStatus.previewHeading")}
              </p>
              <div
                className="flex items-center gap-3 rounded-xl bg-surface px-3 py-2.5"
                style={{ "--avatar-ring": "var(--color-surface)" } as CSSProperties}
              >
                <UserAvatar
                  name={name}
                  colorSeed={me?.id}
                  src={me?.avatarUrl}
                  size="md"
                  presence={myPresence}
                  presenceLabel={myPresence ? presenceLabel(t, myPresence) : undefined}
                />
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-fg">{name}</p>
                  {/* Empty: the placeholder, visibly faint, so an example is
                      never mistaken for what will be saved. */}
                  <p
                    className={
                      trimmed.length > 0 ? "truncate text-label text-fg-muted" : "truncate text-label italic text-fg-faint"
                    }
                  >
                    {trimmed.length > 0 ? trimmed : t("desktop:customStatus.textPlaceholder")}
                  </p>
                </div>
              </div>
            </div>

            <fieldset>
              <legend className="pb-2 text-label font-medium text-fg-muted">
                {t("desktop:customStatus.clearAfter")}
              </legend>
              <RadioGroup
                value={expiry}
                onValueChange={(value) => setExpiry(value as Expiry)}
                aria-label={t("desktop:customStatus.clearAfter")}
                className="grid grid-cols-2 gap-1"
              >
                {EXPIRIES.map((value) => (
                  <RadioItem key={value} value={value} label={t(EXPIRY_LABEL[value])} />
                ))}
              </RadioGroup>
              <p className="mt-2 min-h-[1.125rem] text-label text-fg-faint" aria-live="polite">
                {clearsAt ? t("desktop:customStatus.expiresAt", { time: clearsAt }) : null}
              </p>
            </fieldset>
          </DialogBody>
          <DialogFooter>
            {/* Only offered when there IS something to clear — an always-on
                "Clear" next to an empty field would do nothing (§35). */}
            {(me?.customStatus ?? null) !== null && (
              <Button type="button" variant="ghost" disabled={busy} onClick={clear} className="mr-auto">
                {t("desktop:customStatus.clear")}
              </Button>
            )}
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>
              {t("buttons.cancel")}
            </Button>
            <Button type="submit" variant="primary" loading={busy}>
              {t("desktop:customStatus.save")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
