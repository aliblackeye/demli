/**
 * Pick a video for a watch party, on the phone — by searching YouTube from inside
 * the app, or by pasting a link (M20 mobile parity).
 *
 * The RN twin of `packages/app-ui/src/components/WatchVideoPicker.tsx`. Same
 * rules, different container: a bottom sheet instead of a centred dialog, because
 * on a phone the field has to sit above the keyboard rather than behind it, and
 * the results have to be thumb-reachable rather than mouse-reachable.
 *
 * ## One input, two meanings, and the quota is the reason
 *
 * The field is a search box AND a link box. Which one it is is decided by what is
 * in it: a parseable YouTube reference is submitted directly and costs no quota,
 * anything else is a search phrase. That ordering matters most on mobile, where
 * the overwhelmingly common act is pasting a link somebody dropped in the chat.
 *
 * Nothing is searched while typing. A search happens on an EXPLICIT act — the
 * keyboard's search key, or the button — and never on a keystroke. The daily
 * budget belongs to the whole deployment (see `queries/watch-queries.ts`), so a
 * phone typing its way through it would spend the laptops' allowance too.
 *
 * ## When search is off, there is no search box
 *
 * A deployment with no API key answers `{ searchEnabled: false }`, and then the
 * search affordance is not rendered at all — not greyed out, not present-but-
 * failing (§35). The sheet becomes exactly the paste-a-link sheet, with copy that
 * says so, and the link path keeps working.
 *
 * ## Titles and thumbnails are somebody else's strings
 *
 * `title` and `channelTitle` come from YouTube. They are rendered as RN `<Text>`
 * children — never markdown, never a link, never anything that could become
 * markup. The thumbnail is loaded from `i.ytimg.com` and nothing else can be,
 * because that is the only host the result payload names.
 */

import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MonitorPlay, Search, TriangleAlert } from "lucide-react-native";
import { parseYouTubeVideoId } from "@demli/config";
import { useAppTranslation } from "@/lib/i18n";
import { haptics } from "@/lib/haptics";
import { colors, radius, space } from "@/theme/theme";
import { Text, TextInput } from "../ui/Text";
import { formatWatchDuration } from "./watch-queue";
import type { WatchPickerResult, WatchPickerSearchState } from "@/queries/watch-queries";

/** What the picker is being used for — it only changes the verb and the title. */
export type WatchPickerMode = "start" | "change" | "queue";

export interface WatchVideoPickerSheetProps {
  visible: boolean;
  onClose: () => void;
  mode: WatchPickerMode;
  /**
   * Whether this deployment can search at all. `null` while capabilities are
   * still loading — treated as "not yet", so the search affordance appears once
   * and never flickers in and then out.
   */
  searchEnabled: boolean | null;
  search: WatchPickerSearchState;
  /** Run a search. Only ever called from an explicit user act — see the header. */
  onSearch: (query: string) => void;
  /** Clear whatever the last search left behind (called when the sheet opens). */
  onResetSearch: () => void;
  /**
   * A chosen video. `videoRef` is RAW — a pasted link or a picked id — because the
   * server owns normalization and re-parses it either way. `title` and
   * `durationSeconds` are passed through from a search hit so the queue can show
   * something more useful than an 11-character id.
   */
  onSubmit: (input: { videoRef: string; title?: string; durationSeconds?: number }) => void;
}

