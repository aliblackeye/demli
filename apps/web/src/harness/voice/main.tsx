/**
 * VOICE & CALL HARNESS — dev-only, never part of a build (M16 Dalga 3).
 *
 * Reachable at `/harness-voice.html` under `pnpm --filter @demli/web dev`. Vite
 * builds from `index.html` alone, so nothing here ships.
 *
 * Every surface on this page is the REAL shipping component, mounted with the
 * real stores and fed realistic fixtures — no copies, no mock components:
 *
 *   panel    VoicePanel · VoiceParticipant / VoiceOccupantRow rows · CallDockView
 *            (ringing / live / seat elsewhere / seat vacant) · connection bars ·
 *            ShareAudioStatus · AloneCountdownNotice · VoiceErrorNotice
 *   stage    VideoStage (grid / focus / PiP / fullscreen), StageControlBar, and
 *            the individual tiles (AvatarTile, CameraTile, ScreenShareTile,
 *            LocalScreenShareTile, VideoTileLabel) over canvas-drawn video
 *   call     IncomingCallDialog, CallPill, EmbeddedCallStageView
 *   dialogs  SourcePicker (desktop + web modes), CameraPreviewDialog,
 *            DeviceSettingsDialog, VoiceJoinGuardDialog, AddCallMemberDialog
 *   watch    WatchPartyStage (host band, queue, refusal), WatchVideoPicker
 *
 * Store ACTIONS (toggleMic, leave, startScreenShare …) are replaced with
 * store-local equivalents so every button visibly does what it says without a
 * LiveKit room; the components themselves are untouched.
 *
 * The network is stubbed at `fetch`: /friends answers from a fixture (mode via
 * `?friends=ready|loading|error`), everything else stays pending — so the page
 * never talks to a real server and a headless run logs nothing.
 *
 * URL switches: `?picker=desktop` (Electron source grid with thumbnails and the
 * three sound options) vs the default web surface cards · `?nocam=1` (camera
 * permission denied) · `?nodevices=1` (no devices enumerated).
 */

import "../../shim/demli-bridge";
import "../../styles/desktop-shell.css";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { AnimatePresence, LazyMotion, MotionConfig, domAnimation } from "framer-motion";
import { I18nextProvider, type i18n as I18nInstance } from "@demli/i18n";
import { Button, TooltipProvider, cn } from "@demli/ui";
import {
  IDLE_WATCH_SEARCH,
  WatchVideoPicker,
  type WatchPickerSearchState,
} from "@demli/app-ui";
import { initialCallState, type CallState } from "@demli/client-core";
import type { VoiceParticipant as VoiceParticipantData, VoiceStatus } from "@demli/media";
import type { ChannelId, DmId, GroupId, User, UserId } from "@demli/types";
import { createDesktopI18n } from "../../../../desktop/src/renderer/src/lib/i18n";
import { queryClient, queryKeys } from "../../../../desktop/src/renderer/src/lib/query-client";
import { useAuthStore } from "../../../../desktop/src/renderer/src/stores/auth-store";
import { useChatStore } from "../../../../desktop/src/renderer/src/stores/chat-store";
import { useUiStore } from "../../../../desktop/src/renderer/src/stores/ui-store";
import { useVoiceStore, type ShareAudioState } from "../../../../desktop/src/renderer/src/stores/voice-store";
import { useVideoStageStore } from "../../../../desktop/src/renderer/src/stores/video-stage-store";
import { useVoiceJoinGuard } from "../../../../desktop/src/renderer/src/stores/voice-join-guard-store";
import { useWatchPartyStore } from "../../../../desktop/src/renderer/src/stores/watch-party-store";
import { useVoiceOccupancyStore } from "../../../../desktop/src/renderer/src/stores/voice-occupancy-store";
import { setLocalScreenPreviewTrack } from "../../../../desktop/src/renderer/src/stores/local-screen-preview-store";
import type { DmCallSurface } from "../../../../desktop/src/renderer/src/hooks/useDmCallSurface";
import { VoicePanel } from "../../../../desktop/src/renderer/src/components/VoicePanel";
import { VoiceParticipant } from "../../../../desktop/src/renderer/src/components/VoiceParticipant";
import { VoiceOccupantRow } from "../../../../desktop/src/renderer/src/components/VoiceOccupantRow";
import { CallDockView } from "../../../../desktop/src/renderer/src/components/CallDock";
import { VideoStage } from "../../../../desktop/src/renderer/src/components/VideoStage";
import { StageControlBar } from "../../../../desktop/src/renderer/src/components/StageControlBar";
import { AvatarTile } from "../../../../desktop/src/renderer/src/components/AvatarTile";
import { CameraTile } from "../../../../desktop/src/renderer/src/components/CameraTile";
import { ScreenShareTile } from "../../../../desktop/src/renderer/src/components/ScreenShareTile";
import { LocalScreenShareTile } from "../../../../desktop/src/renderer/src/components/LocalScreenShareTile";
import { IncomingCallDialog } from "../../../../desktop/src/renderer/src/components/IncomingCallDialog";
import { CallPill } from "../../../../desktop/src/renderer/src/components/CallPill";
import { EmbeddedCallStageView } from "../../../../desktop/src/renderer/src/components/EmbeddedCallStage";
import { SourcePicker } from "../../../../desktop/src/renderer/src/components/SourcePicker";
import { CameraPreviewDialog } from "../../../../desktop/src/renderer/src/components/CameraPreviewDialog";
import { DeviceSettingsDialog } from "../../../../desktop/src/renderer/src/components/DeviceSettingsDialog";
import { VoiceJoinGuardDialog } from "../../../../desktop/src/renderer/src/components/VoiceJoinGuardDialog";
import { AddCallMemberDialog } from "../../../../desktop/src/renderer/src/components/AddCallMemberDialog";
import { WatchPartyStage } from "../../../../desktop/src/renderer/src/components/WatchPartyStage";
import {
  fakeLocalScreenTrack,
  fakeRemoteCamera,
  fakeRemoteShare,
  installFakeMediaDevices,
  photoAvatar,
} from "./fake-media";

