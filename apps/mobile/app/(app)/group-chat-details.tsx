import { useState } from "react";
import { RefreshControl, ScrollView, View } from "react-native";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeOut, LinearTransition, ReduceMotion } from "react-native-reanimated";
import { AtSign, CloudOff, Link2, LogOut, Trash2, UserMinus, UserPlus } from "lucide-react-native";
import { USERNAME_MAX_LENGTH } from "@demli/config";
import { useAppTranslation } from "@/lib/i18n";
import { Avatar } from "@/components/Avatar";
import { ChannelMediaGrid } from "@/components/attachments/ChannelMediaGrid";
import { EmptyState } from "@/components/EmptyState";
import { Segmented } from "@/components/Segmented";
import { Skeleton, SkeletonList } from "@/components/Skeleton";
import { TextField } from "@/components/TextField";
import { ConfirmSheet } from "@/components/settings/ConfirmSheet";
import { DangerZone, SectionEyebrow, SettingsRow, SettingsSection } from "@/components/settings/SettingsSection";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Text } from "@/components/ui/Text";
import { toast } from "@/components/ui/toast-store";
import { localizeError } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import {
  useAddGroupChatMember,
  useDeleteGroupChat,
  useGroupChatDetails,
  useRemoveGroupChatMember,
} from "@/queries/group-chat-queries";
import { useAuthStore } from "@/stores/auth-store";
import { useChatStore } from "@/stores/chat-store";
import { colors, motion, radius, space } from "@/theme/theme";

/** The destructive step waiting for its confirm. */
type Pending = { kind: "remove"; userId: string; name: string } | { kind: "leave" } | { kind: "delete" } | null;

/**
 * Roster for a flat group chat: members with presence, owner-only add-by-username
 * and remove, a "Leave group" for non-owners, and a "Delete group" for the owner.
 * Presented as a modal from the group-chat header. Owners delete the whole group
 * (removes it for everyone; the server broadcasts group.deleted) rather than
 * leave it — so there is no non-functional "leave" the server would reject.
 *
 * Koyu Masa: the group's identity on top, Members / Media as a segmented
 * switch, the invite-link entry as a settings row open to everyone, the roster
 * as a card, and every removal / leave / delete confirmed in a sheet that keeps
 * the request's busy state and error in place.
 */
