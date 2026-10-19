/**
 * Attachment tiles for a message row (ADR 0008 §5) — mobile mirror of the
 * desktop's MessageAttachments, on Koyu Masa: borderless rounded tiles, a
 * pulsing placeholder while a picture resolves, the full-screen viewer on tap.
 *
 * Contract-critical behaviors:
 * - Metadata-only DTOs: each tile reserves its EXACT display box BEFORE any
 *   bytes load — a single picture from its stored width/height, several
 *   pictures as an equal square grid sized from the COUNT alone (2 or 4 → two
 *   columns, otherwise three; desktop rule) — so the inverted FlatList never
 *   shifts (CLAUDE.md §27).
 * - Signed URLs are fetched lazily and batched per channel: the FlatList only
 *   mounts rows inside its window, and the resolver coalesces the mounted
 *   tiles' requests into one call; expiry re-signs through the same path.
 * - A broken/expired URL retries the re-sign once automatically, then shows a
 *   quiet retry affordance — never a raw error (CLAUDE.md §26).
 */

import { memo, useMemo, useRef, useState } from "react";
import { View, useWindowDimensions } from "react-native";
import { Text } from "../ui/Text";
import { Touchable } from "../ui/Touchable";
import { Badge } from "../ui/Badge";
import { Skeleton } from "../Skeleton";
import { Image } from "expo-image";
import { VideoView, useVideoPlayer } from "expo-video";
import { useAudioPlayer, useAudioPlayerStatus } from "expo-audio";
import { ImageOff, Pause, Play, RotateCcw } from "lucide-react-native";
import type { AttachmentUrlEntry } from "@demli/client-core";
import type { Attachment, ChannelId } from "@demli/types";
import { imageActionTarget, type ImageActionTarget } from "../../lib/image-actions";
import { ImageActionSheet } from "./ImageActionSheet";
import { ImageViewer, type ViewerImage } from "./ImageViewer";
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
import { useReducedMotion } from "../../theme/motion";
import { PRESS } from "../../theme/motion-presets";
import { colors, motion, radius, space, typography } from "../../theme/theme";

const MAX_TILE_H = 280;
const IMAGE_FALLBACK = { width: 288, height: 162 };
const VIDEO_FALLBACK = { width: 300, height: 168 };
const GRID_GAP = 4;

/** Tile width budget: screen minus avatar column + row paddings. */
function useMaxTileWidth(): number {
  const { width } = useWindowDimensions();
  return Math.max(180, Math.min(320, width - 84));
}

/** Columns for an n-picture grid — desktop rule: 2 or 4 → two, else three. */
export function gridColumns(count: number): number {
  return count === 2 || count === 4 ? 2 : 3;
}

/**
 * Placeholder / broken-state body shared by all tiles. `broken` distinguishes
 * the quiet loading state (the system pulse) from the retry affordance.
 */
function TileFallback({ broken, onRetry }: { broken: boolean; onRetry: () => void }) {
  const { t } = useAppTranslation();
  if (!broken) {
    return <Skeleton width="100%" height="100%" radius={0} />;
  }
  return (
    <View
      accessibilityRole="alert"
      style={{
        flex: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: space.xs,
        padding: space.sm,
        backgroundColor: colors.surface,
      }}
    >
      <ImageOff size={20} color={colors.fgMuted} />
      <Text type="meta" tone="muted" style={{ textAlign: "center", fontWeight: "400" }}>
        {t("mobile:attachments.loadFailed")}
      </Text>
      <Touchable
        onPress={onRetry}
        accessibilityRole="button"
        accessibilityLabel={t("mobile:attachments.retry")}
        hitSlop={8}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.xs,
          paddingHorizontal: space.sm,
          paddingVertical: 4,
          borderRadius: radius.sm,
        }}
      >
        <RotateCcw size={12} color={colors.accent} />
        <Text type="meta" tone="accent" style={{ fontWeight: "600" }}>
          {t("mobile:attachments.retry")}
        </Text>
      </Touchable>
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

