import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";
import { Text } from "@/components/ui/Text";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { Phone, Pin, UserRound, Video } from "lucide-react-native";
import { isCallLive } from "@demli/client-core";
import type { DmId, UserId } from "@demli/types";
import { useAppTranslation } from "@/lib/i18n";
import { ChatThread } from "@/components/ChatThread";
import { DmHeaderTitle } from "@/components/ChatHeaderTitle";
import { MemberActionSheet, type MemberSheetTarget } from "@/components/member/MemberActionSheet";
import { Screen } from "@/components/Screen";
import { openPinsSheet } from "@/lib/pins-sheet";
import { useFriends } from "@/queries/social-queries";
import { getCallController, useCallState } from "@/stores/call-store";
import { colors, space } from "@/theme/theme";

/**
 * A header action rendered as a full 44×44 touch target (Apple/Material minimum)
 * with the glyph centered — the bare icons were ~37px, below the guideline.
 */
function HeaderIconButton({
  onPress,
  onLongPress,
  disabled,
  label,
  hint,
  children,
}: {
  onPress: () => void;
  onLongPress?: () => void;
  disabled?: boolean;
  label: string;
  /** Spoken hint for a secondary long-press action, when the button has one. */
  hint?: string;
  children: ReactNode;
}) {
  return (
    <Pressable
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      accessibilityState={{ disabled: !!disabled }}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed && !disabled ? 0.6 : 1,
      })}
    >
      {children}
    </Pressable>
  );
}

/**
 * A 1:1 direct message (ADR 0010 §1): a `kind='dm'` friend group whose single
 * hidden stream channel IS `streamId`, so it renders the exact same <ChatThread>
 * a text channel or a flat group chat does (ADR 0005) — no duplicated message
 * pipeline. The header opens the other participant's profile and, when the two
 * are still friends, starts a voice or video call (ADR 0012).
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
            // 44pt targets already carry their own padding, so a small gap and a
            // negative right margin keep the icons visually tight and edge-aligned.
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                gap: space.xs,
                marginRight: -space.sm,
              }}
            >
              <HeaderIconButton
                onPress={() => startCall("audio")}
                disabled={!canCall}
                label={t("mobile:call.a11yVoiceCall")}
              >
                <Phone size={21} color={canCall ? colors.accent : colors.fgFaint} />
              </HeaderIconButton>
              <HeaderIconButton
                onPress={() => startCall("video")}
                disabled={!canCall}
                label={t("mobile:call.a11yVideoCall")}
              >
                <Video size={22} color={canCall ? colors.accent : colors.fgFaint} />
              </HeaderIconButton>
              {/* A DM has no role system, so every participant may pin (M17). */}
              <HeaderIconButton onPress={openPinsSheet} label={t("mobile:pins.open")}>
                <Pin size={21} color={colors.accent} />
              </HeaderIconButton>
              {userId ? (
                <HeaderIconButton
                  onPress={() =>
                    router.push({ pathname: "/user/[userId]", params: { userId, name: title } })
                  }
                  // Long press = the user menu, the same gesture the roster and a
                  // message author answer to. Tap still opens the profile.
                  onLongPress={() =>
                    setMemberTarget({ userId: userId as UserId, displayName: title })
                  }
                  label={t("mobile:dm.viewProfile")}
                  hint={t("mobile:userMenu.moreActions")}
                >
                  <UserRound size={22} color={colors.accent} />
                </HeaderIconButton>
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
        />
      ) : (
        <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: space.xl }}>
          <Text style={{ color: colors.fgMuted, fontSize: 14, textAlign: "center" }}>
            {t("mobile:dm.unavailable")}
          </Text>
        </View>
      )}
    </Screen>
  );
}
