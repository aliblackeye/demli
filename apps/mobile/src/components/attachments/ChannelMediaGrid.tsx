import { memo, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { ImageIcon, Play, X } from "lucide-react-native";
import type { AttachmentUrlEntry } from "@demli/client-core";
import type { Attachment } from "@demli/types";
import { EmptyState } from "@/components/EmptyState";
import { useAppTranslation } from "@/lib/i18n";
import { useAttachmentUrls } from "@/lib/attachments/use-attachment-urls";
import { imageActionTarget, type ImageActionTarget } from "@/lib/image-actions";
import {
  ImageActionButtons,
  ImageActionSheet,
  IMAGE_ACTION_HIT_SIZE,
} from "@/components/attachments/ImageActionSheet";
import { useChannelMessages } from "@/queries/chat-queries";
import { colors, radius, space } from "@/theme/theme";

const GAP = 3;
const COLUMNS = 3;

/**
 * Full-screen image viewer (tap the backdrop or the × to close), with the same
 * save/copy pair the message-tile viewer carries. The buttons live OUTSIDE the
 * dismiss target so a tap on one cannot fall through and close the viewer.
 */
function ImageViewer({
  url,
  target,
  onClose,
}: {
  url: string;
  target: ImageActionTarget;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const { t } = useAppTranslation();
  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.92)" }}>
        <Pressable
          onPress={onClose}
          accessibilityLabel={t("common:buttons.close")}
          style={{ flex: 1, justifyContent: "center" }}
        >
          <Image source={{ uri: url }} contentFit="contain" style={{ width: "100%", height: "100%" }} />
        </Pressable>
        <View
          style={{
            position: "absolute",
            top: insets.top + space.sm,
            left: space.lg,
            right: space.lg,
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
          }}
        >
          <ImageActionButtons target={target} t={t} />
          <Pressable
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={t("common:buttons.close")}
            style={{
              width: IMAGE_ACTION_HIT_SIZE,
              height: IMAGE_ACTION_HIT_SIZE,
              borderRadius: radius.pill,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: "rgba(255,255,255,0.12)",
            }}
          >
            <X size={20} color={colors.fg} />
          </Pressable>
        </View>
      </View>
    </Modal>
  );
}

/** One square media cell. Images open a viewer; videos show a play badge. */
const MediaTile = memo(function MediaTile({
  attachment,
  entry,
  size,
  onOpenImage,
  onImageActions,
}: {
  attachment: Attachment;
  entry: AttachmentUrlEntry | undefined;
  size: number;
  onOpenImage: (target: ImageActionTarget, url: string) => void;
  /** Long press → the shared save/copy sheet, same gesture as a chat image. */
  onImageActions: (target: ImageActionTarget) => void;
}) {
  const { t } = useAppTranslation();
  const url = entry?.status === "ready" ? entry.url : null;
  const isVideo = attachment.kind === "video";

  const frame = {
    width: size,
    height: size,
    borderRadius: radius.sm,
    borderCurve: "continuous" as const,
    overflow: "hidden" as const,
    backgroundColor: colors.surfaceRaised,
  };

  if (isVideo) {
    return (
      <View style={{ ...frame, alignItems: "center", justifyContent: "center", backgroundColor: "#000" }}>
        {url !== null ? (
          <Image source={{ uri: url }} contentFit="cover" style={{ width: "100%", height: "100%" }} />
        ) : null}
        <View
          style={{
            position: "absolute",
            width: 34,
            height: 34,
            borderRadius: radius.pill,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0,0,0,0.5)",
          }}
        >
          <Play size={16} color="#fff" />
        </View>
      </View>
    );
  }

  const target = url === null ? null : imageActionTarget(attachment, url);

  return (
    <Pressable
      onPress={() => url !== null && target !== null && onOpenImage(target, url)}
      onLongPress={() => target !== null && onImageActions(target)}
      delayLongPress={350}
      disabled={url === null}
      accessibilityRole="imagebutton"
      accessibilityLabel={t("mobile:attachments.openImageA11y")}
      accessibilityHint={t("mobile:attachments.imageActionsHint")}
      style={frame}
    >
      {url !== null ? (
        <Image source={{ uri: url }} contentFit="cover" transition={80} style={{ width: "100%", height: "100%" }} />
      ) : null}
    </Pressable>
  );
});

/**
 * A photo/video grid for a channel's shared media (ref #8, group DM "Media" tab).
 * Derives image + video attachments from the channel's cached message pages
 * (newest-first) and resolves their signed URLs through the SAME batched resolver
 * the message tiles use (ADR 0008 §5) — no new endpoint, no duplicated pipeline.
 * Kept simple: renders what is loaded, no infinite scroll of its own.
 */
export function ChannelMediaGrid({ channelId }: { channelId: string }) {
  const { t } = useAppTranslation();
  const { width } = useWindowDimensions();
  const query = useChannelMessages(channelId);
  const [viewer, setViewer] = useState<{ url: string; target: ImageActionTarget } | null>(null);
  const [actionTarget, setActionTarget] = useState<ImageActionTarget | null>(null);

  const media = useMemo<Attachment[]>(() => {
    const out: Attachment[] = [];
    const seen = new Set<string>();
    for (const page of query.data?.pages ?? []) {
      for (const message of page.messages) {
        for (const attachment of message.attachments ?? []) {
          if ((attachment.kind === "image" || attachment.kind === "video") && !seen.has(attachment.id)) {
            seen.add(attachment.id);
            out.push(attachment);
          }
        }
      }
    }
    return out;
  }, [query.data]);

  const ids = useMemo(() => media.map((a) => a.id), [media]);
  const urls = useAttachmentUrls(channelId, ids);

  // Tile size: the grid lives inside the details modal's `space.lg`-padded body.
  const tile = Math.floor((width - space.lg * 2 - GAP * (COLUMNS - 1)) / COLUMNS);

  if (query.isLoading && media.length === 0) {
    return (
      <View style={{ paddingVertical: space.xl, alignItems: "center" }}>
        <ActivityIndicator color={colors.fgFaint} />
      </View>
    );
  }

  if (media.length === 0) {
    return (
      <EmptyState
        icon={<ImageIcon size={22} color={colors.fgMuted} />}
        title={t("mobile:groupChatDetails.mediaEmptyTitle")}
        subtitle={t("mobile:groupChatDetails.mediaEmptySubtitle")}
      />
    );
  }

  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: GAP }}>
      {media.map((attachment) => (
        <MediaTile
          key={attachment.id}
          attachment={attachment}
          entry={urls.get(attachment.id)}
          size={tile}
          onOpenImage={(target, url) => setViewer({ url, target })}
          onImageActions={setActionTarget}
        />
      ))}
      {viewer !== null ? (
        <ImageViewer url={viewer.url} target={viewer.target} onClose={() => setViewer(null)} />
      ) : null}
      <ImageActionSheet target={actionTarget} onClose={() => setActionTarget(null)} />
    </View>
  );
}
