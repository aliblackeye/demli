/**
 * SETTINGS-AREA HARNESS — dev only, never part of a build.
 *
 * Reachable at `/harness-settings.html` under `pnpm --filter @demli/web dev`.
 * Vite builds from `index.html` alone, so nothing here ships (same rule as
 * ui-kit / stage-harness).
 *
 * It mounts the REAL components of the M16 settings area — the settings layer
 * and every section, server settings (roles, members, emoji, audit log), the
 * channel/category/invite dialogs, destructive confirmations, friends, DM,
 * group chat and recent calls — with the REAL stylesheet, the REAL motion
 * stack (LazyMotion strict + MotionConfig reducedMotion="user") and the REAL
 * query/mutation hooks. The only fake is the backend: ./fake-api answers every
 * request in memory (see its header), so each control genuinely does its job
 * against fixture data, and nothing can reach a live server.
 *
 * URL params:
 *   ?view=settings|server|dialogs|friends|dm|group|calls|updates
 *   ?state=ideal|loading|error|empty     list reads (fake-api)
 *   ?surface=web|desktop                 desktop = Electron-only settings live
 *   ?failWrites=1                        every mutation (and system write) fails
 *
 * Page chrome (toolbar labels) is Turkish developer text and stays out of the
 * catalogs on purpose: it is never shown to a user.
 */
import "../../shim/demli-bridge";
import "../../styles/desktop-shell.css";

