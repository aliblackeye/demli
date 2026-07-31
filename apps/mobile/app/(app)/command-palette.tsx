import { memo, useEffect, useMemo, useState } from "react";
import { FlatList, Keyboard, Pressable, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  Hash,
  Headphones,
  HeadphoneOff,
  LogIn,
  Mic,
  MicOff,
  Plus,
  Search,
  Server,
  Settings,
  Settings2,
  UserPlus,
  Volume2,
  X,
} from "lucide-react-native";
import type { GroupId } from "@demli/types";
import { Text, TextInput } from "@/components/ui/Text";
import { Screen } from "@/components/Screen";
import { useAppTranslation } from "@/lib/i18n";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import {
  buildPaletteItems,
  filterPaletteItems,
  paletteSectionLabel,
  toPaletteRows,
  type PaletteAction,
  type PaletteIcon,
  type PaletteItem,
  type PaletteRow,
  type PaletteTranslate,
} from "@/components/command-palette/palette-items";
import { useGroupDetails, useGroups } from "@/queries/chat-queries";
import { useChatStore } from "@/stores/chat-store";
import { useHomeShellStore } from "@/stores/home-shell-store";
import { useVoiceStore } from "@/stores/voice-store";
import { colors, radius, space, typography } from "@/theme/theme";

/**
 * Debounce for the field. The list is filtered from ALREADY-CACHED query data
 * (groups + the selected server's details), so a keystroke costs no request —
 * this only keeps the FlatList from rebuilding on every character (§27).
 */
const QUERY_DEBOUNCE_MS = 150;

/** Row heights — fixed so `getItemLayout` can skip measurement. 52 ≥ the 44pt tap target. */
const ITEM_HEIGHT = 52;
const HEADER_HEIGHT = 32;

const ICONS: Record<PaletteIcon, typeof Hash> = {
  hash: Hash,
  volume: Volume2,
  server: Server,
  mic: Mic,
  micOff: MicOff,
  headphones: Headphones,
  headphoneOff: HeadphoneOff,
  search: Search,
  userPlus: UserPlus,
  plus: Plus,
  logIn: LogIn,
  settings2: Settings2,
  settings: Settings,
};

