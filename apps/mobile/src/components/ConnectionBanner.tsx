import { View } from "react-native";
import { Text } from "./ui/Text";
import { useAppTranslation } from "@/lib/i18n";
import { useChatStore } from "../stores/chat-store";
import { colors, space } from "../theme/theme";

/**
 * Thin status strip shown while the realtime socket is not `online`. Selecting
 * only `connectionStatus` keeps this out of the message-list render path.
 */
export function ConnectionBanner() {
  const { t } = useAppTranslation();
  const status = useChatStore((s) => s.connectionStatus);
  if (status === "online") return null;

  const label =
    status === "reconnecting"
      ? t("mobile:connection.reconnecting")
      : status === "connecting"
        ? t("mobile:connection.connecting")
        : t("mobile:connection.offline");

  return (
    <View
      style={{
        backgroundColor: colors.surfaceRaised,
        borderBottomWidth: 1,
        borderBottomColor: colors.stroke,
        paddingVertical: space.xs + 2,
        alignItems: "center",
      }}
    >
      <Text style={{ color: colors.idle, fontSize: 12, fontWeight: "600" }}>{label}</Text>
    </View>
  );
}