const params = new URLSearchParams(window.location.search);
const PICKER_MODE = params.get("picker") === "desktop" ? "desktop" : "web";
const FRIENDS_MODE = (params.get("friends") ?? "ready") as "ready" | "loading" | "error";

installFakeMediaDevices({ denyCamera: params.get("nocam") === "1", noDevices: params.get("nodevices") === "1" });

// ── fixtures ────────────────────────────────────────────────────────────────

const NAMES = ["Ali Karagöz", "Burak Yılmaz", "Mert Demir", "Ece Kaya", "Deniz Aydın", "Zeynep Arslan"];
const PHOTO_HUES: Record<number, number> = { 1: 18, 5: 280 };

function makeUser(index: number): User {
  const hue = PHOTO_HUES[index];
  return {
    id: `user-${index}` as UserId,
    username: (NAMES[index] ?? `user${index}`).split(" ")[0]!.toLowerCase(),
    displayName: NAMES[index] ?? `User ${index}`,
    avatarUrl: hue === undefined ? null : photoAvatar(hue),
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

const USERS = NAMES.map((_, i) => makeUser(i));
const ME = USERS[0]!;
const CHANNEL = "chan-lobi" as ChannelId;
const DM = "dm-burak" as DmId;

/** The roster every voice surface reads; index 0 is you. */
function roster(
  speaking: number[],
  selfCamera: boolean,
  selfSharing: boolean,
  selfMic = true,
): VoiceParticipantData[] {
  return USERS.map((u, i) => ({
    userId: u.id,
    identity: u.id,
    micEnabled: i === 0 ? selfMic : !(i === 2 || i === 3),
    speaking: speaking.includes(i),
    screenSharing: i === 4 || (i === 0 && selfSharing),
    cameraEnabled: i === 1 || (i === 0 && selfCamera),
    volume: i === 5 ? 0 : 1,
    deafened: i === 3,
    isLocal: i === 0,
  }));
}

const SHARE_AUDIO: Record<string, ShareAudioState> = {
  live: { status: "live", source: "system", notice: null, requested: true },
  waiting: { status: "waiting", source: "app", notice: null, requested: true },
  none: { status: "unavailable", source: null, notice: null, requested: false },
  noSound: { status: "unavailable", source: null, notice: "app_unavailable", requested: true },
  failed: { status: "failed", source: "app", notice: null, requested: true },
};

// ── network stub ────────────────────────────────────────────────────────────

const realFetch = window.fetch.bind(window);
window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  // Same-origin dev-server assets (fonts, modules) pass straight through.
  if (url.startsWith(window.location.origin) || url.startsWith("/")) return realFetch(input, init);
  if (url.includes("/friends")) {
    if (FRIENDS_MODE === "loading") return new Promise<Response>(() => undefined);
    if (FRIENDS_MODE === "error") {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: "INTERNAL", message: "harness" } }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
      );
    }
    const friends = USERS.slice(1).map((user) => ({
      user,
      friendship: { status: "accepted", createdAt: "2026-01-01T00:00:00.000Z" },
    }));
    return Promise.resolve(
      new Response(JSON.stringify({ friends }), { status: 200, headers: { "content-type": "application/json" } }),
    );
  }
  // Every other API call stays in flight: the page never reaches a server.
  return new Promise<Response>(() => undefined);
};

