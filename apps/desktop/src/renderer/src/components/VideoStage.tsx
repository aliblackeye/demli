/**
 * Voice-room VIDEO STAGE — the single center-column surface for watching a voice
 * room's people and screen-shares. It is a UNIFIED participant grid:
 *
 *  - Every participant is an EQUAL tile, camera on or off. A camera-on tile shows
 *    the video (whole, `object-contain`, never cropped/mirrored); a camera-off
 *    tile shows a colored gradient with a centered avatar + name chip. The grid
 *    FILLS the stage — the column/row split is chosen from the live tile count and
 *    the measured window shape (see `computeGridShape`) so two people sit side by
 *    side on a wide window, stack on a tall/narrow one, 3–4 land in a 2×2, and
 *    many scroll — always equal tiles, minimal empty space.
 *
 *  1. Focus a tile     — click any tile to promote it to the large stage; the rest
 *                        move to a resizable RIGHT-hand camera panel (a side
 *                        rail). Click it (or "back to grid") to return to default.
 *  2. Fullscreen       — the stage expands to fill the whole window (Esc exits).
 *                        The grid re-solves for the new size, so nothing is
 *                        squished or stretched.
 *  3. Camera panel     — in focus mode the non-stage tiles ride a vertical panel on
 *                        the RIGHT, resizable via a draggable divider (min ~180px /
 *                        max 40%) and collapsible so it never crowds the stream.
 *                        Its MEMBERSHIP follows the conversation (K3): self and the
 *                        screens are always there, everyone else only while the
 *                        active-speaker tracker still counts them as talking
 *                        (300 ms attack / 5 s release, recency-ordered, cap 5).
 *                        Whoever falls out is UNMOUNTED, not hidden — that is what
 *                        lets adaptiveStream/dynacast stop pulling their video —
 *                        and the panel shows how many are being held back, so a
 *                        quiet participant never reads as an absent one.
 *  4. Stage overlay    — ONE draggable, corner-snapping box over the stage (see
 *                        CameraPip). Its subject is your SELF-VIEW by default —
 *                        including an explicit "camera off" rectangle when your
 *                        camera is off — or a camera you pinned from the panel
 *                        while watching a broadcast. Never two boxes.
 *
 * The stage code is IDENTICAL for a server voice room and a DM call: both mount
 * this component (AppCenter / EmbeddedCallStage) and there is no per-surface
 * branch in the layout, the filmstrip rule or the overlay — the founder's rule
 * that the two must not feel different is enforced by there being one path.
 *
 * Default stage: the first screen-share if anyone is sharing, else the participant
 * grid. "What's on the stage" is DERIVED (buildTiles → resolveStage) from the live
 * roster + media sources plus a single `focusedKey` in the video-stage-store — no
 * scattered booleans (§11/§23).
 *
 * Track rendering is fully DELEGATED to CameraTile / LocalCameraTile /
 * ScreenShareTile (imperative livekit `track.attach`; engine snapshots via
 * useRemoteCameras/useRemoteScreenShares). This component never touches a
 * MediaStreamTrack, every source is mounted in exactly one place at a time (no
 * duplicate subscription), and the tiles are memoized on stable refs so a speaking
 * tick re-renders only the tile that changed, not the whole grid (CLAUDE.md §27).
 */

import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { m } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import {
  LayoutGrid,
  Maximize2,
  MessageSquare,
  Minimize2,
  PanelRightClose,
  PanelRightOpen,
  PictureInPicture2,
  Tv,
  Video,
  Volume2,
} from "lucide-react";
import { IconButton, Tooltip, TooltipContent, TooltipTrigger, cn } from "@demli/ui";
import { staggerContainer, staggerItem, transitions } from "@demli/app-ui";
import type { RemoteScreenShare } from "@demli/media";
import type { GroupId } from "@demli/types";
import { useAppTranslation } from "../lib/i18n";
import { useElementSize } from "../hooks/useElementSize";
import { useAutoHideOverlay } from "../hooks/useAutoHideOverlay";
import { getCallController } from "../lib/call-controller";
import { useDmCallSurface } from "../hooks/useDmCallSurface";
import { isScreenCaptureAvailable } from "../lib/screen-share";
import {
  buildTiles,
  computeGridShape,
  isTheaterTile,
  resolveStage,
  type CameraSource,
  type GridShape,
  type StageTile,
} from "../lib/video-stage";
import {
  setRemoteCameraQuality,
  useRemoteCameras,
  useRemoteScreenShares,
  useVoiceStore,
} from "../stores/voice-store";
import { useActiveSpeakers } from "../stores/active-speaker-store";
import { useLocalScreenPreviewTrack } from "../stores/local-screen-preview-store";
import {
  CAMERA_PANEL_MAX_FRAC,
  CAMERA_PANEL_MIN_PX,
  useVideoStageStore,
} from "../stores/video-stage-store";
import { useChatStore } from "../stores/chat-store";
import { useGroupDetails } from "../queries/chat-queries";
import { openChannelChat } from "../lib/channel-actions";
import { CameraTile } from "./CameraTile";
import { LocalCameraTile } from "./LocalCameraTile";
import { ScreenShareTile } from "./ScreenShareTile";
import { LocalScreenShareTile } from "./LocalScreenShareTile";
import { AvatarTile } from "./AvatarTile";
import { CameraPip } from "./CameraPip";
import { StageResizeHandle } from "./StageResizeHandle";
import { StageControlBar } from "./StageControlBar";
import { UpdateBadge } from "./UpdateBadge";
import { SourcePicker } from "./SourcePicker";
import { CameraPreviewDialog } from "./CameraPreviewDialog";
import { WatchPartyStage } from "./WatchPartyStage";
import { WatchVideoDialog } from "./WatchVideoDialog";
import { useHasWatchParty } from "../stores/watch-party-store";
import { startWatchParty } from "../realtime/connection";

