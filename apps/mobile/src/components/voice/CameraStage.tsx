import { useCallback, useEffect, useMemo, useState } from "react";
import type { LayoutChangeEvent, ViewStyle } from "react-native";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Expand, LayoutGrid, PictureInPicture2 } from "lucide-react-native";
import { participantKey, resolveStage, type StageTile } from "@demli/media";
import { useAppTranslation } from "@/lib/i18n";
import { setRemoteCameraQuality } from "@/stores/voice-store";
import { useSelfViewStore } from "@/stores/self-view-store";
import { space } from "@/theme/theme";
import { Badge } from "../ui/Badge";
import { IconButton } from "../ui/IconButton";
import { useActiveSpeakers } from "./active-speakers";
import { ParticipantGrid } from "./CameraGrid";
import { ParticipantTile, type ParticipantTileData } from "./ParticipantTile";
import { SelfViewPip } from "./SelfViewPip";
import { toVideoTrackRef } from "./track-ref";
import type { MobileStage } from "./use-stage-tiles";
import { VideoFullscreenModal } from "./VideoFullscreenModal";

/**
 * The participant area when no screen share owns the stage. Two modes (founder
 * requirements #1–#2), and BOTH are decided by the shared pure model
 * `resolveStage` in `@demli/media` — the same one the desktop stage runs on
 * (ADR 0022), so grid⇄focus and the speaker-driven filmstrip behave identically
 * on both platforms instead of each surface inventing its own rule.
 *
 *  - grid: every participant an equal, screen-filling tile — camera on OR off
 *    (see {@link ParticipantGrid}). Tapping any tile promotes it to the stage.
 *  - focus: the tapped tile fills a large stage; the rest form a compact
 *    horizontal filmstrip. Tap the stage (or the grid button) to return; tap a
 *    filmstrip tile to move focus there; the expand button opens a CAMERA stage
 *    fullscreen ({@link VideoFullscreenModal}) — a cameraless (avatar) focus has
 *    no fullscreen (nothing to enlarge).
 *
 * K3 SPEAKER FILMSTRIP. In focus mode the strip is not "everyone else": it is
 * you, plus whoever has actually spoken recently, ordered by recency and capped —
 * with the rest reported as a "+N" count so a quiet participant never reads as an
 * absent one. The membership set comes from the ONE shared `ActiveSpeakerTracker`
 * (300 ms attack / 5 s release), so the strip follows the conversation instead of
 * strobing on every syllable gap. The rule only engages once there is a crowd to
 * thin (see `SPEAKER_FILMSTRIP_MIN_OTHERS`); in a 1-1 call nothing is hidden.
 * Tiles outside the strip are UNMOUNTED, not hidden, so `adaptiveStream` stops
 * pulling their video.
 *
 * K4 SELF-VIEW. While another tile owns the stage your own tile is off it, so the
 * draggable {@link SelfViewPip} carries your camera — and, when your camera is
 * off, an explicit "camera off" rectangle rather than nothing. It is excluded
 * from the filmstrip while it is up so you are never drawn twice.
 *
 * Focus is local UI state (which tile is large), never engine state — it changes
 * nothing about tracks or subscriptions. If the focused participant leaves,
 * `resolveStage` simply stops resolving that key and we fall back to the grid.
 */
