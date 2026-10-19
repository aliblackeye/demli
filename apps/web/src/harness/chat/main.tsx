/**
 * CHAT HARNESS — dev-only review surface for the M16 messaging redesign.
 *
 * Reachable at `/harness-chat.html` under `pnpm --filter @demli/web dev`. Vite
 * builds from `index.html` alone, so nothing here ships (same as ui-kit).
 *
 * It renders the REAL product components, not copies: the desktop ChatView
 * (header, ChatDataProvider, the shared MessageList / MessageRow /
 * MessageComposer, pins, search, attachments, embeds, invite cards, emoji) with
 * the REAL stylesheet and the real motion stack (LazyMotion strict +
 * MotionConfig reducedMotion="user"). Only the server is fake — see
 * ./fake-backend, which answers the real `api` client from ./fixtures.
 *
 * Scenes (`?scene=`):
 *   channel   #genel — the full history fixture (default). `&ch=` switches the
 *             channel: slow (slow mode), empty (intro), loading (never
 *             resolves → skeleton), error (500 → error state), nsfw (age gate;
 *             `&age=minor|unknown` for the other two gate stages).
 *   blocked   the REAL DmView on an empty DM whose peer YOU blocked — the
 *             peer intro and the composer's blocked state.
 *   composer  the shared composer with every attachment-draft state, a reply
 *             target and a live slow-mode countdown.
 * `&lang=en` renders English. `&live=1` connects the real realtime client to
 * ./fake-gateway, so a send walks the real outbox → socket → echo path.
 *
 * The page chrome (scene names) is developer text and stays out of the i18n
 * catalogs on purpose; everything inside the product surface uses real keys.
 */

import "../../shim/demli-bridge";
import "./fake-backend";
import { installFakeGateway } from "./fake-gateway";
import "../../styles/desktop-shell.css";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { LazyMotion, MotionConfig, domAnimation } from "framer-motion";
import { I18nextProvider, type i18n as I18nInstance } from "@demli/i18n";
import { TooltipProvider, cn } from "@demli/ui";
import {
  ComposerServicesProvider,
  MarkdownSlotsProvider,
  MessageComposer as AppMessageComposer,
  PlatformProvider,
  createDesktopBridge,
  type ComposerAttachmentDraft,
  type ComposerServices,
} from "@demli/app-ui";
import type { Channel, User } from "@demli/types";
import { ChatView } from "../../../../desktop/src/renderer/src/components/ChatView";
import { DmView } from "../../../../desktop/src/renderer/src/components/DmView";
import { attachOutbox } from "../../../../desktop/src/renderer/src/realtime/outbox";
import { startRealtime } from "../../../../desktop/src/renderer/src/realtime/connection";
import { BlockUserDialog } from "../../../../desktop/src/renderer/src/components/BlockUserDialog";
import { AttachmentPreviewStrip } from "../../../../desktop/src/renderer/src/components/AttachmentPreviewStrip";
import { EmojiPicker } from "../../../../desktop/src/renderer/src/components/EmojiPicker";
import { markdownSlots } from "../../../../desktop/src/renderer/src/components/MarkdownTokens";
import type { AttachmentDraft } from "../../../../desktop/src/renderer/src/hooks/useAttachmentDrafts";
import { createDesktopI18n } from "../../../../desktop/src/renderer/src/lib/i18n";
import { queryClient, queryKeys } from "../../../../desktop/src/renderer/src/lib/query-client";
import { useAuthStore } from "../../../../desktop/src/renderer/src/stores/auth-store";
import { useChatStore } from "../../../../desktop/src/renderer/src/stores/chat-store";
import {
  ATTACHMENT_URLS,
  BLOCKED_DM,
  CHANNELS,
  DENIZ,
  ELIF,
  GROUP_ID,
  ME,
  ME_ID,
  MERT,
  USERS,
  ZEYNEP,
} from "./fixtures";

type Scene = "channel" | "blocked" | "composer";
const SCENES: { id: Scene; label: string }[] = [
  { id: "channel", label: "Kanal" },
  { id: "blocked", label: "Engellenmiş DM" },
  { id: "composer", label: "Composer durumları" },
];
const CHANNEL_KEYS = Object.keys(CHANNELS) as (keyof typeof CHANNELS)[];

const params = new URLSearchParams(window.location.search);
const scene = (SCENES.some((s) => s.id === params.get("scene")) ? params.get("scene") : "channel") as Scene;
const channelKey = (CHANNEL_KEYS.includes(params.get("ch") as keyof typeof CHANNELS)
  ? params.get("ch")
  : "genel") as keyof typeof CHANNELS;
const age = params.get("age");
const live = params.get("live") === "1";

/* ── Seed the real stores BEFORE the first render ────────────────────────── */

