import { memo, useCallback, useState } from "react";
import type { LayoutChangeEvent, ViewStyle } from "react-native";
import { Pressable, View } from "react-native";
import { MicOff, VolumeX } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { Avatar } from "@/components/Avatar";
import { avatarTileGlow } from "@/theme/avatar-color";
import { colors, space } from "@/theme/theme";
import { Text } from "../ui/Text";
import { CameraTile } from "./CameraTile";
import { openParticipantVolumeSheet } from "./ParticipantVolumeSheet";
import { IdentityGlow, MediaPill, SpeakingFrame, TILE_RADIUS, usePressWash } from "./stage-chrome";

/**
 * One participant as an EQUAL, screen-filling tile — the
 * unit the unified voice grid is built from. Camera on OR off, every participant
 * is the same size; a cameraless participant is a full tile (neutral surface +
 * a faint identity glow + big centered avatar + name chip), never a cramped chip
 * in a side strip.
 *
 *  - has a live camera track → delegates to the PRESERVED {@link CameraTile}
 *    (which keeps the media-overhaul contain/no-mirror-crop fix untouched).
 *  - no track → renders {@link AvatarTile}: the neutral `surface` tile with a
 *    faint glow in the person's hue behind the avatar (hue deterministic from
 *    `userId`, shared 1:1 with desktop — see theme/avatar-color), the avatar
 *    centered and a bottom name chip. The same look as the desktop stage tile.
 *
 * Memoized on primitive props so an active-speaker tick only re-renders the ONE
 * tile whose `speaking`/`muted` actually changed (CLAUDE.md §27) — the live track
 * object is passed by stable reference, never rebuilt here.
 */
export interface ParticipantTileData {
  /** Stable key + roster join key — the participant identity. */
  identity: string;
  /** Drives the deterministic cameraless-tile glow hue (shared w/ desktop). */
  userId: string;
  name: string;
  /**
   * The participant's avatar image, or null when they have none. Resolved by the
   * surface that builds these tiles, from the SAME identity sources as `name`
   * (group roster → DM peer → users directory), so a tile that can show a name
   * can always show the photo.
   */
  avatarUrl: string | null;
  isLocal: boolean;
  /** Mic is off → show the muted badge. */
  muted: boolean;
  speaking: boolean;
  /** Live camera video track, or null → render the avatar tile. */
  track: object | null;
  /**
   * Listener's personal playback volume for this remote, 0..2 (kişi-başı ses
   * seviyesi). Absent/1 = default; 0 → the "muted for you" marker on the tile.
   * Ignored for the local user (you can't attenuate yourself).
   */
  volume?: number;
}

/**
 * A CAMERALESS participant as a full tile: the neutral surface with the person's
 * identity glow behind the avatar, the avatar centered and a bottom-center name chip (+ mic-off badge). The avatar
 * scales to the tile via onLayout so it stays big in a grid cell and compact in a
 * filmstrip — no fixed size, no giant lonely circle in a black void.
 *
 * Koyu Masa: borderless, the shared tile radius, the name in a {@link MediaPill},
 * the coral {@link SpeakingFrame} for "talking", a wash on press. Identity is the
 * glow only ({@link IdentityGlow}, the desktop tile's disc): a full-bleed hue
 * would turn a room of camera-off people into saturated blocks that also blur
 * into the coral speaking frame and the pink danger tone.
 */