export default function GroupChatDetails() {
  const { t } = useAppTranslation();
  const params = useLocalSearchParams<{ groupChatId: string; name?: string }>();
  const groupChatId = params.groupChatId ?? null;
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();

  const me = useAuthStore((s) => s.user);
  const presence = useChatStore((s) => s.presence);
  const { data, isLoading, isError, error: loadError, refetch, isRefetching } = useGroupChatDetails(groupChatId);
  const addMember = useAddGroupChatMember(groupChatId);
  const removeMember = useRemoveGroupChatMember(groupChatId);
  const deleteGroup = useDeleteGroupChat(groupChatId);

  const [tab, setTab] = useState<"members" | "media">("members");
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);

  const group = data?.group;
  const members = data?.members ?? [];
  const isOwner = !!group && !!me && group.ownerId === me.id;
  const title = group?.name ?? params.name ?? t("mobile:groupChatDetails.fallbackTitle");

  const onAdd = () => {
    const trimmed = username.trim().replace(/^@/, "");
    if (trimmed.length === 0) {
      setError(t("mobile:groupChatDetails.validationUsername"));
      return;
    }
    setError(null);
    addMember.mutate(
      { username: trimmed },
      {
        onSuccess: () => {
          setUsername("");
          haptics.light();
          toast({ key: "member-added", variant: "success", title: t("mobile:newGroupChat.memberAddedNamed", { username: trimmed }), duration: 2000 });
        },
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

  const ask = (next: Pending) => {
    setPendingError(null);
    setPending(next);
  };

  const confirmPending = () => {
    if (!pending) return;
    if (pending.kind === "remove") {
      removeMember.mutate(pending.userId, {
        onSuccess: () => setPending(null),
        onError: (err) => setPendingError(localizeError(err, t)),
      });
    } else if (pending.kind === "leave") {
      if (!me) return;
      removeMember.mutate(me.id, {
        onSuccess: () => {
          setPending(null);
          router.navigate("/groups");
        },
        onError: (err) => setPendingError(localizeError(err, t)),
      });
    } else {
      deleteGroup.mutate(undefined, {
        onSuccess: () => {
          setPending(null);
          router.navigate("/groups");
        },
        onError: (err) => setPendingError(localizeError(err, t)),
      });
    }
  };

  const sheet =
    pending?.kind === "remove"
      ? {
          title: t("mobile:groupChatDetails.removeConfirmTitle"),
          body: t("mobile:groupChatDetails.removeConfirmBody", { name: pending.name }),
          confirm: t("buttons.remove"),
          icon: UserMinus,
          errorTitle: t("mobile:groupChatDetails.removeError"),
        }
      : pending?.kind === "leave"
        ? {
            title: t("mobile:groupChatDetails.leaveConfirmTitle"),
            body: t("mobile:groupChatDetails.leaveConfirmBody"),
            confirm: t("buttons.leave"),
            icon: LogOut,
            errorTitle: t("mobile:groupChatDetails.leaveError"),
          }
        : {
            title: t("mobile:groupChatDetails.deleteConfirmTitle"),
            body: t("mobile:groupChatDetails.deleteConfirmBody"),
            confirm: t("buttons.delete"),
            icon: Trash2,
            errorTitle: t("mobile:groupChatDetails.deleteError"),
          };

  return (
    <View style={{ flex: 1, backgroundColor: colors.app }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.app }}
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xl + insets.bottom + keyboard, gap: space.xl }}
        keyboardShouldPersistTaps="handled"
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={() => void refetch()}
            tintColor={colors.fgMuted}
            colors={[colors.accent]}
            progressBackgroundColor={colors.surfaceRaised}
          />
        }
      >
        <Stack.Screen options={{ title }} />

        {isLoading && !data ? (
          <View style={{ gap: space.lg }}>
            <View style={{ alignItems: "center", gap: space.md }}>
              <Skeleton width={72} height={72} radius={radius.pill} />
              <Skeleton width="40%" height={18} />
            </View>
            <Skeleton width="100%" height={44} radius={radius.lg} />
            <SkeletonList count={4} lines={2} leadingSize={40} />
          </View>
        ) : null}

        {isError && !data ? (
          <EmptyState
            tone="error"
            icon={<CloudOff size={22} color={colors.danger} />}
            title={t("mobile:groupChatDetails.loadErrorTitle")}
            subtitle={localizeError(loadError, t)}
            action={<Button label={t("common:buttons.retry")} variant="secondary" size="sm" onPress={() => void refetch()} loading={isRefetching} />}
          />
        ) : null}

        {data ? (
          <>
            <View style={{ alignItems: "center", gap: space.sm }}>
              <Avatar name={title} size={72} uri={null} />
              <Text type="heading" tone="display" numberOfLines={2} style={{ textAlign: "center" }}>
                {title}
              </Text>
              <Text type="meta" tone="faint" style={{ fontWeight: "400" }}>
                {t("mobile:group.membersCount", { n: members.length })}
              </Text>
            </View>

            {/* Members / Media tabs (ref #8). */}
            <Segmented
              accessibilityLabel={t("mobile:groupChatDetails.tabsLabel")}
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
                <SettingsSection>
                  <SettingsRow
                    icon={Link2}
                    accent
                    title={t("mobile:groupChatInvite.menuItem")}
                    subtitle={t("mobile:groupChatDetails.inviteRowSubtitle")}
                    onPress={onInvite}
                  />
                </SettingsSection>

                {isOwner ? (
                  <View style={{ gap: space.md }}>
                    <SectionEyebrow style={{ paddingBottom: 0 }}>{t("mobile:groupChatDetails.addMemberSection")}</SectionEyebrow>
                    <TextField
                      label={t("mobile:groupChatDetails.usernameLabel")}
                      value={username}
                      onChangeText={(next) => {
                        setUsername(next);
                        if (error) setError(null);
                      }}
                      leading={<AtSign size={16} color={colors.fgFaint} />}
                      autoCapitalize="none"
                      autoCorrect={false}
                      maxLength={USERNAME_MAX_LENGTH}
                      placeholder={t("mobile:groupChatDetails.usernamePlaceholder")}
                      returnKeyType="done"
                      onSubmitEditing={onAdd}
                      error={error}
                    />
                    <Button
                      label={t("mobile:groupChatDetails.addMemberButton")}
                      icon={UserPlus}
                      variant="secondary"
                      block
                      onPress={onAdd}
                      loading={addMember.isPending}
                      disabled={username.trim().length === 0}
                    />
                  </View>
                ) : null}

                <View>
                  <SectionEyebrow>{t("mobile:group.membersCount", { n: members.length })}</SectionEyebrow>
                  <View style={{ backgroundColor: colors.surface, borderRadius: radius.xl, borderCurve: "continuous", overflow: "hidden" }}>
                    {members.map((member) => {
                      const name = member.user.displayName || member.user.username;
                      const canRemove = isOwner && member.userId !== me?.id && member.role !== "owner";
                      return (
                        <Animated.View
                          key={member.userId}
                          exiting={FadeOut.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
                          layout={LinearTransition.duration(motion.duration.standard).reduceMotion(ReduceMotion.System)}
                          style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingLeft: space.lg, paddingRight: space.xs, paddingVertical: space.sm, minHeight: 60 }}
                        >
                          <Avatar
                            name={name}
                            size={40}
                            uri={member.user.avatarUrl}
                            presence={presence[member.userId] ?? "offline"}
                            ringColor={colors.surface}
                          />
                          <View style={{ flex: 1, gap: 2 }}>
                            <Text type="body" tone="default" numberOfLines={1} style={{ fontWeight: "600" }}>
                              {name}
                            </Text>
                            <Text type="meta" tone="faint" numberOfLines={1} style={{ fontWeight: "400" }}>
                              @{member.user.username}
                            </Text>
                          </View>
                          {member.role === "owner" ? <Badge variant="accent" label={t("mobile:role.owner")} /> : null}
                          {member.userId === me?.id ? <Badge variant="neutral" label={t("mobile:common.you")} /> : null}
                          {canRemove ? (
                            <IconButton
                              icon={UserMinus}
                              label={t("mobile:groupChatDetails.removeA11y", { name })}
                              onPress={() => ask({ kind: "remove", userId: member.userId, name })}
                            />
                          ) : (
                            <View style={{ width: space.sm }} />
                          )}
                        </Animated.View>
                      );
                    })}
                  </View>
                </View>

                {group ? (
                  <DangerZone
                    title={t("mobile:common.dangerZone")}
                    description={
                      isOwner ? t("mobile:groupChatDetails.deleteConfirmBody") : t("mobile:groupChatDetails.leaveConfirmBody")
                    }
                  >
                    {isOwner ? (
                      <Button
                        label={t("mobile:groupChatDetails.deleteGroup")}
                        icon={Trash2}
                        variant="danger"
                        onPress={() => ask({ kind: "delete" })}
                      />
                    ) : (
                      <Button
                        label={t("mobile:groupChatDetails.leaveGroup")}
                        icon={LogOut}
                        variant="danger"
                        onPress={() => ask({ kind: "leave" })}
                      />
                    )}
                  </DangerZone>
                ) : null}
              </>
            ) : group ? (
              <ChannelMediaGrid channelId={group.streamId} />
            ) : null}
          </>
        ) : null}
      </ScrollView>

      <ConfirmSheet
        visible={pending !== null}
        title={sheet.title}
        body={sheet.body}
        confirmLabel={sheet.confirm}
        confirmIcon={sheet.icon}
        onConfirm={confirmPending}
        cancelLabel={t("common:buttons.cancel")}
        onCancel={() => setPending(null)}
        busy={removeMember.isPending || deleteGroup.isPending}
        error={pendingError}
        errorTitle={sheet.errorTitle}
      />
    </View>
  );
}