function ImageTile({
  attachment,
  channelId,
  entry,
  box,
  crop,
  onOpen,
}: {
  attachment: Attachment;
  channelId: ChannelId;
  entry: AttachmentUrlEntry | undefined;
  box: { width: number; height: number };
  /** Grid cells crop to fill the square; a lone picture shows whole. */
  crop: boolean;
  onOpen: () => void;
}) {
  const { t } = useAppTranslation();
  const reduced = useReducedMotion();
  const recovery = useMediaErrorRecovery(channelId, attachment.id);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
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
        borderRadius: radius.lg,
        borderCurve: "continuous",
        overflow: "hidden",
        backgroundColor: colors.surface,
      }}
    >
      {url !== null && !failed ? (
        <Touchable
          onPress={onOpen}
          // Long press = the app's one per-item action gesture. Save/copy joins
          // that vocabulary rather than inventing a hover a phone cannot show.
          onLongPress={() => setActionsOpen(true)}
          delayLongPress={350}
          tone={colors.surface}
          pressedTone={colors.surface}
          pressScale={PRESS.scale.button}
          accessibilityRole="imagebutton"
          accessibilityLabel={t("mobile:attachments.openImageA11y")}
          accessibilityHint={t("mobile:attachments.imageActionsHint")}
          style={{ flex: 1 }}
        >
          {!loaded ? (
            <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0 }}>
              <Skeleton width="100%" height="100%" radius={0} />
            </View>
          ) : null}
          <Image
            source={{ uri: url }}
            contentFit={crop ? "cover" : "contain"}
            transition={reduced ? 0 : motion.duration.fast}
            accessibilityIgnoresInvertColors
            style={{ flex: 1 }}
            onLoad={() => setLoaded(true)}
            onError={recovery.onMediaError}
          />
        </Touchable>
      ) : (
        <TileFallback broken={Boolean(failed)} onRetry={recovery.reset} />
      )}
      {isGif ? (
        <View pointerEvents="none" style={{ position: "absolute", top: 6, left: 6 }}>
          <Badge label="GIF" variant="veil" />
        </View>
      ) : null}
      <ImageActionSheet
        target={actionsOpen ? actionTarget : null}
        onClose={() => setActionsOpen(false)}
      />
    </View>
  );
}

function VideoTile({
  attachment,
  channelId,
  entry,
}: {
  attachment: Attachment;
  channelId: ChannelId;
  entry: AttachmentUrlEntry | undefined;
}) {
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
        borderRadius: radius.lg,
        borderCurve: "continuous",
        overflow: "hidden",
        backgroundColor: colors.rail,
      }}
    >
      {url !== null && !failed ? (
        <VideoView player={player} nativeControls contentFit="contain" style={{ flex: 1 }} />
      ) : (
        <TileFallback broken={Boolean(failed)} onRetry={recovery.reset} />
      )}
    </View>
  );
}

/**
 * The audio card (design-system "dosya kartı"): surface card, a coral play
 * button, the label with duration and size, and a thin progress line that
 * follows playback.
 */