import { useEffect, useState, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { LazyMotion, MotionConfig, domAnimation } from "framer-motion";
import { I18nextProvider, type i18n as I18nInstance } from "@demli/i18n";
import { Button, TooltipProvider, cn } from "@demli/ui";
import type { ChannelId, GroupId, User, UserId } from "@demli/types";
import { apiBaseUrl } from "../../../../desktop/src/renderer/src/lib/api-client";
import { queryClient, queryKeys } from "../../../../desktop/src/renderer/src/lib/query-client";
import { createDesktopI18n } from "../../../../desktop/src/renderer/src/lib/i18n";
import { useAuthStore } from "../../../../desktop/src/renderer/src/stores/auth-store";
import { useChatStore } from "../../../../desktop/src/renderer/src/stores/chat-store";
import { useUiStore } from "../../../../desktop/src/renderer/src/stores/ui-store";
import { SettingsShell } from "../../../../desktop/src/renderer/src/components/SettingsShell";
import { BlockUserDialog } from "../../../../desktop/src/renderer/src/components/BlockUserDialog";
import { ServerSettingsDialog } from "../../../../desktop/src/renderer/src/components/ServerSettingsDialog";
import { AddServerDialog } from "../../../../desktop/src/renderer/src/components/AddServerDialog";
import { InviteDialog } from "../../../../desktop/src/renderer/src/components/InviteDialog";
import { ChannelInviteDialog } from "../../../../desktop/src/renderer/src/components/ChannelInviteDialog";
import { CreateChannelDialog } from "../../../../desktop/src/renderer/src/components/CreateChannelDialog";
import { CategoryDialogs } from "../../../../desktop/src/renderer/src/components/CategoryDialogs";
import { ChannelSettingsDialog } from "../../../../desktop/src/renderer/src/components/ChannelSettingsDialog";
import { LeaveServerDialog } from "../../../../desktop/src/renderer/src/components/LeaveServerDialog";
import { CreateGroupChatDialog } from "../../../../desktop/src/renderer/src/components/CreateGroupChatDialog";
import { AddGroupMemberDialog } from "../../../../desktop/src/renderer/src/components/AddGroupMemberDialog";
import { GroupChatInviteDialog } from "../../../../desktop/src/renderer/src/components/GroupChatInviteDialog";
import { FriendsView } from "../../../../desktop/src/renderer/src/components/FriendsView";
import { DmView } from "../../../../desktop/src/renderer/src/components/DmView";
import { GroupChatView } from "../../../../desktop/src/renderer/src/components/GroupChatView";
import { RecentCallsView } from "../../../../desktop/src/renderer/src/components/RecentCallsView";
import {
  CriticalUpdateOverlay,
  GlobalUpdateBanner,
} from "../../../../desktop/src/renderer/src/components/UpdateSettings";
import { installFakeBackend, remoteEdits, scenarioState } from "./fake-api";
import { installDesktopBridge, pushUpdateStatus } from "./desktop-bridge";
import { ALL_USERS, CATEGORIES, DMS, GROUP_CHAT, ME, PRESENCE, SERVER_ID } from "./fixtures";

const params = new URLSearchParams(window.location.search);
const surface = params.get("surface") === "desktop" ? "desktop" : "web";

// Order matters: the fake backend and bridges must exist before the first query.
installFakeBackend(apiBaseUrl);
if (surface === "desktop") installDesktopBridge(params.get("failWrites") === "1");

// "Another manager" edits: write the store, then invalidate exactly what the
// realtime handler invalidates for role.updated / group.updated
// (renderer/src/realtime/connection.ts).
if (window.__harness) {
  window.__harness.remote = {
    renameRole: (roleId, name) => {
      remoteEdits.renameRole(roleId, name);
      void queryClient.invalidateQueries({ queryKey: queryKeys.roles(SERVER_ID as GroupId) });
    },
    renameServer: (name) => {
      remoteEdits.renameServer(name);
      void queryClient.invalidateQueries({ queryKey: queryKeys.groups });
      void queryClient.invalidateQueries({ queryKey: queryKeys.groupDetails(SERVER_ID as GroupId) });
    },
  };
}

type View = "settings" | "server" | "dialogs" | "friends" | "dm" | "group" | "calls" | "updates";
const VIEWS: { id: View; label: string }[] = [
  { id: "settings", label: "Ayarlar" },
  { id: "server", label: "Sunucu ayarları" },
  { id: "dialogs", label: "Diyaloglar" },
  { id: "friends", label: "Arkadaşlar" },
  { id: "dm", label: "DM" },
  { id: "group", label: "Grup sohbeti" },
  { id: "calls", label: "Son aramalar" },
  { id: "updates", label: "Güncellemeler" },
];

function readView(): View {
  const v = params.get("view");
  return VIEWS.some((item) => item.id === v) ? (v as View) : "settings";
}

function seedStores(): void {
  const users = Object.fromEntries(ALL_USERS.map((u) => [u.id, u])) as Record<UserId, User>;
  useAuthStore.setState({ user: ME, status: "authenticated", token: "harness" });
  useChatStore.setState({
    users,
    presence: PRESENCE as Record<UserId, (typeof PRESENCE)[string]>,
    activeGroupId: SERVER_ID as GroupId,
    activeDmId: DMS[0]!.id,
    activeGroupChatId: GROUP_CHAT.id,
    connectionStatus: "online",
  } as never);
}

/* ── Views ─────────────────────────────────────────────────────────────── */

function Stage({ children, className }: { children: ReactNode; className?: string }): JSX.Element {
  return <div className={cn("relative flex h-[calc(100vh-3.5rem)] min-h-0 overflow-hidden", className)}>{children}</div>;
}

function Launcher({ children }: { children: ReactNode }): JSX.Element {
  return <div className="flex flex-wrap items-start gap-2 p-6">{children}</div>;
}

function SettingsView(): JSX.Element {
  const open = useUiStore((s) => s.settingsOpen);
  useEffect(() => {
    useUiStore.getState().openSettings("profile");
  }, []);
  return (
    <Stage>
      {!open && (
        <Launcher>
          <Button data-harness="open-settings" onClick={() => useUiStore.getState().openSettings("sessions")}>
            Ayarları aç
          </Button>
        </Launcher>
      )}
      <SettingsShell />
      <BlockUserDialog />
    </Stage>
  );
}

function ServerView(): JSX.Element {
  const open = useUiStore((s) => s.serverSettingsOpen);
  useEffect(() => {
    useUiStore.getState().setServerSettingsOpen(true);
  }, []);
  return (
    <Stage>
      {!open && (
        <Launcher>
          <Button data-harness="open-server" onClick={() => useUiStore.getState().setServerSettingsOpen(true)}>
            Sunucu ayarlarını aç
          </Button>
        </Launcher>
      )}
      <ServerSettingsDialog />
    </Stage>
  );
}

function DialogsView(): JSX.Element {
  const ui = useUiStore.getState;
  const entries: { id: string; label: string; open: () => void }[] = [
    { id: "add-server", label: "Sunucu ekle", open: () => ui().openAddServer("choose") },
    { id: "join-server", label: "Sunucuya katıl", open: () => ui().openAddServer("join") },
    { id: "invite", label: "Sunucu daveti", open: () => ui().setInviteDialogOpen(true) },
    { id: "channel-invite", label: "Kanala davet", open: () => ui().setChannelInviteChannelId("c-lobi" as ChannelId) },
    { id: "create-channel", label: "Kanal oluştur", open: () => ui().setCreateChannelDialogOpen(true, CATEGORIES[0]!.id) },
    { id: "category-create", label: "Kategori oluştur", open: () => ui().setCategoryDialog({ mode: "create" }) },
    {
      id: "category-rename",
      label: "Kategori adlandır",
      open: () => ui().setCategoryDialog({ mode: "rename", categoryId: CATEGORIES[0]!.id, name: CATEGORIES[0]!.name }),
    },
    {
      id: "category-delete",
      label: "Kategori sil",
      open: () => ui().setCategoryDialog({ mode: "delete", categoryId: CATEGORIES[1]!.id, name: CATEGORIES[1]!.name }),
    },
    { id: "channel-text", label: "Kanal ayarları (metin)", open: () => ui().openChannelSettings("c-oyunlar" as ChannelId) },
    { id: "channel-voice", label: "Kanal ayarları (ses)", open: () => ui().openChannelSettings("c-film" as ChannelId) },
    { id: "channel-delete", label: "Kanal sil", open: () => ui().openChannelSettings("c-gece" as ChannelId, "delete") },
    { id: "leave-server", label: "Sunucudan ayrıl", open: () => ui().openLeaveServer(SERVER_ID as GroupId) },
    { id: "create-group", label: "Grup oluştur", open: () => ui().setCreateGroupChatDialogOpen(true) },
    { id: "add-member", label: "Gruba üye ekle", open: () => ui().setAddGroupMemberDialogOpen(true) },
    { id: "group-invite", label: "Grup davet linki", open: () => ui().setGroupChatInviteId(GROUP_CHAT.id) },
  ];
  useEffect(() => {
    const open = params.get("open");
    entries.find((entry) => entry.id === open)?.open();
    // Read once on mount: the param picks the dialog to open on load.
  }, []);
  return (
    <Stage className="flex-col">
      <Launcher>
        {entries.map((entry) => (
          <Button key={entry.id} variant="secondary" size="sm" data-harness={`open-${entry.id}`} onClick={entry.open}>
            {entry.label}
          </Button>
        ))}
      </Launcher>
      <AddServerDialog />
      <InviteDialog />
      <ChannelInviteDialog />
      <CreateChannelDialog />
      <CategoryDialogs />
      <ChannelSettingsDialog />
      <LeaveServerDialog />
      <CreateGroupChatDialog />
      <AddGroupMemberDialog />
      <GroupChatInviteDialog />
    </Stage>
  );
}

function UpdatesView(): JSX.Element {
  const steps: { label: string; status: Parameters<typeof pushUpdateStatus>[0] }[] = [
    { label: "Güncel", status: { kind: "up-to-date", version: "0.0.80" } },
    { label: "Denetleniyor", status: { kind: "checking" } },
    { label: "Var (isteğe bağlı)", status: { kind: "available", version: "0.0.81", critical: false } },
    { label: "İniyor %40", status: { kind: "downloading", version: "0.0.81", percent: 40, critical: false } },
    { label: "Hazır", status: { kind: "ready", version: "0.0.81", critical: false } },
    { label: "Hata", status: { kind: "error", scope: "download" } },
    { label: "Zorunlu (iniyor)", status: { kind: "downloading", version: "0.0.82", percent: 62, critical: true } },
  ];
  return (
    <Stage className="flex-col">
      {surface !== "desktop" ? (
        <p className="p-6 text-sm text-fg-muted">Bu görünüm ?surface=desktop ile çalışır.</p>
      ) : (
        <Launcher>
          {steps.map((step) => (
            <Button key={step.label} variant="secondary" size="sm" onClick={() => pushUpdateStatus(step.status)}>
              {step.label}
            </Button>
          ))}
          <Button size="sm" onClick={() => useUiStore.getState().openSettings("profile")}>
            Ayarlar → Genel
          </Button>
        </Launcher>
      )}
      <SettingsShell />
      <CriticalUpdateOverlay />
      <GlobalUpdateBanner />
    </Stage>
  );
}

function Harness(): JSX.Element {
  const [view, setView] = useState<View>(readView);
  const go = (next: View): void => {
    const url = new URL(window.location.href);
    url.searchParams.set("view", next);
    window.history.replaceState(null, "", url);
    setView(next);
  };
  return (
    <div className="h-full overflow-hidden bg-rail text-fg">
      <nav className="sticky top-0 z-40 flex h-14 items-center gap-3 px-4 surface-glass">
        <span className="font-display text-base font-semibold text-fg-display">Ayarlar alanı</span>
        <span className="hidden text-label text-fg-faint lg:inline">
          harness · {scenarioState} · {surface}
        </span>
        <div className="ml-auto flex min-w-0 gap-1 overflow-x-auto" role="tablist" aria-label="Görünüm">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              role="tab"
              aria-selected={view === v.id}
              data-harness-view={v.id}
              onClick={() => go(v.id)}
              className={cn(
                "shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors motion-hover",
                view === v.id ? "bg-accent-surface text-accent-hover" : "text-fg-muted hover:bg-surface hover:text-fg",
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
      </nav>
      {view === "settings" && <SettingsView />}
      {view === "server" && <ServerView />}
      {view === "dialogs" && <DialogsView />}
      {view === "friends" && (
        <Stage>
          <FriendsView />
        </Stage>
      )}
      {view === "dm" && (
        <Stage>
          <DmView />
        </Stage>
      )}
      {view === "group" && (
        <Stage>
          <GroupChatView />
        </Stage>
      )}
      {view === "calls" && (
        <Stage>
          <RecentCallsView />
        </Stage>
      )}
      {view === "updates" && <UpdatesView />}
    </div>
  );
}

function Root(): JSX.Element | null {
  const [i18n, setI18n] = useState<I18nInstance | null>(null);
  useEffect(() => {
    seedStores();
    void createDesktopI18n().then(setI18n);
  }, []);
  if (!i18n) return null;
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        {/* Same motion wiring as App.tsx: a motion.* element anywhere below
            would throw here exactly as it would in the product. */}
        <LazyMotion features={domAnimation} strict>
          <MotionConfig reducedMotion="user">
            <TooltipProvider delayDuration={350} skipDelayDuration={200}>
              <Harness />
            </TooltipProvider>
          </MotionConfig>
        </LazyMotion>
      </QueryClientProvider>
    </I18nextProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Root />);
