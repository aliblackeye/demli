import { useCallback, useEffect, useState } from "react";
import { Linking, View } from "react-native";
import * as Notifications from "expo-notifications";
import { Bell, BellOff } from "lucide-react-native";
import { Text } from "./ui/Text";
import { Row } from "./Row";
import { useAppTranslation } from "@/lib/i18n";
import { colors, space, typography } from "../theme/theme";

/**
 * Notification permission, made visible and recoverable.
 *
 * The app already asks at sign-in (`push-manager.ensurePermission`), but a denial
 * was a dead end: push silently never arrived, nothing in the UI said why, and on
 * Android a second `requestPermissionsAsync()` is a no-op once the user has said
 * no — so the app COULD not ask again even if it wanted to. The only way back is
 * the OS settings page, and the user had no reason to suspect that.
 *
 * Founder: "bildirimlere izin verin şeyi çıksın da bari bildirimler çalışsın …
 * ben izin vermesem çalışmayacaktı."
 *
 * So this row states the current answer plainly and gives the one action that can
 * change it. It is deliberately NOT a nag: when permission is granted it is a
 * quiet confirmation, not a banner demanding attention.
 */
/** Matches the settings screen's own section label (local to that file). */
function SectionLabel({ children }: { children: string }): JSX.Element {
  return (
    <Text
      style={{
        color: colors.fgFaint,
        fontSize: typography.size["2xs"],
        fontWeight: "700",
        letterSpacing: 0.6,
        textTransform: "uppercase",
        paddingHorizontal: space.lg,
        paddingTop: space.lg,
        paddingBottom: space.xs,
      }}
    >
      {children}
    </Text>
  );
}

export function NotificationPermissionRow(): JSX.Element | null {
  const { t } = useAppTranslation();
  const [granted, setGranted] = useState<boolean | null>(null);
  const [canAskAgain, setCanAskAgain] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const perms = await Notifications.getPermissionsAsync();
      setGranted(perms.granted);
      setCanAskAgain(perms.canAskAgain);
    } catch {
      // A permissions read that throws (older OS, odd OEM) must not blank the
      // settings screen — leave the row hidden rather than showing a lie.
      setGranted(null);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onPress = useCallback(() => {
    void (async () => {
      // Ask in-app while that is still possible; Android turns the prompt into a
      // no-op after a denial, and that is exactly when the OS settings page is
      // the only route.
      if (canAskAgain) {
        try {
          const res = await Notifications.requestPermissionsAsync();
          if (res.granted) {
            await refresh();
            return;
          }
        } catch {
          // fall through to settings
        }
      }
      await Linking.openSettings();
      // The user leaves the app to flip it; re-read when they come back.
      void refresh();
    })();
  }, [canAskAgain, refresh]);

  if (granted === null) return null;

  return (
    <>
      <SectionLabel>{t("mobile:notifications.permissionSection")}</SectionLabel>
      <View style={{ paddingHorizontal: space.md }}>
        <Row
          title={
            granted
              ? t("mobile:notifications.permissionOnTitle")
              : t("mobile:notifications.permissionOffTitle")
          }
          subtitle={
            granted
              ? t("mobile:notifications.permissionOnSubtitle")
              : t("mobile:notifications.permissionOffSubtitle")
          }
          leading={
            granted ? (
              <Bell size={20} color={colors.fgMuted} />
            ) : (
              <BellOff size={20} color={colors.danger} />
            )
          }
          onPress={granted ? undefined : onPress}
          showChevron={!granted}
        />
      </View>
      {!granted ? (
        <Text
          style={{
            color: colors.fgFaint,
            fontSize: 12,
            paddingHorizontal: space.lg,
            paddingTop: space.xs,
          }}
        >
          {t("mobile:notifications.permissionHint")}
        </Text>
      ) : null}
    </>
  );
}
