/**
 * Startup splash — the Demli mark under the one coral light, a REAL progress
 * bar, and one line of status. Mobile parity with the desktop/web boot splash.
 *
 * The bar is driven by {@link useBootStore}, whose phases are completed by the
 * code that actually finishes each piece of startup work (brand fonts, i18n
 * catalogs, session restore, first server payload, gateway handshake). Nothing
 * here animates a fake percentage (CLAUDE.md §35).
 *
 * ── One continuous surface ──────────────────────────────────────────────────
 * The native splash (app.json `expo-splash-screen`) is the same mark at the same
 * 112dp on the same black page, so the hand-over from the OS splash to this one
 * is invisible: the mark does not move or resize, only the light, the bar and
 * the status line arrive (a fade on the `fast` step). When boot finishes the
 * whole layer fades away on the `standard` step and the sign-in screen (or
 * Home) is underneath, on the same black page with the same light — boot →
 * sign-in reads as one surface, as on the desktop.
 *
 * ── Never a dead end ────────────────────────────────────────────────────────
 * A splash that can hang is worse than no splash — on a phone it reads as a
 * broken install. Three layers stop that:
 *  - the non-blocking phases finish themselves (BootPhaseBinder's grace timers),
 *    so the app opens even with a dead socket or a failed fetch;
 *  - {@link CEILING_AFTER_SESSION_MS} force-completes the boot once the session
 *    is known — past that point the app is usable, whatever else is pending;
 *  - a blocking phase that stalls past {@link FAIL_MS} swaps the status line for
 *    an honest error with "try again" / "restart", so the user always has an
 *    action instead of a spinner.
 *
 * ── Two mounts, one splash ──────────────────────────────────────────────────
 * i18n is itself a boot phase, so for the first moments there is no `t()` and no
 * provider tree to read it from. app/_layout.tsx therefore renders this same
 * component twice over a boot: standalone with `translationsReady={false}` until
 * fonts + catalogs land, then inside the providers as a full-screen overlay
 * above the navigation stack. Both mounts render from the SAME store, so the
 * mark and the bar are continuous — there is only ever one splash on screen.
 * Nothing in here may depend on a provider (no safe-area, no i18n hook outside
 * the `translationsReady` branches).
 */

