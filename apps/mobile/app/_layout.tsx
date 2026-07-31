// MUST be the first import: Hermes ships without `Intl.PluralRules`, and i18next
// reads that at init time. Without it i18next silently falls back to its v3
// plural handling, which looks for `key`/`key_plural` — our catalogs use the v4
// `key_one`/`key_other` form (correct, and what desktop/web resolve against), so
// NOTHING matched and the raw key rendered on screen ("chat.memberSummary"
// instead of "3 kişi · 2 çevrimiçi"). Pure-JS polyfill, so it rides an OTA.
import "intl-pluralrules";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { QueryClientProvider } from "@tanstack/react-query";
import { createI18n, I18nextProvider, type i18n as I18nInstance } from "@demli/i18n";
import { queryClient } from "@/lib/query-client";
import { localeStorage } from "@/lib/locale-storage";
import { ensureLiveKitGlobals } from "@/media/livekit-globals";
import { startRealtime, stopRealtime } from "@/realtime/connection";
import { attachOutbox, detachOutbox } from "@/realtime/outbox";
// Side-effect import: registers the voice-lifecycle → sound-cue subscribers
// once at app entry (join/leave, peer join/leave, mute/unmute, screen
// start/stop). Mirrors desktop App.tsx's `import "./sounds/voice-sounds"`.
import "@/sounds/voice-sounds";
// Side-effect import: drives the call ringtone (incoming ring / outgoing ringback)
// off the call FSM phase, globally. Mirrors desktop's CallLayer ring wiring.
import "@/sounds/call-ringtone";
import { useAttachmentStore } from "@/stores/attachment-store";
import { useAuthStore } from "@/stores/auth-store";
import { configureCallController, resetCallController } from "@/stores/call-store";
import { useChatStore } from "@/stores/chat-store";
import { useVoiceStore } from "@/stores/voice-store";
import { NativeUpdateGate } from "@/updates/NativeUpdateGate";
import { UpdateGate } from "@/updates/UpdateGate";
import { PushController } from "@/push/PushController";
import { VoiceEvictionWatcher } from "@/components/voice/VoiceEvictionWatcher";
import { VoiceKeepAwake } from "@/components/voice/VoiceKeepAwake";
import { ForegroundServiceController } from "@/components/voice/ForegroundServiceController";
import { PendingDeepLinkController } from "@/deeplinks/PendingDeepLinkController";
import { BootPhaseBinder } from "@/components/BootPhaseBinder";
import { BootSplash } from "@/components/BootSplash";
import { markBootPhase } from "@/stores/boot-store";
import { colors, fontFamily } from "@/theme/theme";
import { useAppFonts } from "@/theme/fonts";

/**
 * Root layout — the mobile analog of the desktop renderer's App.tsx. It owns:
 *  - app-wide providers (SafeArea + TanStack Query),
 *  - the boot sequence (validate any stored session against the baked backend),
 *  - the realtime connection lifecycle bound to the session, and
 *  - the themed native navigation stack.
 * Voice (E2) needs LiveKit's RN WebRTC globals installed before any Room is
 * constructed, so we register them once here at the app entry (idempotent).
 */
ensureLiveKitGlobals();

/** How long the persisted-locale read may take before we boot on device locale. */
const I18N_STORAGE_TIMEOUT_MS = 6_000;

