/**
 * Startup splash — the Demli mark, a REAL progress bar, and one line of status.
 * Mobile parity with the desktop/web boot splash (components/BootSplash.tsx).
 *
 * The bar is driven by {@link useBootStore}, whose phases are completed by the
 * code that actually finishes each piece of startup work (brand fonts, i18n
 * catalogs, session restore, first server payload, gateway handshake). Nothing
 * here animates a fake percentage (CLAUDE.md §35).
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
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, Easing, Image, Pressable, View } from "react-native";
import * as Updates from "expo-updates";
import { RotateCw } from "lucide-react-native";
import { Text } from "./ui/Text";
import { useAppTranslation, type AppTFunction } from "../lib/i18n";
import { useAuthStore } from "../stores/auth-store";
import {
  isBlockingBootPhase,
  selectBootProgress,
  useBootStore,
  type BootPhase,
} from "../stores/boot-store";
import { colors, radius, space, typography } from "../theme/theme";

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
/** Fade-out duration; the unmount timer sits just past it. */
const FADE_OUT_MS = 320;
/** How long the bar takes to glide to a newly reached percentage. */
const BAR_EASE_MS = 260;

const MARK_SIZE = 112;
const TRACK_WIDTH = 288;

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

  const [slow, setSlow] = useState(false);
  const [gone, setGone] = useState(false);

  // Width + fade are laid out on the JS thread (width is not a native-driver
  // property), which is fine: two values, both driven by discrete phase changes
  // rather than per-frame input.
  const barWidth = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;

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

  // Bar glide. Only ever moves when a real phase completed.
  useEffect(() => {
    Animated.timing(barWidth, {
      toValue: progress,
      duration: BAR_EASE_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    }).start();
  }, [barWidth, progress]);

  // ── Hand-over ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!done) return;
    const animation = Animated.timing(opacity, {
      toValue: 0,
      duration: FADE_OUT_MS,
      easing: Easing.out(Easing.quad),
      useNativeDriver: true,
    });
    animation.start();
    // Unmount just after the fade. A plain timer (not the animation callback) so
    // an interrupted animation can never leave an invisible full-screen overlay
    // pinned over the app forever.
    const timer = setTimeout(() => setGone(true), FADE_OUT_MS + 40);
    return () => {
      animation.stop();
      clearTimeout(timer);
    };
  }, [done, opacity]);

  if (gone) return null;

  return (
    <Animated.View
      // Above every in-app layer; `pointerEvents` flips to "none" as it fades so
      // it never swallows a tap meant for the app underneath.
      pointerEvents={done ? "none" : "auto"}
      accessibilityRole="progressbar"
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 100,
        elevation: 100,
        alignItems: "center",
        justifyContent: "center",
        gap: space.xl,
        paddingHorizontal: space.xl,
        backgroundColor: colors.app,
        opacity,
      }}
    >
      <Image
        source={LOGO}
        // Decorative — the bar and its status line carry the meaning.
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={{ width: MARK_SIZE, height: MARK_SIZE, borderRadius: radius.lg }}
      />

      <View style={{ width: "100%", maxWidth: TRACK_WIDTH, alignItems: "center", gap: space.md }}>
        <View
          style={{
            height: 4,
            width: "100%",
            borderRadius: radius.pill,
            overflow: "hidden",
            backgroundColor: colors.strokeStrong,
          }}
        >
          <Animated.View
            style={{
              height: "100%",
              borderRadius: radius.pill,
              backgroundColor: colors.accent,
              width: barWidth.interpolate({
                inputRange: [0, 1],
                outputRange: ["0%", "100%"],
              }),
            }}
          />
        </View>

        {/* Reserved height so the copy appearing never nudges the bar. */}
        <View style={{ minHeight: 44, alignItems: "center", justifyContent: "flex-start" }}>
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
      </View>
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
 * be hard-coding English into a localized app (ADR 0009).
 */
function RestartGlyphButton(): JSX.Element {
  return (
    <Pressable
      onPress={restartApp}
      accessibilityRole="button"
      hitSlop={12}
      style={({ pressed }) => ({
        padding: space.md,
        borderRadius: radius.pill,
        borderCurve: "continuous",
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.stroke,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <RotateCw size={18} color={colors.fg} />
    </Pressable>
  );
}

function BootStatusLine({ phase, slow }: { phase: BootPhase | null; slow: boolean }): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <Text style={{ color: colors.fgMuted, fontSize: typography.size.sm, textAlign: "center" }}>
      {phaseLabel(t, phase)}
      {slow ? (
        <Text style={{ color: colors.fgFaint, fontSize: typography.size.sm }}>
          {` · ${t("mobile:boot.slow")}`}
        </Text>
      ) : null}
    </Text>
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
    <View style={{ alignItems: "center", gap: space.md }}>
      <Text style={{ color: colors.fgMuted, fontSize: typography.size.sm, textAlign: "center" }}>
        {t("mobile:boot.errorBody")}
      </Text>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
        <BootAction label={t("mobile:boot.retry")} onPress={retry} primary />
        <BootAction label={t("mobile:boot.restart")} onPress={restartApp} />
      </View>
    </View>
  );
}

/**
 * A minimal button local to the splash. The shared `Button` is deliberately NOT
 * used: this screen can render before the app's providers exist, so it must not
 * depend on anything below the boot gate.
 */
function BootAction({
  label,
  onPress,
  primary = false,
}: {
  label: string;
  onPress: () => void;
  primary?: boolean;
}): JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        paddingHorizontal: space.lg,
        paddingVertical: space.sm,
        borderRadius: radius.pill,
        borderCurve: "continuous",
        backgroundColor: primary ? colors.accent : colors.surface,
        borderWidth: primary ? 0 : 1,
        borderColor: colors.stroke,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <Text
        style={{
          color: primary ? colors.onAccent : colors.fg,
          fontSize: typography.size.body,
          fontWeight: "700",
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}
