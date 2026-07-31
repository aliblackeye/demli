import { useState } from "react";
import { Pressable, View } from "react-native";
import { Text } from "../ui/Text";
import Svg, { Path } from "react-native-svg";
import { useAppTranslation } from "@/lib/i18n";
import { GOOGLE_AUTH_ENABLED } from "@/lib/auth-config";
import { colors, radius, space } from "@/theme/theme";

/** Self-hosted 4-colour Google "G" (no remote asset). Mirrors the desktop mark. */
function GoogleIcon({ size = 18 }: { size?: number }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 48 48">
      <Path
        fill="#FFC107"
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
      />
      <Path
        fill="#FF3D00"
        d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
      />
      <Path
        fill="#4CAF50"
        d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
      />
      <Path
        fill="#1976D2"
        d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
      />
    </Svg>
  );
}

/**
 * "Continue with Google" — a visible-but-inactive placeholder (M15), gated by
 * {@link GOOGLE_AUTH_ENABLED}. Until OAuth is wired the button reads as disabled
 * and tapping it surfaces a "coming soon" line; flipping the env var un-greys it
 * (the actual OAuth start is still a TODO, mirroring the desktop flag). Includes
 * the "or" divider above it so the two auth screens just drop this in.
 */
export function GoogleButton() {
  const { t } = useAppTranslation();
  const [showSoon, setShowSoon] = useState(false);
  const enabled = GOOGLE_AUTH_ENABLED;

  return (
    <View style={{ gap: space.md }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: space.md }}>
        <View style={{ flex: 1, height: 1, backgroundColor: colors.stroke }} />
        <Text style={{ color: colors.fgFaint, fontSize: 12, textTransform: "uppercase", letterSpacing: 0.6 }}>
          {t("mobile:auth.orDivider")}
        </Text>
        <View style={{ flex: 1, height: 1, backgroundColor: colors.stroke }} />
      </View>

      <Pressable
        onPress={() => {
          if (enabled) return; // OAuth start — TODO once the provider is wired.
          setShowSoon(true);
        }}
        accessibilityRole="button"
        accessibilityState={{ disabled: !enabled }}
        accessibilityLabel={t("mobile:auth.continueWithGoogle")}
        style={({ pressed }) => ({
          minHeight: 46,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "center",
          gap: space.sm,
          borderRadius: radius.md,
          borderCurve: "continuous",
          borderWidth: 1,
          borderColor: colors.stroke,
          backgroundColor: colors.surfaceRaised,
          opacity: enabled ? (pressed ? 0.85 : 1) : 0.6,
        })}
      >
        <GoogleIcon />
        <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "600" }}>
          {t("mobile:auth.continueWithGoogle")}
        </Text>
      </Pressable>

      {showSoon && !enabled ? (
        <Text style={{ color: colors.fgFaint, fontSize: 12, textAlign: "center" }}>
          {t("mobile:auth.googleSoon")}
        </Text>
      ) : null}
    </View>
  );
}
