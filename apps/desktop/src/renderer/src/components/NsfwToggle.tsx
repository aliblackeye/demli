import { useId } from "react";
import { EyeOff } from "lucide-react";
import { Switch, cn } from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";

/**
 * The "NSFW / 18+ channel" switch, shared by the create-channel and channel-
 * settings dialogs (text channels only). Marking a channel NSFW gates it behind
 * an age check for viewers (see {@link NsfwChannelGate}) and lets the server
 * accept NSFW-classified image uploads there.
 *
 * A setting row: the whole row is the hit target (a <label> around the real
 * `Switch`), the switch is named by the row title and described by the hint.
 */
export function NsfwToggle({
  checked,
  onChange,
  disabled = false,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}): JSX.Element {
  const { t } = useAppTranslation();
  const id = useId();
  return (
    <label
      htmlFor={id}
      className={cn(
        "flex w-full cursor-pointer items-center gap-3 rounded-xl px-3.5 py-3 transition-colors motion-hover",
        checked ? "bg-accent-surface" : "bg-surface hover:bg-raised/60",
        disabled && "pointer-events-none opacity-40",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg transition-colors motion-hover",
          checked ? "bg-accent/20 text-accent" : "bg-raised/60 text-fg-muted",
        )}
      >
        <EyeOff className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span id={`${id}-label`} className="block text-sm font-medium text-fg">
          {t("desktop:channelNsfw.toggleLabel")}
        </span>
        <span id={`${id}-hint`} className="block text-label text-fg-faint">
          {t("desktop:channelNsfw.toggleHint")}
        </span>
      </span>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-hint`}
      />
    </label>
  );
}
