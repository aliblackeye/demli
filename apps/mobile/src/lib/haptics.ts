/**
 * Central haptic-feedback helper (task: mobile native batch 1.6).
 *
 * ONE place that touches `expo-haptics` so every call site stays declarative
 * (`haptics.light()`) and the master switch is enforced in exactly one spot.
 * Mirrors the `sounds/sound-manager.ts` design: re-read the persisted setting on
 * every trigger (so a toggle applies immediately), fire-and-forget, and swallow
 * every error — a haptic must NEVER crash or block the UI.
 *
 * Platform: expo-haptics is a no-op / soft-fail on web and on devices without a
 * vibrator; wrapping each call in try/catch keeps those cases silent. We do not
 * gate on Platform.OS — the module handles unsupported platforms itself.
 *
 * Feedback vocabulary (kept small and intentional, §7 "smooth but not a motion
 * demo"): a light impact for routine control taps (mute, camera, send, menu open),
 * a medium impact for weightier actions, and success/error notification patterns
 * for call accept/decline. Selection is available for discrete pickers.
 */
import * as Haptics from "expo-haptics";
import { useHapticsSettings } from "@/stores/haptics-settings";

/** True when the user has haptics enabled (master switch). Read per trigger. */
function enabled(): boolean {
  return useHapticsSettings.getState().enabled;
}

/** Run a haptic effect if enabled; never throw, never await at the call site. */
function fire(run: () => Promise<unknown>): void {
  if (!enabled()) return;
  // expo-haptics returns a promise; we intentionally don't await it. Swallow
  // rejections (unsupported hardware, transient native error) — cosmetic only.
  try {
    void run().catch(() => {});
  } catch {
    // Synchronous throw (module unavailable) — ignore.
  }
}

export const haptics = {
  /** Routine control tap (mute/unmute, camera, screen share, send, menu open). */
  light(): void {
    fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
  },
  /** Weightier action (deafen, destructive confirm). */
  medium(): void {
    fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium));
  },
  /** Strong emphasis (rarely used — reserved for the heaviest actions). */
  heavy(): void {
    fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy));
  },
  /** Discrete selection change (segmented/picker steps). */
  selection(): void {
    fire(() => Haptics.selectionAsync());
  },
  /** Positive outcome — call accepted / connected. */
  success(): void {
    fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
  },
  /** Warning outcome. */
  warning(): void {
    fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
  },
  /** Negative/terminal outcome — call declined / hang up. */
  error(): void {
    fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error));
  },
};