const GRID_GAP = 12;
const TILE_ASPECT = 16 / 9;

/** Screen-share tile that resolves the sharer's display name for its label. */
function StageScreen({
  share,
  className,
  onSelect,
  showVolume,
}: {
  share: RemoteScreenShare;
  className?: string;
  onSelect?: () => void;
  /** Show the film-audio volume slider — on for the large watching stage (task #82). */
  showVolume?: boolean;
}): JSX.Element {
  const user = useChatStore((s) => s.users[share.userId]);
  const name = user?.displayName ?? share.identity;
  return (
    <ScreenShareTile
      share={share}
      sharerName={name}
      className={className}
      onSelect={onSelect}
      showVolume={showVolume}
    />
  );
}

/**
 * Render one tile (participant camera / cameraless avatar / screen). The video
 * tiles are memoized on stable refs, so re-creating this node on a parent render
 * does not re-attach or re-render an unchanged tile.
 */
function tileNode(
  tile: StageTile,
  opts: {
    showName: boolean;
    large?: boolean;
    onSelect?: () => void;
    selfLabel?: string;
    /** The server behind the room, for the watch party's owner override. */
    groupId?: GroupId | null;
  },
): ReactNode {
  const { showName, large = false, onSelect, selfLabel } = opts;
  const fill = "h-full w-full";
  if (tile.kind === "watch") {
    // The watch tile is pinned to the stage by resolveStage, so this renders in
    // exactly one place for the life of the session — which is what keeps the
    // iframe from being torn down and re-handshaked (see resolveStage).
    return (
      <WatchPartyStage
        channelId={tile.channelId}
        groupId={opts.groupId ?? null}
        className={fill}
      />
    );
  }
  if (tile.kind === "screen") {
    // Film-audio volume slider only on the large stage tile (not tiny filmstrip).
    return (
      <StageScreen share={tile.share} className={fill} onSelect={onSelect} showVolume={large} />
    );
  }
  if (tile.kind === "local-screen") {
    return (
      <LocalScreenShareTile
        track={tile.track}
        label={selfLabel ?? ""}
        className={fill}
        onSelect={onSelect}
      />
    );
  }
  if (tile.camera) {
    if (tile.camera.kind === "camera-local") {
      return (
        <LocalCameraTile
          deviceId={tile.camera.deviceId}
          participant={tile.participant}
          className={fill}
          onSelect={onSelect}
          showName={showName}
        />
      );
    }
    return (
      <CameraTile
        camera={tile.camera.camera}
        participant={tile.participant}
        className={fill}
        onSelect={onSelect}
        showName={showName}
      />
    );
  }
  return (
    <AvatarTile
      participant={tile.participant}
      className={fill}
      onSelect={onSelect}
      large={large}
    />
  );
}

/**
 * Grid placement for the FIRST tile of an incomplete last row, so a trailing row
 * with fewer tiles than columns is centered (Meet-style) instead of left-aligned.
 * Undefined for every other tile (auto-flow handles them).
 */
function lastRowCenteringStyle(
  index: number,
  shape: GridShape,
  count: number,
): CSSProperties | undefined {
  const firstOfLastRow = shape.cols * (shape.rows - 1);
  if (index !== firstOfLastRow) return undefined;
  const lastRowCount = count - firstOfLastRow;
  if (lastRowCount <= 0 || lastRowCount >= shape.cols) return undefined;
  const leading = Math.floor((shape.cols - lastRowCount) / 2);
  return leading > 0 ? { gridColumnStart: leading + 1 } : undefined;
}

/**
 * Stage-header action: the design system's ghost IconButton (bare glyph, white
 * wash on hover). A toggle passes `pressed`, which both announces `aria-pressed`
 * and paints the coral "on" wash — a plain action leaves it undefined.
 */
function ToolbarButton({
  label,
  icon: Icon,
  pressed,
  onClick,
}: {
  label: string;
  icon: LucideIcon;
  pressed?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <IconButton variant="ghost" size="sm" label={label} tooltipSide="bottom" pressed={pressed} onClick={onClick}>
      <Icon aria-hidden />
    </IconButton>
  );
}

