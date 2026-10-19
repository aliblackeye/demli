import { useEffect, useMemo } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { LazyMotion, MotionConfig, domAnimation } from "framer-motion";
import { TooltipProvider } from "@demli/ui";
import { MarkdownSlotsProvider, PlatformProvider, createDesktopBridge } from "@demli/app-ui";
import { Loader2 } from "lucide-react";
import { queryClient } from "./lib/query-client";
import { startRealtime, stopRealtime } from "./realtime/connection";
import { attachOutbox, detachOutbox } from "./realtime/outbox";
import { disposeCallController, initCallController } from "./lib/call-controller";
// Side effect only: subscribes voice-store transitions to UI sound cues.
import "./sounds/voice-sounds";
import { useAuthStore } from "./stores/auth-store";
import { useAccountsStore } from "./stores/accounts-store";
import { useChatStore } from "./stores/chat-store";
import { useAppTranslation } from "./lib/i18n";
import { AppShell } from "./components/AppShell";
import { AuthScreen } from "./components/AuthScreen";
import { AccountSwitchingOverlay } from "./components/AccountSwitchingOverlay";
import {
  CriticalUpdateOverlay,
  GlobalUpdateBanner,
} from "./components/UpdateSettings";
import { VoiceEvictionToast } from "./components/VoiceEvictionToast";
import { OutboxChannelGoneToast } from "./components/OutboxChannelGoneToast";
import { ImageActionToast } from "./components/ImageActionToast";
import { BlockedSendToast } from "./components/BlockedSendToast";
import { CallLayer } from "./components/CallLayer";
import { VoiceJoinGuardDialog } from "./components/VoiceJoinGuardDialog";
import { markdownSlots } from "./components/MarkdownTokens";
import { BootPhaseBinder } from "./components/BootPhaseBinder";
import { PendingInviteController } from "./components/PendingInviteController";
import { NotificationController } from "./notifications/NotificationController";

/**
 * What sits under the startup splash while the session is still being restored.
 * The splash covers it on a normal boot; it is only ever SEEN if the splash has
 * already let go (its ceiling fired) while `initialize()` is still out — so it is
 * the same black page with one quiet, labelled spinner, never a white frame.
 */
function BootScreen(): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <div className="flex h-screen items-center justify-center bg-rail" aria-busy="true">
      <Loader2
        role="status"
        aria-label={t("desktop:app.starting")}
        className="size-6 animate-spin text-fg-subtle"
      />
    </div>
  );
}

/**
 * Milestone 2b — the renderer talks to the real backend: HTTP API for server
 * state (TanStack Query), the realtime gateway for live events. Voice remains
 * mocked until Milestone 3.
 */