function AudioTile({
  attachment,
  channelId,
  entry,
}: {
  attachment: Attachment;
  channelId: ChannelId;
  entry: AttachmentUrlEntry | undefined;
}) {
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
  const played =
    status.duration > 0 ? Math.min(1, Math.max(0, status.currentTime / status.duration)) : 0;
  const elapsed = status.currentTime > 0 ? formatMediaDuration(Math.round(status.currentTime * 1000)) : null;

  return (
    <View
      style={{
        width: maxW,
        minHeight: 64,
        borderRadius: radius.xl,
        borderCurve: "continuous",
        backgroundColor: colors.surface,
        overflow: "hidden",
      }}
    >
      {failed ? (
        <View style={{ height: 96 }}>
          <TileFallback broken onRetry={recovery.reset} />
        </View>
      ) : (
        <>
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: space.md,
              paddingHorizontal: space.md,
              paddingVertical: space.md,
            }}
          >
            <Touchable
              onPress={toggle}
              disabled={url === null}
              tone={url === null ? colors.surfaceRaised : colors.accent}
              pressedTone={url === null ? colors.surfaceRaised : colors.accentDeep}
              pressScale={PRESS.scale.icon}
              accessibilityRole="button"
              accessibilityLabel={t(
                status.playing ? "mobile:attachments.pauseAudioA11y" : "mobile:attachments.playAudioA11y",
              )}
              hitSlop={4}
              style={{
                width: 40,
                height: 40,
                borderRadius: radius.pill,
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              {status.playing ? (
                <Pause size={16} color={colors.onAccent} fill={colors.onAccent} />
              ) : (
                <Play
                  size={16}
                  color={url === null ? colors.fgFaint : colors.onAccent}
                  fill={url === null ? colors.fgFaint : colors.onAccent}
                  style={{ marginLeft: 2 }}
                />
              )}
            </Touchable>
            <View style={{ flex: 1, gap: 2 }}>
              <Text numberOfLines={1} type="ui" tone="default" style={{ fontWeight: "600" }}>
                {t("mobile:attachments.audioLabel")}
              </Text>
              <Text style={{ color: colors.fgFaint, fontSize: typography.size["2xs"], fontVariant: ["tabular-nums"] }}>
                {elapsed && durationMs !== null ? `${elapsed} / ` : ""}
                {durationMs !== null ? `${formatMediaDuration(durationMs)} · ` : ""}
                {formatBytes(attachment.sizeBytes)}
              </Text>
            </View>
          </View>
          <View
            importantForAccessibility="no-hide-descendants"
            style={{ height: 3, backgroundColor: colors.wash }}
          >
            <View style={{ height: 3, width: `${Math.round(played * 100)}%`, backgroundColor: colors.accent }} />
          </View>
        </>
      )}
    </View>
  );
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
  const maxW = useMaxTileWidth();
  const urls = useAttachmentUrls(
    channelId,
    attachments.map((a) => a.id),
  );
  const [viewerAt, setViewerAt] = useState<number | null>(null);

  const images = useMemo(() => attachments.filter((a) => a.kind === "image"), [attachments]);
  const others = useMemo(() => attachments.filter((a) => a.kind !== "image"), [attachments]);

  // The viewer pages through the pictures whose URL is ready.
  const viewerImages = useMemo<ViewerImage[]>(() => {
    const list: ViewerImage[] = [];
    for (const a of images) {
      const entry = urls.get(a.id);
      if (entry?.status !== "ready" || !entry.url) continue;
      list.push({
        id: a.id,
        url: entry.url,
        width: a.width,
        height: a.height,
        target: imageActionTarget(a, entry.url),
      });
    }
    return list;
  }, [images, urls]);

  const openViewer = (attachmentId: string) => {
    const at = viewerImages.findIndex((v) => v.id === attachmentId);
    if (at >= 0) setViewerAt(at);
  };

  const columns = gridColumns(images.length);
  const cell = Math.floor((maxW - GRID_GAP * (columns - 1)) / columns);

  return (
    <View style={{ marginTop: space.xs + 2, gap: space.xs + 2, opacity: muted ? 0.6 : 1 }}>
      {images.length === 1 ? (
        <ImageTile
          attachment={images[0]!}
          channelId={channelId}
          entry={urls.get(images[0]!.id)}
          box={fitTileBox(images[0]!.width, images[0]!.height, maxW, MAX_TILE_H, IMAGE_FALLBACK)}
          crop={false}
          onOpen={() => openViewer(images[0]!.id)}
        />
      ) : images.length > 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: GRID_GAP, width: maxW }}>
          {images.map((a) => (
            <ImageTile
              key={a.id}
              attachment={a}
              channelId={channelId}
              entry={urls.get(a.id)}
              box={{ width: cell, height: cell }}
              crop
              onOpen={() => openViewer(a.id)}
            />
          ))}
        </View>
      ) : null}
      {others.map((attachment) =>
        attachment.kind === "video" ? (
          <VideoTile key={attachment.id} attachment={attachment} channelId={channelId} entry={urls.get(attachment.id)} />
        ) : (
          <AudioTile key={attachment.id} attachment={attachment} channelId={channelId} entry={urls.get(attachment.id)} />
        ),
      )}
      {viewerAt !== null ? (
        <ImageViewer images={viewerImages} initialIndex={viewerAt} onClose={() => setViewerAt(null)} />
      ) : null}
    </View>
  );
});