function seed(): void {
  const me: User =
    age === "minor"
      ? { ...ME, isAdult: false, birthdate: "2012-05-01" }
      : age === "unknown"
        ? { ...ME, isAdult: false, birthdate: null }
        : ME;
  useAuthStore.setState({ status: "authenticated", token: "harness-token", user: me });
  // `useMe` reads this cache key; the NSFW gate reads isAdult/birthdate from it.
  queryClient.setQueryData(queryKeys.me, me);
  const now = Date.now();
  useChatStore.setState({
    users: Object.fromEntries([...USERS.filter((u) => u.id !== ME_ID), me].map((u) => [u.id, u])),
    activeView: "server",
    activeGroupId: GROUP_ID,
    activeChannelId: CHANNELS[channelKey].id,
    activeDmId: scene === "blocked" ? BLOCKED_DM.id : null,
    memberSidebarOpen: false,
    // Watermark at m15 → the unread line sits above m16 ("YENİ").
    lastReadMessageId: { [CHANNELS.genel.id]: "m15" },
    typing: {
      [CHANNELS.genel.id]: { [DENIZ.id]: now + 60 * 60_000 },
      [CHANNELS.slow.id]: { [ELIF.id]: now + 60 * 60_000, [MERT.id]: now + 60 * 60_000 },
    },
    presence: { [DENIZ.id]: "online", [ELIF.id]: "idle", [MERT.id]: "online", [ZEYNEP.id]: "dnd" },
    slowmodeCooldownUntil: { [CHANNELS.slow.id]: now + 25_000 },
    // Live mode: the real outbox controller owns this projection and would
    // replace a hand-seeded one on its first publish.
    outbox: live ? {} : {
      [CHANNELS.genel.id]: [
        {
          nonce: "n-queued",
          channelId: CHANNELS.genel.id,
          authorId: ME_ID,
          content: "Bu mesaj çevrimdışıyken yazıldı, bağlantı gelince gidecek.",
          createdAt: new Date(now - 60_000).toISOString(),
          deliveryState: "queued",
          errorKey: "offline",
        },
        {
          nonce: "n-failed",
          channelId: CHANNELS.genel.id,
          authorId: ME_ID,
          content: "Bunu sunucu onaylamadı — yeniden denenebilir.",
          createdAt: new Date(now - 30_000).toISOString(),
          deliveryState: "failed",
          errorKey: "timeout",
        },
      ],
    },
  });
}
seed();
if (live) {
  installFakeGateway();
  void attachOutbox(ME_ID).then(() => startRealtime("harness-token"));
}

/* ── Scenes ──────────────────────────────────────────────────────────────── */

function ChannelScene(): JSX.Element {
  return <ChatView />;
}

/** The REAL DmView on an empty DM whose peer the viewer blocked. */
function BlockedScene(): JSX.Element {
  return <DmView />;
}

const DRAFTS: AttachmentDraft[] = [
  draft("d1", "gun-batimi.png", "image", "ready", 1, ATTACHMENT_URLS["att-sunset"] ?? null),
  draft("d2", "demlik-yakin-plan.jpg", "image", "uploading", 0.42, ATTACHMENT_URLS["att-tea-1"] ?? null),
  draft("d3", "mac-ozeti.mp4", "video", "processing", 0, null),
  {
    ...draft("d4", "cok-buyuk-dosya.mov", "video", "error", 0, null),
    error: { key: "desktop:attachments.tooLarge", params: { limit: "50 MB" } },
    retryable: false,
  },
  draft("d5", "ses-kaydi.mp3", "audio", "error", 0, null),
];

function draft(
  localId: string,
  name: string,
  kind: AttachmentDraft["kind"],
  status: AttachmentDraft["status"],
  progress: number,
  previewUrl: string | null,
): AttachmentDraft {
  return {
    localId,
    file: new File([""], name),
    name,
    kind,
    sizeBytes: 2_400_000,
    previewUrl,
    status,
    progress,
    error: null,
    retryable: true,
  };
}

/**
 * The shared composer with harness-owned drafts (the real upload pipeline needs
 * storage) — every other piece is the product's: the real AttachmentPreviewStrip,
 * the real EmojiPicker, the real slow-mode countdown.
 */