import { useCallback, useEffect, useState } from "react";
import { Image, View } from "react-native";
import Animated, {
  FadeIn,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import * as Updates from "expo-updates";
import { RotateCw } from "lucide-react-native";
import { Text } from "./ui/Text";
import { Button } from "./ui/Button";
import { Glow } from "./ui/Glow";
import { ProgressBar } from "./ui/ProgressBar";
import { Touchable } from "./ui/Touchable";
import { useAppTranslation, type AppTFunction } from "../lib/i18n";
import { useAuthStore } from "../stores/auth-store";
import {
  isBlockingBootPhase,
  selectBootProgress,
  useBootStore,
  type BootPhase,
} from "../stores/boot-store";
import { motionTo, useReducedMotion } from "../theme/motion";
import { colors, motion, radius, space, typography } from "../theme/theme";

// The rounded brand mark (same asset the native splash uses). Bundled at build
// time via require() so it is always available for the JS-level boot splash.
/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const LOGO = require("../../assets/splash-icon.png");

/** After this long on one phase the copy admits it is taking a while. */
const SLOW_MS = 4_000;
/** After this long on a BLOCKING phase the splash gives the user actions. */
const FAIL_MS = 13_000;
/**
 * Once the session phase is done the app is usable, so anything still pending
 * (server payload, socket) gets this long before the splash lets go regardless.
 * The binder's own grace timers are shorter; this is the backstop.
 */
const CEILING_AFTER_SESSION_MS = 10_000;
/** Fade-out duration (the `standard` step); the unmount timer sits just past it. */
const FADE_OUT_MS = motion.duration.standard;

/** Must equal app.json `expo-splash-screen.imageWidth`, so the hand-over is still. */
export const MARK_SIZE = 112;
const TRACK_WIDTH = 240;
const GLOW_SIZE = 420;

/**
 * The splash mounts twice per boot (see "Two mounts, one splash"). Only the
 * FIRST mount plays the arrival fades — the second must pick up exactly where the
 * first left off, or the bar and the light would blink at the hand-over.
 */
let splashArrived = false;

/**
 * The line under the bar, per phase. A switch over literal keys (rather than a
 * key map) so the strictly-typed `t` still checks every key at compile time.
 */
function phaseLabel(t: AppTFunction, phase: BootPhase | null): string {
  switch (phase) {
    case "fonts":
      return t("mobile:boot.phase.fonts");
    case "i18n":
      return t("mobile:boot.phase.i18n");
    case "session":
      return t("mobile:boot.phase.session");
    case "data":
      return t("mobile:boot.phase.data");
    case "realtime":
      return t("mobile:boot.phase.realtime");
    default:
      return t("mobile:boot.ready");
  }
}

export function BootSplash({
  translationsReady,
}: {
  /**
   * i18n is one of the boot phases, so for the first moments there is no `t()`.
   * Until then the splash shows the mark and the bar with NO copy rather than an
   * untranslated key.
   */
  translationsReady: boolean;
}): JSX.Element | null {
  const done = useBootStore((s) => s.status === "done");
  const phase = useBootStore((s) => s.phase);
  const phaseSince = useBootStore((s) => s.phaseSince);
  const failedPhase = useBootStore((s) => s.failedPhase);
  const sessionSettled = useBootStore((s) => s.completed.includes("session"));
  const progress = useBootStore(selectBootProgress);
  const reduced = useReducedMotion();
  const [arrive] = useState(() => !splashArrived);
  useEffect(() => {
    splashArrived = true;
  }, []);

  const [slow, setSlow] = useState(false);
  const [gone, setGone] = useState(false);
  const opacity = useSharedValue(1);

  // ── Stall watchdogs ──────────────────────────────────────────────────────
  // Both key on `phaseSince`, so every phase change (and every retry, which
  // resets the clock) gets the full grace period again.
  useEffect(() => {
    if (done) return;
    setSlow(false);
    const slowTimer = setTimeout(() => setSlow(true), SLOW_MS);
    // Only a blocking phase earns the error UI; the optional ones complete
    // themselves (BootPhaseBinder) long before this would fire.
    const failTimer = isBlockingBootPhase(phase)
      ? setTimeout(() => {
          if (phase) useBootStore.getState().failBootPhase(phase);
        }, FAIL_MS)
      : null;
    return () => {
      clearTimeout(slowTimer);
      if (failTimer !== null) clearTimeout(failTimer);
    };
  }, [done, phase, phaseSince]);

  // Backstop: the session is known, so the app IS usable — never keep the user
  // here waiting on optional work.
  useEffect(() => {
    if (done || !sessionSettled) return;
    const timer = setTimeout(() => useBootStore.getState().finishBoot(), CEILING_AFTER_SESSION_MS);
    return () => clearTimeout(timer);
  }, [done, sessionSettled]);

  // ── Hand-over ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!done) return;
    opacity.value = motionTo(0, "standard", { reduced });
    // Unmount just after the fade. A plain timer (not the animation callback) so
    // an interrupted animation can never leave an invisible full-screen overlay
    // pinned over the app forever.
    const timer = setTimeout(() => setGone(true), (reduced ? 0 : FADE_OUT_MS) + 40);
    return () => clearTimeout(timer);
  }, [done, opacity, reduced]);

  const layer = useAnimatedStyle(() => ({ opacity: opacity.value }));

  if (gone) return null;

  return (
    <Animated.View
      // Above every in-app layer; `pointerEvents` flips to "none" as it fades so
      // it never swallows a tap meant for the app underneath.
      pointerEvents={done ? "none" : "auto"}
      style={[
        {
          position: "absolute",
          top: 0,
          left: 0,
          right: 0,
          bottom: 0,
          zIndex: 100,
          elevation: 100,
          alignItems: "center",
          justifyContent: "center",
          paddingHorizontal: space.xl,
          backgroundColor: colors.rail,
        },
        layer,
      ]}
    >
      {/* The mark sits at the exact centre — where the OS splash drew it — and
          never moves; everything else hangs below it. */}
      <View style={{ width: MARK_SIZE, height: MARK_SIZE, alignItems: "center", justifyContent: "center" }}>
        <Animated.View
          entering={arrive ? FadeIn.duration(motion.duration.arrival).reduceMotion(ReduceMotion.System) : undefined}
          style={{ position: "absolute", width: GLOW_SIZE, height: GLOW_SIZE, alignItems: "center", justifyContent: "center" }}
          pointerEvents="none"
        >
          <Glow size={GLOW_SIZE} />
        </Animated.View>
        <Image
          source={LOGO}
          // Decorative — the bar and its status line carry the meaning.
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{ width: MARK_SIZE, height: MARK_SIZE }}
        />
      </View>

      <Animated.View
        entering={arrive ? FadeIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System) : undefined}
        style={{
          position: "absolute",
          top: "50%",
          marginTop: MARK_SIZE / 2 + space.xl,
          width: "100%",
          maxWidth: TRACK_WIDTH,
          alignItems: "center",
          gap: space.md,
        }}
      >
        <ProgressBar value={progress} />

        {/* Reserved height so the copy appearing never nudges the bar. */}
        <View style={{ minHeight: 88, alignItems: "center", justifyContent: "flex-start" }}>
          {translationsReady ? (
            failedPhase !== null ? (
              <BootFailure />
            ) : (
              <BootStatusLine phase={phase} slow={slow} />
            )
          ) : failedPhase !== null ? (
            // i18n itself is what stalled, so there is no catalog to write copy
            // from. A glyph-only restart is the honest escape: language-neutral,
            // and still a real action instead of a spinner that never ends.
            <RestartGlyphButton />
          ) : null}
        </View>
      </Animated.View>
    </Animated.View>
  );
}

