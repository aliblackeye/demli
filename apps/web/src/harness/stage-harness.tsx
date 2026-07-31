/**
 * VIDEO STAGE HARNESS — dev-only, never part of a build.
 *
 * Reachable at `/stage-harness.html` under `pnpm --filter @demli/web dev`.
 * Vite builds from `index.html` alone, so nothing here ships; it exists because
 * the stage's hardest behaviours are the ones a unit test cannot see:
 *
 *   - the K3 filmstrip appearing/vanishing as people start and stop talking,
 *   - the self-view overlay with the camera ON vs OFF,
 *   - the overlay being dragged to another corner and staying there.
 *
 * It mounts the REAL <VideoStage/> (not a copy) and seeds the real stores, so a
 * screenshot taken here is a screenshot of the shipping component. Speaking is
 * driven from the same `participants[].speaking` flag the engine writes, which is
 * exactly what the active-speaker tracker consumes in production.
 *
 * `?fakecam=1` installs a canvas-backed `getUserMedia` so the self-view has real
 * moving video in a headless browser. It is installed on THIS page only.
 */

import "../shim/demli-bridge";
import "../styles/desktop-shell.css";

import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { LazyMotion, MotionConfig, domAnimation } from "framer-motion";
import { I18nextProvider, type i18n as I18nInstance } from "@demli/i18n";
import { TooltipProvider } from "@demli/ui";
import type { VoiceParticipant } from "@demli/media";
import type { User, UserId } from "@demli/types";
import { VideoStage } from "../../../desktop/src/renderer/src/components/VideoStage";
import { createDesktopI18n } from "../../../desktop/src/renderer/src/lib/i18n";
import { useAuthStore } from "../../../desktop/src/renderer/src/stores/auth-store";
import { useChatStore } from "../../../desktop/src/renderer/src/stores/chat-store";
import { useVoiceStore } from "../../../desktop/src/renderer/src/stores/voice-store";
import { useVideoStageStore } from "../../../desktop/src/renderer/src/stores/video-stage-store";

const params = new URLSearchParams(window.location.search);

/** A canvas-backed camera so the self-view has real frames in a headless run. */
function installFakeCamera(): void {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 360;
  const ctx = canvas.getContext("2d");
  let frame = 0;
  const paint = (): void => {
    if (!ctx) return;
    frame += 1;
    const hue = (frame * 2) % 360;
    ctx.fillStyle = `hsl(${hue}, 45%, 22%)`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "600 34px sans-serif";
    ctx.fillText("SELF CAM", 200, 160);
    ctx.beginPath();
    ctx.arc(320 + Math.sin(frame / 20) * 120, 250, 26, 0, Math.PI * 2);
    ctx.fillStyle = "#F55416";
    ctx.fill();
    requestAnimationFrame(paint);
  };
  paint();
  const stream = (canvas as HTMLCanvasElement & { captureStream(fps?: number): MediaStream })
    .captureStream(30);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      ...navigator.mediaDevices,
      // A CLONE per call: the tile stops every track it was handed on unmount, and
      // a shared canvas track would be dead for the next mount (the real
      // getUserMedia hands out a fresh stream each time).
      getUserMedia: async () => stream.clone(),
      enumerateDevices: async () => [],
    },
  });
}

if (params.get("fakecam") === "1") installFakeCamera();

const NAMES = ["Ali", "Burak", "Mert", "Can", "Deniz", "Ece"];

