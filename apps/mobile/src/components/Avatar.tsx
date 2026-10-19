import { useEffect, useState } from "react";
import { View } from "react-native";
import { Image } from "expo-image";
import Animated, { useAnimatedStyle, useSharedValue } from "react-native-reanimated";
import { Smartphone } from "lucide-react-native";
import type { PresencePlatform, PresenceStatus } from "@demli/types";
import { motionTo, useReducedMotion } from "../theme/motion";
import { colors, motion, presenceColor, radius } from "../theme/theme";
import { avatarTileSolid } from "../theme/avatar-color";
import { useAppTranslation } from "../lib/i18n";
import { Text } from "./ui/Text";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] ?? "?").slice(0, 2).toUpperCase();
  return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
}

/**
 * Named size steps — the desktop `UserAvatar` ramp (20 / 32 / 40 / 80) plus the
 * 56 mobile uses for profile headers and call tiles. A raw number still works
 * for the call sites that size an avatar to a measured tile.
 */
export const AVATAR_SIZE = { xs: 20, sm: 32, md: 40, lg: 56, xl: 80 } as const;
export type AvatarSize = keyof typeof AVATAR_SIZE | number;

/** Koyu Masa ring width: every avatar wears 2px of the surface behind it. */
const RING = 2;

/**
 * Avatar with a deterministic initials fallback. The photo sits over the
 * initials, so a slow or dead URL degrades to the initials rather than a blank
 * hole: a failed load is remembered PER URL, so a new `uri` (right after an
 * upload) is retried instead of staying stuck on the fallback. expo-image
 * caches to memory + disk and crossfades the photo in on the fast step (none
 * under reduced motion).
 *
 * Tint: the SHARED avatar-colour contract in theme/avatar-color.ts — the same
 * algorithm the voice grid and the desktop renderer use, so one person is one
 * colour everywhere; the solid is dark enough that the light initials read on
 * every hue.
 *
 * Rings (design system §5 "Avatarlar"):
 *  - `ring` — 2px of `ringColor` (default the app surface) around the circle,
 *    which is what separates overlapping avatars in a stack and the presence
 *    dot from the photo. Drawn OUTSIDE the box, so layout size never changes.
 *  - `speaking` — +2px of coral outside that, fading in/out on the tone step
 *    so a voice row does not flicker as someone talks in bursts.
 *
 * Presence (task #47): a user connected from mobile AND online/idle shows a
 * green/amber PHONE glyph instead of the plain dot — the founder's "connected
 * from mobile and looking at the app" signal. Every other case keeps the dot.
 */
