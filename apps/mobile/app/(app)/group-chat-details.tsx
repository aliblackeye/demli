import { useState } from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { Text } from "@/components/ui/Text";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Link2, UserMinus } from "lucide-react-native";
import { USERNAME_MAX_LENGTH } from "@demli/config";
import { useAppTranslation } from "@/lib/i18n";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/Button";
import { ChannelMediaGrid } from "@/components/attachments/ChannelMediaGrid";
import { Segmented } from "@/components/Segmented";
import { TextField } from "@/components/TextField";
import { localizeError } from "@/lib/errors";
import {
  useAddGroupChatMember,
  useDeleteGroupChat,
  useGroupChatDetails,
  useRemoveGroupChatMember,
} from "@/queries/group-chat-queries";
import { useAuthStore } from "@/stores/auth-store";
import { useChatStore } from "@/stores/chat-store";
import { colors, radius, space, typography } from "@/theme/theme";

function SectionLabel({ children }: { children: string }) {
  return (
    <Text
      style={{
        color: colors.fgFaint,
        fontSize: typography.size["2xs"],
        fontWeight: "700",
        letterSpacing: 0.6,
        textTransform: "uppercase",
      }}
    >
      {children}
    </Text>
  );
}

/**
 * Roster for a flat group chat: members with presence, owner-only add-by-username
 * and remove, a "Leave group" for non-owners, and a "Delete group" for the owner.
 * Presented as a modal from the group-chat header. Owners delete the whole group
 * (removes it for everyone; the server broadcasts group.deleted) rather than
 * leave it — so there is no non-functional "leave" the server would reject.
 */
