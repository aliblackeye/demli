/**
 * THE mobile voice stage — one shell for both surfaces (call-ux-plan W3).
 *
 * WHY IT EXISTS. A server voice channel and a DM call are the same room: the same
 * engine, the same voice FSM, the same token path (plan §1.1 proves the media
 * layer never forked). Only the mobile SHELL had forked, and it forked silently —
 * two screens each assembling their own stage, so features landed on whichever
 * one the author had open:
 *
 *   - the in-stage control bar existed only in the DM call;
 *   - the per-user volume sheet HOST existed only in the voice room, which made
 *     long-pressing a participant in a call a genuinely dead control — the tile
 *     called `openParticipantVolumeSheet`, the controller store updated, and
 *     nothing was mounted to render it (§35, and the last functional blocker on
 *     `docs/product/road-to-open-source.md`);
 *   - the tile builder was 18 copy-pasted lines in each screen.
 *
 * This component is the fix that KEEPS being the fix: both screens render it, so
 * a control added here cannot reach one surface and miss the other. The screens
 * keep only what is genuinely theirs — the call keeps its minimize/add-person
 * header, the room keeps its channel header, chat view and watch-party controls —
 * and hand the stage itself over.
 *
 * WHAT IT OWNS: the stage switch (watch party → screen share → participant grid →
 * empty), the floating {@link StageControlBar}, the pre-publish sheets that bar
 * opens, and the single {@link ParticipantVolumeSheet} host. Media state is read
 * straight from the voice store, so there is still exactly one source of truth
 * for mic/camera/share (CLAUDE.md §11) and this shell owns no media logic.
 */
import { useState, type ReactNode } from "react";
import { View } from "react-native";
import type { RemoteScreenShare } from "@demli/media";
import type { UserId } from "@demli/types";
import { useVoiceStore } from "@/stores/voice-store";
import { space } from "@/theme/theme";
import { CameraPreviewSheet } from "./CameraPreviewSheet";
import { CameraStage } from "./CameraStage";
import { ParticipantVolumeSheet } from "./ParticipantVolumeSheet";
import { ScreenShareQualitySheet } from "./ScreenShareQualitySheet";
import { ScreenShareStage } from "./ScreenShareStage";
import { StageControlBar } from "./StageControlBar";
import type { MobileStage } from "./use-stage-tiles";
import { useAutoHideControls } from "./useAutoHideControls";

