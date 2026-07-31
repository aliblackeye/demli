import { useState } from "react";
import { Pressable, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MoreVertical, UserPlus } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { Screen } from "@/components/Screen";
import { ServerActionsSheet } from "@/components/home/ServerActionsSheet";
import { ServerChannelList } from "@/components/home/ServerChannelList";
import { useGroupDetails } from "@/queries/chat-queries";
import { colors, space } from "@/theme/theme";

/**
 * Full-screen server view. Reachable from deep links (a `/kat/<code>` invite
 * preview, the join flow) — the Home shell's rail shows the SAME channels inline
 * via {@link ServerChannelList}, so this route and the panel never diverge.
 *
 * The route keeps its native Stack header; its actions mirror the shell panel's
 * (invite + the "…" overflow menu that holds settings and the destructive
 * leave), so the two surfaces stay identical.
 */
export default function GroupScreen() {
  const { t } = useAppTranslation();
  const params = useLocalSearchParams<{ groupId: string; name?: string }>();
  const groupId = params.groupId;
  const insets = useSafeAreaInsets();
  const { data } = useGroupDetails(groupId ?? null);
  const serverName = params.name ?? data?.group.name ?? t("mobile:group.channelsTitle");
  const [actionsOpen, setActionsOpen] = useState(false);

  return (
    <Screen>
      <Stack.Screen
        options={{
          title: serverName,
          headerRight: () => (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.lg, paddingRight: space.xs }}>
              <Pressable
                onPress={() =>
                  router.push({ pathname: "/invite", params: { groupId, name: serverName } })
                }
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={t("mobile:group.inviteFriends")}
              >
                <UserPlus size={22} color={colors.accent} />
              </Pressable>
              <Pressable
                onPress={() => setActionsOpen(true)}
                hitSlop={10}
                accessibilityRole="button"
                accessibilityLabel={t("mobile:group.serverActionsA11y", { name: serverName })}
              >
                <MoreVertical size={22} color={colors.fgMuted} />
              </Pressable>
            </View>
          ),
        }}
      />
      <ConnectionBanner />
      {groupId ? (
        <ServerChannelList groupId={groupId} contentBottomPadding={space.xl + insets.bottom} />
      ) : null}
      <ServerActionsSheet
        visible={actionsOpen}
        groupId={groupId ?? null}
        serverName={serverName}
        onClose={() => setActionsOpen(false)}
        onLeft={() => router.navigate("/groups")}
      />
    </Screen>
  );
}