export function CameraStage({ stage }: { stage: MobileStage }) {
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const speakers = useActiveSpeakers();

  // The K3 policy: self + screens always, everyone else only while recently
  // heard. `recent` already carries the hysteresis and the ceiling.
  const layout = useMemo(
    () =>
      resolveStage(stage.stageTiles, {
        focusedKey,
        speakerFilmstrip: {
          recentSpeakers: speakers.recent,
          selfIdentity: stage.selfIdentity,
        },
      }),
    [stage.stageTiles, focusedKey, speakers.recent, stage.selfIdentity],
  );

  // A tile the grid reports by identity becomes a stage key through the shared
  // key helper — never a hand-rolled string (§23, no magic strings).
  const focusIdentity = useCallback((identity: string) => {
    setFocusedKey(participantKey(identity));
  }, []);

  // The focused tile vanished (they left) — resolveStage already fell back to the
  // grid; drop our stale key and close any fullscreen so no dead tile renders.
  useEffect(() => {
    if (focusedKey && layout.mode === "grid") {
      setFocusedKey(null);
      setFullscreen(false);
    }
  }, [focusedKey, layout.mode]);

  const focused = layout.stage ? stage.tileByKey.get(layout.stage.key) ?? null : null;

  // Subscriber-side sharpness: a focused REMOTE camera is large, so ask the SFU
  // for its HIGH simulcast layer; release to adaptive ("auto") when it returns to
  // a small tile. Only meaningful for a remote CAMERA tile.
  const focusedRemoteId = focused?.track && !focused.isLocal ? focused.identity : null;
  useEffect(() => {
    if (!focusedRemoteId) return;
    setRemoteCameraQuality(focusedRemoteId, "high");
    return () => setRemoteCameraQuality(focusedRemoteId, "auto");
  }, [focusedRemoteId]);

  if (layout.mode === "grid" || !focused || !layout.stage) {
    return <ParticipantGrid tiles={stage.tiles} onTilePress={focusIdentity} />;
  }

  return (
    <FocusStage
      stage={stage}
      focused={focused}
      filmstrip={layout.filmstrip}
      hiddenCount={layout.hiddenBySpeakerRule.length}
      locked={layout.locked}
      fullscreen={fullscreen}
      setFullscreen={setFullscreen}
      setFocusedKey={setFocusedKey}
      onFocusIdentity={focusIdentity}
    />
  );
}

/**
 * The focus layout: one large stage tile, a compact filmstrip of whoever is
 * currently worth showing, and the self-view overlay. Split into its own
 * component so the stable style/handler hooks live outside the early return in
 * {@link CameraStage} (Rules of Hooks), and so the filmstrip tiles stay
 * memo-stable across active-speaker ticks (§27).
 */
