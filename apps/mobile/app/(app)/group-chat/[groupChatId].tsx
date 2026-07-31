import { useMemo } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";
import { Text } from "@/components/ui/Text";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Pin, Users } from "lucide-react-native";
import type { UserId } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { ChatThread } from "@/components/ChatThread";
import { ChatSummaryHeaderTitle } from "@/components/ChatHeaderTitle";
import { Screen } from "@/components/Screen";
import { openPinsSheet } from "@/lib/pins-sheet";
import { localizeError } from "@/lib/errors";
import { useGroupChatDetails } from "@/queries/group-chat-queries";
import { colors, space } from "@/theme/theme";

/**
 * A flat group chat: one shared conversation keyed by `group.streamId` (ADR
 * 0005), so it renders the same <ChatThread> a text channel does. The header
 * opens the roster (members / add / leave).
 */
export default function GroupChatScreen() {
  const { t } = useAppTranslation();
  const params = useLocalSearchParams<{ groupChatId: string; name?: string }>();
  const groupChatId = params.groupChatId;

  const { data, isLoading, isError, error, refetch } = useGroupChatDetails(groupChatId ?? null);
  const group = data?.group;
  const title = group?.name ?? params.name ?? t("mobile:groupChatDetails.fallbackTitle");

  // Roster ids for the header's "N members · M online" summary. Stable per
  // roster change, so the header's presence selector never churns identities.
  const memberIds = useMemo<UserId[]>(
    () => (data?.members ?? []).map((m) => m.user.id),
    [data?.members],
  );

  return (
    <Screen>
      <Stack.Screen
        options={{
          title,
          // Group counterpart of the DM presence line: how many people are in
          // this chat and how many of them are around right now.
          headerTitle: () => <ChatSummaryHeaderTitle title={title} memberIds={memberIds} />,
          headerRight: () =>
            group ? (
              <View style={{ flexDirection: "row", alignItems: "center", gap: space["4.5"] }}>
                {/* A flat group chat has no role system — any member may pin. */}
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
                      pathname: "/group-chat-details",
                      params: { groupChatId, name: group.name },
                    })
                  }
                  hitSlop={10}
                  accessibilityLabel={t("mobile:groupChatDetails.membersA11y")}
                >
                  <Users size={22} color={colors.accent} />
                </Pressable>
              </View>
            ) : null,
        }}
      />

      {group ? (
        <ChatThread channelId={group.streamId} groupId={group.id} name={group.name} />
      ) : isError ? (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl, gap: space.md }}>
          <Text selectable style={{ color: colors.fgMuted, fontSize: 14, textAlign: "center" }}>
            {localizeError(error, t)}
          </Text>
          <Pressable onPress={() => void refetch()} hitSlop={8}>
            <Text style={{ color: colors.accent, fontSize: 14, fontWeight: "600" }}>{t("buttons.retry")}</Text>
          </Pressable>
        </View>
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
          {isLoading ? <ActivityIndicator color={colors.fgFaint} /> : null}
        </View>
      )}
    </Screen>
  );
}
