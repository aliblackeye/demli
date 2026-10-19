import { useState } from "react";
import { CalendarCheck, Check, X } from "lucide-react";
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
import { shouldPromptForBirthdate } from "@demli/client-core";
import { floatingPillClass, floatingPillItemClass } from "@demli/app-ui";
import { useAppTranslation } from "../lib/i18n";
import { useMe } from "../queries/social-queries";
import { useAgePromptStore } from "../stores/age-prompt-store";
import { BirthdateVerification } from "./BirthdateVerification";

/**
 * The proactive, ONE-TIME "verify your age" reminder (desktop + web).
 *
 * ── Why a dismissible pill and not a banner or a modal ──────────────────────
 * Most accounts have no date of birth on file, and today most of them will never
 * open an age-restricted channel. A blocking dialog or a permanent strip would
 * punish everyone for a feature they may never use — the founder's line is that
 * nothing may make the app unusable. So this is the same affordance the web
 * "get the native app" nudge already uses: a small pill in the corner, outside
 * the column layout (it can never push or cover chat), dismissed with one click
 * and then gone for good. Enforcement lives where it belongs — at the NSFW
 * channel gate, which nobody can walk past.
 *
 * It renders only once `/users/me` has really been read (`isSuccess`): before
 * that, a not-yet-loaded record is indistinguishable from "no birthdate" and the
 * pill would flash on every cold start.
 *
 * The dialog it opens hosts the SAME {@link BirthdateVerification} form the gate
 * uses, so the set-once confirmation and the under-18 warning are identical
 * wherever the user verifies.
 */
export function AgeVerifyPrompt(): JSX.Element | null {
  const { t } = useAppTranslation();
  const me = useMe();
  const userId = me.data?.id ?? null;
  const dismissed = useAgePromptStore((s) => (userId ? (s.dismissedByUser[userId] ?? false) : true));
  const dismiss = useAgePromptStore((s) => s.dismiss);

  const [open, setOpen] = useState(false);
  /** Set after a successful save so the dialog can close on the user's terms. */
  const [savedAdult, setSavedAdult] = useState<boolean | null>(null);

  const visible = shouldPromptForBirthdate({
    // `isFetched`, NOT `isSuccess`: `useMe` seeds itself from the auth-store user
    // via `initialData`, which makes the query "successful" on the very first
    // render. Only a resolved fetch means the real /users/me — the one endpoint
    // guaranteed to carry the me-only birthdate — actually landed.
    selfLoaded: me.isFetched && userId !== null,
    birthdateSet: Boolean(me.data?.birthdate),
    dismissed,
  });

  // Keep the dialog mounted while it is open even if the pill's own condition
  // just flipped (the save that closed it also cleared `birthdateSet`'s absence).
  if (!visible && !open) return null;

  const closeDialog = (): void => {
    setOpen(false);
    setSavedAdult(null);
    // Closing a dialog you deliberately opened is an answer either way — you
    // verified, or you decided not to. Both retire the nudge for this account:
    // asking again after that is the nagging this design exists to avoid, and
    // the NSFW gate still stops anyone who actually needs to verify.
    if (userId) dismiss(userId);
  };

  return (
    <>
      {visible && (
        <div className={floatingPillClass}>
          <button type="button" onClick={() => setOpen(true)} className={floatingPillItemClass}>
            <CalendarCheck aria-hidden className="size-4 text-accent" />
            {t("desktop:ageVerify.pill")}
          </button>
          <button
            type="button"
            aria-label={t("desktop:ageVerify.dismiss")}
            title={t("desktop:ageVerify.dismiss")}
            onClick={() => userId && dismiss(userId)}
            className={cn(floatingPillItemClass, "p-1.5 text-fg-faint hover:text-fg")}
          >
            <X aria-hidden className="size-3.5" />
          </button>
        </div>
      )}

      <Dialog open={open} onOpenChange={(next) => (next ? setOpen(true) : closeDialog())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("desktop:ageVerify.dialogTitle")}</DialogTitle>
            <DialogDescription>{t("desktop:ageVerify.dialogBody")}</DialogDescription>
          </DialogHeader>
          <DialogBody>
            {savedAdult === null ? (
              <BirthdateVerification
                onSaved={(user) => setSavedAdult(user.isAdult === true)}
                secondaryAction={
                  <Button variant="ghost" onClick={closeDialog}>
                    {t("desktop:ageVerify.close")}
                  </Button>
                }
              />
            ) : (
              <div className="space-y-4">
                <p className="flex animate-fade-in items-start gap-2.5 rounded-xl bg-surface p-4 text-sm leading-relaxed text-fg">
                  <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
                  {savedAdult
                    ? t("desktop:birthdate.doneAdult")
                    : t("desktop:birthdate.doneMinor")}
                </p>
                <Button variant="primary" className="w-full" onClick={closeDialog}>
                  {t("desktop:ageVerify.close")}
                </Button>
              </div>
            )}
          </DialogBody>
        </DialogContent>
      </Dialog>
    </>
  );
}
