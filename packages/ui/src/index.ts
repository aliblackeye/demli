/**
 * Shared UI utilities and the "Koyu Masa" primitives (dark-first design system,
 * docs/design-system/demli-design-system.md): cva variants, Radix where it
 * brings focus/dismiss machinery (dialog, sheet, menus, popover, tooltip,
 * select), hand-built ARIA widgets where it does not (switch, checkbox, radio,
 * slider, toast).
 *
 * Product-specific components (AppShell, ChatView, VoicePanel, ...) live in
 * apps/desktop/src/renderer; only reusable primitives belong here.
 *
 * Note: these components use Tailwind theme tokens (bg-overlay, text-fg, ...)
 * defined by the consuming app's stylesheet — see
 * apps/desktop/src/renderer/src/styles/globals.css.
 */

export { cn } from "./lib/cn";
export { cva, type VariantProps } from "class-variance-authority";
export * from "./lib/color";
export * from "./motion/spring";

export * from "./components/button";
export * from "./components/icon-button";
export * from "./components/input";
export * from "./components/textarea";
export * from "./components/field";
export * from "./components/switch";
export * from "./components/checkbox";
export * from "./components/radio-group";
export * from "./components/slider";
export * from "./components/select";
export * from "./components/kbd";
export * from "./components/badge";
export * from "./components/chip";
export * from "./components/dialog";
export * from "./components/sheet";
export * from "./components/toast";
export * from "./components/tooltip";
export * from "./components/context-menu";
export * from "./components/dropdown-menu";
export * from "./components/popover";
export * from "./components/presence-badge";
export * from "./components/skeleton";
export * from "./components/user-avatar";
export * from "./components/avatar-group";