function AvatarTile({
  userId,
  name,
  avatarUrl,
  isLocal,
  muted,
  speaking,
  mutedForYou,
  onPress,
  onLongPress,
  accessibilityLabel,
  style,
}: {
  userId: string;
  name: string;
  avatarUrl: string | null;
  isLocal: boolean;
  muted: boolean;
  speaking: boolean;
  /** Volume set to 0 by this listener → show the "muted for you" glyph. */
  mutedForYou?: boolean;
  onPress?: () => void;
  /** Long-press → open the per-user volume sheet (remotes only). */
  onLongPress?: () => void;
  accessibilityLabel?: string;
  style?: ViewStyle;
}) {
  const { t } = useAppTranslation();
  const glow = avatarTileGlow(userId);
  const wash = usePressWash();
  // Size the avatar to the measured tile so it fills a grid cell yet shrinks in a
  // filmstrip. clamp(min(w,h) * 0.42) with sane floor/ceiling. The same
  // measurement sizes the identity glow.
  const [box, setBox] = useState({ width: 0, height: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const width = Math.round(e.nativeEvent.layout.width);
    const height = Math.round(e.nativeEvent.layout.height);
    if (width !== box.width || height !== box.height) setBox({ width, height });
  };
  const avatarSize =
    box.width > 0 ? Math.round(Math.max(28, Math.min(120, Math.min(box.width, box.height) * 0.42))) : 0;

  const label = isLocal ? t("mobile:voice.cameraYou", { name }) : name;

  const frame: ViewStyle = {
    overflow: "hidden",
    borderRadius: TILE_RADIUS,
    borderCurve: "continuous",
    backgroundColor: colors.surface,
    ...style,
  };

  const body = (
    <>
      <IdentityGlow color={glow} width={box.width} height={box.height} />
      <View
        onLayout={onLayout}
        style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.sm }}
      >
        {avatarSize > 0 ? <Avatar name={name} size={avatarSize} uri={avatarUrl} /> : null}
      </View>
      {/* Bottom-center name chip — the cameraless tile's only identity marker. */}
      <MediaPill
        style={{ position: "absolute", bottom: space.sm, alignSelf: "center", maxWidth: "88%" }}
      >
        {muted ? <MicOff size={12} color={colors.danger} strokeWidth={2.25} /> : null}
        {mutedForYou ? <VolumeX size={12} color={colors.fgMuted} strokeWidth={2.25} /> : null}
        <Text
          numberOfLines={1}
          style={{ color: colors.fgDisplay, fontSize: 12, fontWeight: "600", flexShrink: 1 }}
        >
          {label}
        </Text>
      </MediaPill>
      <SpeakingFrame speaking={speaking} />
    </>
  );

  if (onPress || onLongPress) {
    return (
      <Pressable
        onPress={onPress}
        onLongPress={onLongPress}
        delayLongPress={350}
        {...wash.handlers}
        accessibilityRole="button"
        // "Speaking" is part of what TalkBack reads — the ring alone is visual.
        accessibilityLabel={
          speaking
            ? t("mobile:voice.speakingA11y", { name: accessibilityLabel ?? label })
            : (accessibilityLabel ?? label)
        }
        style={frame}
      >
        {body}
        {wash.overlay}
      </Pressable>
    );
  }
  return <View style={frame}>{body}</View>;
}

export const ParticipantTile = memo(function ParticipantTile({
  identity,
  userId,
  track,
  name,
  avatarUrl,
  isLocal,
  muted,
  speaking,
  volume,
  focused,
  showName = false,
  contain = false,
  onSelect,
  onPress,
  accessibilityLabel,
  style,
}: {
  /** Participant identity — the arg `onSelect` is called with. */
  identity: string;
  userId: string;
  /** Live camera track, or null → avatar tile. */
  track: object | null;
  name: string;
  /** Avatar image for the cameraless tile, or null when the user has none. */
  avatarUrl: string | null;
  isLocal: boolean;
  muted: boolean;
  speaking: boolean;
  /** Listener's personal playback volume, 0..2 (0 → "muted for you"). Self ignored. */
  volume?: number;
  /** Marks the focused/stage tile (passed through to the camera tile). */
  focused?: boolean;
  /** Show the participant name on a CAMERA tile (avatar tiles always show it). */
  showName?: boolean;
  /** Camera tile: fit the whole frame (contain) instead of cropping (cover). */
  contain?: boolean;
  /**
   * Tappable → promote to focus / switch focus. Prefer this over `onPress`: passing
   * a STABLE `onSelect` (+ the stable `identity`) lets the grid keep the same
   * handler reference across renders, so an active-speaker tick doesn't re-render
   * every tile (§27). `onPress` is an escape hatch for one-off handlers (e.g. the
   * stage's exit-focus tap) and wins when both are set.
   */
  onSelect?: (identity: string) => void;
  onPress?: () => void;
  accessibilityLabel?: string;
  style?: ViewStyle;
}) {
  // Stable per-tile handler: identity + onSelect are both stable, so unchanged
  // tiles keep the same `handlePress` reference and the memo below holds.
  const selectHandler = useCallback(() => onSelect?.(identity), [onSelect, identity]);
  const handlePress = onPress ?? (onSelect ? selectHandler : undefined);

  // Long-press → per-user volume sheet. Self-wired via identity (no prop drilling
  // through the grid/stage, §27) and NEVER for the local user (can't attenuate
  // yourself). Stable reference so the memo holds across active-speaker ticks.
  const longPressHandler = useCallback(() => openParticipantVolumeSheet(identity), [identity]);
  const handleLongPress = isLocal ? undefined : longPressHandler;
  const mutedForYou = !isLocal && (volume ?? 1) <= 0;

  if (track) {
    return (
      <CameraTile
        track={track}
        name={name}
        isLocal={isLocal}
        muted={muted}
        speaking={speaking}
        focused={focused}
        mutedForYou={mutedForYou}
        showName={showName}
        contain={contain}
        onPress={handlePress}
        onLongPress={handleLongPress}
        accessibilityLabel={accessibilityLabel}
        style={style}
      />
    );
  }
  return (
    <AvatarTile
      userId={userId}
      name={name}
      avatarUrl={avatarUrl}
      isLocal={isLocal}
      muted={muted}
      speaking={speaking}
      mutedForYou={mutedForYou}
      onPress={handlePress}
      onLongPress={handleLongPress}
      accessibilityLabel={accessibilityLabel}
      style={style}
    />
  );
});
