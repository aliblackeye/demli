import { useMemo } from "react";
import { View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { CloudOff, Pin, Users } from "lucide-react-native";
import type { UserId } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { ChatThread } from "@/components/ChatThread";
import { ChatSummaryHeaderTitle } from "@/components/ChatHeaderTitle";
import { EmptyState } from "@/components/EmptyState";
import { Screen } from "@/components/Screen";
import { SkeletonMessages } from "@/components/Skeleton";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
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

  const { data, isLoading, isError, isRefetching, error, refetch } = useGroupChatDetails(
    groupChatId ?? null,
  );
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
              <View style={{ flexDirection: "row", alignItems: "center", gap: space.xs, marginRight: -space.sm }}>
                {/* A flat group chat has no role system — any member may pin. */}
                <IconButton icon={Pin} label={t("mobile:pins.open")} size="lg" onPress={openPinsSheet} />
                <IconButton
                  icon={Users}
                  label={t("mobile:groupChatDetails.membersA11y")}
                  size="lg"
                  onPress={() =>
                    router.push({
                      pathname: "/group-chat-details",
                      params: { groupChatId, name: group.name },
                    })
                  }
                />
              </View>
            ) : null,
        }}
      />

      {group ? (
        <ChatThread channelId={group.streamId} groupId={group.id} name={group.name} />
      ) : isError ? (
        <View style={{ flex: 1, justifyContent: "center" }}>
          <EmptyState
            tone="error"
            icon={<CloudOff size={22} color={colors.danger} />}
            title={t("mobile:chat.chatLoadFailedTitle")}
            subtitle={localizeError(error, t)}
            action={
              <Button
                label={t("buttons.retry")}
                variant="secondary"
                loading={isRefetching}
                onPress={() => void refetch()}
              />
            }
          />
        </View>
      ) : isLoading ? (
        // The thread's own first-load shape, so the hand-off to <ChatThread>
        // (which shows the same skeleton while its first page loads) is seamless.
        <SkeletonMessages />
      ) : null}
    </Screen>
  );
}
