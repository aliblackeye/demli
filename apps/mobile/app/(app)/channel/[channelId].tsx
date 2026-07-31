import { useMemo } from "react";
import { Pressable, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Pin, Search } from "lucide-react-native";
import type { UserId } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { ChatThread } from "@/components/ChatThread";
import { ChatSummaryHeaderTitle } from "@/components/ChatHeaderTitle";
import { NsfwChannelGate } from "@/components/NsfwChannelGate";
import { Screen } from "@/components/Screen";
import { openPinsSheet } from "@/lib/pins-sheet";
import { buildMemberColorMap } from "@/lib/permissions";
import { useGroupDetails, useRoles } from "@/queries/chat-queries";
import { useMe } from "@/queries/social-queries";
import { useNsfwGateStore } from "@/stores/nsfw-gate-store";
import { colors, space } from "@/theme/theme";

/**
 * Chat view for one text channel in a server. The conversation itself lives in
 * the shared <ChatThread> (also used by flat group chats), so this route only
 * owns the channel's title and reads the channel's slow-mode setting from the
 * already-cached group details to drive the composer indicator.
 */
export default function ChannelScreen() {
  const { t } = useAppTranslation();
  const params = useLocalSearchParams<{ channelId: string; groupId?: string; name?: string }>();
  const channelId = params.channelId;
  const groupId = params.groupId ?? null;

  // Cached from the server screen; no extra network hit in the common path.
  const { data } = useGroupDetails(groupId);
  const { data: roles } = useRoles(groupId);
  const channel = data?.channels.find((c) => c.id === channelId) ?? null;
  const slowmodeSeconds = channel?.slowmodeSeconds ?? 0;

  // NSFW age gate (M15): a channel marked 18+ is unreadable/unpostable until the
  // viewer is confirmed adult AND (per-channel) has acknowledged the warning. The
  // gate also needs to know whether a (set-once) date of birth exists, to tell
  // "you haven't told us yet" apart from "you told us, and you're a minor".
  const me = useMe();
  const isAdult = me.data?.isAdult === true;
  const birthdateSet = Boolean(me.data?.birthdate);
  const nsfwConfirmed = useNsfwGateStore((s) =>
    channelId ? !!s.confirmedByChannel[channelId] : false,
  );
  const gated = !!channel?.nsfw && (!isAdult || !nsfwConfirmed);

  // Author role colors (highest colored role). Recomputes only when members or
  // roles change — never on presence ticks, so the FlatList is not churned.
  const authorColors = useMemo(
    () => buildMemberColorMap(data?.members, roles),
    [data?.members, roles],
  );

  // Roster ids for the header's "N members · M online" summary — read from the
  // already-cached group details, so no extra request.
  const memberIds = useMemo<UserId[]>(
    () => (data?.members ?? []).map((m) => m.user.id),
    [data?.members],
  );

  // Bare name — the "#" is a real glyph in the header component now (desktop
  // ChatView pattern), not a character glued into the title string.
  const title = params.name ?? t("mobile:channel.fallbackTitle");

  if (!channelId) {
    return (
      <Screen>
        <Stack.Screen options={{ title: t("mobile:channel.fallbackTitle") }} />
      </Screen>
    );
  }

  return (
    <Screen>
      <Stack.Screen
        options={{
          title,
          headerTitle: () => (
            <ChatSummaryHeaderTitle title={title} memberIds={memberIds} glyph="hash" />
          ),
          headerRight: () => (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space["4.5"] }}>
              {/* The pin board lives in <ChatThread> (it needs the channel id),
                  so the header just publishes an open command (lib/pins-sheet). */}
              <Pressable
                onPress={openPinsSheet}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={t("mobile:pins.open")}
              >
                <Pin size={21} color={colors.accent} />
              </Pressable>
              <Pressable
                onPress={() =>
                  router.push({
                    pathname: "/channel-search",
                    params: { channelId, name: params.name ?? "" },
                  })
                }
                hitSlop={10}
                accessibilityLabel={t("mobile:search.title")}
              >
                <Search size={22} color={colors.accent} />
              </Pressable>
            </View>
          ),
        }}
      />
      {gated && channel ? (
        <NsfwChannelGate channel={channel} isAdult={isAdult} birthdateSet={birthdateSet} />
      ) : (
        <ChatThread
          channelId={channelId}
          groupId={groupId ?? ""}
          name={params.name ?? ""}
          slowmodeSeconds={slowmodeSeconds}
          authorColors={authorColors}
          serverGroupId={groupId ?? undefined}
        />
      )}
    </Screen>
  );
}