function SectionHeader({ label }: { label: string }) {
  return (
    <View
      accessibilityRole="header"
      style={{ height: HEADER_HEIGHT, justifyContent: "flex-end", paddingHorizontal: space.lg }}
    >
      <Text
        style={{
          color: colors.fgFaint,
          fontSize: typography.size["2xs"],
          fontWeight: "700",
          letterSpacing: 0.6,
          textTransform: "uppercase",
          paddingBottom: space.xs,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

/**
 * One palette row. Memoized: while typing, only rows whose item identity changed
 * re-render — the rest are skipped even though the list data array is new.
 */
const PaletteItemRow = memo(function PaletteItemRow({
  item,
  onSelect,
}: {
  item: PaletteItem;
  onSelect: (action: PaletteAction) => void;
}) {
  const Icon = ICONS[item.icon];
  return (
    <Pressable
      onPress={() => onSelect(item.action)}
      accessibilityRole="button"
      accessibilityLabel={item.meta ? `${item.label}, ${item.meta}` : item.label}
      style={({ pressed }) => ({
        height: ITEM_HEIGHT,
        flexDirection: "row",
        alignItems: "center",
        gap: space.md,
        marginHorizontal: space.md,
        paddingHorizontal: space.md,
        borderRadius: radius.md,
        borderCurve: "continuous",
        backgroundColor: pressed ? colors.surfaceRaised : "transparent",
      })}
    >
      <Icon size={20} color={colors.fgMuted} />
      <Text numberOfLines={1} style={{ flex: 1, color: colors.fg, fontSize: 15, fontWeight: "600" }}>
        {item.label}
      </Text>
      {item.meta ? (
        <Text
          numberOfLines={1}
          style={{ maxWidth: "35%", color: colors.fgFaint, fontSize: typography.size["2xs"] }}
        >
          {item.meta}
        </Text>
      ) : null}
    </Pressable>
  );
});

/**
 * The mobile command palette (M20/W5) — the counterpart of the desktop
 * `CommandMenu` (Ctrl/Cmd+K). Mobile has no keyboard shortcut, so it opens from
 * the search icon in the Home shell's panel headers (DmListPanel / ServerPanel),
 * not from a navigation tab of its own.
 *
 * Full-screen rather than a bottom sheet on purpose: the field auto-focuses, so
 * the IME is up immediately and a sheet would leave the results squeezed into
 * the strip above it. The list is padded by the LIVE keyboard height instead of
 * a KeyboardAvoidingView — under Android's edge-to-edge mode KAV receives no
 * keyboard inset (see lib/use-keyboard-height, written for that founder bug), so
 * KAV here would let the IME cover the last rows.
 *
 * Selecting a row dismisses the keyboard and REPLACES this screen with the
 * target, so the palette never sits in the back stack between Home and where you
 * went. Actions that change nothing on screen (switch server, mute, deafen) just
 * pop back. Android back / the iOS swipe both close it.
 *
 * The item set, its visibility rules and the search are in
 * `components/command-palette/palette-items.ts` (pure, unit-tested); this file
 * is rendering and navigation only.
 */
export default function CommandPaletteScreen() {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const keyboardHeight = useKeyboardHeight();

  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");

  // One filter pass per typing pause, not per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setQuery(input), QUERY_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [input]);

  const selectedServerId = useHomeShellStore((s) => s.selectedServerId);
  const selectServer = useHomeShellStore((s) => s.selectServer);

  const { data: groups } = useGroups();
  const { data: details } = useGroupDetails((selectedServerId as GroupId | null) ?? null);

  const servers = useMemo(
    () => (groups ?? []).filter((g) => g.kind === "server"),
    [groups],
  );
  const selectedServerName = useMemo(
    () => servers.find((g) => g.id === selectedServerId)?.name ?? null,
    [servers, selectedServerId],
  );

  const lastChannelId = useChatStore((s) =>
    selectedServerId ? (s.lastChannelByGroup[selectedServerId as GroupId] ?? null) : null,
  );

  // Voice: the palette only reads three scalars, so a speaking/participant tick
  // in the room never re-renders this screen (§27).
  const voiceStatus = useVoiceStore((s) => s.status);
  const micEnabled = useVoiceStore((s) => s.micEnabled);
  const deafened = useVoiceStore((s) => s.deafened);
  const toggleMic = useVoiceStore((s) => s.toggleMic);
  const toggleDeafen = useVoiceStore((s) => s.toggleDeafen);
  const voiceActive =
    voiceStatus === "connected" || voiceStatus === "joining" || voiceStatus === "reconnecting";

  const items = useMemo(
    () =>
      buildPaletteItems({
        // The app's typed `t` is narrower than the structural PaletteTranslate
        // (a literal-key union vs `string`); the keys it is asked for all exist
        // in the catalog, guarded by the i18n package's parity tests.
        t: t as unknown as PaletteTranslate,
        selectedServerId,
        selectedServerName,
        servers,
        channels: details?.channels ?? [],
        lastChannelId,
        voiceActive,
        micEnabled,
        deafened,
      }),
    [
      t,
      selectedServerId,
      selectedServerName,
      servers,
      details?.channels,
      lastChannelId,
      voiceActive,
      micEnabled,
      deafened,
    ],
  );

  const rows = useMemo(
    () => toPaletteRows(filterPaletteItems(items, query)),
    [items, query],
  );

  // Fixed heights → an O(1) offset table, so the list can jump without measuring
  // every row (the channel + server list grows with the account).
  const offsets = useMemo(() => {
    const out: number[] = [];
    let y = 0;
    for (const row of rows) {
      out.push(y);
      y += row.type === "header" ? HEADER_HEIGHT : ITEM_HEIGHT;
    }
    return out;
  }, [rows]);

  const close = () => {
    Keyboard.dismiss();
    if (router.canGoBack()) router.back();
  };

  const onSelect = (action: PaletteAction): void => {
    Keyboard.dismiss();
    switch (action.kind) {
      case "openTextChannel":
        router.replace({
          pathname: "/channel/[channelId]",
          params: { channelId: action.channelId, groupId: action.groupId, name: action.name },
        });
        return;
      case "joinVoiceChannel":
        router.replace({
          pathname: "/voice/[channelId]",
          params: { channelId: action.channelId, groupId: action.groupId, name: action.name },
        });
        return;
      case "searchMessages":
        router.replace({
          pathname: "/channel-search",
          params: { channelId: action.channelId, name: action.name },
        });
        return;
      case "invitePeople":
        router.replace({
          pathname: "/invite",
          params: { groupId: action.groupId, name: action.serverName },
        });
        return;
      // Both land on the new-server modal: it carries the create form AND the
      // join-with-code form, which is where each of the two desktop entries
      // sends you.
      case "createServer":
      case "joinServerWithCode":
        router.replace("/new-group");
        return;
      // Mobile has no separate device dialog — the mic/audio/video sections live
      // inside the settings screen, so both desktop entries land there.
      case "voiceSettings":
      case "openSettings":
        router.replace("/settings");
        return;
      // Nothing new to show: flip the state and go back where we came from.
      case "switchServer":
        selectServer(action.groupId);
        close();
        return;
      case "toggleMic":
        toggleMic();
        close();
        return;
      case "toggleDeafen":
        toggleDeafen();
        close();
        return;
    }
  };

  const renderItem = ({ item: row }: { item: PaletteRow }) =>
    row.type === "header" ? (
      <SectionHeader label={paletteSectionLabel(row.section, t as unknown as PaletteTranslate)} />
    ) : (
      <PaletteItemRow item={row.item} onSelect={onSelect} />
    );

  return (
    <Screen>
      {/* The IME's height is taken off the CONTAINER, not just added as list
          padding: under Android edge-to-edge the root view is not resized when
          the keyboard opens, so without this the last rows render behind the
          keyboard and the scroll view believes it is already at its end. */}
      <View style={{ flex: 1, paddingTop: insets.top, paddingBottom: keyboardHeight }}>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: space.sm,
            paddingHorizontal: space.md,
            paddingVertical: space.sm,
            borderBottomWidth: 1,
            borderBottomColor: colors.stroke,
          }}
        >
          <View
            style={{
              flex: 1,
              flexDirection: "row",
              alignItems: "center",
              gap: space.sm,
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
              value={input}
              onChangeText={setInput}
              autoFocus
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              accessibilityLabel={t("mobile:commandMenu.title")}
              placeholder={t("mobile:commandMenu.placeholder")}
              placeholderTextColor={colors.fgFaint}
              style={{ flex: 1, color: colors.fg, fontSize: 15, paddingVertical: space.md }}
            />
          </View>
          <Pressable
            onPress={close}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={t("common:buttons.close")}
            style={({ pressed }) => ({
              width: 44,
              height: 44,
              alignItems: "center",
              justifyContent: "center",
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <X size={22} color={colors.fgMuted} />
          </Pressable>
        </View>

        <FlatList<PaletteRow>
          data={rows}
          keyExtractor={(row) => row.key}
          renderItem={renderItem}
          getItemLayout={(_, index) => ({
            length: rows[index]?.type === "header" ? HEADER_HEIGHT : ITEM_HEIGHT,
            offset: offsets[index] ?? 0,
            index,
          })}
          initialNumToRender={14}
          maxToRenderPerBatch={16}
          windowSize={9}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          contentContainerStyle={{
            paddingTop: space.xs,
            // The container already stops above the IME, so only the nav-bar
            // inset is left to clear when the keyboard is down.
            paddingBottom: space.xl + (keyboardHeight > 0 ? 0 : insets.bottom),
          }}
          ListEmptyComponent={
            <View style={{ padding: space.xl, gap: space.xs }}>
              <Text style={{ color: colors.fgMuted, fontSize: 14, textAlign: "center" }}>
                {t("mobile:commandMenu.empty")}
              </Text>
              <Text style={{ color: colors.fgFaint, fontSize: 13, textAlign: "center" }}>
                {t("mobile:commandMenu.emptyHint")}
              </Text>
            </View>
          }
        />
      </View>
    </Screen>
  );
}