/** Reload the JS bundle. No-op (logged) in Expo Go / a dev client. */
function restartApp(): void {
  void Updates.reloadAsync().catch((error: unknown) => {
    console.warn("[boot] restart unavailable in this runtime", error);
  });
}

/**
 * The escape hatch for a boot that stalled BEFORE the catalogs loaded. Carries no
 * copy at all — the label is the icon — because the only honest alternative would
 * be hard-coding English into a localized app (ADR 0009). Built on the bare
 * Touchable: this renders outside every provider.
 */
function RestartGlyphButton(): JSX.Element {
  return (
    <Touchable
      onPress={restartApp}
      accessibilityRole="button"
      tone={colors.surfaceRaised}
      pressedTone={colors.raisedHover}
      hitSlop={6}
      style={{
        width: 44,
        height: 44,
        borderRadius: radius.pill,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <RotateCw size={18} color={colors.fg} />
    </Touchable>
  );
}

function BootStatusLine({ phase, slow }: { phase: BootPhase | null; slow: boolean }): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <Animated.View key={phase ?? "ready"} entering={FadeIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}>
      <Text
        accessibilityLiveRegion="polite"
        style={{ color: colors.fgFaint, fontSize: typography.size.label, lineHeight: 18, textAlign: "center" }}
      >
        {phaseLabel(t, phase)}
        {slow ? (
          <Text style={{ color: colors.fgFaint, fontSize: typography.size.label }}>
            {` · ${t("mobile:boot.slow")}`}
          </Text>
        ) : null}
      </Text>
    </Animated.View>
  );
}

/**
 * The honest end of the road: the app could not finish a step it genuinely
 * needs. Two real actions, no fake progress and no silent spinner.
 *
 * "Try again" re-runs the only blocking phase that can realistically stall (the
 * session restore — a network round-trip); `initialize()` is idempotent.
 * "Restart" reloads the JS bundle through expo-updates, which is the mobile
 * equivalent of the desktop's window reload. `reloadAsync` throws in Expo Go /
 * a dev client, so the failure is swallowed and the retry stays available.
 */
function BootFailure(): JSX.Element {
  const { t } = useAppTranslation();

  const retry = useCallback(() => {
    const boot = useBootStore.getState();
    boot.clearBootFailure();
    if (boot.phase === "session") {
      void useAuthStore.getState().initialize();
    }
  }, []);

  return (
    <Animated.View
      entering={FadeIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
      accessibilityRole="alert"
      style={{ alignItems: "center", gap: space.md }}
    >
      <Text style={{ color: colors.fgMuted, fontSize: typography.size.label, lineHeight: 18, textAlign: "center" }}>
        {t("mobile:boot.errorBody")}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <Button variant="primary" size="sm" label={t("mobile:boot.retry")} onPress={retry} />
        <Button variant="secondary" size="sm" label={t("mobile:boot.restart")} onPress={restartApp} />
      </View>
    </Animated.View>
  );
}
