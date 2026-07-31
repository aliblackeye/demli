import { EyeOff } from "lucide-react";
import { cn } from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";

/**
 * The "NSFW / 18+ channel" switch, shared by the create-channel and channel-
 * settings dialogs (text channels only). Marking a channel NSFW gates it behind
 * an age check for viewers (see {@link NsfwChannelGate}) and lets the server
 * accept NSFW-classified image uploads there.
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
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "flex w-full items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors motion-instant",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/70",
        "disabled:pointer-events-none disabled:opacity-50",
        checked
          ? "border-accent/50 bg-accent/[0.06]"
          : "border-stroke bg-raised/40 hover:bg-raised",
      )}
    >
      <EyeOff className={cn("size-4 shrink-0", checked ? "text-accent" : "text-fg-faint")} />
      <span className="min-w-0 flex-1">
        <span className="block text-[13px] font-medium text-fg">
          {t("desktop:channelNsfw.toggleLabel")}
        </span>
        <span className="block text-2xs text-fg-faint">
          {t("desktop:channelNsfw.toggleHint")}
        </span>
      </span>
      <span
        aria-hidden
        className={cn(
          "relative h-5 w-9 shrink-0 rounded-full transition-colors motion-instant",
          checked ? "bg-accent" : "bg-stroke-strong",
        )}
      >
        <span
          className={cn(
            "absolute top-0.5 size-4 rounded-full bg-white transition-transform motion-instant",
            checked ? "translate-x-[18px]" : "translate-x-0.5",
          )}
        />
      </span>
    </button>
  );
}
