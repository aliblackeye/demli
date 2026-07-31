import { useEffect } from "react";
import { AnimatePresence, m } from "framer-motion";
import { Loader2, WifiOff } from "lucide-react";
import { overlayFade, toastPop } from "@demli/app-ui";
import { useAppTranslation } from "../lib/i18n";
import { useAccountsStore } from "../stores/accounts-store";

/** How long the offline toast lingers before auto-dismissing. */
const SWITCH_ERROR_TOAST_MS = 4_000;

/**
 * Full-screen covering overlay shown while an account switch is in flight
 * (ADR 0013). It hides the app during the ordered teardown+bringup so no
 * previous-account data ever flashes before the new identity's stores/cache are
 * clean and its profile is loaded.
 *
 * Also hosts the transient "couldn't switch — offline" toast (#100): when a
 * switch is CANCELLED because the target account was unreachable, the current
 * session stays put and this soft, auto-dismissing notice explains why.
 */
export function AccountSwitchingOverlay(): JSX.Element | null {
  const { t } = useAppTranslation();
  const switching = useAccountsStore((s) => s.switching);
  const switchError = useAccountsStore((s) => s.switchError);
  const setSwitchError = useAccountsStore((s) => s.setSwitchError);

  useEffect(() => {
    if (switchError === null) return;
    const timer = setTimeout(() => setSwitchError(null), SWITCH_ERROR_TOAST_MS);
    return () => clearTimeout(timer);
  }, [switchError, setSwitchError]);

  return (
    <AnimatePresence>
      {switching ? (
        // Covering overlay: fades in over the teardown and fades OUT to reveal the
        // freshly-loaded new-account app (opacity only — no transform on a
        // full-screen scrim).
        <m.div
          key="switching"
          role="status"
          aria-live="polite"
          variants={overlayFade}
          initial="initial"
          animate="animate"
          exit="exit"
          className="fixed inset-0 z-[100] flex flex-col items-center justify-center gap-3 bg-app/95 backdrop-blur-sm"
        >
          <Loader2 className="size-6 animate-spin text-accent" />
          <p className="text-sm font-medium text-fg-muted">{t("desktop:accounts.switching")}</p>
        </m.div>
      ) : switchError === "offline" ? (
        // Centering lives on the static flex parent so framer's y/scale transforms
        // on the toast never clash with a `-translate-x-1/2` centering transform.
        <div
          key="switch-offline"
          className="pointer-events-none fixed inset-x-0 bottom-4 z-[100] flex justify-center px-4"
        >
          <m.div
            role="status"
            aria-live="polite"
            variants={toastPop}
            initial="initial"
            animate="animate"
            exit="exit"
            className="pointer-events-auto flex items-center gap-2 rounded-lg border border-stroke bg-surface px-3.5 py-2.5 text-sm text-fg shadow-2xl"
          >
            <WifiOff className="size-4 shrink-0 text-danger" />
            <span>{t("desktop:accounts.switchOffline")}</span>
          </m.div>
        </div>
      ) : null}
    </AnimatePresence>
  );
}
