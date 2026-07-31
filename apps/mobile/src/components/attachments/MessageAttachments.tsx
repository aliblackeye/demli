/**
 * Attachment tiles for a message row (ADR 0008 §5) — mobile mirror of the
 * desktop's MessageAttachments.
 *
 * Contract-critical behaviors:
 * - Metadata-only DTOs: each tile reserves its EXACT display box from the
 *   stored width/height BEFORE any bytes load, so the inverted FlatList never
 *   shifts (CLAUDE.md §27).
 * - Signed URLs are fetched lazily and batched per channel: the FlatList only
 *   mounts rows inside its window, and the resolver coalesces the mounted
 *   tiles' requests into one call; expiry re-signs through the same path.
 * - A broken/expired URL retries the re-sign once automatically, then shows a
 *   quiet retry affordance — never a raw error (CLAUDE.md §26).
 */

import { memo, useMemo, useRef, useState } from "react";
import { Modal, Pressable, View, useWindowDimensions } from "react-native";
import { Text } from "../ui/Text";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Image } from "expo-image";
import { VideoView, useVideoPlayer } from "expo-video";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { FileAudio, ImageOff, Pause, Play, RotateCcw, X } from "lucide-react-native";
import type { AttachmentUrlEntry } from "@demli/client-core";
import type { Attachment, ChannelId } from "@demli/types";
import { imageActionTarget, type ImageActionTarget } from "../../lib/image-actions";
import {
  ImageActionButtons,
  ImageActionSheet,
  IMAGE_ACTION_HIT_SIZE,
} from "./ImageActionSheet";
import {
  retryAttachmentUrl,
  useAttachmentUrls,
} from "../../lib/attachments/use-attachment-urls";
import {
  fitTileBox,
  formatBytes,
  formatMediaDuration,
} from "../../lib/attachments/validate";
import { useAppTranslation } from "../../lib/i18n";
import { colors, radius, space, typography } from "../../theme/theme";

const MAX_TILE_H = 260;
const IMAGE_FALLBACK = { width: 288, height: 162 };
const VIDEO_FALLBACK = { width: 300, height: 168 };

/** Tile width budget: screen minus avatar column + row paddings. */
function useMaxTileWidth(): number {
  const { width } = useWindowDimensions();
  return Math.max(180, Math.min(300, width - 110));
}

interface TileProps {
  attachment: Attachment;
  channelId: ChannelId;
  entry: AttachmentUrlEntry | undefined;
}

/**
 * Placeholder / broken-state body shared by all tiles. `broken` distinguishes
 * the quiet loading state from the retry affordance.
 */
function TileFallback({ broken, onRetry }: { broken: boolean; onRetry: () => void }) {
  const { t } = useAppTranslation();
  if (!broken) {
    return <View style={{ flex: 1, backgroundColor: colors.surfaceRaised }} />;
  }
  return (
    <View
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: space.xs,
        backgroundColor: colors.surfaceRaised,
      }}
    >
      <ImageOff size={20} color={colors.fgFaint} />
      <Text style={{ color: colors.fgMuted, fontSize: 12 }}>
        {t("mobile:attachments.loadFailed")}
      </Text>
      <Pressable
        onPress={onRetry}
        hitSlop={8}
        style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}
      >
        <RotateCcw size={12} color={colors.accent} />
        <Text style={{ color: colors.accent, fontSize: 12, fontWeight: "600" }}>
          {t("mobile:attachments.retry")}
        </Text>
      </Pressable>
    </View>
  );
}

/**
 * Auto-heal once on a media load error (the usual cause is an expired signed
 * URL) by re-requesting a fresh URL; a second failure surfaces the retry
 * affordance instead of looping.
 */
function useMediaErrorRecovery(channelId: ChannelId, attachmentId: string) {
  const attempts = useRef(0);
  const [broken, setBroken] = useState(false);

  return {
    broken,
    onMediaError: () => {
      attempts.current += 1;
      if (attempts.current <= 1) {
        retryAttachmentUrl(channelId, attachmentId);
      } else {
        setBroken(true);
      }
    },
    reset: () => {
      attempts.current = 0;
      setBroken(false);
      retryAttachmentUrl(channelId, attachmentId);
    },
  };
}