export function VoiceStage({
  stage,
  nameFor,
  activeShare,
  sharerName,
  shareFullscreen,
  onShareFullscreenChange,
  disconnectLabel,
  onDisconnect,
  watchSlot = null,
  emptySlot = null,
  chromeHidden = false,
}: {
  /** The live participant stage, built once by `useStageTiles`. */
  stage: MobileStage;
  /** Roster-aware name resolver — the volume sheet titles itself with it. */
  nameFor: (userId: UserId) => string;
  /** The screen share that owns the stage, or null. */
  activeShare: RemoteScreenShare | null;
  sharerName: string | null;
  shareFullscreen: boolean;
  onShareFullscreenChange: (open: boolean) => void;
  /** "Hang up" in a DM call, "Leave" in a room — the one word that differs. */
  disconnectLabel: string;
  onDisconnect: () => void;
  /**
   * Rendered INSTEAD of the share/grid stage while a watch party owns it (ADR
   * 0016). A slot rather than a prop because only the voice room has parties, and
   * the player must stay mounted by its owner so the sync heartbeat never
   * re-renders this shell (§27).
   */
  watchSlot?: ReactNode;
  /** Rendered when nothing else claims the stage (pre-roster / waiting state). */
  emptySlot?: ReactNode;
  /**
   * Suppress the floating bar — for the states that deliberately own the whole
   * screen (a fullscreen share, an expanded watch party).
   */
  chromeHidden?: boolean;
}) {
  const status = useVoiceStore((s) => s.status);
  const micEnabled = useVoiceStore((s) => s.micEnabled);
  const cameraEnabled = useVoiceStore((s) => s.cameraEnabled);
  const screenShareEnabled = useVoiceStore((s) => s.screenShareEnabled);
  const toggleMic = useVoiceStore((s) => s.toggleMic);
  const toggleCamera = useVoiceStore((s) => s.toggleCamera);
  const toggleScreenShare = useVoiceStore((s) => s.toggleScreenShare);

  // Floating stage controls (founder: controls over the video). Tap-to-toggle
  // because there is no hover on a phone; they fade on idle so the stage is not
  // permanently covered by chrome.
  const stageControls = useAutoHideControls();
  const [cameraPreviewOpen, setCameraPreviewOpen] = useState(false);
  const [shareQualityOpen, setShareQualityOpen] = useState(false);

  const connected = status === "connected";
  // Mic stays usable while a room exists (joining/connected/reconnecting), not
  // only when fully connected — you most need to mute during a flaky reconnect
  // (audit D2). Camera/share stay gated on `connected` (they publish a track).
  const roomActive = status === "connected" || status === "joining" || status === "reconnecting";
  const hasParticipants = stage.tiles.length > 0;

  // Same flows the bottom bar uses (#101 / #112): turning the camera ON opens the
  // preview first, starting a share opens the quality sheet first; turning either
  // OFF is a direct toggle. The two bars must not disagree about what a tap does.
  const onStageCamera = (): void => {
    if (cameraEnabled) toggleCamera();
    else setCameraPreviewOpen(true);
  };
  const onStageShareScreen = (): void => {
    if (screenShareEnabled) toggleScreenShare();
    else setShareQualityOpen(true);
  };

  /**
   * The bar's fullscreen button, narrowed to what it can actually act on. A
   * screen share has ONE fullscreen surface lifted to the screen (the
   * landscape/immersive viewer), so the bar can drive it. A camera's fullscreen
   * lives on its own focused tile — with three cameras up there is no single "the
   * video" for a bar button to enlarge, and offering one anyway would either pick
   * at random or do nothing visible; §35 forbids both.
   */
  const canFullscreenFromBar = activeShare !== null;

  return (
    <View style={{ flex: 1 }}>
      <View style={{ flex: 1 }}>
        {/* The stage CONTENT's `onTouchStart` toggles the floating controls. Touch
            events BUBBLE in React Native, so the stage's own gestures (focus a
            tile, drag the self-view, exit focus) all still land — this observes
            the tap, it does not take it.

            The bar below is this view's SIBLING, never its child: a touch that
            starts on a bar button must not bubble into the toggle, or every press
            would also hide the bar (and the long-press tooltip would mount inside
            a bar that had just faded to nothing). The bar instead holds itself up
            while a finger is on it and re-arms the idle timer on release. */}
        <View
          style={{ flex: 1 }}
          onTouchStart={chromeHidden ? undefined : stageControls.toggle}
        >
          {watchSlot ? (
            watchSlot
          ) : activeShare ? (
            <ScreenShareStage
              share={activeShare}
              sharerName={sharerName}
              participantTiles={stage.tiles}
              fullscreen={shareFullscreen}
              onFullscreenChange={onShareFullscreenChange}
            />
          ) : hasParticipants ? (
            <View style={{ flex: 1, padding: space.md }}>
              <CameraStage stage={stage} />
            </View>
          ) : (
            emptySlot
          )}
        </View>

        {!chromeHidden ? (
          <StageControlBar
            visible={stageControls.visible}
            opacity={stageControls.opacity}
            onInteractionStart={stageControls.hold}
            onInteractionEnd={stageControls.reveal}
            micEnabled={micEnabled}
            onToggleMic={toggleMic}
            cameraEnabled={cameraEnabled}
            onToggleCamera={onStageCamera}
            canUseCamera={connected}
            screenShareEnabled={screenShareEnabled}
            onToggleScreenShare={onStageShareScreen}
            canShareScreen={connected}
            canToggleAudio={roomActive}
            disconnectLabel={disconnectLabel}
            onDisconnect={onDisconnect}
            canFullscreen={canFullscreenFromBar}
            fullscreen={shareFullscreen}
            onToggleFullscreen={() => onShareFullscreenChange(!shareFullscreen)}
          />
        ) : null}
      </View>

      {/* The stage bar's pre-publish sheets, so its camera and share buttons run
          the identical flow the bottom bar runs. */}
      <CameraPreviewSheet
        visible={cameraPreviewOpen}
        onClose={() => setCameraPreviewOpen(false)}
        onConfirm={toggleCamera}
      />
      <ScreenShareQualitySheet
        visible={shareQualityOpen}
        onClose={() => setShareQualityOpen(false)}
        onConfirm={toggleScreenShare}
      />

      {/*
        THE per-user volume sheet host — mounted ONCE, here, which is the whole
        point of this shell. Every participant tile long-press routes through the
        module-level `openParticipantVolumeSheet` controller (no prop drilling,
        §27); before this it was hosted only by the voice room, so the identical
        long-press in a DM call updated the controller and rendered nothing. Being
        mounted by the shared stage means neither surface can lose it again.
      */}
      <ParticipantVolumeSheet nameFor={nameFor} />
    </View>
  );
}
