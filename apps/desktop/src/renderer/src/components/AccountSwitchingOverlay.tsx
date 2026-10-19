import { AnimatePresence, m } from "framer-motion";
import { Loader2, WifiOff } from "lucide-react";
import { overlayFade } from "@demli/app-ui";
import demliLogo from "../assets/demli-logo.svg";
import { useAppTranslation } from "../lib/i18n";
import { useAccountsStore } from "../stores/accounts-store";
import { NoticeToast } from "./NoticeToast";

/** How long the offline toast lingers before auto-dismissing. */
const SWITCH_ERROR_TOAST_MS = 4_000;

/**
 * Full-screen covering overlay shown while an account switch is in flight
 * (ADR 0013). It hides the app during the ordered teardown+bringup so no
 * previous-account data ever flashes before the new identity's stores/cache are
 * clean and its profile is loaded — which is why it is OPAQUE (the black page
 * tone, the boot splash's single warm light behind the mark), not a translucent
 * veil the old account could show through.
 */
export function AccountSwitchingOverlay(): JSX.Element {
  const { t } = useAppTranslation();
  const switching = useAccountsStore((s) => s.switching);

  return (
    <AnimatePresence>
      {switching && (
        // Covering overlay: fades in over the teardown and fades OUT to reveal the
        // freshly-loaded new-account app (opacity only — no transform on a
        // full-screen layer).
        <m.div
          key="switching"
          role="status"
          aria-live="polite"
          variants={overlayFade}
          initial="initial"
          animate="animate"
          exit="exit"
          className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-5 bg-rail"
          style={{
            backgroundImage:
              "radial-gradient(42% 32% at 50% 44%, var(--color-accent-glow), transparent 72%)",
          }}
        >
          <img src={demliLogo} alt="" className="size-16" draggable={false} />
          <p className="flex items-center gap-2 text-sm font-medium text-fg-muted">
            <Loader2 aria-hidden className="size-4 animate-spin text-accent" />
            {t("desktop:accounts.switching")}
          </p>
        </m.div>
      )}
    </AnimatePresence>
  );
}

/**
 * The transient "couldn't switch — offline" notice (#100): when a switch is
 * CANCELLED because the target account was unreachable, the current session
 * stays put and this soft, auto-dismissing notice explains why.
 *
 * A member of the app-root {@link AppNoticeStack} like every other root notice —
 * it used to position itself at the stack's exact spot as a separate layer, so
 * it drew on top of any notice that fired with it. The error is set just before
 * `switching` clears, so for a moment both exist: the covering overlay (z-100)
 * sits above the stack (z-60) and the notice is revealed as the overlay fades.
 */
export function AccountSwitchOfflineToast(): JSX.Element {
  const { t } = useAppTranslation();
  const switchError = useAccountsStore((s) => s.switchError);
  const setSwitchError = useAccountsStore((s) => s.setSwitchError);
  return (
    <AnimatePresence>
      {switchError === "offline" && (
        <NoticeToast
          key="switch-offline"
          tone="danger"
          icon={<WifiOff />}
          duration={SWITCH_ERROR_TOAST_MS}
          onDismiss={() => setSwitchError(null)}
        >
          {t("desktop:accounts.switchOffline")}
        </NoticeToast>
      )}
    </AnimatePresence>
  );
}
