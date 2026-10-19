import { memo, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  View,
  useWindowDimensions,
} from "react-native";
import { Image } from "expo-image";
import { ImageIcon, Play } from "lucide-react-native";
import type { AttachmentUrlEntry } from "@demli/client-core";
import type { Attachment } from "@demli/types";
import { EmptyState } from "@/components/EmptyState";
import { useAppTranslation } from "@/lib/i18n";
import { useAttachmentUrls } from "@/lib/attachments/use-attachment-urls";
import { imageActionTarget, type ImageActionTarget } from "@/lib/image-actions";
import { ImageActionSheet } from "@/components/attachments/ImageActionSheet";
import { ImageViewer, type ViewerImage } from "@/components/attachments/ImageViewer";
import { useChannelMessages } from "@/queries/chat-queries";
import { colors, radius, space } from "@/theme/theme";

const GAP = 3;
const COLUMNS = 3;

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
  onOpenImage: (attachmentId: string) => void;
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
      onPress={() => url !== null && onOpenImage(attachment.id)}
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
  /** The picture the shared viewer opened on, or null when closed. */
  const [viewerId, setViewerId] = useState<string | null>(null);
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

  // The viewer pages through every loaded picture of the channel, newest first.
  const viewerImages = useMemo<ViewerImage[]>(() => {
    const list: ViewerImage[] = [];
    for (const a of media) {
      const entry = urls.get(a.id);
      if (a.kind !== "image" || entry?.status !== "ready" || !entry.url) continue;
      list.push({ id: a.id, url: entry.url, width: a.width, height: a.height, target: imageActionTarget(a, entry.url) });
    }
    return list;
  }, [media, urls]);
  const viewerIndex = viewerId === null ? -1 : viewerImages.findIndex((v) => v.id === viewerId);

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
          onOpenImage={setViewerId}
          onImageActions={setActionTarget}
        />
      ))}
      {viewerIndex >= 0 ? (
        <ImageViewer images={viewerImages} initialIndex={viewerIndex} onClose={() => setViewerId(null)} />
      ) : null}
      <ImageActionSheet target={actionTarget} onClose={() => setActionTarget(null)} />
    </View>
  );
}