function ComposerScene(): JSX.Element {
  const [drafts, setDrafts] = useState<AttachmentDraft[]>(DRAFTS);
  const [reply, setReply] = useState(true);
  const channel: Channel = CHANNELS.slow;
  const services = useMemo<ComposerServices>(
    () => ({
      useMeId: () => ME_ID,
      useUsers: () => useChatStore((s) => s.users),
      useReplyTarget: () =>
        reply
          ? { messageId: "s1", authorId: ZEYNEP.id, content: "Duyuru kanalında yavaş mod açık: 30 saniyede bir mesaj.", kind: "user" }
          : undefined,
      useReplyAuthorName: () => (reply ? ZEYNEP.displayName : null),
      useAllowBroadcast: () => true,
      useAttachmentsDisabled: () => false,
      useAttachmentDrafts: () => ({
        drafts: drafts as ComposerAttachmentDraft[],
        hasPending: drafts.some((d) => d.status === "uploading" || d.status === "processing"),
        hasDrafts: drafts.length > 0,
        addFiles: () => {},
        removeDraft: (id) => setDrafts((list) => list.filter((d) => d.localId !== id)),
        retryDraft: (id) =>
          setDrafts((list) =>
            list.map((d) => (d.localId === id ? { ...d, status: "uploading", progress: 0.1, error: null } : d)),
          ),
        clearDrafts: () => setDrafts([]),
      }),
      useSlowmodeCooldownUntil: (id) => useChatStore((s) => s.slowmodeCooldownUntil[id] ?? 0),
      getReplyTarget: () => undefined,
      clearReplyTarget: () => setReply(false),
      clearSlowmodeCooldown: (id) => useChatStore.getState().clearSlowmodeCooldown(id),
      getDraft: () => "",
      setDraft: () => {},
      clearDraft: () => {},
      flushDrafts: () => {},
      notifyTyping: () => {},
      notifyIdle: () => {},
      sendMessage: () => {},
      attachmentAccept: "image/*,video/*,audio/*",
      renderEmojiPicker: ({ onSelect, align, side, children }) => (
        <EmojiPicker groupId={GROUP_ID} onSelect={onSelect} align={align} side={side}>
          {children}
        </EmojiPicker>
      ),
      renderAttachmentPreview: ({ drafts: list, onRemove, onRetry }) => (
        <AttachmentPreviewStrip drafts={list as AttachmentDraft[]} onRemove={onRemove} onRetry={onRetry} />
      ),
    }),
    [drafts, reply],
  );
  return (
    <div className="flex min-w-0 flex-1 flex-col justify-end bg-app">
      <ComposerServicesProvider value={services}>
        <div data-harness="composer">
          <AppMessageComposer channel={channel} />
        </div>
      </ComposerServicesProvider>
    </div>
  );
}

/* ── Shell ───────────────────────────────────────────────────────────────── */

function HarnessNav(): JSX.Element {
  const link = (next: Record<string, string>): string => {
    const url = new URL(window.location.href);
    url.search = "";
    for (const [k, v] of Object.entries(next)) url.searchParams.set(k, v);
    if (params.get("lang")) url.searchParams.set("lang", params.get("lang") ?? "");
    return url.toString();
  };
  return (
    <nav
      aria-label="Harness"
      className="flex w-48 shrink-0 flex-col gap-1 overflow-y-auto bg-rail p-3 text-sm"
    >
      <span className="px-2 pb-2 font-display text-sm font-semibold text-fg-display">Sohbet harness</span>
      {SCENES.map((s) => (
        <a
          key={s.id}
          href={link({ scene: s.id })}
          className={cn(
            "rounded-md px-2 py-1.5 text-fg-muted transition-colors motion-hover hover:bg-surface hover:text-fg",
            scene === s.id && "bg-accent-surface text-accent-hover",
          )}
        >
          {s.label}
        </a>
      ))}
      <span className="px-2 pb-1 pt-3 text-2xs font-semibold uppercase tracking-wider text-fg-faint">Kanallar</span>
      {CHANNEL_KEYS.map((key) => (
        <a
          key={key}
          href={link({ scene: "channel", ch: key })}
          className={cn(
            "rounded-md px-2 py-1.5 text-fg-muted transition-colors motion-hover hover:bg-surface hover:text-fg",
            scene === "channel" && channelKey === key && "bg-accent-surface text-accent-hover",
          )}
        >
          #{CHANNELS[key].name}
        </a>
      ))}
    </nav>
  );
}

function Frame({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex h-full bg-rail text-fg">
      <HarnessNav />
      <main className="flex min-w-0 flex-1">{children}</main>
    </div>
  );
}

function Root(): JSX.Element | null {
  const [i18n, setI18n] = useState<I18nInstance | null>(null);
  const bridge = useMemo(() => createDesktopBridge(window.demli), []);
  useEffect(() => {
    void createDesktopI18n().then(async (instance) => {
      await instance.changeLanguage(params.get("lang") === "en" ? "en" : "tr");
      setI18n(instance);
      // Deliberately NOT syncing documentElement.lang: the desktop renderer ships
      // `<html lang="en">` whatever the UI language, and the harness must render
      // what ships (a CSS `uppercase` would turn Turkish "i" into "I" there).
      (window as unknown as { __chatHarnessReady: boolean }).__chatHarnessReady = true;
    });
  }, []);
  if (!i18n) return null;
  return (
    <I18nextProvider i18n={i18n}>
      {/* Same provider stack as the renderer's App.tsx: a motion.* element below
          would throw here exactly as it would in the product. */}
      <LazyMotion features={domAnimation} strict>
        <MotionConfig reducedMotion="user">
          <PlatformProvider bridge={bridge}>
            <MarkdownSlotsProvider slots={markdownSlots}>
              <QueryClientProvider client={queryClient}>
                <TooltipProvider delayDuration={350} skipDelayDuration={200}>
                  <Frame>
                    {scene === "channel" && <ChannelScene />}
                    {scene === "blocked" && <BlockedScene />}
                    {scene === "composer" && <ComposerScene />}
                  </Frame>
                  <BlockUserDialog />
                </TooltipProvider>
              </QueryClientProvider>
            </MarkdownSlotsProvider>
          </PlatformProvider>
        </MotionConfig>
      </LazyMotion>
    </I18nextProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Root />);
