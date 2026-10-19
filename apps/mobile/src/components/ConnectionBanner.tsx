import type { StyleProp, ViewStyle } from "react-native";
import { RefreshCw, WifiOff } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { useChatStore } from "../stores/chat-store";
import { space } from "../theme/theme";
import { Banner } from "./ui/Banner";

/**
 * Status notice shown while the realtime socket is not `online`, drawn on the
 * kit {@link Banner} (borderless Koyu Masa wash, not a bordered strip). Connecting
 * / reconnecting is the quiet `info` tone — the app is already doing something
 * about it, and a flaky network must not shout; a socket that is down is the
 * `warning` tone. It clears itself the moment the socket is back, so it has no
 * close control. Selecting only `connectionStatus` keeps this out of the
 * message-list render path.
 */
export function ConnectionBanner({ style }: { style?: StyleProp<ViewStyle> }) {
  const { t } = useAppTranslation();
  const status = useChatStore((s) => s.connectionStatus);
  if (status === "online") return null;

  const offline = status !== "reconnecting" && status !== "connecting";
  const label =
    status === "reconnecting"
      ? t("mobile:connection.reconnecting")
      : status === "connecting"
        ? t("mobile:connection.connecting")
        : t("mobile:connection.offline");

  return (
    <Banner
      variant={offline ? "warning" : "info"}
      icon={offline ? WifiOff : RefreshCw}
      title={label}
      style={[{ marginHorizontal: space.md, marginTop: space.sm }, style]}
    />
  );
}
