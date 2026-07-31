import { cn } from "@demli/ui";

/**
 * On-brand switch. Previously copy-pasted into SoundSettings / SystemSettings /
 * SourcePicker with a thumb that drifted past the track edge when checked: the
 * unchecked state used a layout `border` (shrinking the content box) while the
 * checked state had none, so the same `translate-x` values landed differently
 * in each state and the thumb poked out of the track.
 *
 * Fix: the resting outline is a `ring` (which does NOT affect box size), so the
 * track's content box is a constant 36×20 in both states. The thumb (16×16) then
 * sits with a symmetric 2px inset on every edge — `top-0.5 left-0.5` plus a
 * `translate-x-0 → translate-x-4` (0 → 16px) slide across the remaining 16px.
 *
 * Renderer-local for now; a candidate to promote into `packages/ui` as a proper
 * Radix Switch once a second surface needs it (noted in the i18n-desktop report).
 */
export function Toggle({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
}): JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors motion-instant",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        disabled && "cursor-not-allowed opacity-50",
        checked
          ? "bg-accent hover:bg-accent-hover"
          : "bg-raised ring-1 ring-inset ring-stroke hover:bg-overlay",
      )}
    >
      <span
        className={cn(
          "absolute left-0.5 top-0.5 size-4 rounded-full bg-white shadow-sm transition-transform motion-instant",
          checked ? "translate-x-4" : "translate-x-0",
        )}
      />
    </button>
  );
}
