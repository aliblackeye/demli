import { View } from "react-native";
import { FileAudio, Image as ImageIcon } from "lucide-react-native";
import type { LucideIcon } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { ActionRow, ActionSheet } from "./ui/ActionSheet";
import { colors, radius } from "@/theme/theme";

/** The coral glyph disc that leads each source row. */
function SourceGlyph({ Icon }: { Icon: LucideIcon }) {
  return (
    <View
      style={{
        width: 36,
        height: 36,
        borderRadius: radius.pill,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.accentSurface,
      }}
    >
      <Icon size={18} color={colors.accent} />
    </View>
  );
}

/**
 * Composer "add attachment" sheet — the kit ActionSheet (draggable, back
 * button, reduced motion) with the two sources the upload pipeline accepts.
 * The picking itself still goes through lib/attachments/pickers.ts (the OS
 * photo picker / document picker); the size and type caps are stated where
 * the files are added, by the tray's own error line.
 */
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
  return (
    <ActionSheet visible={visible} title={t("mobile:attachments.addTitle")} onClose={onClose}>
      <ActionRow
        icon={<SourceGlyph Icon={ImageIcon} />}
        label={t("mobile:attachments.sheetPhotoOrVideo")}
        onPress={() => {
          onClose();
          onPickMedia();
        }}
      />
      <ActionRow
        icon={<SourceGlyph Icon={FileAudio} />}
        label={t("mobile:attachments.sheetAudioFile")}
        onPress={() => {
          onClose();
          onPickAudio();
        }}
      />
    </ActionSheet>
  );
}
