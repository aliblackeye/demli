/**
 * GIF picker bottom sheet — searches Tenor via the API proxy, shows a two-column
 * masonry-ish grid of preview thumbnails, and sends the picked GIF as an image
 * attachment through the standard upload pipeline.
 *
 * Opens with trending GIFs; typing in the search field switches to search results.
 * Pagination fires on FlatList's onEndReached.
 */

import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, View, useWindowDimensions } from "react-native";
import { Image } from "expo-image";
import { Search } from "lucide-react-native";
import type { GifItem } from "@demli/client-core";
import type { Attachment, ChannelId } from "@demli/types";
import { getApi } from "../lib/clients";
import { sendChatMessage } from "../realtime/connection";
import { attachmentUrlResolver } from "../lib/attachments/url-resolver";
import { useGifSearch, useGifTrending } from "../queries/gif-queries";
import { useAppTranslation } from "../lib/i18n";
import { haptics } from "../lib/haptics";
import { toast } from "./ui/Toast";
import { ActionSheet } from "./ui/ActionSheet";
import { Text, TextInput } from "./ui/Text";
import { Touchable } from "./ui/Touchable";
import { PRESS } from "../theme/motion-presets";
import { colors, radius, space } from "../theme/theme";

const GRID_GAP = 4;
const COLUMNS = 2;

export function GifPicker({
  visible,
  channelId,
  onClose,
}: {
  visible: boolean;
  channelId: ChannelId;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const { width: screenW } = useWindowDimensions();
  const [query, setQuery] = useState("");
  const [sending, setSending] = useState(false);

  const trending = useGifTrending();
  const search = useGifSearch(query);

  const isSearching = query.trim().length > 0;
  const active = isSearching ? search : trending;
  const items = useMemo(
    () => active.data?.pages.flatMap((p) => p.results) ?? [],
    [active.data],
  );

  const cellWidth = Math.floor((screenW - space.md * 2 - GRID_GAP * (COLUMNS - 1)) / COLUMNS);

  const pickGif = useCallback(
    async (gif: GifItem) => {
      if (sending) return;
      haptics.light();
      setSending(true);
      onClose();

      try {
        // Download the full GIF as a blob.
        const res = await fetch(gif.fullUrl);
        const blob = await res.blob();
        const sizeBytes = blob.size || gif.fullSize;

        const ticket = await getApi().createAttachmentUploadUrl(channelId, {
          mime: "image/gif",
          sizeBytes,
        });

        await fetch(ticket.uploadUrl, {
          method: "PUT",
          headers: { "Content-Type": "image/gif" },
          body: blob,
        });

        const { attachment } = await getApi().completeAttachment(ticket.attachmentId, {
          width: gif.fullWidth,
          height: gif.fullHeight,
        });

        sendChatMessage(channelId, "", [attachment]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Failed";
        toast({ title: t("common:gif.title"), description: msg, variant: "danger" });
      } finally {
        setSending(false);
      }
    },
    [channelId, sending, onClose, t],
  );

  const renderItem = useCallback(
    ({ item }: { item: GifItem }) => {
      const aspect = item.previewHeight / (item.previewWidth || 1);
      const h = Math.round(cellWidth * aspect);
      return (
        <Touchable
          onPress={() => void pickGif(item)}
          pressScale={PRESS.scale.button}
          accessibilityRole="imagebutton"
          accessibilityLabel={item.title || t("common:gif.title")}
          style={{
            width: cellWidth,
            height: Math.max(60, Math.min(h, 200)),
            borderRadius: radius.md,
            borderCurve: "continuous",
            overflow: "hidden",
            backgroundColor: colors.surface,
          }}
        >
          <Image
            source={{ uri: item.previewUrl }}
            contentFit="cover"
            style={{ flex: 1 }}
            accessibilityIgnoresInvertColors
          />
        </Touchable>
      );
    },
    [cellWidth, pickGif, t],
  );

  const keyExtractor = useCallback((item: GifItem) => item.id, []);

  return (
    <ActionSheet visible={visible} title={t("common:gif.title")} onClose={onClose}>
      {/* Search input */}
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          marginHorizontal: space.sm,
          marginBottom: space.sm,
          paddingHorizontal: space.md,
          height: 40,
          borderRadius: radius.lg,
          borderCurve: "continuous",
          backgroundColor: colors.surface,
        }}
      >
        <Search size={16} color={colors.fgFaint} />
        <TextInput
          value={query}
          onChangeText={setQuery}
          placeholder={t("common:gif.search")}
          placeholderTextColor={colors.fgFaint}
          autoCorrect={false}
          returnKeyType="search"
          style={{
            flex: 1,
            color: colors.fg,
            fontSize: 15,
            paddingVertical: 0,
          }}
        />
      </View>

      {/* GIF grid */}
      <FlatList
        data={items}
        keyExtractor={keyExtractor}
        renderItem={renderItem}
        numColumns={COLUMNS}
        columnWrapperStyle={{ gap: GRID_GAP, paddingHorizontal: space.sm }}
        contentContainerStyle={{ gap: GRID_GAP, paddingBottom: space.lg }}
        style={{ maxHeight: 360 }}
        onEndReached={() => {
          if (active.hasNextPage && !active.isFetchingNextPage) {
            void active.fetchNextPage();
          }
        }}
        onEndReachedThreshold={0.5}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          active.isLoading ? (
            <View style={{ alignItems: "center", paddingVertical: space.xl }}>
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : isSearching && !active.isLoading ? (
            <Text
              type="meta"
              tone="faint"
              style={{ textAlign: "center", paddingVertical: space.xl, fontWeight: "400" }}
            >
              {t("common:gif.noResults")}
            </Text>
          ) : null
        }
        ListFooterComponent={
          active.isFetchingNextPage ? (
            <View style={{ alignItems: "center", paddingVertical: space.md }}>
              <ActivityIndicator size="small" color={colors.fgFaint} />
            </View>
          ) : items.length > 0 ? (
            <Text
              type="caption"
              tone="faint"
              style={{ textAlign: "center", paddingVertical: space.sm, fontWeight: "400" }}
            >
              {t("common:gif.poweredBy")}
            </Text>
          ) : null
        }
      />

      {sending ? (
        <View style={{ alignItems: "center", paddingVertical: space.sm }}>
          <ActivityIndicator size="small" color={colors.accent} />
        </View>
      ) : null}
    </ActionSheet>
  );
}
