/**
 * Shared UI utilities and Radix-based primitives (dark-first design system).
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

export * from "./components/button";
export * from "./components/input";
export * from "./components/textarea";
export * from "./components/kbd";
export * from "./components/dialog";
export * from "./components/tooltip";
export * from "./components/context-menu";
export * from "./components/dropdown-menu";
export * from "./components/popover";
export * from "./components/presence-badge";
export * from "./components/skeleton";
export * from "./components/user-avatar";