function makeUser(index: number): User {
  return {
    id: `user-${index}` as UserId,
    username: NAMES[index]?.toLowerCase() ?? `user${index}`,
    displayName: NAMES[index] ?? `User ${index}`,
    avatarUrl: null,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function makeParticipant(index: number, speaking: boolean, cameraOn: boolean): VoiceParticipant {
  return {
    userId: `user-${index}` as UserId,
    identity: `user-${index}`,
    micEnabled: true,
    speaking,
    screenSharing: false,
    cameraEnabled: index === 0 && cameraOn,
    volume: 1,
    deafened: false,
    isLocal: index === 0,
  };
}

/**
 * Rewrite the roster with the given speakers. A NEW array + new rows, because
 * that is what the engine does on a real speaking change and what the store's
 * subscribers (including the active-speaker pump) react to.
 */
function setSpeaking(speakingIndexes: number[], count: number, cameraOn: boolean): void {
  useVoiceStore.setState({
    participants: Array.from({ length: count }, (_, i) =>
      makeParticipant(i, speakingIndexes.includes(i), cameraOn),
    ),
    cameraEnabled: cameraOn,
  });
}

function Harness(): JSX.Element {
  const count = Number(params.get("people") ?? 6);
  const [cameraOn, setCameraOn] = useState(params.get("cam") !== "off");
  const [speaking, setSpeakingState] = useState<number[]>([]);

  useEffect(() => {
    const users: Record<string, User> = {};
    for (let i = 0; i < count; i += 1) users[`user-${i}`] = makeUser(i);
    useChatStore.setState({ users: users as Record<UserId, User> });
    useAuthStore.setState({ user: makeUser(0), status: "authenticated", token: "harness" });
    useVoiceStore.setState({
      status: "connected",
      roomId: "harness-room",
      roomLabel: { channelName: "lobi", groupName: "Demli" },
      micEnabled: true,
    });
    setSpeaking([], count, cameraOn);
    // The harness owns the whole page; a previous run's persisted overlay corner
    // must not silently change what a screenshot shows. `?keeppos=1` opts out, so
    // the REMEMBERED corner (the founder's "konumu hatırlansın") can be verified
    // across a reload rather than overwritten by the fixture.
    if (params.get("keeppos") === "1") useVideoStageStore.setState({ focusedKey: null });
    else useVideoStageStore.setState({ pipEnabled: true, pipX: 1, pipY: 1, focusedKey: null });
    // Seeding is keyed on the ROSTER only — flipping the camera must not reset
    // the focus, or the camera-off screenshot could never be taken in focus mode.
  }, [count]);

  // Camera on/off without disturbing the rest of the session.
  useEffect(() => {
    setSpeaking(speaking, count, cameraOn);
  }, [cameraOn]);

  const apply = (next: number[]): void => {
    setSpeakingState(next);
    setSpeaking(next, count, cameraOn);
  };

  return (
    <div className="flex h-screen w-screen flex-col bg-bg text-fg">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-stroke p-2 text-xs">
        <span className="font-semibold">harness</span>
        {Array.from({ length: count }, (_, i) => (
          <button
            key={i}
            data-testid={`speak-${i}`}
            onClick={() =>
              apply(speaking.includes(i) ? speaking.filter((s) => s !== i) : [...speaking, i])
            }
            className={`rounded border px-2 py-1 ${
              speaking.includes(i) ? "border-accent text-accent" : "border-stroke text-fg-muted"
            }`}
          >
            {NAMES[i] ?? i} {speaking.includes(i) ? "🔊" : "·"}
          </button>
        ))}
        <button
          data-testid="toggle-cam"
          onClick={() => setCameraOn((c) => !c)}
          className="rounded border border-stroke px-2 py-1 text-fg-muted"
        >
          cam: {cameraOn ? "on" : "off"}
        </button>
      </div>
      <div className="flex min-h-0 flex-1">
        <VideoStage />
      </div>
    </div>
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
      <QueryClientProvider client={new QueryClient()}>
        {/* Same motion wiring as App.tsx — the stage renders `m.*` elements,
            which are inert without a LazyMotion ancestor. */}
        <LazyMotion features={domAnimation} strict>
          <MotionConfig reducedMotion="user">
            <TooltipProvider>
              <Harness />
            </TooltipProvider>
          </MotionConfig>
        </LazyMotion>
      </QueryClientProvider>
    </I18nextProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<Root />);