export function App(): JSX.Element {
  const { t } = useAppTranslation();
  const status = useAuthStore((s) => s.status);
  const addingAccount = useAccountsStore((s) => s.addingAccount);

  // Single-source platform bridge (Phase 1): the shared @demli/app-ui
  // components read platform capabilities through usePlatform() instead of
  // touching window.demli directly, so the same component tree renders on
  // desktop and web. On desktop the bridge IS the Electron-injected
  // window.demli (a thin pass-through), so the reference is stable and no
  // method binding/serialization is disturbed.
  const platformBridge = useMemo(() => createDesktopBridge(window.demli), []);

  // Validate any persisted session once on boot.
  useEffect(() => {
    void useAuthStore.getState().initialize();
  }, []);

  // Realtime connection follows the SIGN-IN lifecycle (login / logout / boot),
  // keyed on `status` only. A multi-account SWITCH keeps `status` authenticated
  // and is driven imperatively by `runAccountSwitch` (lib/account-manager, ADR
  // 0013) — which owns the ordered realtime/call/store teardown+bringup — so this
  // effect deliberately does NOT re-fire on the token swap and race it.
  useEffect(() => {
    if (status !== "authenticated") return;
    const { token, user } = useAuthStore.getState();
    if (!token) return;
    if (user) useChatStore.getState().upsertUsers([user]);
    startRealtime(token);
    // The DM-call controller (ADR 0012) lives for the signed-in session; it is
    // keyed on the current user so a re-login as someone else never carries a
    // stale identity. connection.ts feeds it call.* events via getCallController.
    if (user) initCallController(user.id);
    // Persistent send queue (M17): point it at THIS account's blob and replay
    // whatever survived the last session, before the socket reports online.
    if (user) void attachOutbox(user.id);
    return () => {
      disposeCallController();
      stopRealtime();
      // Detach (not wipe): the queue is per account and its unsent messages must
      // still be there when this user signs back in.
      void detachOutbox();
      useChatStore.getState().resetChatState();
      queryClient.clear();
    };
  }, [status]);

  return (
    // Premium motion, app-wide (founder: "her yer premium animasyonlu"). LazyMotion
    // + domAnimation loads only the DOM animation/gesture/exit feature set once and
    // lets every surface use the lightweight `m.*` components (small bundle vs the
    // full `motion.*`). `strict` makes an accidental heavyweight `motion.*` import a
    // build-time error, so the bundle saving can't silently regress.
    // MotionConfig reducedMotion="user" is the framer half of the global CSS
    // prefers-reduced-motion guard — transforms/opacity motion drop automatically
    // for users who ask for it, so no component re-implements that.
    <LazyMotion features={domAnimation} strict>
    <MotionConfig reducedMotion="user">
    <PlatformProvider bridge={platformBridge}>
    {/* Supplies the shared @demli/app-ui MessageMarkdown its two store-coupled
        inline-token renderers (mention pill + custom emoji) once for the whole
        app; the pure markdown structure lives in app-ui, these slots stay desktop. */}
    <MarkdownSlotsProvider slots={markdownSlots}>
    <QueryClientProvider client={queryClient}>
      {/* Tooltip context at the ROOT, not just inside AppShell: the global call
          surfaces (CallLayer → CallPill) and every other root-level overlay live
          OUTSIDE AppShell, and a Radix <Tooltip> without a provider THROWS —
          which took the whole renderer down with "bir şeyler ters gitti" the
          moment a DM call started (founder P0). AppShell keeps its own nested
          provider for its own delay tuning; nesting is supported. */}
      <TooltipProvider delayDuration={350} skipDelayDuration={200}>
      {status === "initializing" ? (
        <BootScreen />
      ) : status === "authenticated" ? (
        <AppShell />
      ) : (
        <AuthScreen />
      )}
      {/* Multi-account (ADR 0013): the "add account" login shown as an overlay
          over the running app (current session stays live), and the covering
          "switching…" overlay while runAccountSwitch tears down + brings up. */}
      {addingAccount && status === "authenticated" && <AuthScreen variant="add" />}
      <AccountSwitchingOverlay />
      {/* Update surfaces live at the root so they work on EVERY screen —
          including login. Mandatory updates block, always. */}
      <CriticalUpdateOverlay />
      {/* The floating optional-update card is for the SIGNED-OUT screens only.
          Once the shell is up, the top-right UpdateBadge (in each surface's
          header) owns optional updates — showing both would be two controls for
          one job, and the founder asked for the badge. */}
      {status !== "authenticated" && <GlobalUpdateBanner />}
      {/* The app-root NOTICE STACK — one bottom-centre column that owns the
          position of every root notice, so two that fire together stack (newest
          nearest the edge) instead of drawing on top of each other. Above the
          dialog/lightbox layer (z-50) on purpose: an image saved from the
          lightbox must be confirmed while the lightbox is still open. Each
          notice is the shared NoticeToast card and owns its own timer. */}
      <div
        aria-label={t("common:a11y.notifications")}
        role="region"
        className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex flex-col-reverse items-center gap-2 px-4"
      >
        {/* Single-active-session notice: shows "you joined voice on another
            device" when this device is evicted, and survives the voice panel
            unmounting. */}
        <VoiceEvictionToast />
        {/* Offline queue (M17): tells the user when queued messages had to be
            abandoned because their channel is gone — by definition there is no
            channel view left to show it in. */}
        <OutboxChannelGoneToast />
        {/* "Görsel kaydedildi / kopyalandı" (and the honest failure line) for the
            attachment save/copy actions. Root-level because the action can start
            from the full-screen lightbox, which unmounts on close. A CANCELLED
            save stays silent. */}
        <ImageActionToast />
        {/* Blocking (M18): a DM send the gateway refused because a block exists.
            Root-level for the same reason — the queue row can only show its
            generic "rejected" copy, so the neutral reason is given once, here. */}
        <BlockedSendToast />
      </div>
      {/* DM calls (ADR 0012): global incoming-call ring + in-call surface, on
          every screen. Mounted at the root so a call is never missed. */}
      <CallLayer />
      {/* Confirms an interrupting voice-channel join (live screen share / DM call
          would be torn down) before it happens — founder UX #6. Mounted once so
          every join entry point shares one dialog. */}
      <VoiceJoinGuardDialog />
      {/* Headless: binds i18n into the notification manager and routes toast
          clicks. Safe to mount always — it emits nothing on the login screen. */}
      <NotificationController />
      {/* Headless: reports the REAL startup phases (session restore, first
          server payload, gateway handshake) to the boot store so the splash's
          progress bar tracks work that actually happened (CLAUDE.md §35). It
          renders null and unmounts itself once the boot is done. */}
      <BootPhaseBinder />
      {/* Headless, web-only in effect: replays an app.getdemli.com/invite/<kod>
          route (or the legacy /kat form) into the AddServerDialog join step
          once authenticated. */}
      <PendingInviteController />
      </TooltipProvider>
    </QueryClientProvider>
    </MarkdownSlotsProvider>
    </PlatformProvider>
    </MotionConfig>
    </LazyMotion>
  );
}