/**
 * Full-screen image viewer (tap the backdrop or the × to close), with the
 * save/copy pair pinned to the top bar. A long press has nothing to aim at once
 * the picture fills the screen, so here the actions are explicit buttons — and
 * they sit in their OWN row rather than inside the dismiss target, so a tap on
 * "save" can never fall through and close the viewer instead.
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
          <Image
            source={{ uri: url }}
            contentFit="contain"
            style={{ width: "100%", height: "100%" }}
          />
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

function ImageTile({ attachment, channelId, entry }: TileProps) {
  const { t } = useAppTranslation();
  const maxW = useMaxTileWidth();
  const box = fitTileBox(attachment.width, attachment.height, maxW, MAX_TILE_H, IMAGE_FALLBACK);
  const recovery = useMediaErrorRecovery(channelId, attachment.id);
  const [viewerOpen, setViewerOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const isGif = attachment.mime === "image/gif";
  const url = entry?.status === "ready" ? entry.url : null;
  const failed = recovery.broken || entry?.status === "error";

  // The action payload is built from the attachment DTO plus the signed URL the
  // resolver already handed this tile — there is no path by which a URL of
  // someone else's choosing reaches the downloader.
  const actionTarget = useMemo<ImageActionTarget | null>(
    () => (url === null ? null : imageActionTarget(attachment, url)),
    [attachment, url],
  );

  return (
    <View
      style={{
        width: box.width,
        height: box.height,
        borderRadius: radius.md,
        borderCurve: "continuous",
        overflow: "hidden",
        borderWidth: 1,
        borderColor: colors.stroke,
      }}
    >
      {url !== null && !failed ? (
        <Pressable
          onPress={() => setViewerOpen(true)}
          // Long press = the app's one per-item action gesture (message rows,
          // roster rows, DM rows all use it). Save/copy joins that vocabulary
          // rather than inventing a hover-style affordance a phone cannot show.
          onLongPress={() => setActionsOpen(true)}
          delayLongPress={350}
          accessibilityLabel={t("mobile:attachments.openImageA11y")}
          accessibilityHint={t("mobile:attachments.imageActionsHint")}
          style={{ flex: 1 }}
        >
          <Image
            source={{ uri: url }}
            contentFit="cover"
            transition={80}
            style={{ flex: 1 }}
            onError={recovery.onMediaError}
          />
        </Pressable>
      ) : (
        <TileFallback broken={Boolean(failed)} onRetry={recovery.reset} />
      )}
      {isGif && (
        <View
          style={{
            position: "absolute",
            top: 6,
            left: 6,
            borderRadius: 4,
            backgroundColor: "rgba(0,0,0,0.6)",
            paddingHorizontal: 4,
            paddingVertical: 1,
          }}
        >
          <Text style={{ color: "#fff", fontSize: 9, fontWeight: "800", letterSpacing: 0.5 }}>
            GIF
          </Text>
        </View>
      )}
      {viewerOpen && url !== null && actionTarget !== null && (
        <ImageViewer url={url} target={actionTarget} onClose={() => setViewerOpen(false)} />
      )}
      <ImageActionSheet
        target={actionsOpen ? actionTarget : null}
        onClose={() => setActionsOpen(false)}
      />
    </View>
  );
}

function VideoTile({ attachment, channelId, entry }: TileProps) {
  const maxW = useMaxTileWidth();
  const box = fitTileBox(attachment.width, attachment.height, maxW, MAX_TILE_H, VIDEO_FALLBACK);
  const recovery = useMediaErrorRecovery(channelId, attachment.id);
  const url = entry?.status === "ready" ? entry.url : null;
  const failed = recovery.broken || entry?.status === "error";
  // useVideoPlayer accepts null and recreates the player when the URL arrives.
  const player = useVideoPlayer(url);

  return (
    <View
      style={{
        width: box.width,
        height: box.height,
        borderRadius: radius.md,
        borderCurve: "continuous",
        overflow: "hidden",
        borderWidth: 1,
        borderColor: colors.stroke,
        backgroundColor: "#000",
      }}
    >
      {url !== null && !failed ? (
        <VideoView
          player={player}
          nativeControls
          contentFit="contain"
          style={{ flex: 1 }}
        />
      ) : (
        <TileFallback broken={Boolean(failed)} onRetry={recovery.reset} />
      )}
    </View>
  );
}

function AudioTile({ attachment, channelId, entry }: TileProps) {
  const { t } = useAppTranslation();
  const maxW = useMaxTileWidth();
  const recovery = useMediaErrorRecovery(channelId, attachment.id);
  const url = entry?.status === "ready" ? entry.url : null;
  const failed = recovery.broken || entry?.status === "error";
  const player = useAudioPlayer(url ?? undefined);
  const status = useAudioPlayerStatus(player);

  const toggle = () => {
    if (status.playing) {
      player.pause();
      return;
    }
    // Restart a finished clip instead of playing silence from the end.
    if (status.duration > 0 && status.currentTime >= status.duration) {
      void player.seekTo(0);
    }
    player.play();
  };

  const durationMs =
    attachment.durationMs ?? (status.duration > 0 ? Math.round(status.duration * 1000) : null);

  return (
    <View
      style={{
        width: maxW,
        height: 64,
        borderRadius: radius.md,
        borderCurve: "continuous",
        borderWidth: 1,
        borderColor: colors.stroke,
        backgroundColor: colors.surfaceRaised,
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        paddingHorizontal: space.md,
      }}
    >
      {failed ? (
        <TileFallback broken onRetry={recovery.reset} />
      ) : (
        <>
          <Pressable
            onPress={toggle}
            disabled={url === null}
            accessibilityLabel={t(
              status.playing ? "mobile:attachments.pauseAudioA11y" : "mobile:attachments.playAudioA11y",
            )}
            hitSlop={8}
            style={{
              width: 36,
              height: 36,
              borderRadius: radius.pill,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: url === null ? colors.surface : colors.accent,
            }}
          >
            {status.playing ? (
              <Pause size={16} color={colors.onAccent} />
            ) : (
              <Play size={16} color={url === null ? colors.fgFaint : colors.onAccent} />
            )}
          </Pressable>
          <View style={{ flex: 1, gap: 2 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}>
              <FileAudio size={13} color={colors.fgMuted} />
              <Text numberOfLines={1} style={{ color: colors.fg, fontSize: 13, fontWeight: "600" }}>
                {t("mobile:attachments.audioLabel")}
              </Text>
            </View>
            <Text style={{ color: colors.fgFaint, fontSize: typography.size["2xs"] }}>
              {durationMs !== null ? `${formatMediaDuration(durationMs)} · ` : ""}
              {formatBytes(attachment.sizeBytes)}
            </Text>
          </View>
        </>
      )}
    </View>
  );
}

function AttachmentTile(props: TileProps) {
  switch (props.attachment.kind) {
    case "image":
      return <ImageTile {...props} />;
    case "video":
      return <VideoTile {...props} />;
    case "audio":
      return <AudioTile {...props} />;
  }
}

export interface MessageAttachmentsProps {
  channelId: ChannelId;
  attachments: Attachment[];
  /** Dim tiles slightly for optimistic (sending/failed) rows. */
  muted?: boolean;
}

/**
 * The attachment block under a message's text. One URL request covers every
 * tile of the message; the resolver batches across concurrently mounted rows.
 */
export const MessageAttachments = memo(function MessageAttachments({
  channelId,
  attachments,
  muted = false,
}: MessageAttachmentsProps) {
  const urls = useAttachmentUrls(
    channelId,
    attachments.map((a) => a.id),
  );

  return (
    <View style={{ marginTop: space.xs, gap: space.xs, opacity: muted ? 0.6 : 1 }}>
      {attachments.map((attachment) => (
        <AttachmentTile
          key={attachment.id}
          attachment={attachment}
          channelId={channelId}
          entry={urls.get(attachment.id)}
        />
      ))}
    </View>
  );
});
