import { useState } from "react";
import { TriangleAlert } from "lucide-react";
import { Button, Field, Input, cn } from "@demli/ui";
import { FormErrorAlert } from "@demli/app-ui";
import {
  ADULT_AGE,
  ageInYears,
  formatBirthdateDisplay,
  isBirthdateLockedError,
} from "@demli/client-core";
import type { User } from "@demli/types";
import { useAppTranslation } from "../lib/i18n";
import { errorKey, type CommonErrorKey } from "../lib/errors";
import { useUpdateProfile } from "../queries/chat-queries";

/**
 * In-place date-of-birth entry — the ONE verification form on desktop/web,
 * rendered both by the NSFW channel gate and by the one-time "verify your age"
 * reminder. Whoever mounts it, the flow and the promises are identical.
 *
 * ── Why it confirms before saving ───────────────────────────────────────────
 * `birthdate` is SET-ONCE: the server takes it exactly once and answers
 * `409 BIRTHDATE_LOCKED` for every later write. A typo is therefore permanent,
 * so a single "Save" click is not an acceptable interaction. The form has two
 * steps: type the date, then confirm a sentence that states the DATE and the AGE
 * it produces ("07.03.2000 — that makes you 26. Is that right?") plus the fact
 * that it is written once. An entry that would make the user a minor adds the
 * consequence in plain words BEFORE it is saved — we never let someone lock
 * themselves out without having read what would happen.
 *
 * ── After a successful save ─────────────────────────────────────────────────
 * `useUpdateProfile` writes the returned self record into the auth store AND the
 * `me` query cache, so every reader (`useMe`) re-derives `isAdult` immediately:
 * the gate that mounted this form re-renders to the next stage with no reload
 * and no refetch round-trip. Callers get {@link BirthdateVerificationProps.onSaved}
 * for anything extra (the reminder dialog uses it to show its own closing line);
 * the gate needs nothing, because it simply stops rendering this component.
 */

type Step = "input" | "confirm";

export interface BirthdateVerificationProps {
  /**
   * Fired once the server accepted the date, with the updated self record.
   * `user.isAdult` is the authoritative outcome — do not re-derive it from the
   * typed string, which is only what the user claimed.
   */
  onSaved?: (user: User) => void;
  /** Rendered next to Verify/Save (the reminder dialog puts its "Close" here). */
  secondaryAction?: React.ReactNode;
  className?: string;
}

/** Today as `YYYY-MM-DD` — the max selectable date, so no future DOB is offered. */
function todayISODate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function BirthdateVerification({
  onSaved,
  secondaryAction,
  className,
}: BirthdateVerificationProps): JSX.Element {
  const { t } = useAppTranslation();
  const updateProfile = useUpdateProfile();

  const [value, setValue] = useState("");
  const [step, setStep] = useState<Step>("input");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<CommonErrorKey | "desktop:birthdate.invalid" | null>(null);

  // Age of the typed date. `null` means "not a real, non-future calendar date",
  // which is exactly when the form must refuse to advance.
  const age = ageInYears(value);
  const isAdultEntry = age !== null && age >= ADULT_AGE;

  const toConfirm = (): void => {
    if (age === null) {
      setError("desktop:birthdate.invalid");
      return;
    }
    setError(null);
    setStep("confirm");
  };

  const save = async (): Promise<void> => {
    if (saving || age === null) return;
    setSaving(true);
    setError(null);
    try {
      const { user } = await updateProfile.mutateAsync({ birthdate: value });
      onSaved?.(user);
    } catch (err) {
      // A 409 means the server already holds a date of birth (another device
      // saved one, or this is a stale view). Its value is the truth and the
      // caller re-derives from the refreshed `me` record — so say what happened
      // instead of inviting a retry that can never succeed.
      setError(isBirthdateLockedError(err) ? "errors.birthdateLocked" : errorKey(err));
      setStep("input");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={cn("space-y-4 text-left", className)}>
      {/* A failure of the SAVE (network, already-set) is form-level; a bad date is
          the field's own problem and is written under it. */}
      {error && error !== "desktop:birthdate.invalid" && <FormErrorAlert>{t(error)}</FormErrorAlert>}

      {step === "input" ? (
        <div key="input" className="animate-fade-in space-y-4">
          <Field
            label={t("desktop:birthdate.label")}
            help={t("desktop:birthdate.once")}
            error={error === "desktop:birthdate.invalid" ? t(error) : undefined}
          >
            <Input
              id="birthdate-verify"
              type="date"
              value={value}
              max={todayISODate()}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
            />
          </Field>
          <div className="flex items-center gap-2">
            <Button variant="primary" className="flex-1" onClick={toConfirm} disabled={age === null}>
              {t("desktop:birthdate.verify")}
            </Button>
            {secondaryAction}
          </div>
        </div>
      ) : (
        <div key="confirm" className="animate-fade-in space-y-4">
          <div className="space-y-2 rounded-xl bg-surface p-4">
            <p className="text-sm leading-relaxed text-fg">
              {t("desktop:birthdate.confirmQuestion", {
                date: formatBirthdateDisplay(value),
                age: age ?? 0,
              })}
            </p>
            <p className="text-label text-fg-faint">{t("desktop:birthdate.once")}</p>
            {/* The under-18 consequence is stated BEFORE the write, never after —
                this is the one screen where "undo" does not exist. */}
            {!isAdultEntry && (
              <p className="flex items-start gap-2 rounded-lg bg-danger-surface px-3 py-2 text-label leading-relaxed text-danger">
                <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                {t("desktop:birthdate.minorWarning")}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              onClick={() => setStep("input")}
              disabled={saving}
            >
              {t("desktop:birthdate.back")}
            </Button>
            <Button variant="primary" className="flex-1" onClick={() => void save()} loading={saving}>
              {t("desktop:birthdate.save")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
