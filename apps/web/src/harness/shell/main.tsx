/**
 * SHELL HARNESS — dev-only, never part of a build.
 *
 * Reachable at `/harness-shell.html?scene=<name>` under
 * `pnpm --filter @demli/web dev`. Vite builds from `index.html` alone, so this
 * page and src/harness/* never reach a bundle.
 *
 * Every scene mounts the REAL product components of the app frame (boot splash,
 * crash fallback, sign-in, the four-column shell with its real data provider,
 * the mobile shell, the command menu, every root notice, the update badge) and
 * drives them through the REAL stores + query cache (./seed.ts). Nothing is a
 * copy, so a screenshot here is a screenshot of the shipping component in that
 * state. `?lang=en` switches the catalog; `?scene=` lists:
 *
 *   shell · home · loading · empty · command · mobile (narrow viewport → MobileShell)
 *   boot · boot-slow · boot-fail · boot-update · crash
 *   auth · auth-add · auth-reauth · auth-notice · birthdate · switching · switch-offline
 *   notices · update
 */

import "../../shim/demli-bridge";
import "../../styles/desktop-shell.css";

import { useEffect, useState, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { LazyMotion, MotionConfig, domAnimation } from "framer-motion";
import { I18nextProvider, type i18n as I18nInstance } from "@demli/i18n";
import { TooltipProvider } from "@demli/ui";
import {
  AppShell as AppShellFrame,
  MarkdownSlotsProvider,
  PlatformProvider,
  createDesktopBridge,
} from "@demli/app-ui";
import type { ChannelId } from "@demli/types";
import { createDesktopI18n } from "../../../../desktop/src/renderer/src/lib/i18n";
import { queryClient } from "../../../../desktop/src/renderer/src/lib/query-client";
import { markdownSlots } from "../../../../desktop/src/renderer/src/components/MarkdownTokens";
import { AppShell } from "../../../../desktop/src/renderer/src/components/AppShell";
import { AuthScreen } from "../../../../desktop/src/renderer/src/components/AuthScreen";
import { BootSplash } from "../../../../desktop/src/renderer/src/components/BootSplash";
import { ErrorFallback } from "../../../../desktop/src/renderer/src/components/ErrorBoundary";
import { BirthdateVerification } from "../../../../desktop/src/renderer/src/components/BirthdateVerification";
import { AgeVerifyPrompt } from "../../../../desktop/src/renderer/src/components/AgeVerifyPrompt";
import { AccountSwitchingOverlay } from "../../../../desktop/src/renderer/src/components/AccountSwitchingOverlay";
import { AppNoticeStack } from "../../../../desktop/src/renderer/src/components/AppNoticeStack";
import { UpdateBadge } from "../../../../desktop/src/renderer/src/components/UpdateBadge";
import { ConnectionBanner, TypingIndicator } from "../../../../desktop/src/renderer/src/components/ChatChrome";
import { useAuthStore } from "../../../../desktop/src/renderer/src/stores/auth-store";
import { useAccountsStore } from "../../../../desktop/src/renderer/src/stores/accounts-store";
import { useBootStore } from "../../../../desktop/src/renderer/src/stores/boot-store";
import { useBootUpdateStore } from "../../../../desktop/src/renderer/src/stores/boot-update-store";
import { useChatStore } from "../../../../desktop/src/renderer/src/stores/chat-store";
import { useUiStore } from "../../../../desktop/src/renderer/src/stores/ui-store";
import { useVoiceStore } from "../../../../desktop/src/renderer/src/stores/voice-store";
import { notifyBlocked } from "../../../../desktop/src/renderer/src/lib/blocked-notice";
import { saveImage } from "../../../../desktop/src/renderer/src/lib/image-actions";
import { pushInAppNotification } from "../../../../desktop/src/renderer/src/notifications/in-app-notifications";
import { CH_SOHBET, G_EMPTY, G_LOADING } from "./fixtures";
import { holdNetwork, openHomeDm, seedSignedIn, seedVoice } from "./seed";

const params = new URLSearchParams(window.location.search);
const scene = params.get("scene") ?? "shell";

holdNetwork();
document.documentElement.dataset.scene = scene;

/** Mounts the update badge on a desktop-looking bridge with a scripted status. */
function installUpdateBridge(): void {
  type Status = Awaited<ReturnType<Window["demli"]["updates"]["getStatus"]>>;
  const kind = params.get("update") ?? "available";
  const status: Status =
    kind === "downloading"
      ? ({ kind: "downloading", version: "0.0.81", percent: 42, critical: false } as Status)
      : kind === "ready"
        ? ({ kind: "ready", version: "0.0.81", critical: false } as Status)
        : ({ kind: "available", version: "0.0.81", critical: false } as Status);
  const bridge = window.demli;
  bridge.appInfo = { ...bridge.appInfo, platform: "win32" as never };
  bridge.updates = {
    ...bridge.updates,
    getStatus: async () => status,
    onStatus: () => () => undefined,
    check: async () => undefined,
    download: async () => undefined,
    install: async () => undefined,
  } as never;
}

if (scene === "update") installUpdateBridge();

function prepare(): void {
  switch (scene) {
    case "shell":
    case "command":
    case "mobile":
    case "notices":
      seedSignedIn();
      seedVoice();
      break;
    case "home":
      seedSignedIn();
      openHomeDm();
      break;
    case "loading":
      seedSignedIn();
      useChatStore.setState({ activeGroupId: G_LOADING, activeChannelId: null });
      break;
    case "empty":
      seedSignedIn();
      useChatStore.setState({ activeGroupId: G_EMPTY, activeChannelId: null });
      break;
    case "birthdate":
    case "switching":
    case "switch-offline":
    case "update":
      seedSignedIn();
      break;
    case "auth":
    case "auth-notice":
      useAuthStore.setState({
        status: "unauthenticated",
        user: null,
        token: null,
        notice: scene === "auth-notice" ? ("errors.sessionExpired" as never) : null,
      } as never);
      break;
    case "auth-add":
    case "auth-reauth":
      seedSignedIn();
      useAccountsStore.setState({
        addingAccount: true,
        reauthUsername: scene === "auth-reauth" ? "ali.is" : null,
      });
      break;
    default:
      break;
  }
}

function Providers({ i18n, children }: { i18n: I18nInstance; children: ReactNode }): JSX.Element {
  return (
    <I18nextProvider i18n={i18n}>
      <LazyMotion features={domAnimation} strict>
        <MotionConfig reducedMotion="user">
          <PlatformProvider bridge={createDesktopBridge(window.demli)}>
            <MarkdownSlotsProvider slots={markdownSlots}>
              <QueryClientProvider client={queryClient}>
                <TooltipProvider delayDuration={350} skipDelayDuration={200}>
                  {children}
                </TooltipProvider>
              </QueryClientProvider>
            </MarkdownSlotsProvider>
          </PlatformProvider>
        </MotionConfig>
      </LazyMotion>
    </I18nextProvider>
  );
}

/** Boot scenes: the real splash over the black page, at a chosen phase. */
function BootScene(): JSX.Element {
  useEffect(() => {
    const boot = useBootStore.getState();
    boot.completeBootPhase("shell");
    boot.completeBootPhase("i18n");
    if (scene === "boot-fail") boot.failBootPhase("session");
    if (scene === "boot-slow") {
      useBootStore.setState({ phaseSince: Date.now() - 5_000 });
    }
    if (scene === "boot-update") {
      useBootUpdateStore.setState({ state: { stage: "downloading", percent: 64 } } as never);
    }
  }, []);
  return <BootSplash translationsReady />;
}

/** The notices scene: fires every root notice once, the way the app would. */
function NoticesScene(): JSX.Element {
  useEffect(() => {
    const window_ = window as Window;
    window_.demli.images = {
      ...window_.demli.images,
      save: async () => ({ status: "saved" }),
    } as never;
    const timers = [
      window.setTimeout(() => useVoiceStore.setState({ endedReason: "sessionReplaced" } as never), 300),
      window.setTimeout(() => notifyBlocked("message"), 600),
      window.setTimeout(
        () => void saveImage({ url: "https://example.invalid/a.png", mime: "image/png", fileName: "a.png" }),
        900,
      ),
      window.setTimeout(
        () =>
          pushInAppNotification({
            title: "Ece · #sohbet",
            body: "Film listesi hazır, akşam 21:30'da başlıyoruz. Gelirken çay getiren kahramandır.",
            navigate: { kind: "channel", channelId: CH_SOHBET } as never,
          }),
        1_200,
      ),
    ];
    return () => timers.forEach((id) => window.clearTimeout(id));
  }, []);
  return (
    <>
      {/* AppShell already mounts the top-right InAppNotificationToast; App.tsx
          (not rendered here) is what mounts the bottom notice stack. */}
      <AppShell />
      <AppNoticeStack />
    </>
  );
}

function Scene(): JSX.Element {
  const [ready, setReady] = useState(scene !== "command");
  useEffect(() => {
    if (scene === "command") {
      useUiStore.getState().setCommandMenuOpen(true);
      setReady(true);
    }
    if (scene === "switching") useAccountsStore.getState().setSwitching(true);
    if (scene === "switch-offline") useAccountsStore.getState().setSwitchError("offline");
  }, []);
  if (!ready) return <></>;

  switch (scene) {
    case "boot":
    case "boot-slow":
    case "boot-fail":
    case "boot-update":
      return <BootScene />;
    case "crash":
      // The boundary's own fallback, rendered directly: throwing on purpose
      // would only add React's dev-mode error log to an otherwise clean console.
      return <ErrorFallback onRestart={() => window.location.reload()} />;
    case "auth":
    case "auth-notice":
      return <AuthScreen />;
    case "auth-add":
    case "auth-reauth":
      return (
        <>
          <AppShell />
          <AuthScreen variant="add" />
        </>
      );
    case "birthdate":
      return (
        <div className="flex h-screen items-center justify-center bg-rail p-4">
          <div className="w-[420px] max-w-full rounded-card bg-app p-6">
            <BirthdateVerification />
          </div>
          <div className="fixed bottom-4 left-4 z-30 flex flex-col items-start gap-2">
            <AgeVerifyPrompt />
          </div>
        </div>
      );
    case "switching":
    case "switch-offline":
      return (
        <>
          <AppShell />
          <AccountSwitchingOverlay />
        </>
      );
    case "notices":
      return <NoticesScene />;
    case "update":
      return (
        <AppShellFrame
          groupRail={<div className="w-[72px] shrink-0" />}
          sidebar={<div className="w-60 bg-sidebar" />}
          center={
            <div className="flex flex-1 flex-col bg-app">
              <ConnectionBanner />
              <div className="flex h-16 items-center justify-between px-4">
                <span className="font-display text-base font-semibold text-fg-display">sohbet</span>
                <UpdateBadge />
              </div>
              <div className="mt-auto">
                <TypingIndicator channelId={"c-typing" as ChannelId} />
              </div>
            </div>
          }
        />
      );
    default:
      return <AppShell />;
  }
}

void createDesktopI18n().then(async (i18n) => {
  const lang = params.get("lang");
  if (lang === "en" || lang === "tr") await i18n.changeLanguage(lang);
  prepare();
  if (scene === "update") {
    // Exercise the typing strip and the connection banner beside the badge.
    useChatStore.setState({
      typing: { ["c-typing" as ChannelId]: { ["u-ece" as never]: Date.now() + 60_000 } } as never,
      connectionStatus: params.get("offline") === "1" ? "reconnecting" : "online",
    });
  }
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <Providers i18n={i18n}>
      <Scene />
    </Providers>,
  );
  document.documentElement.dataset.ready = "1";
});
