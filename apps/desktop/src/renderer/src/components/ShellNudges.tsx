import { useIsMobileViewport } from "../hooks/useMediaQuery";
import { AgeVerifyPrompt } from "./AgeVerifyPrompt";
import { DownloadPrompt } from "./DownloadPrompt";

/**
 * The shell's two dismissible nudges — the one-time "verify your age" reminder
 * and the web-only "get the native app" pill — placed IN FLOW so they cover
 * nothing on either layout:
 *
 *   column (wide shell)  — at the foot of the second column, directly above the
 *          voice panel / user bar. They used to float fixed over the bottom-left
 *          corner, which on the island layout sat on top of the rail's
 *          add-server tile and the user bar's mic button.
 *   bar    (narrow web shell) — a row under the phone top bar, above the
 *          conversation island. They used to float fixed above the composer,
 *          where they hid the newest messages and collided with the root notice
 *          stack (which owns that band alone now).
 *
 * Each placement renders nothing on the other layout, so exactly one copy is on
 * screen; each nudge still renders nothing at all once it does not apply
 * (dismissed, desktop app, no build for this device), and `empty:hidden` then
 * collapses the row so it leaves no gap.
 */
export function ShellNudges({ placement }: { placement: "column" | "bar" }): JSX.Element | null {
  const isMobile = useIsMobileViewport();
  if (placement === "column" ? isMobile : !isMobile) return null;
  if (placement === "column") {
    return (
      <div className="flex shrink-0 flex-col items-start gap-1.5 px-2 pb-2 empty:hidden">
        <AgeVerifyPrompt />
        <DownloadPrompt variant="floating" />
      </div>
    );
  }
  return (
    <div
      data-nudges="bar"
      // One line, never two: on a phone the pills scroll sideways rather than
      // stacking and taking a tenth of the screen from the conversation.
      className="flex shrink-0 items-center gap-2 overflow-x-auto px-3 pb-2 empty:hidden [&>*]:shrink-0"
    >
      <AgeVerifyPrompt />
      <DownloadPrompt variant="floating" />
    </div>
  );
}
