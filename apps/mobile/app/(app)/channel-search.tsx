import { memo, useEffect, useMemo, useState } from "react";
import { ActivityIndicator, FlatList, View } from "react-native";
import { Text } from "@/components/ui/Text";
import { Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { AlertCircle, Search, SearchX } from "lucide-react-native";
import type { Message } from "@demli/types";
import { ApiClientError } from "@demli/client-core";
import { useAppTranslation } from "@/lib/i18n";
import { Avatar } from "@/components/Avatar";
import { EmptyState } from "@/components/EmptyState";
import { Screen } from "@/components/Screen";
import { SkeletonList } from "@/components/Skeleton";
import { TextField } from "@/components/TextField";
import { ShellRow } from "@/components/home/ShellRow";
import { Button } from "@/components/ui/Button";
import { SectionHeading } from "@/components/ui/SectionHeading";
import { MESSAGE_SEARCH_MIN_CHARS, useChannelSearch } from "@/queries/chat-queries";
import { useChatStore } from "@/stores/chat-store";
import { colors, space, typography } from "@/theme/theme";

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
 * The snippet with every occurrence of the searched text drawn in coral, so the
 * eye lands on WHY this message matched. Case-insensitive, literal (the query is
 * escaped — a "." the user typed is a dot, not a wildcard).
 */
function Highlighted({ body, query, expanded }: { body: string; query: string; expanded: boolean }) {
  const parts = useMemo(() => {
    const q = query.trim();
    if (q.length === 0) return [{ text: body, hit: false }];
    const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "giu");
    const out: { text: string; hit: boolean }[] = [];
    let last = 0;
    for (const m of body.matchAll(re)) {
      const at = m.index ?? 0;
      if (at > last) out.push({ text: body.slice(last, at), hit: false });
      out.push({ text: m[0], hit: true });
      last = at + m[0].length;
    }
    if (last < body.length) out.push({ text: body.slice(last), hit: false });
    return out;
  }, [body, query]);
  return (
    <Text
      numberOfLines={expanded ? undefined : 2}
      style={{ color: colors.fgMuted, fontSize: 14, lineHeight: 20 }}
    >
      {parts.map((p, i) =>
        p.hit ? (
          <Text key={i} style={{ color: colors.accentHover, fontWeight: "600" }}>
            {p.text}
          </Text>
        ) : (
          p.text
        ),
      )}
    </Text>
  );
}

/**
 * One search hit — author + timestamp + snippet. Tapping toggles between a
 * 2-line snippet and the full message (the simple in-place context view; the
 * search cache holds no arbitrary older page of the live thread to jump into).
 */
const ResultRow = memo(function ResultRow({ message, query }: { message: Message; query: string }) {
  const { t } = useAppTranslation();
  const author = useChatStore((s) => s.users[message.authorId]);
  const name = author?.displayName ?? author?.username ?? t("mobile:chat.unknownAuthor");
  const [expanded, setExpanded] = useState(false);
  const body = message.content?.trim() ?? "";

  return (
    <ShellRow
      onPress={() => setExpanded((v) => !v)}
      minHeight={64}
      style={{ alignItems: "flex-start", paddingVertical: space.md }}
    >
      <Avatar name={name} size={36} uri={author?.avatarUrl ?? null} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: space.sm }}>
          <Text
            numberOfLines={1}
            style={{ flexShrink: 1, color: colors.fg, fontSize: 14, lineHeight: 19, fontWeight: "600" }}
          >
            {name}
          </Text>
          <Text style={{ color: colors.fgFaint, fontSize: typography.size["2xs"], lineHeight: 14, fontVariant: ["tabular-nums"] }}>
            {formatWhen(message.createdAt)}
          </Text>
        </View>
        {body.length > 0 ? (
          <Highlighted body={body} query={query} expanded={expanded} />
        ) : (
          <Text style={{ color: colors.fgFaint, fontSize: 14, lineHeight: 20, fontStyle: "italic" }}>
            {t("mobile:search.attachmentOnly")}
          </Text>
        )}
      </View>
    </ShellRow>
  );
});