export default function GroupChatDetails() {
  const { t } = useAppTranslation();
  const params = useLocalSearchParams<{ groupChatId: string; name?: string }>();
  const groupChatId = params.groupChatId ?? null;
  const insets = useSafeAreaInsets();

  const me = useAuthStore((s) => s.user);
  const presence = useChatStore((s) => s.presence);
  const { data, isLoading, refetch, isRefetching } = useGroupChatDetails(groupChatId);
  const addMember = useAddGroupChatMember(groupChatId);
  const removeMember = useRemoveGroupChatMember(groupChatId);
  const deleteGroup = useDeleteGroupChat(groupChatId);

  const [tab, setTab] = useState<"members" | "media">("members");
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);

  const group = data?.group;
  const members = data?.members ?? [];
  const isOwner = !!group && !!me && group.ownerId === me.id;

  const onAdd = () => {
    const trimmed = username.trim();
    if (trimmed.length === 0) {
      setError(t("mobile:groupChatDetails.validationUsername"));
      return;
    }
    setError(null);
    addMember.mutate(
      { username: trimmed },
      {
        onSuccess: () => setUsername(""),
        onError: (err) => setError(localizeError(err, t)),
      },
    );
  };

  const onInvite = () => {
    if (!groupChatId) return;
    router.push({
      pathname: "/group-chat-invite",
      params: { groupChatId, name: group?.name ?? params.name ?? "" },
    });
  };

  const onRemove = (userId: string, name: string) => {
    Alert.alert(
      t("mobile:groupChatDetails.removeConfirmTitle"),
      t("mobile:groupChatDetails.removeConfirmBody", { name }),
      [
        { text: t("buttons.cancel"), style: "cancel" },
        {
          text: t("buttons.remove"),
          style: "destructive",
          onPress: () =>
            removeMember.mutate(userId, {
              onError: (err) =>
                Alert.alert(t("mobile:groupChatDetails.removeError"), localizeError(err, t)),
            }),
        },
      ],
    );
  };

  const onLeave = () => {
    if (!me) return;
    Alert.alert(
      t("mobile:groupChatDetails.leaveConfirmTitle"),
      t("mobile:groupChatDetails.leaveConfirmBody"),
      [
        { text: t("buttons.cancel"), style: "cancel" },
        {
          text: t("buttons.leave"),
          style: "destructive",
          onPress: () =>
            removeMember.mutate(me.id, {
              onSuccess: () => router.navigate("/groups"),
              onError: (err) =>
                Alert.alert(t("mobile:groupChatDetails.leaveError"), localizeError(err, t)),
            }),
        },
      ],
    );
  };

  const onDelete = () => {
    Alert.alert(
      t("mobile:groupChatDetails.deleteConfirmTitle"),
      t("mobile:groupChatDetails.deleteConfirmBody"),
      [
        { text: t("buttons.cancel"), style: "cancel" },
        {
          text: t("buttons.delete"),
          style: "destructive",
          onPress: () =>
            deleteGroup.mutate(undefined, {
              onSuccess: () => router.navigate("/groups"),
              onError: (err) =>
                Alert.alert(t("mobile:groupChatDetails.deleteError"), localizeError(err, t)),
            }),
        },
      ],
    );
  };

  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={{ flex: 1, backgroundColor: colors.app }}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.app }}
        contentContainerStyle={{
          padding: space.lg,
          paddingBottom: space.xl + insets.bottom,
          gap: space.xl,
        }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={() => void refetch()}
            tintColor={colors.fgMuted}
            colors={[colors.accent]}
          />
        }
      >
        <Stack.Screen options={{ title: group?.name ?? params.name ?? t("mobile:groupChatDetails.fallbackTitle") }} />

        {isLoading && !data ? (
          <View style={{ paddingTop: space.xl, alignItems: "center" }}>
            <ActivityIndicator color={colors.fgFaint} />
          </View>
        ) : null}

        {data ? (
          <>
            {/* Members / Media tabs (ref #8). */}
            <Segmented
              options={[
                { value: "members", label: t("mobile:groupChatDetails.tabMembers") },
                { value: "media", label: t("mobile:groupChatDetails.tabMedia") },
              ]}
              value={tab}
              onChange={setTab}
            />

            {tab === "members" ? (
              <>
                {/* Any member may hand out a link — a group chat has no roles,
                    and only REVOKING is the owner's (see the invite screen). */}
                <Button variant="ghost" onPress={onInvite}>
                  <Link2 size={18} color={colors.fg} />
                  <Text style={{ color: colors.fg, fontSize: 15, fontWeight: "600" }}>
                    {t("mobile:groupChatInvite.menuItem")}
                  </Text>
                </Button>

                {isOwner ? (
                  <View style={{ gap: space.md }}>
                    <SectionLabel>{t("mobile:groupChatDetails.addMemberSection")}</SectionLabel>
                    {error ? (
                      <View style={{ backgroundColor: colors.dangerSurface, borderRadius: radius.sm, padding: space.sm }}>
                        <Text selectable style={{ color: colors.danger, fontSize: 13 }}>
                          {error}
                        </Text>
                      </View>
                    ) : null}
                    <TextField
                      label={t("mobile:groupChatDetails.usernameLabel")}
                      value={username}
                      onChangeText={setUsername}
                      autoCapitalize="none"
                      autoCorrect={false}
                      maxLength={USERNAME_MAX_LENGTH}
                      placeholder={t("mobile:groupChatDetails.usernamePlaceholder")}
                      returnKeyType="done"
                      onSubmitEditing={onAdd}
                    />
                    <Button label={t("mobile:groupChatDetails.addMemberButton")} variant="ghost" onPress={onAdd} loading={addMember.isPending} />
                  </View>
                ) : null}

                <View style={{ gap: space.md }}>
                  <SectionLabel>{t("mobile:group.membersCount", { n: members.length })}</SectionLabel>
                  <View style={{ gap: space.md }}>
                    {members.map((member) => {
                      const name = member.user.displayName || member.user.username;
                      const canRemove = isOwner && member.userId !== me?.id && member.role !== "owner";
                      return (
                        <View
                          key={member.userId}
                          style={{ flexDirection: "row", alignItems: "center", gap: space.md }}
                        >
                          <Avatar
                            name={name}
                            size={40}
                            uri={member.user.avatarUrl}
                            presence={presence[member.userId] ?? "offline"}
                          />
                          <View style={{ flex: 1 }}>
                            <Text numberOfLines={1} style={{ color: colors.fg, fontSize: 15, fontWeight: "600" }}>
                              {name}
                            </Text>
                            <Text numberOfLines={1} style={{ color: colors.fgFaint, fontSize: 12 }}>
                              @{member.user.username}
                              {member.role === "owner" ? ` · ${t("mobile:role.owner")}` : ""}
                            </Text>
                          </View>
                          {canRemove ? (
                            <Pressable
                              onPress={() => onRemove(member.userId, name)}
                              hitSlop={10}
                              style={{ padding: space.sm }}
                              accessibilityLabel={t("mobile:groupChatDetails.removeA11y", { name })}
                            >
                              <UserMinus size={20} color={colors.danger} />
                            </Pressable>
                          ) : null}
                        </View>
                      );
                    })}
                  </View>
                </View>

                {group && isOwner ? (
                  <Button
                    label={t("mobile:groupChatDetails.deleteGroup")}
                    variant="danger"
                    loading={deleteGroup.isPending}
                    onPress={onDelete}
                    style={{ borderRadius: radius.md }}
                  />
                ) : null}

                {group && !isOwner ? (
                  <Button
                    label={t("mobile:groupChatDetails.leaveGroup")}
                    variant="danger"
                    loading={removeMember.isPending}
                    onPress={onLeave}
                    style={{ borderRadius: radius.md }}
                  />
                ) : null}
              </>
            ) : group ? (
              <ChannelMediaGrid channelId={group.streamId} />
            ) : null}
          </>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
