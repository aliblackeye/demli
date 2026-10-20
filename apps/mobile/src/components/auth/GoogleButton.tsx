import { View } from "react-native";
import Svg, { Path } from "react-native-svg";
import { Text } from "../ui/Text";
import { Button } from "../ui/Button";
import { useAppTranslation } from "@/lib/i18n";
import { GOOGLE_AUTH_ENABLED } from "@/lib/auth-config";
import { colors, space, typography } from "@/theme/theme";

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
 * "Continue with Google", gated by {@link GOOGLE_AUTH_ENABLED} (default off).
 *
 * It renders NOTHING while the flag is off — the desktop rule (AuthScreen): a
 * greyed-out button with a "coming soon" line on tap is a dead control in the
 * spot a user reaches for, and the reward for reaching is an apology (§35). One
 * working way in beats two where one lies.
 *
 * With the flag on it draws the divider + the secondary button. The mobile
 * OAuth start is not wired yet (the server half, `POST /auth/google`, exists;
 * the client token flow does not), so the flag must stay off in every build
 * until that lands — turning it on today would move the dead end one tap in.
 */
export function GoogleButton({ onPress }: { onPress?: () => void }) {
  const { t } = useAppTranslation();
  if (!GOOGLE_AUTH_ENABLED || !onPress) return null;

  return (
    <View style={{ gap: space.md }}>
      <View
        importantForAccessibility="no-hide-descendants"
        style={{ flexDirection: "row", alignItems: "center", gap: space.md }}
      >
        <View style={{ flex: 1, height: 1, backgroundColor: colors.stroke }} />
        <Text style={{ color: colors.fgFaint, fontSize: typography.size.label, lineHeight: 18 }}>
          {t("mobile:auth.orDivider")}
        </Text>
        <View style={{ flex: 1, height: 1, backgroundColor: colors.stroke }} />
      </View>
      <Button
        variant="secondary"
        size="lg"
        block
        label={t("mobile:auth.continueWithGoogle")}
        onPress={onPress}
      >
        <GoogleIcon />
      </Button>
    </View>
  );
}
