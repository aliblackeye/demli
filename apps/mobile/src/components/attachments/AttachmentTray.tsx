/**
 * Pending-attachment tray above the composer (ADR 0008 §5) — thumbnails for
 * queued uploads with progress, a friendly error + retry, and remove ×.
 * State lives in stores/attachment-store.ts; all actions go through
 * lib/attachments/manager.ts.
 */

import { Pressable, ScrollView, View } from "react-native";
import { Text } from "../ui/Text";
import { Image } from "expo-image";
import { AlertCircle, FileAudio, Film, RotateCcw, X } from "lucide-react-native";
import type { ChannelId } from "@demli/types";
import { removeDraft, retryDraft } from "../../lib/attachments/manager";
import { localizeDraftError, type DraftError } from "../../lib/errors";
import { useAppTranslation } from "../../lib/i18n";
import { useAttachmentStore, type DraftAttachment } from "../../stores/attachment-store";
import { colors, radius, space, typography } from "../../theme/theme";

const TILE = 72;

/** Stable empty reference so the zustand selector doesn't churn identities. */
const EMPTY_DRAFTS: DraftAttachment[] = [];

function DraftThumb({ draft }: { draft: DraftAttachment }) {
  if (draft.kind === "image" && draft.localUri) {
    return (
      <Image
        source={{ uri: draft.localUri }}
        contentFit="cover"
        style={{ position: "absolute", inset: 0 }}
      />
    );
  }
  const Icon = draft.kind === "audio" ? FileAudio : Film;
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
      <Icon size={22} color={colors.fgMuted} />
    </View>
  );
}

function DraftChip({ channelId, draft }: { channelId: ChannelId; draft: DraftAttachment }) {
  const { t } = useAppTranslation();
  const uploading = draft.status === "uploading" || draft.status === "processing";
  const errored = draft.status === "error";

  return (
    <View
      style={{
        width: TILE,
        height: TILE,
        borderRadius: radius.md,
        borderCurve: "continuous",
        overflow: "hidden",
        borderWidth: 1,
        borderColor: errored ? colors.danger : colors.stroke,
        backgroundColor: colors.surfaceRaised,
      }}
    >
      <DraftThumb draft={draft} />

      {uploading && (
        <View
          style={{
            position: "absolute",
            inset: 0,
            backgroundColor: "rgba(0,0,0,0.45)",
            justifyContent: "flex-end",
          }}
        >
          <View style={{ height: 3, backgroundColor: "rgba(255,255,255,0.25)" }}>
            <View
              style={{
                height: 3,
                width: `${Math.round(draft.progress * 100)}%`,
                backgroundColor: colors.accent,
              }}
            />
          </View>
        </View>
      )}

      {errored && (
        <Pressable
          onPress={() => retryDraft(channelId, draft.localId)}
          accessibilityLabel={t("mobile:attachments.retryUploadA11y")}
          style={{
            position: "absolute",
            inset: 0,
            alignItems: "center",
            justifyContent: "center",
            gap: 2,
            backgroundColor: "rgba(0,0,0,0.55)",
          }}
        >
          <AlertCircle size={16} color={colors.danger} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
            <RotateCcw size={10} color={colors.fg} />
            <Text style={{ color: colors.fg, fontSize: typography.size.badge, fontWeight: "600" }}>
              {t("mobile:attachments.retry")}
            </Text>
          </View>
        </Pressable>
      )}

      <Pressable
        onPress={() => removeDraft(channelId, draft.localId)}
        accessibilityLabel={t("mobile:attachments.removeA11y")}
        hitSlop={8}
        style={{
          position: "absolute",
          top: 3,
          right: 3,
          width: 18,
          height: 18,
          borderRadius: radius.pill,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "rgba(0,0,0,0.65)",
        }}
      >
        <X size={12} color={colors.fg} />
      </Pressable>
    </View>
  );
}

/** First error in the tray, surfaced as one line under the chips. */
function firstError(drafts: DraftAttachment[]): DraftError | null {
  for (const draft of drafts) {
    if (draft.status === "error" && draft.error) return draft.error;
  }
  return null;
}

export function AttachmentTray({ channelId }: { channelId: ChannelId }) {
  const { t } = useAppTranslation();
  const drafts = useAttachmentStore((s) => s.drafts[channelId]) ?? EMPTY_DRAFTS;
  if (drafts.length === 0) return null;
  const error = firstError(drafts);

  return (
    <View style={{ gap: space.xs }}>
      <ScrollView
        horizontal
        keyboardShouldPersistTaps="handled"
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ gap: space.sm }}
      >
        {drafts.map((draft) => (
          <DraftChip key={draft.localId} channelId={channelId} draft={draft} />
        ))}
      </ScrollView>
      {error !== null && (
        <Text numberOfLines={2} style={{ color: colors.danger, fontSize: 12 }}>
          {localizeDraftError(error, t)}
        </Text>
      )}
    </View>
  );
}