export function WatchVideoPickerSheet({
  visible,
  onClose,
  mode,
  searchEnabled,
  search,
  onSearch,
  onResetSearch,
  onSubmit,
}: WatchVideoPickerSheetProps) {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const [value, setValue] = useState("");
  const [linkError, setLinkError] = useState(false);
  /**
   * The last query THIS sheet asked for. Guards the repeat submission — a second
   * tap on an unchanged field must not spend a second unit of a shared daily
   * budget. Kept in a ref: it never affects what is drawn.
   */
  const lastQueryRef = useRef<string | null>(null);
  const onResetSearchRef = useRef(onResetSearch);
  onResetSearchRef.current = onResetSearch;

  // Every opening starts clean. A query (or a link) left over from the previous
  // party is never the one being asked for now, and stale results next to an
  // empty box would look like an answer to a question nobody asked.
  useEffect(() => {
    if (!visible) return;
    setValue("");
    setLinkError(false);
    lastQueryRef.current = null;
    onResetSearchRef.current();
  }, [visible]);

  const canSearch = searchEnabled === true;

  const submit = (): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0) return;

    // A link wins, always, and spends no quota.
    const videoId = parseYouTubeVideoId(trimmed);
    if (videoId !== null) {
      setLinkError(false);
      haptics.light();
      onSubmit({ videoRef: trimmed });
      onClose();
      return;
    }

    if (!canSearch) {
      // No search on this deployment: an unparseable string is simply a bad
      // link, and saying so is the whole of the honest answer.
      setLinkError(true);
      return;
    }

    setLinkError(false);
    if (lastQueryRef.current === trimmed && search.status !== "error") return;
    lastQueryRef.current = trimmed;
    onSearch(trimmed);
  };

  const pick = (result: WatchPickerResult): void => {
    haptics.light();
    onSubmit({
      videoRef: result.videoId,
      title: result.title,
      ...(result.durationSeconds === null ? {} : { durationSeconds: result.durationSeconds }),
    });
    onClose();
  };

  const title =
    mode === "start"
      ? t("mobile:watchParty.startTitle")
      : mode === "change"
        ? t("mobile:watchParty.changeTitle")
        : t("mobile:watchParty.queueAddTitle");

  const action =
    mode === "start"
      ? t("mobile:watchParty.startAction")
      : mode === "change"
        ? t("mobile:watchParty.changeAction")
        : t("mobile:watchParty.queueAddAction");

  const failureMessage =
    search.status !== "error" || search.failure === null
      ? null
      : search.failure === "disabled"
        ? t("mobile:watchParty.searchDisabled")
        : search.failure === "quota"
          ? t("mobile:watchParty.searchQuota")
          : search.failure === "unavailable"
            ? t("mobile:watchParty.searchUnavailable")
            : t("mobile:watchParty.searchFailed");

  const showEmptyResults = canSearch && search.status === "done" && search.results.length === 0;
  /**
   * The footer verb commits the LINK in the field. It is meaningless for a search
   * phrase, so it only appears once the field actually holds a video reference —
   * a button that would refuse whatever is typed is a button that should not be
   * drawn (§35).
   */
  const fieldHoldsLink = parseYouTubeVideoId(value.trim()) !== null;

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        style={{ flex: 1 }}
      >
        <Pressable
          onPress={onClose}
          accessibilityLabel={t("common:buttons.close")}
          style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.6)", justifyContent: "flex-end" }}
        >
          {/* Card. Its own Pressable swallows taps so they don't dismiss the sheet. */}
          <Pressable
            onPress={() => {}}
            style={{
              maxHeight: "88%",
              backgroundColor: colors.surface,
              borderTopLeftRadius: radius.lg,
              borderTopRightRadius: radius.lg,
              borderCurve: "continuous",
              borderTopWidth: 1,
              borderColor: colors.stroke,
              paddingTop: space.md,
              paddingBottom: space.md + insets.bottom,
              paddingHorizontal: space.lg,
              gap: space.md,
            }}
          >
            {/* Grab handle. */}
            <View
              style={{
                alignSelf: "center",
                width: 36,
                height: 4,
                borderRadius: radius.pill,
                backgroundColor: colors.strokeStrong,
              }}
            />

            <View style={{ gap: 2 }}>
              <Text
                variant="display"
                style={{ color: colors.fg, fontSize: 17, fontWeight: "800" }}
              >
                {title}
              </Text>
              <Text style={{ color: colors.fgMuted, fontSize: 13, lineHeight: 18 }}>
                {canSearch
                  ? t("mobile:watchParty.searchDescription")
                  : t("mobile:watchParty.linkDescription")}
              </Text>
            </View>

            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              {canSearch ? (
                <Search size={18} color={colors.fgMuted} />
              ) : (
                <MonitorPlay size={18} color={colors.fgMuted} />
              )}
              <TextInput
                autoFocus
                value={value}
                onChangeText={(next) => {
                  setValue(next);
                  setLinkError(false);
                }}
                onSubmitEditing={submit}
                // "search" on a search-capable deployment, "go" otherwise: the
                // keyboard's own key is the primary explicit act on a phone, and
                // it must read as the thing it will actually do.
                returnKeyType={canSearch ? "search" : "go"}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder={
                  canSearch
                    ? t("mobile:watchParty.searchPlaceholder")
                    : t("mobile:watchParty.linkPlaceholder")
                }
                placeholderTextColor={colors.fgFaint}
                accessibilityLabel={
                  canSearch
                    ? t("mobile:watchParty.searchLabel")
                    : t("mobile:watchParty.linkLabel")
                }
                aria-invalid={linkError ? true : undefined}
                style={{
                  flex: 1,
                  minHeight: 48,
                  backgroundColor: colors.surfaceRaised,
                  borderColor: linkError ? colors.danger : colors.stroke,
                  borderWidth: 1,
                  borderRadius: radius.md,
                  borderCurve: "continuous",
                  color: colors.fg,
                  fontSize: 15,
                  paddingHorizontal: space.md,
                  paddingVertical: space.sm,
                }}
              />
              {/* The explicit search act. Rendered ONLY where search exists, so
                  there is never a button whose whole job the server refuses. */}
              {canSearch ? (
                <Pressable
                  onPress={submit}
                  accessibilityRole="button"
                  accessibilityLabel={t("mobile:watchParty.searchAction")}
                  disabled={value.trim().length === 0 || search.status === "searching"}
                  style={({ pressed }) => ({
                    minWidth: 48,
                    minHeight: 48,
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: radius.md,
                    borderCurve: "continuous",
                    backgroundColor: colors.surfaceRaised,
                    opacity:
                      value.trim().length === 0 || search.status === "searching"
                        ? 0.4
                        : pressed
                          ? 0.8
                          : 1,
                  })}
                >
                  {search.status === "searching" ? (
                    <ActivityIndicator size="small" color={colors.accent} />
                  ) : (
                    <Search size={18} color={colors.fg} />
                  )}
                </Pressable>
              ) : null}
            </View>

            {linkError ? (
              <Text accessibilityRole="alert" style={{ color: colors.danger, fontSize: 12 }}>
                {t("mobile:watchParty.linkInvalid")}
              </Text>
            ) : null}

            {failureMessage !== null ? (
              <View
                accessibilityRole="alert"
                style={{
                  flexDirection: "row",
                  gap: space.sm,
                  borderRadius: radius.md,
                  borderCurve: "continuous",
                  backgroundColor: colors.surfaceRaised,
                  padding: space.md,
                }}
              >
                <TriangleAlert size={16} color={colors.warning} style={{ marginTop: 1 }} />
                <Text style={{ flex: 1, color: colors.fg, fontSize: 12, lineHeight: 17 }}>
                  {failureMessage}
                </Text>
              </View>
            ) : null}

            {showEmptyResults ? (
              <Text style={{ color: colors.fgMuted, fontSize: 12, lineHeight: 17 }}>
                {t("mobile:watchParty.searchNoResults", { query: search.query })}
              </Text>
            ) : null}

            {canSearch && search.results.length > 0 ? (
              <ScrollView
                accessibilityLabel={t("mobile:watchParty.searchResultsLabel")}
                style={{ maxHeight: 300 }}
                keyboardShouldPersistTaps="handled"
                contentContainerStyle={{ gap: space.xs }}
              >
                {search.results.map((result) => {
                  const duration = formatWatchDuration(result.durationSeconds);
                  return (
                    <Pressable
                      key={result.videoId}
                      onPress={() => pick(result)}
                      accessibilityRole="button"
                      accessibilityLabel={result.title}
                      style={({ pressed }) => ({
                        flexDirection: "row",
                        alignItems: "flex-start",
                        gap: space.sm,
                        padding: space.sm,
                        borderRadius: radius.md,
                        borderCurve: "continuous",
                        backgroundColor: pressed ? colors.surfaceRaised : "transparent",
                      })}
                    >
                      <Image
                        source={{ uri: result.thumbnailUrl }}
                        style={{
                          width: 112,
                          height: 63,
                          borderRadius: radius.sm,
                          backgroundColor: "#000",
                        }}
                        resizeMode="cover"
                        accessibilityIgnoresInvertColors
                      />
                      <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
                        {/* Untrusted YouTube text, rendered as a text node. */}
                        <Text
                          numberOfLines={2}
                          style={{ color: colors.fg, fontSize: 13, lineHeight: 18 }}
                        >
                          {result.title}
                        </Text>
                        <Text numberOfLines={1} style={{ color: colors.fgFaint, fontSize: 11 }}>
                          {duration === null
                            ? result.channelTitle
                            : `${result.channelTitle} · ${duration}`}
                        </Text>
                      </View>
                    </Pressable>
                  );
                })}
              </ScrollView>
            ) : null}

            <Text style={{ color: colors.fgFaint, fontSize: 11, lineHeight: 16 }}>
              {t("mobile:watchParty.drmNote")}
            </Text>

            <View style={{ flexDirection: "row", gap: space.sm }}>
              <Pressable
                onPress={onClose}
                accessibilityRole="button"
                style={({ pressed }) => ({
                  flex: 1,
                  minHeight: 48,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: radius.md,
                  borderCurve: "continuous",
                  backgroundColor: colors.surfaceRaised,
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "700" }}>
                  {t("mobile:watchParty.cancel")}
                </Text>
              </Pressable>
              {fieldHoldsLink ? (
                <Pressable
                  onPress={submit}
                  accessibilityRole="button"
                  style={({ pressed }) => ({
                    flex: 2,
                    minHeight: 48,
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: radius.md,
                    borderCurve: "continuous",
                    backgroundColor: colors.accent,
                    opacity: pressed ? 0.85 : 1,
                  })}
                >
                  <Text style={{ color: colors.onAccent, fontSize: 15, fontWeight: "700" }}>
                    {action}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          </Pressable>
        </Pressable>
      </KeyboardAvoidingView>
    </Modal>
  );
}
