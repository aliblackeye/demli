import { useMemo, useState } from "react";
import { Alert, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { MessageCircleOff, Phone, Pin, UserRound, Video } from "lucide-react-native";
import { isCallLive } from "@demli/client-core";
import type { DmId, UserId } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { friendlyErrorMessage } from "@/lib/clients";
import { ChatThread } from "@/components/ChatThread";
import { DmHeaderTitle } from "@/components/ChatHeaderTitle";
import { EmptyState } from "@/components/EmptyState";
import { MemberActionSheet, type MemberSheetTarget } from "@/components/member/MemberActionSheet";
import { Screen } from "@/components/Screen";
import { IconButton } from "@/components/ui/IconButton";
import { toast } from "@/components/ui/Toast";
import { openPinsSheet } from "@/lib/pins-sheet";
import { useBlocks, useUnblockUser } from "@/queries/member-queries";
import { useFriends } from "@/queries/social-queries";
import { getCallController, useCallState } from "@/stores/call-store";
import { colors, space } from "@/theme/theme";

/**
 * A 1:1 direct message (ADR 0010 §1): a `kind='dm'` friend group whose single
 * hidden stream channel IS `streamId`, so it renders the exact same <ChatThread>
 * a text channel or a flat group chat does (ADR 0005) — no duplicated message
 * pipeline. The header opens the other participant's profile and, when the two
 * are still friends, starts a voice or video call (ADR 0012).
 *
 * If the viewer has blocked the peer, the composer says so and offers the
 * unblock (the same confirm the profile and the user menu use). Only the
 * viewer's OWN block is ever known — whether the peer blocked the viewer is
 * never queryable, so no UI can reveal it (§28).
 */
export default function DmScreen() {
  const { t } = useAppTranslation();
  const params = useLocalSearchParams<{
    dmId: string;
    streamId: string;
    name?: string;
    userId?: string;
  }>();
  const { dmId, streamId, name, userId } = params;
  const title = name ?? t("mobile:dm.fallbackTitle");

  // Call gate (ADR 0012 §3): only an accepted friend can be called. A DM survives
  // an unfriend, so DM membership is NOT proof of friendship — check the live
  // friends list. The server re-checks anyway; this just disables the buttons.
  const { data: friends } = useFriends();
  const isFriend = !!userId && (friends ?? []).some((f) => f.user.id === userId);
  const callState = useCallState();
  const canCall = isFriend && !isCallLive(callState);
  /** The peer, when their user menu is open from the header (long press). */
  const [memberTarget, setMemberTarget] = useState<MemberSheetTarget | null>(null);

  // The viewer's own block list — fetched only while a DM is open.
  const blocks = useBlocks(!!userId);
  const unblock = useUnblockUser();
  const peerBlocked = !!userId && (blocks.data ?? []).some((b) => b.user.id === userId);
  const blocked = useMemo(
    () =>
      peerBlocked && userId
        ? {
            name: title,
            busy: unblock.isPending,
            onUnblock: () =>
              Alert.alert(
                t("mobile:block.unblockConfirmTitle", { name: title }),
                t("mobile:block.unblockConfirmBody"),
                [
                  { text: t("common:buttons.cancel"), style: "cancel" },
                  {
                    text: t("mobile:block.unblockConfirmAction"),
                    onPress: () =>
                      unblock.mutate(userId as UserId, {
                        onError: (err) =>
                          toast({
                            title: t("mobile:userProfile.actionErrorTitle"),
                            description: friendlyErrorMessage(err),
                            variant: "danger",
                          }),
                      }),
                  },
                ],
              ),
          }
        : undefined,
    [peerBlocked, userId, title, unblock, t],
  );

  const startCall = (media: "audio" | "video") => {
    if (!canCall || !dmId) return;
    void getCallController()
      .startCall({ dmId: dmId as DmId, media })
      .catch(() => {
        // The controller lands on a friendly terminal + logs the cause.
      });
    router.push({
      pathname: "/call",
      params: { name: title, ...(media === "video" ? { withVideo: "1" } : {}) },
    });
  };

  return (
    <Screen>
      <Stack.Screen
        options={{
          title,
          // The peer's live presence rides in the title itself (founder P0: "at
          // least show something next to their name"): a colored dot + status
          // line, fed by the presence the store already tracks — no new request.
          headerTitle: () => <DmHeaderTitle userId={userId} name={title} />,
          headerRight: () => (
            // 44pt+ kit targets carry their own padding, so a small gap and a
            // negative right margin keep the icons visually tight and edge-aligned.
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: space.xs,
                marginRight: -space.sm,
              }}
            >
              <IconButton
                icon={Phone}
                label={t("mobile:call.a11yVoiceCall")}
                size="lg"
                haptic="light"
                disabled={!canCall}
                onPress={() => startCall("audio")}
              />
              <IconButton
                icon={Video}
                label={t("mobile:call.a11yVideoCall")}
                size="lg"
                haptic="light"
                disabled={!canCall}
                onPress={() => startCall("video")}
              />
              {/* A DM has no role system, so every participant may pin (M17). */}
              <IconButton icon={Pin} label={t("mobile:pins.open")} size="lg" onPress={openPinsSheet} />
              {userId ? (
                <IconButton
                  icon={UserRound}
                  label={t("mobile:dm.viewProfile")}
                  size="lg"
                  accessibilityHint={t("mobile:userMenu.moreActions")}
                  onPress={() =>
                    router.push({ pathname: "/user/[userId]", params: { userId, name: title } })
                  }
                  // Long press = the user menu, the same gesture the roster and a
                  // message author answer to. Tap still opens the profile.
                  onLongPress={() =>
                    setMemberTarget({ userId: userId as UserId, displayName: title })
                  }
                />
              ) : null}
            </View>
          ),
        }}
      />

      {/* A DM is not inside a server, so the menu drops roles / invite / all
          moderation on its own (§35). */}
      <MemberActionSheet
        target={memberTarget}
        groupId={null}
        onClose={() => setMemberTarget(null)}
      />

      {streamId ? (
        <ChatThread
          channelId={streamId}
          groupId={dmId}
          name={title}
          allowMentionBroadcast={false}
          blocked={blocked}
        />
      ) : (
        <View style={{ flex: 1, justifyContent: "center" }}>
          <EmptyState
            icon={<MessageCircleOff size={22} color={colors.fgMuted} />}
            title={t("mobile:dm.unavailable")}
          />
        </View>
      )}
    </Screen>
  );
}
