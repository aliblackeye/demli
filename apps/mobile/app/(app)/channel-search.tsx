import { useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  View,
} from "react-native";
import { Text, TextInput } from "@/components/ui/Text";
import { Stack, useLocalSearchParams } from "expo-router";
import { Search } from "lucide-react-native";
import type { Message } from "@demli/types";
import { ApiClientError } from "@demli/client-core";
import { useAppTranslation } from "@/lib/i18n";
import { Screen } from "@/components/Screen";
import { Avatar } from "@/components/Avatar";
import { MESSAGE_SEARCH_MIN_CHARS, useChannelSearch } from "@/queries/chat-queries";
import { useChatStore } from "@/stores/chat-store";
import { colors, radius, space, typography } from "@/theme/theme";

/** Debounce for the search field — one request per typing pause (§27). */
const SEARCH_DEBOUNCE_MS = 300;

function formatWhen(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString([], {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * One search hit — author + timestamp + snippet. Tapping toggles between a
 * 2-line snippet and the full message (the simple in-place context view; the
 * search cache holds no arbitrary older page of the live thread to jump into).
 */
function ResultRow({ message }: { message: Message }) {
  const { t } = useAppTranslation();
  const author = useChatStore((s) => s.users[message.authorId]);
  const name = author?.displayName ?? author?.username ?? t("mobile:chat.unknownAuthor");
  const [expanded, setExpanded] = useState(false);
  const body = message.content?.trim() ?? "";

  return (
    <Pressable
      onPress={() => setExpanded((v) => !v)}
      style={({ pressed }) => ({
        flexDirection: "row",
        gap: space.sm,
        paddingHorizontal: space.lg,
        paddingVertical: space.md,
        backgroundColor: pressed ? colors.surfaceRaised : "transparent",
      })}
    >
      <Avatar name={name} size={36} uri={author?.avatarUrl ?? null} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
          <Text
            numberOfLines={1}
            style={{ flexShrink: 1, color: colors.fg, fontSize: 14, fontWeight: "700" }}
          >
            {name}
          </Text>
          <Text style={{ color: colors.fgFaint, fontSize: typography.size["2xs"] }}>{formatWhen(message.createdAt)}</Text>
        </View>
        {body.length > 0 ? (
          <Text
            numberOfLines={expanded ? undefined : 2}
            style={{ color: colors.fgMuted, fontSize: 14, lineHeight: 19 }}
          >
            {body}
          </Text>
        ) : (
          <Text style={{ color: colors.fgFaint, fontSize: 14, fontStyle: "italic" }}>
            {t("mobile:search.attachmentOnly")}
          </Text>
        )}
      </View>
    </Pressable>
  );
}

/**
 * Channel message search (ADR 0011 §5) — the mobile mirror of the desktop
 * ChannelSearchPanel. Opened from the channel header's search icon. Debounces
 * the field, gates on the API's 3-char minimum, and keyset-pages older matches
 * via the FlatList's `onEndReached`.
 */
export default function ChannelSearchScreen() {
  const { t } = useAppTranslation();
  const params = useLocalSearchParams<{ channelId: string; name?: string }>();
  const channelId = params.channelId ?? null;

  const [input, setInput] = useState("");
  const [debounced, setDebounced] = useState("");
  const inputRef = useRef<TextInput>(null);

  // Debounce the raw input into the query the hook actually runs (§27).
  useEffect(() => {
    const id = setTimeout(() => setDebounced(input), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [input]);

  const trimmed = debounced.trim();
  const tooShort = trimmed.length > 0 && trimmed.length < MESSAGE_SEARCH_MIN_CHARS;
  const active = trimmed.length >= MESSAGE_SEARCH_MIN_CHARS;

  const {
    data,
    error,
    isFetching,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    refetch,
  } = useChannelSearch(active ? channelId : null, trimmed);

  const results = useMemo(
    () => data?.pages.flatMap((page) => page.messages) ?? [],
    [data],
  );

  const isRateLimited = error instanceof ApiClientError && error.code === "RATE_LIMITED";
  const showInitialLoading = active && isFetching && results.length === 0 && !error;
  const showEmpty = active && !isFetching && !error && results.length === 0;

  const title = params.name ? `# ${params.name}` : t("mobile:search.title");

  return (
    <Screen>
      <Stack.Screen options={{ title }} />

      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: space.sm,
          margin: space.lg,
          paddingHorizontal: space.md,
          backgroundColor: colors.surfaceRaised,
          borderColor: colors.stroke,
          borderWidth: 1,
          borderRadius: radius.md,
          borderCurve: "continuous",
        }}
      >
        <Search size={18} color={colors.fgFaint} />
        <TextInput
          ref={inputRef}
          value={input}
          onChangeText={setInput}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          placeholder={t("mobile:search.placeholder")}
          placeholderTextColor={colors.fgFaint}
          style={{ flex: 1, color: colors.fg, fontSize: 15, paddingVertical: space.md }}
        />
      </View>

      {!active && !tooShort ? (
        <Text style={{ color: colors.fgFaint, fontSize: 14, textAlign: "center", padding: space.xl }}>
          {t("mobile:search.hint", { count: MESSAGE_SEARCH_MIN_CHARS })}
        </Text>
      ) : null}

      {tooShort ? (
        <Text style={{ color: colors.fgFaint, fontSize: 14, textAlign: "center", padding: space.xl }}>
          {t("mobile:search.tooShort", { count: MESSAGE_SEARCH_MIN_CHARS })}
        </Text>
      ) : null}

      {showInitialLoading ? (
        <View style={{ paddingVertical: space.xl, alignItems: "center" }}>
          <ActivityIndicator color={colors.fgFaint} />
        </View>
      ) : null}

      {error ? (
        <View style={{ padding: space.xl, alignItems: "center", gap: space.md }}>
          <Text style={{ color: colors.fgMuted, fontSize: 14, textAlign: "center" }}>
            {isRateLimited ? t("mobile:search.rateLimited") : t("mobile:search.error")}
          </Text>
          <Pressable onPress={() => void refetch()} hitSlop={8}>
            <Text style={{ color: colors.accent, fontSize: 14, fontWeight: "600" }}>
              {t("buttons.retry")}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {showEmpty ? (
        <Text style={{ color: colors.fgMuted, fontSize: 14, textAlign: "center", padding: space.xl }}>
          {t("mobile:search.noResults", { query: trimmed })}
        </Text>
      ) : null}

      {results.length > 0 ? (
        <FlatList<Message>
          data={results}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <ResultRow message={item} />}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          onEndReachedThreshold={0.4}
          onEndReached={() => {
            if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
          }}
          ListHeaderComponent={
            <Text
              style={{
                color: colors.fgFaint,
                fontSize: typography.size["2xs"],
                fontWeight: "700",
                letterSpacing: 0.6,
                textTransform: "uppercase",
                paddingHorizontal: space.lg,
                paddingBottom: space.xs,
              }}
            >
              {t("mobile:search.resultCount", { count: results.length })}
            </Text>
          }
          ListFooterComponent={
            isFetchingNextPage ? (
              <View style={{ paddingVertical: space.lg }}>
                <ActivityIndicator color={colors.fgFaint} size="small" />
              </View>
            ) : null
          }
        />
      ) : null}
    </Screen>
  );
}
