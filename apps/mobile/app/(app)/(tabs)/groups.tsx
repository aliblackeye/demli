import { HomeShell } from "@/components/home/HomeShell";

/**
 * Home tab — the unified server-rail + panel surface (founder directive: a
 * left server rail beside the panel, one surface). All of the composition lives
 * in {@link HomeShell}; this file
 * stays the thin expo-router entry. The route is still named `groups` so every
 * existing `/groups` navigation (index redirect, post-leave, account switch)
 * keeps resolving here unchanged.
 */
export default function HomeTab() {
  return <HomeShell />;
}
