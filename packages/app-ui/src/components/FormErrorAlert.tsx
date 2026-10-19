import type { ReactNode } from "react";
import { cn } from "@demli/ui";

/** What a form-level band is saying: a failure, a caution, or a neutral heads-up. */
export type FormAlertTone = "danger" | "warning" | "accent";

const TONE_CLASS: Record<FormAlertTone, string> = {
  danger: "bg-danger-surface text-danger",
  warning: "bg-warning/12 text-warning",
  accent: "bg-accent-surface text-accent-hover",
};

/**
 * The form-level band (Koyu Masa validation recipe: per-field errors sit under
 * their field via `@demli/ui` Field; anything that belongs to the whole form —
 * a refused sign-in, a failed save — is this band). A soft wash of the tone with
 * the tone's own ink, no border, radius 12, 13px.
 *
 * `tone="danger"` (the default, and every existing call site) is
 * `role="alert"` so a submit failure is announced; the other tones are polite
 * `role="status"` notices ("your session ended", "re-enter the password for …").
 *
 * The bottom margin between the band and the field it precedes varies by form,
 * so it is left to the caller via `className` — the band owns only its own box.
 */
export function FormErrorAlert({
  children,
  tone = "danger",
  className,
}: {
  children: ReactNode;
  tone?: FormAlertTone;
  className?: string;
}): JSX.Element {
  return (
    <p
      role={tone === "danger" ? "alert" : "status"}
      className={cn(
        "animate-fade-in rounded-lg px-3.5 py-2.5 text-label",
        TONE_CLASS[tone],
        className,
      )}
    >
      {children}
    </p>
  );
}