/**
 * Channel message search (ADR 0011 §5) — the mobile mirror of the desktop
 * ChannelSearchPanel. Opened from the channel header's search icon. Debounces
 * the field, gates on the API's 3-char minimum, and keyset-pages older matches
 * via the FlatList's `onEndReached`.
 *
 * Every state is drawn: before typing (what this searches), too short, a
 * skeleton while the first page loads, an honest failure (rate limit vs. other)
 * with a retry, no matches (naming the query), and the results with the
 * matched text in coral.
 */
export default function ChannelSearchScreen() {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ channelId: string; name?: string }>();
  const channelId = params.channelId ?? null;

  const [input, setInput] = useState("");
  const [debounced, setDebounced] = useState("");

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
    isRefetching,
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

      <View style={{ paddingHorizontal: space.lg, paddingTop: space.sm, paddingBottom: space.xs }}>
        <TextField
          value={input}
          onChangeText={setInput}
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          accessibilityLabel={t("mobile:search.placeholder")}
          placeholder={t("mobile:search.placeholder")}
          leading={<Search size={18} color={colors.fgFaint} />}
        />
      </View>

      {!active ? (
        <View style={{ paddingTop: space.xxl }}>
          <EmptyState
            compact
            icon={<Search size={22} color={colors.fgMuted} />}
            title={t("mobile:search.startTitle")}
            subtitle={
              tooShort
                ? t("mobile:search.tooShort", { count: MESSAGE_SEARCH_MIN_CHARS })
                : t("mobile:search.hint", { count: MESSAGE_SEARCH_MIN_CHARS })
            }
          />
        </View>
      ) : null}

      {showInitialLoading ? (
        <View style={{ paddingHorizontal: space.lg, paddingTop: space.md }}>
          <SkeletonList count={5} leadingSize={36} />
        </View>
      ) : null}

      {active && error && results.length === 0 ? (
        <View style={{ paddingTop: space.xxl, paddingHorizontal: space.lg }}>
          <EmptyState
            tone="error"
            icon={<AlertCircle size={22} color={colors.danger} />}
            title={isRateLimited ? t("mobile:search.rateLimited") : t("mobile:search.error")}
            action={
              <Button
                variant="secondary"
                size="sm"
                label={t("buttons.retry")}
                loading={isRefetching}
                onPress={() => void refetch()}
              />
            }
          />
        </View>
      ) : null}

      {showEmpty ? (
        <View style={{ paddingTop: space.xxl, paddingHorizontal: space.lg }}>
          <EmptyState
            compact
            icon={<SearchX size={22} color={colors.fgMuted} />}
            title={t("mobile:search.noResults", { query: trimmed })}
          />
        </View>
      ) : null}

      {results.length > 0 ? (
        <FlatList<Message>
          data={results}
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <ResultRow message={item} query={trimmed} />}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          onEndReachedThreshold={0.4}
          onEndReached={() => {
            if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
          }}
          contentContainerStyle={{ paddingHorizontal: space.md, paddingBottom: space.xl + insets.bottom, gap: 2 }}
          ListHeaderComponent={
            <SectionHeading style={{ paddingHorizontal: space.md, paddingTop: space.sm }}>
              {t("mobile:search.resultCount", { count: results.length })}
            </SectionHeading>
          }
          ListFooterComponent={
            isFetchingNextPage ? (
              <View style={{ paddingVertical: space.lg }}>
                <ActivityIndicator color={colors.fgFaint} size="small" />
              </View>
            ) : error ? (
              // A LATER page failed: the hits so far stay, the failure is said
              // where the next page would have appeared, with a way to try again.
              <View style={{ alignItems: "center", gap: space.sm, paddingVertical: space.lg }}>
                <Text style={{ color: colors.fgMuted, fontSize: typography.size.label, lineHeight: 18, textAlign: "center" }}>
                  {isRateLimited ? t("mobile:search.rateLimited") : t("mobile:search.error")}
                </Text>
                <Button variant="ghost" size="sm" label={t("buttons.retry")} onPress={() => void fetchNextPage()} />
              </View>
            ) : null
          }
        />
      ) : null}
    </Screen>
  );
}
