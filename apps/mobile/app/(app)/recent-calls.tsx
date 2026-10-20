import { useCallback, useMemo } from "react";
import { FlatList, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { PhoneOff, RotateCcw, PhoneCall } from "lucide-react-native";
import { isCallLive } from "@demli/client-core";
import type { DmId, UserId } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { localizeError } from "@/lib/errors";
import { EmptyState } from "@/components/EmptyState";
import { Screen } from "@/components/Screen";
import { SkeletonList, SkeletonRow } from "@/components/Skeleton";
import { Button } from "@/components/ui/Button";
import { RecentCallRow } from "@/components/call/RecentCallRow";
import type { RecentCall } from "@/lib/clients";
import { useRecentCalls } from "@/queries/call-queries";
import { useFriends, useOpenDm } from "@/queries/social-queries";
import { getCallController, useCallState } from "@/stores/call-store";
import { colors, radius, space } from "@/theme/theme";

/**
 * Recent Calls screen (Voice-UX #2), reachable from the You tab. A read-only,
 * keyset-paged list of the caller's cross-DM call history newest-first. Tapping a
 * row opens (idempotently) that DM and navigates to it; the per-row call-back
 * button re-initiates the call with the same media, gated on mutual-friend +
 * no-live-call (the server re-checks both authoritatively).
 *
 * Every state is drawn: first load = skeleton rows in the row's own shape, a
 * failed load = the kit's error block (what failed, the localized reason, a
 * retry), no history = the empty block, a next page loading = one more skeleton
 * row at the foot of the list instead of a spinner.
 */
export default function RecentCallsScreen() {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const {
    data,
    isPending,
    isError,
    error,
    refetch,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
  } = useRecentCalls();
  const { data: friends } = useFriends();
  const callState = useCallState();
  const openDm = useOpenDm();

  // Lifted once (not per row, §27): the single busy flag + a friend-id set.
  const busy = isCallLive(callState);
  const friendIds = useMemo(() => new Set((friends ?? []).map((f) => f.user.id)), [friends]);
  const calls = useMemo(() => data?.pages.flatMap((page) => page.calls) ?? [], [data]);

  // Open the DM by peer id (idempotent), then navigate — RecentCall has no
  // streamId, so the created/loaded DTO from openDm supplies it (Friends pattern).
  const openConversation = useCallback(
    (peerId: UserId) => {
      openDm.mutate(peerId, {
        onSuccess: ({ dm }) => {
          router.push({
            pathname: "/dm/[dmId]",
            params: {
              dmId: dm.id,
              streamId: dm.streamId,
              name: dm.participant.displayName,
              userId: dm.participant.id,
            },
          });
        },
      });
    },
    [openDm],
  );

  const callBack = useCallback((call: RecentCall) => {
    void getCallController()
      .startCall({ dmId: call.dmId as DmId, media: call.media })
      .catch(() => {
        // The controller lands on a friendly terminal + logs the cause.
      });
    router.push({
      pathname: "/call",
      params: {
        name: call.peer.displayName,
        ...(call.media === "video" ? { withVideo: "1" } : {}),
      },
    });
  }, []);

  let body: JSX.Element;
  if (isPending) {
    body = (
      <View style={{ paddingTop: space.sm, paddingHorizontal: space.md }}>
        <SkeletonList count={7} lines={2} leadingSize={44} leadingRadius={radius.pill} />
      </View>
    );
  } else if (isError) {
    body = (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <EmptyState
          tone="error"
          icon={<PhoneOff size={22} color={colors.danger} strokeWidth={2} />}
          title={t("mobile:recentCalls.loadFailedTitle")}
          subtitle={localizeError(error, t)}
          action={
            <Button
              variant="secondary"
              icon={RotateCcw}
              label={t("buttons.retry")}
              onPress={() => void refetch()}
            />
          }
        />
      </View>
    );
  } else if (calls.length === 0) {
    body = (
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}>
        <EmptyState
          icon={<PhoneCall size={22} color={colors.fgMuted} strokeWidth={2} />}
          title={t("mobile:recentCalls.empty")}
          subtitle={t("mobile:recentCalls.emptySubtitle")}
        />
      </View>
    );
  } else {
    body = (
      <FlatList
        data={calls}
        keyExtractor={(call) => call.id}
        contentContainerStyle={{
          paddingHorizontal: space.xs,
          paddingTop: space.sm,
          paddingBottom: space.md + insets.bottom,
        }}
        renderItem={({ item }) => (
          <RecentCallRow
            call={item}
            canCall={friendIds.has(item.peer.id) && !busy}
            onOpen={openConversation}
            onCallBack={callBack}
          />
        )}
        onEndReachedThreshold={0.5}
        onEndReached={() => {
          if (hasNextPage && !isFetchingNextPage) void fetchNextPage();
        }}
        ListFooterComponent={
          isFetchingNextPage ? (
            <View style={{ paddingHorizontal: space.md }}>
              <SkeletonRow lines={2} leadingSize={44} leadingRadius={radius.pill} />
            </View>
          ) : null
        }
      />
    );
  }

  return <Screen>{body}</Screen>;
}
