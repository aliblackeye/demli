import { Modal, Pressable, View } from "react-native";
import { Text } from "./ui/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { FileAudio, Image as ImageIcon } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { haptics } from "@/lib/haptics";
import { colors, radius, space } from "@/theme/theme";

/**
 * Composer "add attachment" bottom sheet (founder UX: the old Alert.alert
 * options dialog read as a dated Android system dialog). Same RN Modal
 * slide-up pattern as NotificationMuteSheet — theme-tokened rows with icons;
 * the actual picking still goes through lib/attachments/pickers.ts (the modern
 * OS photo picker / document picker).
 */
function SheetRow({
  Icon,
  label,
  onPress,
}: {
  Icon: LucideIcon;
  label: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={() => {
        haptics.light();
        onPress();
      }}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        paddingVertical: space.md,
        paddingHorizontal: space.md,
        borderRadius: radius.md,
        borderCurve: "continuous",
        backgroundColor: pressed ? colors.surfaceRaised : "transparent",
      })}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: radius.pill,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.accentSurface,
        }}
      >
        <Icon size={20} color={colors.accent} />
      </View>
      <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "500" }}>{label}</Text>
    </Pressable>
  );
}

export function AttachmentSheet({
  visible,
  onClose,
  onPickMedia,
  onPickAudio,
}: {
  visible: boolean;
  onClose: () => void;
  onPickMedia: () => void;
  onPickAudio: () => void;
}) {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        onPress={onClose}
        accessibilityLabel={t("common:buttons.close")}
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.55)", justifyContent: "flex-end" }}
      >
        <Pressable
          onPress={() => {}}
          style={{
            backgroundColor: colors.surface,
            borderTopLeftRadius: radius.lg,
            borderTopRightRadius: radius.lg,
            borderCurve: "continuous",
            borderTopWidth: 1,
            borderColor: colors.stroke,
            paddingTop: space.sm,
            paddingBottom: space.md + insets.bottom,
            paddingHorizontal: space.sm,
          }}
        >
          {/* Grab handle. */}
          <View style={{ alignItems: "center", paddingBottom: space.sm }}>
            <View
              style={{
                width: 40,
                height: 4,
                borderRadius: radius.pill,
                backgroundColor: colors.strokeStrong,
              }}
            />
          </View>
          <SheetRow
            Icon={ImageIcon}
            label={t("mobile:attachments.sheetPhotoOrVideo")}
            onPress={() => {
              onClose();
              onPickMedia();
            }}
          />
          <SheetRow
            Icon={FileAudio}
            label={t("mobile:attachments.sheetAudioFile")}
            onPress={() => {
              onClose();
              onPickAudio();
            }}
          />
        </Pressable>
      </Pressable>
    </Modal>
  );
}
