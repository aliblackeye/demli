import { Image, View } from "react-native";
import { Text } from "./ui/Text";
import { Smartphone } from "lucide-react-native";
import { colors, radius } from "../theme/theme";
import { presenceColor } from "../theme/theme";
import { avatarTileSolid } from "../theme/avatar-color";
import { useAppTranslation } from "../lib/i18n";
import type { PresencePlatform, PresenceStatus } from "@demli/types";

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return (parts[0] ?? "?").slice(0, 2).toUpperCase();
  return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
}

/**
 * Deterministic tint per name, from the SHARED avatar-colour contract in
 * theme/avatar-color.ts — the same algorithm the voice grid and the desktop
 * renderer use, so one person is one colour everywhere.
 *
 * It replaces a private six-hex array that predated that contract and fought
 * the palette twice over: the hexes were cool/neon leftovers, and several were
 * light enough that the white initials on them sat near 2:1. The shared solid
 * is deliberately dark (HSL lightness 24%), which is what makes the cream
 * initials below legible on every hue.
 *
 * `Avatar` is given a display name rather than a user id, and the contract
 * accepts any stable string identity, so the name is the key here.
 */
function tintFor(name: string): string {
  return avatarTileSolid(name);
}

/**
 * Avatar with a deterministic initials fallback. When `uri` is set, the image is
 * overlaid on top of the initials circle so a broken/slow URL degrades to the
 * initials rather than a blank hole (no extra native module — RN core Image).
 *
 * The presence indicator (task #47): a user connected from mobile AND currently
 * online/idle shows a green/amber PHONE glyph instead of the plain dot — the
 * founder's "connected from mobile and looking at the app" signal. Every other
 * case (desktop, unknown platform, or offline) keeps the dot.
 */
export function Avatar({
  name,
  size = 40,
  presence,
  platform,
  uri,
}: {
  name: string;
  size?: number;
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
}) {
  const { t } = useAppTranslation();
  const dot = Math.round(size * 0.32);
  const trimmedUri = uri?.trim() ? uri.trim() : null;
  const showPhone = presence !== undefined && presence !== "offline" && platform === "mobile";
  return (
    <View style={{ width: size, height: size }}>
      <View
        style={{
          width: size,
          height: size,
          borderRadius: radius.pill,
          backgroundColor: tintFor(name),
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        <Text
          selectable={false}
          // Space Grotesk, matching the desktop AvatarTile initials.
          variant="display"
          style={{ color: colors.fg, fontSize: size * 0.4, fontWeight: "700" }}
        >
          {initials(name)}
        </Text>
        {trimmedUri ? (
          <Image
            source={{ uri: trimmedUri }}
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
            // Dark backdrop matching the app so the colored phone reads as a
            // cut-out badge over the avatar (mirrors the desktop treatment).
            backgroundColor: colors.app,
            borderRadius: 5,
            padding: 1.5,
          }}
        >
          <Smartphone
            size={dot + 1}
            color={presenceColor(presence!)}
            strokeWidth={2.5}
          />
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
            borderColor: colors.app,
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          {/* Do Not Disturb: a white dash centered on the red dot. */}
          {presence === "dnd" ? (
            <View
              style={{
                width: Math.max(4, Math.round(dot * 0.42)),
                height: Math.max(1.5, Math.round(dot * 0.16)),
                borderRadius: radius.pill,
                // The dnd dot is a light red, so the dash is the dark on-accent
                // ink (~6.5:1) rather than white (~2.7:1).
                backgroundColor: colors.onAccent,
              }}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
