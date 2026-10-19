import { ActivityIndicator, View } from "react-native";
import { Text } from "../components/ui/Text";
import { useAppTranslation } from "@/lib/i18n";
import { Button } from "../components/ui/Button";
import { colors, space } from "../theme/theme";
import { UpdateScreenFrame } from "./UpdateScreenFrame";
import { useUpdatesStore } from "./updates-store";

/**
 * Full-screen blocking gate for a CRITICAL (forced) update. Rendered by
 * `UpdateGate` INSTEAD of the app while any `critical-*` phase is active, so the
 * user cannot proceed until the update is fetched and the app reloads.
 * On failure it stays up and offers a retry (no way past it but to update).
 *
 * expo-updates reports no download fraction, so the waiting state is an honest
 * spinner, not an invented percentage.
 */
export function CriticalUpdateScreen() {
  const { t } = useAppTranslation();
  const phase = useUpdatesStore((s) => s.phase);
  const errorMessage = useUpdatesStore((s) => s.errorMessage);
  const retryCritical = useUpdatesStore((s) => s.retryCritical);
  const failed = phase === "critical-error";

  return (
    <UpdateScreenFrame
      title={t("mobile:updates.criticalTitle")}
      body={failed ? t("mobile:updates.criticalFailedBody") : t("mobile:updates.criticalLoadingBody")}
    >
      {failed ? (
        <>
          <Button variant="primary" size="lg" block label={t("buttons.retry")} onPress={() => void retryCritical()} />
          {errorMessage ? (
            <Text
              selectable
              style={{ color: colors.fgFaint, fontSize: 12, lineHeight: 16, textAlign: "center" }}
            >
              {errorMessage}
            </Text>
          ) : null}
        </>
      ) : (
        <View style={{ alignItems: "center", paddingTop: space.xs }}>
          <ActivityIndicator color={colors.accent} />
        </View>
      )}
    </UpdateScreenFrame>
  );
}
