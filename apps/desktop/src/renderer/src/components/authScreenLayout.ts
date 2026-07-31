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
  const base = "flex items-center justify-center bg-app text-fg";
  const layout = variant === "add" ? "fixed inset-0 z-[60] animate-fade-in" : "h-screen";
  return `${base} ${layout}`;
}
