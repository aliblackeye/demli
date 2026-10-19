import { Component, type ErrorInfo, type ReactNode } from "react";
import { RotateCcw, TriangleAlert } from "lucide-react";
import { Button } from "@demli/ui";
import { useAppTranslation } from "../lib/i18n";

/**
 * Renderer crash handling.
 *
 * Two nets catch renderer-side failures and forward them to the main process's
 * local crash log (see `main/crash-reporter.ts`), while keeping the user
 * experience calm (CLAUDE.md §26 — never show a raw stack trace):
 *
 *   - {@link ErrorBoundary} catches React render errors and swaps in a friendly,
 *     on-brand fallback with a Restart button.
 *   - {@link installGlobalErrorReporting} hooks `window.onerror` and
 *     `onunhandledrejection` so uncaught errors / rejected promises are logged
 *     too. It is deduped and silent — no console spam, no user-facing UI.
 *
 * The payload shape mirrors `crash-reporter-types.ts` (`RendererErrorReport`)
 * and is re-validated + re-bounded in main. We derive the type from the exposed
 * bridge so it can never drift, without importing across the main/ boundary.
 */

type RendererErrorReport = Parameters<
  Window["demli"]["crash"]["reportRendererError"]
>[0];

// Keep these in sync with CRASH_PAYLOAD_LIMITS in crash-reporter-types.ts. Main
// clamps again, so these are a courtesy to keep the IPC payload small.
const MAX_MESSAGE = 2000;
const MAX_STACK = 8000;

function truncate(value: string | undefined, max: number): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Forward a renderer error to the local crash log via the preload bridge.
 * Never throws and never awaits into the UI — a reporting failure must stay
 * invisible. Safe to call before the bridge exists (returns quietly).
 */
export function reportRendererError(report: RendererErrorReport): void {
  const bridge = window.demli?.crash;
  if (!bridge) {
    return;
  }
  const payload: RendererErrorReport = {
    message: truncate(report.message, MAX_MESSAGE) || "Unknown renderer error",
    stack: truncate(report.stack, MAX_STACK),
    componentStack: truncate(report.componentStack, MAX_STACK),
  };
  void bridge.reportRendererError(payload).catch(() => {
    // Swallow — reporting failures must never surface to the user.
  });
}

// ---------------------------------------------------------------------------
// Global (non-React) error hooks — deduped + quiet
// ---------------------------------------------------------------------------

let globalHooksInstalled = false;
const seenKeys = new Set<string>();
/** Cap the dedup set so a storm of distinct errors can't grow it without bound. */
const MAX_SEEN = 50;

function alreadyReported(message: string, stack: string | undefined): boolean {
  const key = `${message}\n${stack ?? ""}`.slice(0, 300);
  if (seenKeys.has(key)) {
    return true;
  }
  if (seenKeys.size >= MAX_SEEN) {
    seenKeys.clear();
  }
  seenKeys.add(key);
  return false;
}

function errorLike(value: unknown): { message?: string; stack?: string } {
  if (value instanceof Error) {
    return { message: value.message, stack: value.stack };
  }
  return {};
}

/**
 * Install one-time global handlers for uncaught errors and unhandled promise
 * rejections. Idempotent. Call once, early, before rendering.
 */
export function installGlobalErrorReporting(): void {
  if (globalHooksInstalled) {
    return;
  }
  globalHooksInstalled = true;

  window.addEventListener("error", (event: ErrorEvent) => {
    const fromError = errorLike(event.error);
    const message = event.message || fromError.message || "Uncaught error";
    const stack = fromError.stack;
    if (alreadyReported(message, stack)) {
      return;
    }
    reportRendererError({ message, stack });
  });

  window.addEventListener(
    "unhandledrejection",
    (event: PromiseRejectionEvent) => {
      const fromError = errorLike(event.reason);
      const message =
        fromError.message ?? String(event.reason ?? "Unhandled rejection");
      const stack = fromError.stack;
      if (alreadyReported(message, stack)) {
        return;
      }
      reportRendererError({ message, stack });
    },
  );
}

// ---------------------------------------------------------------------------
// React error boundary
// ---------------------------------------------------------------------------

interface ErrorBoundaryProps {
  children: ReactNode;
  /**
   * Notified before the fallback renders. AppRoot uses it to tear the startup
   * splash down: the splash overlays the app, so a crash DURING boot would
   * otherwise hide this fallback behind a progress bar that can never finish.
   */
  onError?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Catches render errors from its subtree, reports them, and shows a friendly
 * fallback instead of a blank white screen. Restart reloads the renderer.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.props.onError?.();
    reportRendererError({
      message: error.message || "React render error",
      stack: error.stack,
      componentStack: info.componentStack ?? undefined,
    });
  }

  private handleRestart = (): void => {
    window.location.reload();
  };

  render(): ReactNode {
    if (this.state.hasError) {
      return <ErrorFallback onRestart={this.handleRestart} />;
    }
    return this.props.children;
  }
}

/**
 * The crash fallback: a calm Koyu Masa card on the black page — what happened,
 * and the one action that recovers it. No warm glow here on purpose (the brand
 * light is for arrival, not for failure) and never a stack trace (§26); the
 * details went to the crash log above.
 */
export function ErrorFallback({
  onRestart,
}: {
  onRestart: () => void;
}): JSX.Element {
  // Requires the I18nextProvider ABOVE the boundary (see main.tsx render order).
  const { t } = useAppTranslation();
  return (
    <div className="flex h-screen items-center justify-center bg-rail p-4 text-fg">
      <div
        role="alert"
        className="flex w-[420px] max-w-full animate-pop-in flex-col items-center rounded-card bg-app px-8 pb-8 pt-9 text-center"
      >
        <div className="flex size-12 items-center justify-center rounded-xl bg-danger-surface text-danger">
          <TriangleAlert aria-hidden className="size-6" />
        </div>
        <h1 className="mt-5 font-display text-xl font-semibold leading-tight text-fg-display">
          {t("desktop:crash.title")}
        </h1>
        <p className="mt-2 max-w-[320px] text-sm leading-relaxed text-fg-muted">
          {t("desktop:crash.body")}
        </p>
        <Button variant="primary" size="lg" onClick={onRestart} className="mt-7 w-full">
          <RotateCcw aria-hidden className="size-4" />
          {t("desktop:crash.restart")}
        </Button>
      </div>
    </div>
  );
}
