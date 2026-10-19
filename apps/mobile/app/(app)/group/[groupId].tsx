import { useState } from "react";
import { View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { MoreHorizontal, UserPlus } from "lucide-react-native";
import { useAppTranslation } from "@/lib/i18n";
import { ConnectionBanner } from "@/components/ConnectionBanner";
import { Screen } from "@/components/Screen";
import { ServerActionsSheet } from "@/components/home/ServerActionsSheet";
import { ServerChannelList } from "@/components/home/ServerChannelList";
import { IconButton } from "@/components/ui/IconButton";
import { useGroupDetails } from "@/queries/chat-queries";
import { colors, space } from "@/theme/theme";

/**
 * Full-screen server view. Reachable from deep links (a `/kat/<code>` invite
 * preview, the join flow) — the Home shell's rail shows the SAME channels inline
 * via {@link ServerChannelList}, so this route and the panel never diverge.
 *
 * The route keeps its native Stack header (on the page tone, borderless); its
 * actions mirror the shell panel's — the coral invite button and the "…"
 * overflow menu that holds settings and the destructive leave — so the two
 * surfaces stay identical.
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
          headerStyle: { backgroundColor: colors.app },
          headerRight: () => (
            <View style={{ flexDirection: "row", alignItems: "center", gap: space.sm }}>
              <IconButton
                icon={UserPlus}
                variant="accent"
                size="sm"
                label={t("mobile:group.inviteFriends")}
                onPress={() =>
                  router.push({ pathname: "/invite", params: { groupId, name: serverName } })
                }
              />
              <IconButton
                icon={MoreHorizontal}
                label={t("mobile:group.serverActionsA11y", { name: serverName })}
                onPress={() => setActionsOpen(true)}
              />
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
