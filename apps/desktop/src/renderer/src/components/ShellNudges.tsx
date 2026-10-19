import { useIsMobileViewport } from "../hooks/useMediaQuery";
import { AgeVerifyPrompt } from "./AgeVerifyPrompt";
import { DownloadPrompt } from "./DownloadPrompt";

/**
 * The shell's two dismissible nudges — the one-time "verify your age" reminder
 * and the web-only "get the native app" pill — placed where they cover NOTHING.
 *
 *   column   (wide shell) — in flow at the foot of the second column, directly
 *            above the voice panel / user bar. They used to float fixed over the
 *            bottom-left corner, which on the island layout sat on top of the
 *            rail's add-server tile and the user bar's mic button.
 *   floating (narrow web shell) — fixed above the composer, clear of its attach
 *            button; the second column lives in a drawer there.
 *
 * Each placement renders nothing on the other layout, so exactly one copy is on
 * screen; each nudge still renders nothing at all once it does not apply
 * (dismissed, desktop app, no build for this device).
 */
export function ShellNudges({ placement }: { placement: "column" | "floating" }): JSX.Element | null {
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
      className="fixed left-3 z-30 flex flex-col items-start gap-2"
      style={{ bottom: "calc(6rem + env(safe-area-inset-bottom))" }}
    >
      <AgeVerifyPrompt />
      <DownloadPrompt variant="floating" />
    </div>
  );
}