// ── desktop picker bridge (Electron mode) ───────────────────────────────────

function thumbnail(label: string, hue: number): string {
  const c = document.createElement("canvas");
  c.width = 320;
  c.height = 180;
  const ctx = c.getContext("2d");
  if (!ctx) return "";
  const g = ctx.createLinearGradient(0, 0, 320, 180);
  g.addColorStop(0, `hsl(${hue} 40% 30%)`);
  g.addColorStop(1, `hsl(${(hue + 50) % 360} 45% 12%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 320, 180);
  ctx.fillStyle = "rgba(255,255,255,0.12)";
  ctx.fillRect(0, 0, 320, 18);
  ctx.fillStyle = "rgba(255,255,255,0.9)";
  ctx.font = "600 16px sans-serif";
  ctx.fillText(label, 14, 100);
  return c.toDataURL("image/png");
}

if (PICKER_MODE === "desktop") {
  const bridge = window.demli as unknown as {
    appInfo: Record<string, unknown>;
    capture: Record<string, unknown>;
    processAudio: Record<string, unknown>;
  };
  bridge.appInfo = { ...bridge.appInfo, platform: "win32" };
  bridge.capture = {
    ...bridge.capture,
    listSources: async () => [
      { id: "window:101:0", name: "Netflix — Yüzüklerin Efendisi", kind: "window", thumbnailDataUrl: thumbnail("Netflix", 0) },
      { id: "window:102:0", name: "Visual Studio Code — demli", kind: "window", thumbnailDataUrl: thumbnail("VS Code", 210) },
      { id: "window:103:0", name: "Spotify Premium", kind: "window", thumbnailDataUrl: thumbnail("Spotify", 130) },
      { id: "window:104:0", name: "Çok uzun bir pencere başlığı olan bir tarayıcı sekmesi — YouTube", kind: "window", thumbnailDataUrl: "" },
      { id: "screen:0:0", name: "Ekran 1", kind: "screen", thumbnailDataUrl: thumbnail("Ekran 1", 30) },
      { id: "screen:1:0", name: "Ekran 2", kind: "screen", thumbnailDataUrl: thumbnail("Ekran 2", 260) },
    ],
  };
  bridge.processAudio = { ...bridge.processAudio, support: async () => ({ supported: true }) };
}

// ── store seeding + store-local actions ─────────────────────────────────────

function seedStores(): void {
  const users: Record<string, User> = {};
  for (const u of USERS) users[u.id] = u;
  useChatStore.setState({ users: users as Record<UserId, User> });
  useAuthStore.setState({ user: ME, status: "authenticated", token: "harness" });
  useVideoStageStore.setState({ pipEnabled: true, pipX: 1, pipY: 1, focusedKey: null, fullscreen: false });
  useUiStore.setState({ stageFocused: false });

  const set = useVoiceStore.setState;
  const get = useVoiceStore.getState;
  set({
    status: "connected",
    roomId: CHANNEL,
    roomLabel: { channelName: "lobi", groupName: "Demli Masası" },
    micEnabled: true,
    deafened: false,
    cameraEnabled: false,
    screenShareEnabled: false,
    selectedVideoDeviceId: "cam-1",
    connectionQuality: { level: "excellent", rttMs: 24 },
    error: null,
    aloneDeadlineAt: null,
    participants: roster([1], false, false),
    screenShareAudio: SHARE_AUDIO.live!,
    // Store-local stand-ins for the engine commands (see the header).
    toggleMic: () => set({ micEnabled: !get().micEnabled }),
    toggleDeafen: () => set({ deafened: !get().deafened, micEnabled: get().deafened ? get().micEnabled : false }),
    toggleCamera: () => set({ cameraEnabled: !get().cameraEnabled }),
    leave: () => set({ status: "idle" }),
    startScreenShare: () => {
      setLocalScreenPreviewTrack(fakeLocalScreenTrack());
      set({ screenShareEnabled: true, screenShareAudio: SHARE_AUDIO.waiting! });
    },
    stopScreenShare: () => {
      setLocalScreenPreviewTrack(null);
      set({ screenShareEnabled: false });
    },
    sendSystemShareSound: () => {
      set({ shareAudioSwitching: true });
      window.setTimeout(() => set({ shareAudioSwitching: false, screenShareAudio: SHARE_AUDIO.live! }), 900);
    },
    setParticipantVolume: (userId: UserId, volume: number) =>
      set({ participants: get().participants.map((p) => (p.userId === userId ? { ...p, volume } : p)) }),
    setScreenShareVolume: () => undefined,
    setInputDevice: (id: string) => set({ selectedInputDeviceId: id }),
    setOutputDevice: (id: string) => set({ selectedOutputDeviceId: id }),
    setVideoDevice: (id: string) => set({ selectedVideoDeviceId: id }),
  } as Partial<ReturnType<typeof useVoiceStore.getState>>);

  useVoiceOccupancyStore.setState({
    byChannel: { [CHANNEL]: USERS.slice(0, 4).map((u) => ({ userId: u.id, muted: false })) } as never,
  });
  useWatchPartyStore.setState({
    sessions: {
      [CHANNEL]: {
        channelId: CHANNEL,
        hostId: ME.id,
        source: "youtube",
        // Deliberately NOT an 11-char id: the player renders its "cannot play"
        // explanation instead of an iframe, so the harness never loads YouTube.
        videoId: "harness-offline",
        positionSec: 42,
        playing: true,
        receivedAtMs: Date.now(),
        latencySec: 0,
      },
    },
    queues: {
      [CHANNEL]: [
        { itemId: "q1", videoId: "dQw4w9WgXcQ", addedBy: USERS[1]!.id, addedAt: "2026-10-19T20:00:00Z", title: "Çay demlemenin incelikleri — 12 dakikada ustalık", durationSeconds: 742 },
        { itemId: "q2", videoId: "9bZkp7q19f0", addedBy: USERS[2]!.id, addedAt: "2026-10-19T20:01:00Z", title: "Gece yarısı lo-fi", durationSeconds: 3600 },
        { itemId: "q3", videoId: "kJQP7kiw5Fk", addedBy: USERS[4]!.id, addedAt: "2026-10-19T20:02:00Z", title: null, durationSeconds: null },
      ],
    } as never,
    titles: { [CHANNEL]: { "harness-offline": "Arkadaşlarla film gecesi" } },
    refusal: null,
  });
  queryClient.removeQueries({ queryKey: queryKeys.friends });
}

// ── small harness chrome (real primitives) ──────────────────────────────────

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }): JSX.Element {
  return (
    <section data-testid={`sec-${id}`} aria-labelledby={`h-${id}`} className="space-y-4">
      <h2 id={`h-${id}`} className="font-display text-xl font-medium text-fg-display">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Controls({ children }: { children: ReactNode }): JSX.Element {
  return <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-app p-2">{children}</div>;
}

function Toggle({
  id,
  on,
  onClick,
  children,
}: {
  id: string;
  on?: boolean;
  onClick: () => void;
  children: ReactNode;
}): JSX.Element {
  return (
    <Button data-testid={id} size="sm" variant={on ? "accent" : "secondary"} aria-pressed={on} onClick={onClick}>
      {children}
    </Button>
  );
}

function Caption({ children }: { children: ReactNode }): JSX.Element {
  return <p className="text-2xs font-semibold uppercase tracking-wide text-fg-faint">{children}</p>;
}

// ── sections ────────────────────────────────────────────────────────────────

function surface(state: Partial<CallState>): DmCallSurface {
  const full: CallState = {
    ...initialCallState,
    role: "caller",
    callId: "call-1" as CallState["callId"],
    media: "audio",
    surface: { kind: "dm", dmId: DM },
    peer: USERS[1]!,
    ...state,
  };
  return {
    state: full,
    isDmCall: true,
    callDmId: DM,
    onCallDm: true,
    seatedHere: full.seat === "here",
  };
}

function PanelSection(): JSX.Element {
  const status = useVoiceStore((s) => s.status);
  const sharing = useVoiceStore((s) => s.screenShareEnabled);
  const participants = useVoiceStore((s) => s.participants);
  const set = useVoiceStore.setState;
  const [audioKey, setAudioKey] = useState("live");

  const setStatus = (next: VoiceStatus): void =>
    set({
      status: next,
      error: next === "error" ? { kind: "permission_denied", device: "microphone" } : null,
    });

  return (
    <Section id="panel" title="Ses paneli, katılımcı satırları, arama kutusu">
      <Controls>
        {(["joining", "connected", "reconnecting", "error", "leaving", "idle"] as VoiceStatus[]).map((s) => (
          <Toggle key={s} id={`status-${s}`} on={status === s} onClick={() => setStatus(s)}>
            {s}
          </Toggle>
        ))}
        <span className="mx-1 h-5 w-px bg-stroke-strong" />
        {(["excellent", "good", "poor", "unknown"] as const).map((level) => (
          <Toggle
            key={level}
            id={`quality-${level}`}
            onClick={() => set({ connectionQuality: { level, rttMs: level === "unknown" ? null : level === "excellent" ? 24 : level === "good" ? 96 : 310 } })}
          >
            {level}
          </Toggle>
        ))}
        <span className="mx-1 h-5 w-px bg-stroke-strong" />
        <Toggle id="share-toggle" on={sharing} onClick={() => (sharing ? useVoiceStore.getState().stopScreenShare() : useVoiceStore.getState().startScreenShare("screen:0:0", { quality: "1080p30", audioMode: "system" } as never))}>
          paylaşım
        </Toggle>
        {Object.keys(SHARE_AUDIO).map((k) => (
          <Toggle
            key={k}
            id={`audio-${k}`}
            on={sharing && audioKey === k}
            onClick={() => {
              setAudioKey(k);
              set({ screenShareEnabled: true, screenShareAudio: SHARE_AUDIO[k]! });
            }}
          >
            ses: {k}
          </Toggle>
        ))}
        <Toggle id="alone" onClick={() => set({ aloneDeadlineAt: useVoiceStore.getState().aloneDeadlineAt ? null : Date.now() + 4 * 60_000 + 12_000 })}>
          yalnız sayacı
        </Toggle>
      </Controls>

      <div className="flex flex-wrap items-start gap-4">
        {/* A real sidebar column: the panel sits at the foot of the channel list. */}
        <div data-testid="sidebar-column" className="flex w-[248px] flex-col rounded-card bg-sidebar py-2">
          <p className="px-4 pb-1 text-2xs font-semibold uppercase tracking-wide text-fg-faint">lobi</p>
          <ul aria-label="lobi" className="space-y-px px-2 pb-3">
            {participants.map((p) => (
              <VoiceParticipant key={p.userId} participant={p} channelId={CHANNEL} groupId={null} />
            ))}
          </ul>
          <p className="px-4 pb-1 text-2xs font-semibold uppercase tracking-wide text-fg-faint">film-gecesi</p>
          <ul aria-label="film-gecesi" className="space-y-px px-2 pb-3">
            <VoiceOccupantRow occupant={{ userId: USERS[4]!.id, muted: false }} channelId={"chan-film" as ChannelId} />
            <VoiceOccupantRow occupant={{ userId: USERS[5]!.id, muted: true }} channelId={"chan-film" as ChannelId} />
          </ul>
          <div className="mt-auto">
            <VoicePanel />
          </div>
        </div>

        {(
          [
            ["dock-ringing", "Çalıyor", { phase: "outgoing", seat: "here" }],
            ["dock-live", "Bağlı", { phase: "active", seat: "here" }],
            ["dock-elsewhere", "Başka cihazda", { phase: "active", seat: "elsewhere" }],
            ["dock-vacant", "Ayrıldın", { phase: "active", seat: "vacant" }],
          ] as const
        ).map(([id, label, state]) => (
          <div key={id} data-testid={id} className="w-[248px] space-y-2 rounded-card bg-sidebar py-3">
            <div className="px-4">
              <Caption>{label}</Caption>
            </div>
            <CallDockView surface={surface(state as Partial<CallState>)} />
          </div>
        ))}
      </div>
    </Section>
  );
}

function StageSection(): JSX.Element {
  const [speaking, setSpeaking] = useState<number[]>([1]);
  const camera = useVoiceStore((s) => s.cameraEnabled);
  const sharing = useVoiceStore((s) => s.screenShareEnabled);
  const mic = useVoiceStore((s) => s.micEnabled);
  const [barCamera, setBarCamera] = useState(false);
  const [barShare, setBarShare] = useState(false);
  const [barMic, setBarMic] = useState(true);
  const [barFull, setBarFull] = useState(false);

  useEffect(() => {
    useVoiceStore.setState({ participants: roster(speaking, camera, sharing, mic) });
  }, [speaking, camera, sharing, mic]);

  const share = useMemo(() => fakeRemoteShare(USERS[4]!.id, "DENİZ'İN EKRANI"), []);
  const cam = useMemo(() => fakeRemoteCamera(USERS[1]!.id, "BURAK", 20), []);
  const localScreen = useMemo(() => fakeLocalScreenTrack(), []);
  const participants = useVoiceStore((s) => s.participants);
  const burak = participants[1]!;
  const ece = participants[3]!;
  const mert = participants[2]!;

  return (
    <Section id="stage" title="Video sahnesi ve karolar">
      <Controls>
        {USERS.map((u, i) => (
          <Toggle
            key={u.id}
            id={`speak-${i}`}
            on={speaking.includes(i)}
            onClick={() => setSpeaking((s) => (s.includes(i) ? s.filter((x) => x !== i) : [...s, i]))}
          >
            {u.displayName.split(" ")[0]} konuşuyor
          </Toggle>
        ))}
        <span className="mx-1 h-5 w-px bg-stroke-strong" />
        <Toggle id="stage-camera" on={camera} onClick={() => useVoiceStore.getState().toggleCamera()}>
          kameram
        </Toggle>
        <Toggle id="stage-mic" on={!mic} onClick={() => useVoiceStore.getState().toggleMic()}>
          mikrofon kapalı
        </Toggle>
      </Controls>

      <div data-testid="stage-box" className="flex h-[540px] min-h-0 overflow-hidden rounded-card">
        <VideoStage />
      </div>

      <Caption>Tek tek karolar</Caption>
      <div className="grid grid-cols-3 gap-3">
        <div className="relative aspect-video" data-testid="tile-avatar-speaking">
          <AvatarTile participant={burak} className="h-full w-full" onSelect={() => undefined} />
        </div>
        <div className="relative aspect-video" data-testid="tile-avatar-deafened">
          <AvatarTile participant={ece} className="h-full w-full" onSelect={() => undefined} />
        </div>
        <div className="relative aspect-video" data-testid="tile-avatar-focused">
          <AvatarTile participant={mert} className="h-full w-full" large />
        </div>
        <div className="relative aspect-video" data-testid="tile-camera">
          <CameraTile camera={cam} participant={burak} className="h-full w-full" showName onSelect={() => undefined} />
        </div>
        <div className="relative aspect-video" data-testid="tile-share">
          <ScreenShareTile share={share} sharerName={USERS[4]!.displayName} className="h-full w-full" showVolume onSelect={() => undefined} />
        </div>
        <div className="relative aspect-video" data-testid="tile-local-share">
          <LocalScreenShareTile track={localScreen} label="Senin yayının" className="h-full w-full" />
        </div>
      </div>

      <Caption>Sahne kontrol çubuğu</Caption>
      <Controls>
        <Toggle id="bar-camera" on={barCamera} onClick={() => setBarCamera((v) => !v)}>kamera</Toggle>
        <Toggle id="bar-share" on={barShare} onClick={() => setBarShare((v) => !v)}>paylaşım</Toggle>
        <Toggle id="bar-mic" on={!barMic} onClick={() => setBarMic((v) => !v)}>mikrofon kapalı</Toggle>
        <Toggle id="bar-full" on={barFull} onClick={() => setBarFull((v) => !v)}>tam ekran</Toggle>
      </Controls>
      <div data-testid="bar-box" className="relative h-28 overflow-hidden rounded-card bg-rail">
        <StageControlBar
          visible
          micEnabled={barMic}
          onToggleMic={() => setBarMic((v) => !v)}
          cameraEnabled={barCamera}
          onToggleCamera={() => setBarCamera((v) => !v)}
          canUseCamera
          screenShareEnabled={barShare}
          onToggleScreenShare={() => setBarShare((v) => !v)}
          canShareScreen={false}
          screenShareDisabledHint="Ekran paylaşımı masaüstü uygulaması gerektirir"
          disconnectLabel="Bağlantıyı kes"
          onDisconnect={() => undefined}
          canFullscreen
          fullscreen={barFull}
          onToggleFullscreen={() => setBarFull((v) => !v)}
          onInteract={() => undefined}
        />
      </div>
    </Section>
  );
}

function CallSection(): JSX.Element {
  const [incoming, setIncoming] = useState<null | "audio" | "video" | "group">(null);
  const [pending, setPending] = useState(false);
  const [pill, setPill] = useState<null | "here" | "elsewhere">(null);
  const incomingState: CallState = {
    ...initialCallState,
    phase: "incoming",
    role: "callee",
    callId: "call-2" as CallState["callId"],
    media: incoming === "video" ? "video" : "audio",
    surface:
      incoming === "group"
        ? ({ kind: "group", groupId: "g-1" as GroupId, voiceChannelId: CHANNEL } as unknown as CallState["surface"])
        : { kind: "dm", dmId: DM },
    peer: USERS[5]!,
    pending,
  };
  return (
    <Section id="call" title="Özel arama: gelen arama, arama hapı, gömülü sahne">
      <Controls>
        <Toggle id="incoming-audio" on={incoming === "audio"} onClick={() => setIncoming(incoming === "audio" ? null : "audio")}>gelen sesli</Toggle>
        <Toggle id="incoming-video" on={incoming === "video"} onClick={() => setIncoming(incoming === "video" ? null : "video")}>gelen görüntülü</Toggle>
        <Toggle id="incoming-group" on={incoming === "group"} onClick={() => setIncoming(incoming === "group" ? null : "group")}>gelen grup</Toggle>
        <Toggle id="incoming-pending" on={pending} onClick={() => setPending((v) => !v)}>yanıt gidiyor</Toggle>
        <span className="mx-1 h-5 w-px bg-stroke-strong" />
        <Toggle id="pill-here" on={pill === "here"} onClick={() => setPill(pill === "here" ? null : "here")}>hap: bu cihaz</Toggle>
        <Toggle id="pill-elsewhere" on={pill === "elsewhere"} onClick={() => setPill(pill === "elsewhere" ? null : "elsewhere")}>hap: başka cihaz</Toggle>
      </Controls>
      <div data-testid="embedded-box" className="flex h-[400px] flex-col overflow-hidden rounded-card bg-app">
        <EmbeddedCallStageView surface={surface({ phase: "outgoing", seat: "here" })} />
      </div>
      <AnimatePresence>
        {incoming && <IncomingCallDialog key="incoming" state={incomingState} />}
        {pill && (
          <CallPill
            key="pill"
            state={{ ...initialCallState, phase: "active", seat: pill, peer: USERS[1]!, surface: { kind: "dm", dmId: DM } }}
            activeSince={Date.now() - 754_000}
            onExpand={() => setPill(null)}
          />
        )}
      </AnimatePresence>
      {incoming && (
        // The ring card has no close control of its own (only answer/decline,
        // which need a live controller); this harness-only escape closes it.
        <button
          data-testid="incoming-close"
          type="button"
          onClick={() => setIncoming(null)}
          className="fixed right-4 top-4 z-[80] rounded-md bg-raised px-3 py-1.5 text-xs text-fg"
        >
          harness: kapat
        </button>
      )}
    </Section>
  );
}

function DialogsSection(): JSX.Element {
  const [picker, setPicker] = useState(false);
  const [preview, setPreview] = useState(false);
  const [add, setAdd] = useState(false);
  return (
    <Section id="dialogs" title={`Diyaloglar (kaynak seçici: ${PICKER_MODE === "desktop" ? "masaüstü" : "web"})`}>
      <Controls>
        <Toggle id="open-picker" onClick={() => setPicker(true)}>kaynak seçici</Toggle>
        <Toggle id="open-preview" onClick={() => setPreview(true)}>kamera önizleme</Toggle>
        <Toggle id="open-devices" onClick={() => useUiStore.getState().setDeviceDialogOpen(true)}>aygıtlar</Toggle>
        <Toggle
          id="open-guard"
          onClick={() =>
            useVoiceJoinGuard.setState({
              pending: {
                channelId: "chan-film" as ChannelId,
                channelName: "film-gecesi",
                options: {},
                consequences: { stopsScreenShare: true, leavesCall: true, leavesChannel: false },
              },
            })
          }
        >
          katılma onayı
        </Toggle>
        <Toggle id="open-add" onClick={() => setAdd(true)}>aramaya ekle ({FRIENDS_MODE})</Toggle>
      </Controls>
      <SourcePicker open={picker} onOpenChange={setPicker} onSelect={() => undefined} />
      <CameraPreviewDialog open={preview} onOpenChange={setPreview} />
      <DeviceSettingsDialog />
      <VoiceJoinGuardDialog />
      <AddCallMemberDialog open={add} onOpenChange={setAdd} excludeUserId={USERS[1]!.id} />
    </Section>
  );
}

const SEARCH_RESULTS: WatchPickerSearchState = {
  status: "done",
  query: "çay",
  failure: null,
  results: [
    { videoId: "dQw4w9WgXcQ", title: "Çay demlemenin incelikleri — 12 dakikada ustalık", channelTitle: "Demli Mutfak", durationSeconds: 742, thumbnailUrl: "" },
    { videoId: "9bZkp7q19f0", title: "Gece yarısı lo-fi: çalışırken dinlenecek uzun bir karışım", channelTitle: "Gece Radyosu", durationSeconds: 3600, thumbnailUrl: "" },
  ],
};

function WatchSection(): JSX.Element {
  const [picker, setPicker] = useState<null | "results" | "error" | "empty">(null);
  const thumbs = useMemo(() => [photoAvatar(30), photoAvatar(200)], []);
  const search: WatchPickerSearchState =
    picker === "results"
      ? { ...SEARCH_RESULTS, results: SEARCH_RESULTS.results.map((r, i) => ({ ...r, thumbnailUrl: thumbs[i] ?? "" })) }
      : picker === "error"
        ? { status: "error", query: "çay", results: [], failure: "quota" }
        : picker === "empty"
          ? { status: "done", query: "asdkjhasd", results: [], failure: null }
          : IDLE_WATCH_SEARCH;
  return (
    <Section id="watch" title="Birlikte izle">
      <Controls>
        <Toggle id="watch-refuse" onClick={() => useWatchPartyStore.getState().refuse(CHANNEL, "WATCH_QUEUE_FULL")}>ret bandı</Toggle>
        <Toggle id="watch-picker-results" onClick={() => setPicker("results")}>seçici: sonuçlar</Toggle>
        <Toggle id="watch-picker-error" onClick={() => setPicker("error")}>seçici: kota</Toggle>
        <Toggle id="watch-picker-empty" onClick={() => setPicker("empty")}>seçici: boş</Toggle>
      </Controls>
      <div data-testid="watch-box" className="h-[420px] rounded-card bg-app p-3">
        <WatchPartyStage channelId={CHANNEL} groupId={null} />
      </div>
      <WatchVideoPicker
        open={picker !== null}
        onOpenChange={(open) => !open && setPicker(null)}
        mode="queue"
        searchEnabled
        search={search}
        onSearch={() => undefined}
        onResetSearch={() => undefined}
        onSubmit={() => undefined}
      />
    </Section>
  );
}

function Harness(): JSX.Element {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    seedStores();
    setReady(true);
  }, []);
  if (!ready) return <></>;
  return (
    // globals.css locks html/body/#root to the viewport (the app shell owns
    // scrolling), so the harness scrolls inside its own column.
    <main className={cn("h-screen overflow-y-auto bg-rail text-fg")}>
      <div className="mx-auto max-w-[1180px] space-y-12 px-6 py-8">
        <header className="space-y-1">
          <h1 className="font-display text-3xl font-medium text-fg-display">Ses ve arama</h1>
          <p className="text-label text-fg-faint">
            M16 Dalga 3 harness — gerçek bileşenler, sahte medya (canvas), sunucu yok.
          </p>
        </header>
        <PanelSection />
        <StageSection />
        <CallSection />
        <DialogsSection />
        <WatchSection />
      </div>
    </main>
  );
}

function Root(): JSX.Element | null {
  const [i18n, setI18n] = useState<I18nInstance | null>(null);
  useEffect(() => {
    void createDesktopI18n().then(setI18n);
  }, []);
  if (!i18n) return null;
  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        {/* Same motion wiring as App.tsx — the product renders `m.*` elements,
            which throw under `strict` if anything uses `motion.*`. */}
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
