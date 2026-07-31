import { ActivityIndicator, View } from "react-native";
import { Text } from "../components/ui/Text";
import { useAppTranslation } from "@/lib/i18n";
import { Button } from "../components/Button";
import { colors, space } from "../theme/theme";
import { useUpdatesStore } from "./updates-store";

/**
 * Full-screen blocking gate for a CRITICAL (forced) update. Rendered by
 * `UpdateGate` INSTEAD of the app while any `critical-*` phase is active, so the
 * user cannot proceed until the update is fetched and the app reloads.
 * On failure it stays up and offers a retry (no way past it but to update).
 */
export function CriticalUpdateScreen() {
  const { t } = useAppTranslation();
  const phase = useUpdatesStore((s) => s.phase);
  const errorMessage = useUpdatesStore((s) => s.errorMessage);
  const retryCritical = useUpdatesStore((s) => s.retryCritical);
  const failed = phase === "critical-error";

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: colors.app,
        alignItems: "center",
        justifyContent: "center",
        padding: space.xl,
        gap: space.lg,
      }}
    >
      {!failed ? <ActivityIndicator color={colors.accent} size="large" /> : null}

      <View style={{ gap: space.sm, alignItems: "center" }}>
        <Text variant="display" style={{ color: colors.fg, fontSize: 20, fontWeight: "700", textAlign: "center" }}>
          {t("mobile:updates.criticalTitle")}
        </Text>
        <Text
          selectable
          style={{ color: colors.fgMuted, fontSize: 14, lineHeight: 20, textAlign: "center" }}
        >
          {failed
            ? t("mobile:updates.criticalFailedBody")
            : t("mobile:updates.criticalLoadingBody")}
        </Text>
      </View>

      {failed ? (
        <View style={{ alignSelf: "stretch", gap: space.md }}>
          <Button label={t("buttons.retry")} onPress={() => void retryCritical()} />
          {errorMessage ? (
            <Text
              selectable
              style={{ color: colors.fgFaint, fontSize: 12, textAlign: "center" }}
            >
              {errorMessage}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