export function Avatar({
  name,
  size: sizeProp = 40,
  presence,
  platform,
  uri,
  ring = false,
  ringColor = colors.app,
  speaking,
}: {
  name: string;
  size?: AvatarSize;
  presence?: PresenceStatus;
  /** Client kind driving the indicator — "mobile" swaps the dot for a phone. */
  platform?: PresencePlatform;
  /**
   * The user's avatar image, or an EXPLICIT `null` when there is genuinely none.
   *
   * REQUIRED on purpose (mirrors desktop `UserAvatarProps.src`). The initials
   * fallback below is a good fallback and a terrible default: a caller that
   * simply forgot `uri` got a plausible circle and no error anywhere — no
   * warning, no blank box, no failing test. That is exactly how the voice room,
   * the call grid, the share filmstrip and the mention list ended up silently
   * dropping every photo (founder, 2026-07-28: "odaya girmeden fotoğraf var,
   * içeri girince kayboluyor"). Keeping the `?` off makes forgetting a build
   * error, and `uri={null}` a decision with a reason next to it — enforced by
   * `avatar-uri-coverage.test.ts`.
   */
  uri: string | null | undefined;
  /** Draw the 2px surface ring (stacks, avatars over media or tinted rows). */
  ring?: boolean;
  /** The surface the avatar sits on — the ring and the presence cut-out match it. */
  ringColor?: string;
  /**
   * Coral speaking ring (voice). Leave UNSET outside voice surfaces: only an
   * avatar that is given the prop mounts the animated ring, so a 200-row member
   * list pays nothing for it (§27).
   */
  speaking?: boolean;
}) {
  const { t } = useAppTranslation();
  const reduced = useReducedMotion();
  const tracksSpeaking = speaking !== undefined;
  const size = typeof sizeProp === "number" ? sizeProp : AVATAR_SIZE[sizeProp];
  const dot = Math.max(10, Math.round(size * 0.3));
  const trimmedUri = uri?.trim() ? uri.trim() : null;
  const [failedUri, setFailedUri] = useState<string | null>(null);
  const showImage = trimmedUri !== null && failedUri !== trimmedUri;
  const showPhone = presence !== undefined && presence !== "offline" && platform === "mobile";

  return (
    <View style={{ width: size, height: size }}>
      {ring || tracksSpeaking ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: -RING,
            left: -RING,
            width: size + RING * 2,
            height: size + RING * 2,
            borderRadius: radius.pill,
            backgroundColor: ringColor,
          }}
        />
      ) : null}
      {tracksSpeaking ? <SpeakingRing size={size} speaking={speaking} reduced={reduced} /> : null}
      <View
        style={{
          width: size,
          height: size,
          borderRadius: radius.pill,
          backgroundColor: avatarTileSolid(name),
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        <Text
          selectable={false}
          // Onest, matching the desktop AvatarTile initials.
          variant="display"
          style={{ color: colors.fgDisplay, fontSize: size * 0.4, fontWeight: "600" }}
        >
          {initials(name)}
        </Text>
        {showImage ? (
          <Image
            source={{ uri: trimmedUri }}
            cachePolicy="memory-disk"
            transition={reduced ? 0 : motion.duration.fast}
            contentFit="cover"
            onError={() => setFailedUri(trimmedUri)}
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              borderRadius: radius.pill,
            }}
            accessibilityIgnoresInvertColors
          />
        ) : null}
      </View>
      {showPhone ? (
        <View
          accessibilityRole="image"
          accessibilityLabel={
            presence === "idle"
              ? t("mobile:presence.idleOnMobile")
              : t("mobile:presence.onlineOnMobile")
          }
          style={{
            position: "absolute",
            right: -3,
            bottom: -3,
            // Cut-out in the surface colour so the coloured phone reads as a
            // badge over the avatar (mirrors the desktop treatment).
            backgroundColor: ringColor,
            borderRadius: 5,
            padding: 1.5,
          }}
        >
          <Smartphone size={dot + 1} color={presenceColor(presence!)} strokeWidth={2.5} />
        </View>
      ) : presence ? (
        <View
          style={{
            position: "absolute",
            right: -1,
            bottom: -1,
            width: dot,
            height: dot,
            borderRadius: radius.pill,
            backgroundColor: presenceColor(presence),
            borderWidth: 2,
            borderColor: ringColor,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {/* Do Not Disturb: a dark dash centred on the pink dot. */}
          {presence === "dnd" ? (
            <View
              style={{
                width: Math.max(4, Math.round(dot * 0.42)),
                height: Math.max(1.5, Math.round(dot * 0.16)),
                borderRadius: radius.pill,
                // The dnd dot is a light pink, so the dash is the dark on-accent
                // ink (~7:1) rather than white (~2.6:1).
                backgroundColor: colors.onAccent,
              }}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** The coral ring outside the surface ring, fading with the speaking state. */
function SpeakingRing({ size, speaking, reduced }: { size: number; speaking: boolean; reduced: boolean }) {
  const speak = useSharedValue(speaking ? 1 : 0);
  useEffect(() => {
    speak.value = motionTo(speaking ? 1 : 0, "tone", { reduced });
  }, [speaking, reduced, speak]);
  const style = useAnimatedStyle(() => ({ opacity: speak.value }));
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          position: "absolute",
          top: -RING * 2,
          left: -RING * 2,
          width: size + RING * 4,
          height: size + RING * 4,
          borderRadius: radius.pill,
          borderWidth: RING,
          borderColor: colors.accent,
        },
        style,
      ]}
    />
  );
}
