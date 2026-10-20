/**
 * Pending-attachment tray inside the composer field (ADR 0008 §5) — one chip
 * per queued file: the thumbnail (or a kind glyph + name), a live upload
 * percentage, a friendly error with retry, and remove ×.
 *
 * State lives in stores/attachment-store.ts; all actions go through
 * lib/attachments/manager.ts. The progress bar animates on the UI thread from
 * the store's 0..1 fraction (no per-frame JS work), and chips arrive / leave /
 * reflow on the fast step (instant under reduced motion).
 */

import { useEffect } from "react";
import { ActivityIndicator, ScrollView, View } from "react-native";
import Animated, {
  FadeIn,
  FadeOut,
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Text } from "../ui/Text";
import { Touchable } from "../ui/Touchable";
import { withAlpha } from "../ui/kit-math";
import { Image } from "expo-image";
import { AlertCircle, FileAudio, Film, RotateCcw, X } from "lucide-react-native";
import type { ChannelId } from "@demli/types";
import { removeDraft, retryDraft } from "../../lib/attachments/manager";
import { localizeDraftError, type DraftError } from "../../lib/errors";
import { useAppTranslation } from "../../lib/i18n";
import { useReducedMotion } from "../../theme/motion";
import { useAttachmentStore, type DraftAttachment } from "../../stores/attachment-store";
import { colors, motion, radius, space, typography } from "../../theme/theme";

const TILE = 68;

/** Stable empty reference so the zustand selector doesn't churn identities. */
const EMPTY_DRAFTS: DraftAttachment[] = [];

function DraftThumb({ draft }: { draft: DraftAttachment }) {
  if (draft.kind === "image" && draft.localUri) {
    return (
      <Image
        source={{ uri: draft.localUri }}
        contentFit="cover"
        accessibilityIgnoresInvertColors
        style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}
      />
    );
  }
  const Icon = draft.kind === "audio" ? FileAudio : Film;
  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 4, paddingHorizontal: 6 }}>
      <Icon size={20} color={colors.fgMuted} />
      <Text numberOfLines={1} style={{ color: colors.fgMuted, fontSize: typography.size.badge, maxWidth: TILE - 12 }}>
        {draft.name}
      </Text>
    </View>
  );
}

function ProgressBar({ progress }: { progress: number }) {
  const reduced = useReducedMotion();
  const p = useSharedValue(progress);
  useEffect(() => {
    p.value = reduced
      ? progress
      : withTiming(progress, { duration: motion.duration.fast, reduceMotion: ReduceMotion.System });
  }, [progress, reduced, p]);
  const fill = useAnimatedStyle(() => ({ width: `${Math.round(Math.min(1, Math.max(0, p.value)) * 100)}%` }));
  return (
    <View style={{ height: 3, backgroundColor: colors.washStrong }}>
      <Animated.View style={[{ height: 3, backgroundColor: colors.accent }, fill]} />
    </View>
  );
}

function DraftChip({ channelId, draft }: { channelId: ChannelId; draft: DraftAttachment }) {
  const { t } = useAppTranslation();
  const reduced = useReducedMotion();
  const processing = draft.status === "processing";
  const uploading = draft.status === "uploading";
  const errored = draft.status === "error";
  const percent = Math.round(Math.min(1, Math.max(0, draft.progress)) * 100);

  return (
    <Animated.View
      entering={reduced ? undefined : FadeIn.duration(motion.duration.fast)}
      exiting={reduced ? undefined : FadeOut.duration(motion.duration.instant)}
      layout={reduced ? undefined : LinearTransition.duration(motion.duration.fast)}
      accessible
      accessibilityLabel={draft.name}
      accessibilityRole={uploading ? "progressbar" : undefined}
      accessibilityValue={uploading ? { min: 0, max: 100, now: percent } : undefined}
      style={{
        width: TILE,
        height: TILE,
        borderRadius: radius.lg,
        borderCurve: "continuous",
        overflow: "hidden",
        backgroundColor: colors.surface,
      }}
    >
      <DraftThumb draft={draft} />

      {processing || uploading ? (
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: colors.scrim,
            justifyContent: "flex-end",
          }}
        >
          <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
            {processing ? (
              <ActivityIndicator size="small" color={colors.fg} />
            ) : (
              <Text
                style={{
                  color: colors.fgDisplay,
                  fontSize: typography.size.sm,
                  fontWeight: "600",
                  fontVariant: ["tabular-nums"],
                }}
              >
                {t("mobile:attachments.uploadProgress", { percent })}
              </Text>
            )}
          </View>
          {uploading ? <ProgressBar progress={draft.progress} /> : null}
        </View>
      ) : null}

      {errored ? (
        <Touchable
          onPress={() => retryDraft(channelId, draft.localId)}
          tone={colors.scrim}
          pressedTone={withAlpha(colors.danger, 0.28)}
          accessibilityRole="button"
          accessibilityLabel={t("mobile:attachments.retryUploadA11y")}
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            alignItems: "center",
            justifyContent: "center",
            gap: 3,
          }}
        >
          <AlertCircle size={16} color={colors.danger} />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 3 }}>
            <RotateCcw size={10} color={colors.fg} />
            <Text style={{ color: colors.fg, fontSize: typography.size.badge, fontWeight: "600" }}>
              {t("mobile:attachments.retry")}
            </Text>
          </View>
        </Touchable>
      ) : null}

      <Touchable
        onPress={() => removeDraft(channelId, draft.localId)}
        tone={colors.scrim}
        pressedTone={colors.rail}
        accessibilityRole="button"
        accessibilityLabel={t("mobile:attachments.removeA11y")}
        hitSlop={10}
        style={{
          position: "absolute",
          top: 4,
          right: 4,
          width: 22,
          height: 22,
          borderRadius: radius.pill,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <X size={12} color={colors.fgDisplay} strokeWidth={2.5} />
      </Touchable>
    </Animated.View>
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
      {error !== null ? (
        <Text accessibilityRole="alert" numberOfLines={2} type="meta" tone="danger" style={{ fontWeight: "400", paddingHorizontal: space.xs }}>
          {localizeDraftError(error, t)}
        </Text>
      ) : null}
    </View>
  );
}
