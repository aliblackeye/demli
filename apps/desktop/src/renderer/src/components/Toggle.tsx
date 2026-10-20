import { Switch } from "@demli/ui";

/**
 * The settings on/off control. Now a thin adapter over the Koyu Masa `Switch`
 * primitive (44×24, thumb on the authored position spring, tone-only hover,
 * focus-visible ring) so every switch in the product is the same control.
 *
 * The prop shape (`checked` / `onChange` / `label`) is kept so existing call
 * sites and the echo-cancellation test — which finds the control as
 * `button[role="switch"][aria-label=…]` — keep working unchanged.
 */
export function Toggle({
  checked,
  disabled,
  onChange,
  label,
  describedBy,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
  label: string;
  /** Id of the row's description line, so the switch announces what it does. */
  describedBy?: string;
}): JSX.Element {
  return (
    <Switch
      checked={checked}
      disabled={disabled}
      onCheckedChange={onChange}
      aria-label={label}
      aria-describedby={describedBy}
    />
  );
}
