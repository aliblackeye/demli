/**
 * Root-container layout for {@link AuthScreen}, split out as a pure function so
 * the "add account" overlay contract (ADR 0013) is unit-testable without a DOM.
 *
 * There are two very different layout needs behind the one component:
 *
 *  - PRIMARY ("primary") — the sole full-screen sign-in gate. It is the ONLY
 *    child rendered when signed out, so a normal in-flow `h-screen` block fills
 *    the viewport correctly.
 *
 *  - ADD ("add") — the multi-account "Hesap ekle" login, rendered as a SIBLING of
 *    the running `<AppShell/>` (App.tsx), with the current session kept live. It
 *    MUST take itself out of normal flow and cover the viewport (`fixed inset-0`).
 *    Without that it was a SECOND in-flow `h-screen` block pushed to y=100vh and
 *    then CLIPPED away by `#root { height:100%; overflow:hidden }` (globals.css) —
 *    so it was completely invisible and "Hesap ekle" appeared to do nothing, on
 *    BOTH desktop and web (they share the same #root CSS). This was the P0.
 *
 * z-[60]: above the app shell and its own dialogs (CommandMenu / drawer z-50,
 * SettingsShell z-[55]) so the takeover actually covers them, but below the call
 * ring (z-70+), critical-update overlay and account-switching overlay (z-[100]).
 */
export type AuthScreenVariant = "primary" | "add";

/** Tailwind classes for the AuthScreen root container, per {@link AuthScreenVariant}. */
export function authScreenRootClass(variant: AuthScreenVariant): string {
  // OPAQUE page tone on both variants: the "add" overlay must fully hide the
  // running app behind it (no previous account's chat bleeding through), and
  // the primary gate is the first surface after the black boot splash.
  // `items-center-safe` + `overflow-y-auto`: centred while it fits, scrollable
  // from the top when the register form is taller than a short window — plain
  // `items-center` would push the heading above the viewport, unreachable.
  const base = "flex items-center-safe justify-center overflow-y-auto bg-rail text-fg";
  const layout = variant === "add" ? "fixed inset-0 z-[60] animate-fade-in" : "h-screen";
  return `${base} ${layout}`;
}

/**
 * The sign-in page's single warm light: the boot splash's coral glow, lifted to
 * sit above the card — boot and sign-in read as one continuous surface. Read
 * from the `--color-accent-glow` token, never a re-typed colour.
 */
export const AUTH_GLOW =
  "radial-gradient(60% 38% at 50% 0%, var(--color-accent-glow), transparent 70%)";
