import { View } from "react-native";
import { Text } from "../ui/Text";
import { useAppTranslation } from "@/lib/i18n";
import { useVoiceStore } from "@/stores/voice-store";
import { colors, radius, space } from "@/theme/theme";
import { AloneCountdownNotice } from "./AloneCountdownNotice";
import { localizeVoiceError } from "./voice-error";

/**
 * The voice notices every call surface shows — the DM call (InCallView, also
 * after a group upgrade) and the server / group-DM voice room — so a mic,
 * camera, screen or reconnect failure reads the same wherever the user is. The
 * mobile twin of what the desktop VoicePanel renders under its status line: the
 * "you're the only one here" countdown, then the §26 voice error (localized,
 * never a stack trace). One component, so the surfaces cannot drift again.
 */
export function VoiceNotices({ marginTop }: { marginTop?: number }) {
  const { t } = useAppTranslation();
  const error = useVoiceStore((s) => s.error);
  const message = localizeVoiceError(error, t);

  return (
    <>
      <AloneCountdownNotice marginTop={marginTop} />
      {message ? (
        <View
          accessibilityRole="alert"
          style={{
            marginHorizontal: space.lg,
            marginTop: marginTop ?? space.sm,
            padding: space.md,
            borderRadius: radius.md,
            borderCurve: "continuous",
            backgroundColor: colors.dangerSurface,
          }}
        >
          <Text selectable style={{ color: colors.danger, fontSize: 13 }}>
            {message}
          </Text>
        </View>
      ) : null}
    </>
  );
}