export function VideoStage(): JSX.Element {
  const { t } = useAppTranslation();
  const shares = useRemoteScreenShares();
  const remoteCameras = useRemoteCameras();
  const cameraEnabled = useVoiceStore((s) => s.cameraEnabled);
  const selectedVideoDeviceId = useVoiceStore((s) => s.selectedVideoDeviceId);
  const participants = useVoiceStore((s) => s.participants);
  const screenShareEnabled = useVoiceStore((s) => s.screenShareEnabled);
  const micEnabled = useVoiceStore((s) => s.micEnabled);
  const voiceStatus = useVoiceStore((s) => s.status);
  const toggleMic = useVoiceStore((s) => s.toggleMic);
  const toggleCamera = useVoiceStore((s) => s.toggleCamera);
  const startScreenShare = useVoiceStore((s) => s.startScreenShare);
  const stopScreenShare = useVoiceStore((s) => s.stopScreenShare);
  const leaveVoice = useVoiceStore((s) => s.leave);
  // Room label captured at join (task #2) — names the stage header from any
  // surface, DM calls included. Null → the header shows the hint only.
  const roomLabel = useVoiceStore((s) => s.roomLabel);
  const channelName = roomLabel?.channelName ?? null;
  // The connected room's channel, so the stage can hand the user its CHAT (M20).
  // The voice room id IS the channel id, so this is a lookup, not new state.
  // Unresolved — and the button therefore absent — in the two cases where there
  // is nothing to open: a DM call (no channel behind the room) and a room that
  // belongs to a server other than the one being browsed (whose channel list we
  // are not holding). Both fail to "no button" rather than to a wrong one.
  const voiceRoomId = useVoiceStore((s) => s.roomId);
  const activeGroupId = useChatStore((s) => s.activeGroupId);
  const { data: stageGroupDetails } = useGroupDetails(activeGroupId);
  const roomChannel =
    voiceRoomId === null
      ? undefined
      : stageGroupDetails?.channels.find((c) => c.id === voiceRoomId);

  // ── watch party (M20, ADR 0016) ───────────────────────────────────────────
  // A party is bound to a VOICE CHANNEL, so it exists exactly where `roomChannel`
  // resolves — which already excludes the two surfaces that have no channel behind
  // them: a DM call (an ephemeral `dmcall:<id>` room, never a channel id) and a room
  // on a server other than the one being browsed. Both fail to "no watch party"
  // rather than to a party pointed at the wrong room.
  const watchChannelId = roomChannel?.id ?? null;
  // A BOOLEAN, deliberately: the 5 s sync heartbeat must not re-render the whole
  // stage (§27). The session object is read only inside WatchPartyStage.
  const watchActive = useHasWatchParty(watchChannelId);
  const [watchStartOpen, setWatchStartOpen] = useState(false);

  // Self-preview (founder #2): the sharer's own broadcast auto-appears as a grid
  // tile — no toggle. The raw capture track lives in the imperative preview store;
  // we surface it as a tile whenever we are actually sharing, so a stale/stopped
  // track can never reach the stage (the engine flips `screenShareEnabled` false on
  // every teardown path). It is a normal grid tile you click to focus (buildTiles /
  // resolveStage never auto-promote it), not forced onto the big stage.
  const previewTrack = useLocalScreenPreviewTrack();
  const localScreenTrack = screenShareEnabled ? previewTrack : null;

  const focusedKey = useVideoStageStore((s) => s.focusedKey);
  const filmstripCollapsed = useVideoStageStore((s) => s.filmstripCollapsed);
  const cameraPanelWidth = useVideoStageStore((s) => s.cameraPanelWidth);
  const fullscreen = useVideoStageStore((s) => s.fullscreen);
  const pipEnabled = useVideoStageStore((s) => s.pipEnabled);
  const pipSourceKey = useVideoStageStore((s) => s.pipSourceKey);
  const pipX = useVideoStageStore((s) => s.pipX);
  const pipY = useVideoStageStore((s) => s.pipY);
  const focus = useVideoStageStore((s) => s.focus);
  const clearFocus = useVideoStageStore((s) => s.clearFocus);
  const toggleFullscreen = useVideoStageStore((s) => s.toggleFullscreen);
  const toggleFilmstrip = useVideoStageStore((s) => s.toggleFilmstrip);
  const setCameraPanelWidth = useVideoStageStore((s) => s.setCameraPanelWidth);
  const togglePip = useVideoStageStore((s) => s.togglePip);
  const setPipSource = useVideoStageStore((s) => s.setPipSource);
  const clearPipSource = useVideoStageStore((s) => s.clearPipSource);
  const setPipPosition = useVideoStageStore((s) => s.setPipPosition);
  const setFullscreen = useVideoStageStore((s) => s.setFullscreen);

  const { ref: stageContainerRef, size: stageSize } = useElementSize<HTMLDivElement>();
  // Measures the stage+panel ROW so the camera-panel width can be clamped/converted
  // against the real available width (the panel width is stored as a fraction).
  const { ref: rowRef, size: rowSize } = useElementSize<HTMLDivElement>();

  // Build the ordered tile list (screens, then every participant with any camera).
  // Participant rows and camera/share objects keep stable refs while unchanged, so
  // rebuilding this array on a speaking tick does not re-render the memoized tiles.
  const tiles = useMemo<StageTile[]>(
    () =>
      buildTiles({
        participants,
        remoteCameras,
        shares,
        cameraEnabled,
        selectedVideoDeviceId,
        localScreenTrack,
        watchChannelId: watchActive ? watchChannelId : null,
      }),
    [
      participants,
      remoteCameras,
      shares,
      cameraEnabled,
      selectedVideoDeviceId,
      localScreenTrack,
      watchActive,
      watchChannelId,
    ],
  );

  const selfLabel = t("desktop:stage.yourBroadcast");
  const tileKeys = tiles.map((tile) => tile.key).join("|");

  // ── K3: the filmstrip beside a focused stage follows the CONVERSATION ──────
  // Committed speaking state (300 ms attack / 5 s release, recency-ordered, cap
  // 5) from the shared tracker — never the raw `speaking` flag, which would make
  // the strip strobe on every syllable gap. `recent` is the membership set:
  // everyone else is UNMOUNTED, which is what lets adaptiveStream/dynacast stop
  // pulling their video rather than merely hiding it.
  const speakers = useActiveSpeakers();
  const selfIdentity = participants.find((p) => p.isLocal)?.identity ?? null;
  const speakerFilmstrip = useMemo(
    () => ({ recentSpeakers: speakers.recent, selfIdentity }),
    [speakers.recent, selfIdentity],
  );
  const layout = resolveStage(tiles, { focusedKey, speakerFilmstrip });
  const { locked } = layout;
  // "Theatre" chrome (double-click fullscreen, camera PiP, pin-to-overlay) keys
  // off anything being WATCHED — a screen share or a watch party — not just a
  // screen. See isTheaterTile.
  const stageIsTheater = isTheaterTile(layout.stage);

  // Stable per-tile focus callbacks — rebuilt only when the tile SET changes, so a
  // speaking tick keeps them referentially stable and the memoized tiles skip
  // re-rendering (CLAUDE.md §27). Empty while the layout is LOCKED (a running
  // watch party owns the stage): a tile that cannot be promoted must not look
  // clickable (§35).
  const selectHandlers = useMemo(() => {
    const map = new Map<string, () => void>();
    if (locked) return map;
    for (const key of tileKeys.split("|")) {
      if (key) map.set(key, () => focus(key));
    }
    return map;
  }, [tileKeys, focus, locked]);

  // Drop an explicit focus whose tile has gone away — falls back to the default.
  useEffect(() => {
    if (focusedKey && !tileKeys.split("|").includes(focusedKey)) clearFocus();
  }, [focusedKey, tileKeys, clearFocus]);

  // Esc leaves fullscreen.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") setFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [fullscreen, setFullscreen]);

  // NB: resetting the stage view state is NOT tied to this component's unmount —
  // the center now swaps VideoStage⇄ChatView as the user peeks at chat, and that
  // must PRESERVE focus/panel layout (requirement #3). The reset is owned by
  // AppShell, keyed on the voice session ending (status → idle), so it fires on
  // real teardown but not on a chat detour.

  // Subscriber-side sharpness: when a REMOTE camera is the focused stage (large /
  // fullscreen), ask the SFU for its HIGH simulcast layer; release to adaptive
  // ("auto") when it shrinks back to a tile. Small grid/filmstrip tiles never call
  // this, so they stay on the bandwidth-friendly low layer (adaptiveStream).
  const focusedRemoteCameraId =
    layout.mode === "focus" &&
    layout.stage?.kind === "participant" &&
    layout.stage.camera?.kind === "camera-remote"
      ? layout.stage.camera.camera.identity
      : null;
  useEffect(() => {
    if (!focusedRemoteCameraId) return;
    setRemoteCameraQuality(focusedRemoteCameraId, "high");
    return () => setRemoteCameraQuality(focusedRemoteCameraId, "auto");
  }, [focusedRemoteCameraId]);

  // ── in-stage floating controls (founder: hover the video area) ─────────────
  // Mouse: auto-hiding video-player chrome. Touch/keyboard fallbacks live in
  // StageControlBar (there is no hover on a phone, and a faded bar must still be
  // tabbable). Reuses the SAME hook as the share-tile chrome so the two overlays
  // feel identical.
  const { visible: controlsVisible, handlers: controlsAutoHide, reveal: revealControls } =
    useAutoHideOverlay();
  const [stagePickerOpen, setStagePickerOpen] = useState(false);
  const [stageCameraPreviewOpen, setStageCameraPreviewOpen] = useState(false);

  // Leaving goes through the call controller for a DM call (it owns the row and
  // the last-one-out rule) and straight through the voice store for a server
  // room. VideoStage serves BOTH surfaces, so it picks per-surface rather than
  // assuming one — a wrong choice here would either strand a DM call
  // server-side or throw on a plain voice channel.
  //
  // Both branches now mean the SAME thing to the user: walk out of the room
  // (ADR 0023 §2). The DM branch differs only in that the controller ends the
  // call when nobody is left behind.
  const { state: callState, isDmCall } = useDmCallSurface();
  const callRinging = callState.phase === "outgoing";
  const voiceConnected = voiceStatus === "connected";

  const onStageDisconnect = (): void => {
    if (isDmCall) {
      if (callRinging) void getCallController()?.cancel();
      else void getCallController()?.leaveRoom();
      return;
    }
    leaveVoice();
  };
  const onStageScreenShare = (): void => {
    if (screenShareEnabled) stopScreenShare();
    else setStagePickerOpen(true);
  };
  // Preview-before-publish (#101) — identical wiring to CallDock / VoicePanel, so
  // the camera behaves the same wherever it is turned on.
  const onStageCamera = (): void => {
    if (cameraEnabled) toggleCamera();
    else setStageCameraPreviewOpen(true);
  };

  // Fullscreen is offered ONLY when there is real video to enlarge — a broadcast
  // or somebody's camera. Blowing an avatar grid up to the whole window changes
  // nothing the user can see, and a control that visibly does nothing is worse
  // than an absent one (§35, founder: "eğer yayın falan açıksa").
  const hasVideoToEnlarge = tiles.some(
    (tile) =>
      tile.kind === "screen" ||
      tile.kind === "local-screen" ||
      tile.kind === "watch" ||
      (tile.kind === "participant" && tile.camera !== null),
  );
  // ...but ALWAYS while already fullscreen. Turning your camera off inside
  // fullscreen used to remove the only visible way back out (Esc still worked,
  // which is not a thing to rely on): the control that got you in must never
  // vanish while you are in.
  const canToggleFullscreen = hasVideoToEnlarge || fullscreen;
  const canShareScreenFromStage = voiceConnected && isScreenCaptureAvailable();

  // ── the single floating overlay: self-view by default, a pinned camera if the
  //    user chose one (see video-stage-store for why there is only one box) ────
  //
  // It exists only in FOCUS mode: in the grid you are already a tile, and a
  // second copy of yourself floating over it is noise (K4's rejected variant).
  // A pinned camera additionally requires a THEATRE stage, which is the only
  // place that pin can be set from — so an unreachable pin can never win over
  // the self-view.
  const pinnedCamera: CameraSource | null =
    stageIsTheater && pipSourceKey
      ? (layout.cameras.find((c) => c.key === pipSourceKey) ?? null)
      : null;
  // Showing yourself on top of yourself helps nobody: when YOUR tile is the
  // stage, the self-view stands down (a pinned camera still shows).
  const stageIsSelf =
    layout.stage?.kind === "participant" && layout.stage.participant.isLocal;
  const selfCamera: CameraSource | null =
    layout.cameras.find((c) => c.kind === "camera-local") ?? null;
  const showOverlay =
    pipEnabled && layout.mode === "focus" && (pinnedCamera !== null || !stageIsSelf);
  // `null` source + `self` = the explicit "camera off" rectangle. It is NOT an
  // absent overlay: the founder asked to be able to SEE that his camera is off.
  const overlaySelf = pinnedCamera === null;
  const overlaySource = pinnedCamera ?? selfCamera;

  // Whatever the overlay is showing is mounted THERE, so its tile leaves the
  // filmstrip — one attach per track, one getUserMedia per camera. For the
  // self-view that means the local tile drops out even with the camera off,
  // because the overlay is already representing you.
  const filmstripTiles = !showOverlay
    ? layout.filmstrip
    : layout.filmstrip.filter((tile) => {
        if (tile.kind !== "participant") return true;
        if (overlaySelf) return !tile.participant.isLocal;
        return tile.camera?.key !== overlaySource?.key;
      });
  // In focus mode the non-stage tiles ride a RIGHT panel (resizable,
  // collapsible) instead of a bottom filmstrip (requirement #2). The panel exists
  // whenever there is something to show there; the collapse toggle hides it.
  const panelHasTiles =
    layout.mode === "focus" &&
    (filmstripTiles.length > 0 || layout.hiddenBySpeakerRule.length > 0);
  const showPanel = panelHasTiles && !filmstripCollapsed;

  // Camera-panel width in px, clamped to [MIN_PX, MAX_FRAC·rowWidth] against the
  // measured row. `cameraPanelWidth` is stored resolution-independent (a fraction).
  const rowW = rowSize.width;
  const panelMaxPx = rowW > 0 ? rowW * CAMERA_PANEL_MAX_FRAC : 0;
  const panelWidthPx =
    rowW > 0
      ? Math.min(Math.max(cameraPanelWidth * rowW, CAMERA_PANEL_MIN_PX), panelMaxPx)
      : 260;
  const onPanelResize = (px: number): void => {
    if (rowW > 0) setCameraPanelWidth(px / rowW);
  };

  // Clicking the stage returns to the grid — but not while the layout is locked
  // (a running watch party owns the stage), where the click would do nothing.
  const stageOnSelect = !locked && focusedKey ? clearFocus : undefined;
  const gridShape = computeGridShape(layout.grid.length, stageSize, {
    aspect: TILE_ASPECT,
    gap: GRID_GAP,
  });
  const scrollRowHeight =
    stageSize.width > 0
      ? Math.max(
          140,
          (stageSize.width - GRID_GAP * (gridShape.cols - 1)) / gridShape.cols / TILE_ASPECT,
        )
      : 180;

  const toolbar: ReactNode = (
    <div className="flex shrink-0 items-center justify-between gap-2 pb-3">
      {/* Stage header: channel glyph + name (Onest display) · a dot separator ·
          the contextual hint. The room name comes from the join-time label. */}
      <div className="flex min-w-0 items-center gap-2.5 pl-1">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-surface text-fg-muted">
          <Volume2 aria-hidden className="size-4" />
        </span>
        {channelName && (
          <>
            <span className="shrink-0 truncate font-display text-base font-medium text-fg-display">
              {channelName}
            </span>
            <span aria-hidden className="size-1 shrink-0 rounded-full bg-fg-subtle" />
          </>
        )}
        <p className="truncate text-label text-fg-faint">
          {layout.mode === "grid" ? t("desktop:stage.focusHint") : t("desktop:stage.regionLabel")}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {/* Stage → chat, the other half of the M20 split: the room you are IN has
            a conversation, and getting to it must not mean hunting for its row in
            the sidebar or hanging up. Server voice rooms only — a DM call has no
            channel behind it (and its own messages already flow under the
            embedded stage), so the button is absent rather than inert (§35). */}
        {!isDmCall && roomChannel && (
          <ToolbarButton
            label={t("desktop:stage.openChat")}
            icon={MessageSquare}
            onClick={() => openChannelChat(roomChannel)}
          />
        )}
        {/* Start a watch party (M20, ADR 0016). Only while a party is NOT
            running and only where one can exist — a resolved voice CHANNEL, on a
            connected room. Once a session is live the change/stop/transfer
            controls live in the player's own band (and only for the host), so
            this button never becomes a second, weaker copy of them. Any occupant
            may start one while the room is idle; that is the gateway's rule and
            this agrees with it rather than inventing a stricter one. */}
        {watchChannelId && !watchActive && voiceConnected && (
          <ToolbarButton
            label={t("desktop:watchParty.start")}
            icon={Tv}
            onClick={() => setWatchStartOpen(true)}
          />
        )}
        {focusedKey && !locked && (
          <ToolbarButton
            label={t("desktop:stage.exitFocus")}
            icon={LayoutGrid}
            onClick={clearFocus}
          />
        )}
        {panelHasTiles && (
          <ToolbarButton
            label={
              filmstripCollapsed
                ? t("desktop:stage.showCameras")
                : t("desktop:stage.collapseCameras")
            }
            icon={filmstripCollapsed ? PanelRightOpen : PanelRightClose}
            pressed={!filmstripCollapsed}
            onClick={toggleFilmstrip}
          />
        )}
        {/* The overlay toggle follows the overlay itself: it exists in FOCUS mode
            (where the self-view lives), not only over a broadcast. Labelled for
            whichever subject is actually up, so the control never claims to do
            something other than what it does. */}
        {layout.mode === "focus" && (
          <ToolbarButton
            label={
              pipEnabled
                ? overlaySelf
                  ? t("desktop:stage.selfViewOff")
                  : t("desktop:stage.pipOff")
                : t("desktop:stage.selfViewOn")
            }
            icon={PictureInPicture2}
            pressed={pipEnabled}
            onClick={togglePip}
          />
        )}
        {/* Same rule as the floating bar's fullscreen control: only offered when
            there is actual video to enlarge, so the two can never disagree. */}
        {canToggleFullscreen && (
          <ToolbarButton
            label={
              fullscreen ? t("desktop:stage.fullscreenExit") : t("desktop:stage.fullscreenEnter")
            }
            icon={fullscreen ? Minimize2 : Maximize2}
            pressed={fullscreen}
            onClick={toggleFullscreen}
          />
        )}
        {/* The update badge belongs here too.
            It is rendered per-surface (ChatView, DmView, GroupChatView,
            FriendsView, RecentCallsView) and the stage was simply missed — so a
            user sitting in a voice room, which is where this product is USED,
            never saw that an update had arrived (founder, 2026-07-28: "güncelleme
            gelmiş ama üstte yeşil indirme butonu çıkmadığı oluyor"). It renders
            null unless there is something to do, so adding it here costs nothing
            when there is no update. `update-badge-surfaces.test.ts` now enumerates
            the centre surfaces so the next one cannot forget it. */}
        <UpdateBadge />
      </div>
    </div>
  );

  const gridView: ReactNode =
    layout.grid.length === 0 ? (
      <div
        data-testid="stage-empty"
        className="flex h-full w-full flex-col items-center justify-center gap-3 text-center animate-fade-in"
      >
        <span className="flex size-12 items-center justify-center rounded-full bg-surface text-fg-faint">
          <Video aria-hidden className="size-5" />
        </span>
        <p className="text-label text-fg-muted">{t("desktop:stage.empty")}</p>
      </div>
    ) : gridShape.scroll ? (
      // Tiles resolve in a gentle stagger (framer) on mount; a later join animates
      // its own tile in. Transform+opacity only, so the CSS-grid layout is
      // untouched (§27). Focus/panel/PiP logic is elsewhere and unchanged.
      <m.div
        variants={staggerContainer}
        initial="initial"
        animate="animate"
        className="grid h-full w-full content-start gap-3 overflow-y-auto"
        style={{
          gridTemplateColumns: `repeat(${gridShape.cols}, minmax(0, 1fr))`,
          gridAutoRows: `${scrollRowHeight}px`,
        }}
      >
        {layout.grid.map((tile) => (
          <m.div key={tile.key} variants={staggerItem} className="relative min-h-0 min-w-0">
            {tileNode(tile, { showName: true, onSelect: selectHandlers.get(tile.key), selfLabel })}
          </m.div>
        ))}
      </m.div>
    ) : (
      <m.div
        variants={staggerContainer}
        initial="initial"
        animate="animate"
        className="grid h-full w-full gap-3"
        style={{
          gridTemplateColumns: `repeat(${gridShape.cols}, minmax(0, 1fr))`,
          gridTemplateRows: `repeat(${gridShape.rows}, minmax(0, 1fr))`,
        }}
      >
        {layout.grid.map((tile, index) => (
          <m.div
            key={tile.key}
            variants={staggerItem}
            className="relative min-h-0 min-w-0"
            style={lastRowCenteringStyle(index, gridShape, layout.grid.length)}
          >
            {tileNode(tile, { showName: true, onSelect: selectHandlers.get(tile.key), selfLabel })}
          </m.div>
        ))}
      </m.div>
    );

  const stageArea: ReactNode = (
    <div
      ref={stageContainerRef}
      onDoubleClick={stageIsTheater ? toggleFullscreen : undefined}
      {...controlsAutoHide}
      className="relative min-h-0 min-w-0 flex-1"
    >
      {layout.mode === "grid"
        ? gridView
        : layout.stage && (
            // Keyed by the promoted tile so focusing a different tile CROSSFADES the
            // stage (visual only — resolveStage/focusedKey still own what's on it).
            <m.div
              key={layout.stage.key}
              initial={{ opacity: 0, scale: 0.985 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={transitions.standard}
              className="relative h-full w-full min-h-0"
            >
              {tileNode(layout.stage, {
                showName: layout.stage.kind === "participant",
                large: true,
                onSelect: stageOnSelect,
                selfLabel,
                // The watch tile needs the server behind the room for the owner
                // override; `roomChannel` only resolves inside this group, so
                // the two can never point at different servers.
                groupId: activeGroupId,
              })}
            </m.div>
          )}

      {showOverlay && (
        <CameraPip
          source={overlaySource}
          self={overlaySelf}
          containerSize={stageSize}
          x={pipX}
          y={pipY}
          onMove={setPipPosition}
          // Closing a PINNED camera hands the overlay back to the self-view (the
          // subject you always want back); closing the SELF-VIEW turns the
          // overlay off, which is the only thing "close" can mean there.
          onClose={overlaySelf ? togglePip : clearPipSource}
        />
      )}

      <StageControlBar
        visible={controlsVisible}
        micEnabled={micEnabled}
        onToggleMic={toggleMic}
        cameraEnabled={cameraEnabled}
        onToggleCamera={onStageCamera}
        canUseCamera={voiceConnected}
        screenShareEnabled={screenShareEnabled}
        onToggleScreenShare={onStageScreenShare}
        canShareScreen={canShareScreenFromStage}
        screenShareDisabledHint={
          voiceConnected
            ? t("desktop:voice.shareNeedsDesktop")
            : t("desktop:call.connecting")
        }
        disconnectLabel={
          isDmCall
            ? callRinging
              ? t("desktop:call.cancel")
              : t("desktop:call.leaveRoom")
            : t("desktop:voice.disconnect")
        }
        onDisconnect={onStageDisconnect}
        canFullscreen={canToggleFullscreen}
        fullscreen={fullscreen}
        onToggleFullscreen={toggleFullscreen}
        onInteract={revealControls}
      />
    </div>
  );

  // Right-hand camera panel (requirement #2): the non-stage tiles, stacked
  // vertically and scrollable, at the resizable panel width. Each participant
  // camera keeps its "pin to floating overlay" (PiP) action while a screen is the
  // stage — so a single camera can still float over the stream if the user wants.
  const cameraPanel: ReactNode = showPanel && (
    <aside
      aria-label={t("desktop:stage.cameraPanelLabel")}
      style={{ width: panelWidthPx }}
      className="flex min-h-0 shrink-0 flex-col gap-2 overflow-y-auto"
    >
      {filmstripTiles.map((tile) => {
        const pinnable = tile.kind === "participant" && tile.camera !== null;
        return (
          <m.div
            key={tile.key}
            initial={{ opacity: 0, x: 12 }}
            animate={{ opacity: 1, x: 0 }}
            transition={transitions.standard}
            className="relative aspect-video w-full shrink-0"
          >
            {tileNode(tile, { showName: true, onSelect: selectHandlers.get(tile.key), selfLabel })}
            {stageIsTheater && pinnable && tile.kind === "participant" && tile.camera && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    aria-label={t("desktop:stage.pinToOverlay")}
                    onClick={() => setPipSource(tile.camera!.key)}
                    className={cn(
                      "absolute right-1.5 top-1.5 z-10 flex size-7 items-center justify-center rounded-full surface-glass-strong text-fg",
                      "transition-colors motion-hover hover:bg-raised",
                      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent",
                    )}
                  >
                    <PictureInPicture2 aria-hidden className="size-3.5" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{t("desktop:stage.pinToOverlay")}</TooltipContent>
              </Tooltip>
            )}
          </m.div>
        );
      })}
      {/* The people the speaker rule is holding back. A hidden participant must
          never read as an absent one, so the room's real size stays on screen
          even when most of it is quiet — and the line says WHY they are not
          shown, so the strip does not look broken. */}
      {layout.hiddenBySpeakerRule.length > 0 && (
        <p
          data-testid="filmstrip-quiet-count"
          className="shrink-0 rounded-xl bg-wash px-2 py-2.5 text-center text-2xs font-medium text-fg-muted"
        >
          {t("desktop:stage.quietParticipants", {
            count: layout.hiddenBySpeakerRule.length,
          })}
        </p>
      )}
    </aside>
  );

  return (
    <section
      aria-label={t("desktop:stage.regionLabel")}
      data-testid="video-stage"
      data-mode={layout.mode}
      data-fullscreen={fullscreen || undefined}
      // Koyu Masa: the room sits on the page black, with ONE warm light — a faint
      // coral wash from the top edge (the "dem" light), mixed from the accent
      // token so it follows the palette. Fullscreen arrives with a short fade so
      // the jump to the whole window is a transition, not a cut.
      className={cn(
        "flex min-w-0 flex-col bg-rail",
        "bg-[radial-gradient(80%_45%_at_50%_0%,color-mix(in_oklab,var(--color-accent)_7%,transparent),transparent_75%)]",
        fullscreen ? "fixed inset-0 z-50 p-3 animate-fade-in" : "min-h-0 flex-1 p-4",
      )}
    >
      {toolbar}
      <div
        ref={rowRef}
        className={cn(
          "flex min-h-0 flex-1",
          // The stage card: the base tone (#0d0d0d) on the page black, radius 24,
          // no border and no shadow — Koyu Masa separates by tone alone. Dropped
          // in fullscreen, where the stage fills the window edge-to-edge.
          !fullscreen && "rounded-card bg-app p-3",
        )}
      >
        {stageArea}
        {showPanel && (
          <StageResizeHandle
            ariaLabel={t("desktop:stage.resizeCameras")}
            widthPx={panelWidthPx}
            minPx={CAMERA_PANEL_MIN_PX}
            maxPx={panelMaxPx || panelWidthPx}
            onResize={onPanelResize}
          />
        )}
        {cameraPanel}
      </div>

      {/* Dialogs for the floating bar's camera / screen-share controls. Mounted at
          the section root (not inside the stage) so a portal-less dialog can never
          inherit the stage's pointer handlers or its fullscreen stacking context. */}
      <SourcePicker
        open={stagePickerOpen}
        onOpenChange={setStagePickerOpen}
        onSelect={startScreenShare}
      />
      <CameraPreviewDialog
        open={stageCameraPreviewOpen}
        onOpenChange={setStageCameraPreviewOpen}
      />
      {/* Pick the FIRST video — by search or by link. The "change the video" and
          "add to queue" twins live in the player's own band, so the verbs are
          never offered from the same place at the same time.

          Search matters most right here: this is the moment a party is created,
          and requiring a link from a real browser to get past it would leave the
          "pick it from inside the app" request half-answered. */}
      {watchChannelId && (
        <WatchVideoDialog
          open={watchStartOpen}
          onOpenChange={setWatchStartOpen}
          mode="start"
          channelId={watchChannelId}
          onSubmit={(input) => startWatchParty(watchChannelId, input.videoRef)}
        />
      )}
    </section>
  );
}