export default function RootLayout() {
  const status = useAuthStore((s) => s.status);

  // Brand typography ("Demli Voice v2"): Instrument Sans + Space Grotesk, loaded
  // from bundled .ttf via expo-font. `ready` also flips on failure/timeout, so a
  // bad asset degrades to the system face instead of trapping the boot splash.
  const { ready: fontsReady } = useAppFonts();

  // Boot phase 1 of 5. `ready` also flips on failure/timeout, so this completes
  // even when the brand faces never registered — degraded typography, not a
  // trapped splash (see theme/fonts.ts).
  useEffect(() => {
    if (fontsReady) markBootPhase("fonts");
  }, [fontsReady]);

  // Localization boot (ADR 0009): resolve the locale (persisted choice → device
  // language → "en"), init i18next, and wire persistence — all async, so the app
  // waits behind a short splash for the instance before mounting any screen that
  // calls useTranslation. The locale is backed by expo-secure-store (see
  // lib/locale-storage.ts), which is OTA-safe (no new native module).
  const [i18n, setI18n] = useState<I18nInstance | null>(null);
  useEffect(() => {
    let settled = false;
    const adopt = (instance: I18nInstance): void => {
      if (settled) return;
      settled = true;
      setI18n(instance);
      // Boot phase 2 of 5 — catalogs parsed and the locale resolved.
      markBootPhase("i18n");
    };

    void createI18n({ storage: localeStorage }).then(adopt, (error: unknown) => {
      console.warn("[i18n] init failed — retrying without persistence", error);
      void createI18n().then(adopt, () => undefined);
    });

    // The keystore read is the one await in here that could HANG rather than
    // reject (expo-secure-store swallows its own errors), and i18n is a blocking
    // boot phase — a hang there is an app that never opens. Past this cap we give
    // up on the persisted choice and boot on the detected device locale instead:
    // a possibly-wrong language still opens, a stuck splash never does.
    const fallback = setTimeout(() => {
      if (settled) return;
      console.warn("[i18n] locale storage did not answer — booting on the device locale");
      void createI18n().then(adopt, () => undefined);
    }, I18N_STORAGE_TIMEOUT_MS);

    return () => {
      settled = true;
      clearTimeout(fallback);
    };
  }, []);

  // Boot: validate any stored session against the baked backend.
  useEffect(() => {
    void useAuthStore.getState().initialize();
  }, []);

  // End any voice session when the user is no longer authenticated (logout or
  // session expiry). Voice is app-scoped and no longer torn down by screen
  // unmount (B2), so its lifecycle must be ended explicitly here — the session's
  // last legitimate ender alongside the Leave button and switching rooms. No-op
  // while idle, so the initial "initializing" pass is harmless.
  useEffect(() => {
    if (status !== "authenticated") useVoiceStore.getState().leave();
  }, [status]);

  // Realtime follows the SIGN-IN lifecycle (login / logout / boot), keyed on
  // `status` only. A multi-account SWITCH keeps `status` authenticated and is
  // driven imperatively by `runAccountSwitch` (lib/account-manager, ADR 0013) —
  // which owns the ordered realtime/call/store teardown+bringup — so this effect
  // deliberately does NOT re-fire on the token swap and race it.
  useEffect(() => {
    if (status !== "authenticated") return;
    const { token, user } = useAuthStore.getState();
    if (!token) return;
    if (user) {
      useChatStore.getState().upsertUsers([user]);
      // Rebind the DM-call controller to this session (correct currentUserId; no
      // stale call state across a re-login) — mirrors the realtime lifecycle.
      configureCallController(user.id);
    }
    startRealtime(token);
    // Persistent send queue (M17): point it at THIS account's file and replay
    // whatever survived the last session.
    if (user) void attachOutbox(user.id);
    return () => {
      stopRealtime();
      // Detach (not wipe): the queue is per account and its unsent messages must
      // still be there when this user signs back in.
      void detachOutbox();
      resetCallController();
      useChatStore.getState().resetChatState();
      useAttachmentStore.getState().resetAttachmentDrafts();
      queryClient.clear();
    };
  }, [status]);

  // Hold the app behind the boot splash until i18n AND the brand fonts are ready
  // — every screen below relies on a resolved locale (and useTranslation needs
  // the provider above it), and mounting before the fonts register would flash
  // the whole app in the system face and then reflow. Both gates are
  // self-resolving: fonts time out after 2.5s rather than blocking forever.
  //
  // Same component as the in-tree overlay below, reading the same boot store, so
  // the handover is invisible — there is only ever ONE splash. `t()` has no
  // provider yet at this point, hence `translationsReady={false}`.
  if (!i18n || !fontsReady) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.app }}>
        <BootSplash translationsReady={false} />
      </View>
    );
  }

  return (
    <SafeAreaProvider>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <StatusBar style="light" />
          {/* Completes the remaining boot phases (session, first payload, gateway
              handshake) from the code that actually owns each. Sits OUTSIDE the
              update gates so a critical-update screen never stalls the boot
              model. No UI. */}
          <BootPhaseBinder />
          {/* Push token lifecycle + notification-tap routing (task #46). No UI. */}
          <PushController />
          {/* Single-active-session notice: alerts "you joined voice on another
              device" when this device is evicted. No UI of its own. */}
          <VoiceEvictionWatcher />
          {/* Keeps the screen awake while in a voice room (movie-night watch /
              call) — otherwise the phone dims and locks. No UI. */}
          <VoiceKeepAwake />
          {/* Android mic foreground service: keeps talking alive when the app is
              backgrounded during a pure-audio call (no screen share). No UI. */}
          <ForegroundServiceController />
          {/* Replays a /kat or /arkadas deep link that arrived while signed out,
              once the session authenticates. No UI. */}
          <PendingDeepLinkController />
          {/* OTA (expo-updates) outermost; the native-runtime gate nests inside
              so a critical OTA download blocks first and the two never overlap. */}
          <UpdateGate>
            <NativeUpdateGate>
              <Stack
                screenOptions={{
                  headerStyle: { backgroundColor: colors.surface },
                  // Native header titles are chrome, so they take the display
                  // face — same call desktop makes for its panel headings.
                  headerTitleStyle: {
                    color: colors.fg,
                    fontFamily: fontFamily.display.semibold,
                  },
                  headerTintColor: colors.accent,
                  headerShadowVisible: false,
                  contentStyle: { backgroundColor: colors.app },
                }}
              >
                <Stack.Screen name="index" options={{ headerShown: false }} />
                <Stack.Screen name="sign-in" options={{ headerShown: false }} />
                <Stack.Screen name="(app)" options={{ headerShown: false }} />
                {/* Deep-link handlers (App/Universal Links + custom scheme). Live
                    above the (app) auth guard so a signed-out open isn't bounced
                    with the code lost — they stash + replay after login. */}
                <Stack.Screen name="kat/[code]" />
                <Stack.Screen name="arkadas/[code]" />
              </Stack>
              {/* Boot splash overlay — covers the stack until every applicable
                  phase is done, then fades out. Deliberately INSIDE both gates:
                  a blocking OTA / native-update screen replaces these children,
                  so the splash can never hide it. */}
              <BootSplash translationsReady />
            </NativeUpdateGate>
          </UpdateGate>
        </QueryClientProvider>
      </I18nextProvider>
    </SafeAreaProvider>
  );
}