function FocusStage({
  stage,
  focused,
  filmstrip,
  hiddenCount,
  locked,
  fullscreen,
  setFullscreen,
  setFocusedKey,
  onFocusIdentity,
}: {
  stage: MobileStage;
  focused: ParticipantTileData;
  filmstrip: StageTile[];
  hiddenCount: number;
  locked: boolean;
  fullscreen: boolean;
  setFullscreen: (v: boolean) => void;
  setFocusedKey: (key: string | null) => void;
  onFocusIdentity: (identity: string) => void;
}) {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const selfViewEnabled = useSelfViewStore((s) => s.enabled);
  const toggleSelfView = useSelfViewStore((s) => s.toggle);

  // Measure the stage box so the self-view overlay can clamp/corner-snap inside
  // it rather than against the whole window.
  const [box, setBox] = useState({ w: 0, h: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setBox((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }));
  };

  // Stable style objects so an active-speaker tick doesn't churn the memoized
  // filmstrip tiles (§27).
  const stageStyle = useMemo<ViewStyle>(() => ({ flex: 1 }), []);
  const stripStyle = useMemo<ViewStyle>(() => ({ width: 108, aspectRatio: 3 / 4 }), []);
  const exitFocus = useCallback(() => setFocusedKey(null), [setFocusedKey]);

  const selfTile = stage.selfIdentity
    ? stage.tileByKey.get(participantKey(stage.selfIdentity)) ?? null
    : null;
  const selfIsOnStage = focused.isLocal;
  // The self-view carries you while it is up, so drop your filmstrip tile — being
  // drawn twice is the "iki ayrı kutu" the founder asked us not to build. When the
  // overlay is off (or you ARE the stage) the strip keeps you, so you never
  // disappear from your own room entirely.
  const showSelfView = selfViewEnabled && !selfIsOnStage && selfTile !== null;
  const strip = useMemo(
    () =>
      filmstrip
        .map((tile) => stage.tileByKey.get(tile.key) ?? null)
        .filter((tile): tile is ParticipantTileData => tile !== null)
        .filter((tile) => !(showSelfView && tile.isLocal)),
    [filmstrip, stage.tileByKey, showSelfView],
  );

  // One stable reference to the focused CAMERA track, reused by the fullscreen
  // viewer — null when the focused tile is cameraless (avatar), so no fullscreen.
  const focusTrackRef = useMemo(
    () => (focused.track ? toVideoTrackRef(focused.track) : null),
    [focused.track],
  );

  const focusLabel = focused.isLocal
    ? t("mobile:voice.cameraYou", { name: focused.name })
    : focused.name;

  return (
    <View style={{ flex: 1, gap: space.md }}>
      {/* Stage: the focused tile, large. Tap it to exit focus (requirement #1). */}
      <View style={{ flex: 1 }} onLayout={onLayout}>
        <ParticipantTile
          identity={focused.identity}
          userId={focused.userId}
          track={focused.track}
          name={focused.name}
          avatarUrl={focused.avatarUrl}
          isLocal={focused.isLocal}
          muted={focused.muted}
          speaking={focused.speaking}
          volume={focused.volume}
          focused
          // Stage view: label the person and show the WHOLE frame (contain) so a
          // landscape camera is never cropped in a portrait stage.
          showName
          contain
          onPress={locked ? undefined : exitFocus}
          accessibilityLabel={t("mobile:voice.focus.exit")}
          style={stageStyle}
        />
        {/* Overlay controls, rendered after the tile so they win their own taps. */}
        <View
          style={{
            position: "absolute",
            top: space.sm,
            right: space.sm,
            flexDirection: "row",
            gap: space.sm,
          }}
        >
          {/* Self-view toggle (K4) — offered only when you are not the stage
              yourself, because in that case the stage already IS your self-view. */}
          {!selfIsOnStage && selfTile ? (
            <IconButton
              icon={PictureInPicture2}
              variant="veil"
              active={selfViewEnabled}
              toggle
              onPress={toggleSelfView}
              label={
                selfViewEnabled
                  ? t("mobile:voice.selfView.hide")
                  : t("mobile:voice.selfView.show")
              }
            />
          ) : null}
          {/* Fullscreen only makes sense for a live camera. */}
          {focused.track ? (
            <IconButton
              icon={Expand}
              variant="veil"
              onPress={() => setFullscreen(true)}
              label={t("mobile:voice.fullscreen.open")}
            />
          ) : null}
          {locked ? null : (
            <IconButton
              icon={LayoutGrid}
              variant="veil"
              onPress={exitFocus}
              label={t("mobile:voice.focus.exit")}
            />
          )}
        </View>

        {/* K4 self-view: your own camera (or the explicit camera-off rectangle),
            draggable and corner-snapping inside the measured stage box. */}
        {box.w > 0 && showSelfView ? (
          <SelfViewPip self={selfTile} width={box.w} height={box.h} insets={insets} />
        ) : null}
      </View>

      {/* Filmstrip: whoever the speaker rule currently keeps on screen. Tap to
          move focus there. The "+N" chip keeps the room's real size legible when
          most of it is quiet — a withheld participant must never read as gone. */}
      {strip.length > 0 || hiddenCount > 0 ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: space.sm, alignItems: "center" }}
            style={{ flex: 1 }}
          >
            {strip.map((tile) => (
              <ParticipantTile
                key={tile.identity}
                identity={tile.identity}
                userId={tile.userId}
                track={tile.track}
                name={tile.name}
                avatarUrl={tile.avatarUrl}
                isLocal={tile.isLocal}
                muted={tile.muted}
                speaking={tile.speaking}
                volume={tile.volume}
                onSelect={onFocusIdentity}
                accessibilityLabel={t("mobile:voice.focus.focusCamera", { name: tile.name })}
                style={stripStyle}
              />
            ))}
          </ScrollView>
          {hiddenCount > 0 ? (
            <View
              accessible
              accessibilityRole="text"
              accessibilityLabel={t("mobile:voice.filmstripHiddenA11y", { n: hiddenCount })}
            >
              <Badge label={t("mobile:voice.filmstripHidden", { n: hiddenCount })} />
            </View>
          ) : null}
        </View>
      ) : null}

      {/* Fullscreen the focused CAMERA (requirement #2). Built from the same live
          track — one reference, no extra subscription. The self-view rides along
          (K4: focus AND fullscreen), so you can still see your own state. */}
      {focusTrackRef ? (
        <VideoFullscreenModal
          visible={fullscreen}
          trackRef={focusTrackRef}
          label={focusLabel}
          mirror={focused.isLocal}
          // A CAMERA is aspect-correct contain, never the landscape rotate-to-fill
          // (that's for a wide desktop SCREEN share) — so it can't squish/crop.
          allowFill={false}
          selfViewTile={showSelfView ? selfTile : null}
          onClose={() => setFullscreen(false)}
        />
      ) : null}
    </View>
  );
}
