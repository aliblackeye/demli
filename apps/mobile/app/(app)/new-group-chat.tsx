import { useState } from "react";
import { ScrollView, View } from "react-native";
import { router, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, FadeInDown, LinearTransition, ReduceMotion } from "react-native-reanimated";
import { AtSign, MessageCircle, Plus, UserPlus } from "lucide-react-native";
import { GROUP_NAME_MAX_LENGTH, USERNAME_MAX_LENGTH } from "@demli/config";
import { useAppTranslation } from "@/lib/i18n";
import { Avatar } from "@/components/Avatar";
import { SkeletonList } from "@/components/Skeleton";
import { TextField } from "@/components/TextField";
import { SectionEyebrow } from "@/components/settings/SettingsSection";
import { Badge } from "@/components/ui/Badge";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Text } from "@/components/ui/Text";
import { toast } from "@/components/ui/toast-store";
import { localizeError } from "@/lib/errors";
import { haptics } from "@/lib/haptics";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import { useAddGroupChatMember, useCreateGroupChat, useGroupChatDetails } from "@/queries/group-chat-queries";
import { useAuthStore } from "@/stores/auth-store";
import { colors, motion, radius, space } from "@/theme/theme";

/** The created group's id + name, held once creation succeeds. */
type CreatedGroup = { id: string; name: string };

/** "1 / 2" step marker: two short bars, the done/current ones in coral. */
function StepMarker({ step }: { step: 1 | 2 }) {
  const { t } = useAppTranslation();
  return (
    <View
      accessible
      accessibilityLabel={t("mobile:newGroupChat.stepA11y", { step, total: 2 })}
      style={{ flexDirection: "row", alignItems: "center", gap: space.xs }}
    >
      {[1, 2].map((n) => (
        <View
          key={n}
          style={{ width: 28, height: 4, borderRadius: radius.pill, backgroundColor: n <= step ? colors.accent : colors.surfaceRaised }}
        />
      ))}
      <Text type="caption" tone="faint" style={{ marginLeft: space.xs }}>
        {t("mobile:newGroupChat.step", { step, total: 2 })}
      </Text>
    </View>
  );
}

/**
 * Step 1 — name the group. On success we DON'T drop straight into the (empty)
 * chat; we advance to the invite step so the creator can pull friends in first.
 */
function NameStep({ onCreated }: { onCreated: (group: CreatedGroup) => void }) {
  const { t } = useAppTranslation();
  const createGroupChat = useCreateGroupChat();
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const onCreate = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > GROUP_NAME_MAX_LENGTH) {
      setFieldError(t("mobile:newGroupChat.validationName", { max: GROUP_NAME_MAX_LENGTH }));
      return;
    }
    setError(null);
    setFieldError(null);
    createGroupChat.mutate(
      { name: trimmed },
      {
        onSuccess: ({ group }) => {
          haptics.success();
          onCreated({ id: group.id, name: group.name });
        },
        onError: (err) => setError(localizeError(err, t)),
      },
    );
  };

  return (
    <View style={{ gap: space.xl }}>
      <StepMarker step={1} />
      <View style={{ alignItems: "center", gap: space.md }}>
        <Avatar name={name.trim() || t("mobile:newGroupChat.namePlaceholder")} size={72} uri={null} />
        <View style={{ alignItems: "center", gap: space.xs }}>
          <Text type="heading" tone="display" accessibilityRole="header" style={{ textAlign: "center" }}>
            {t("mobile:newGroupChat.title")}
          </Text>
          <Text type="ui" tone="muted" style={{ textAlign: "center", fontWeight: "400", lineHeight: 20 }}>
            {t("mobile:newGroupChat.intro")}
          </Text>
        </View>
      </View>
      {error ? <Banner variant="danger" title={t("mobile:newGroupChat.createErrorTitle")} description={error} /> : null}
      <TextField
        label={t("mobile:newGroupChat.nameLabel")}
        value={name}
        onChangeText={(next) => {
          setName(next);
          if (fieldError) setFieldError(null);
        }}
        maxLength={GROUP_NAME_MAX_LENGTH}
        placeholder={t("mobile:newGroupChat.namePlaceholder")}
        autoFocus
        returnKeyType="done"
        onSubmitEditing={onCreate}
        error={fieldError}
        editable={!createGroupChat.isPending}
      />
      <Button
        label={t("mobile:newGroupChat.create")}
        icon={Plus}
        variant="accent"
        size="lg"
        block
        onPress={onCreate}
        loading={createGroupChat.isPending}
      />
    </View>
  );
}

/**
 * Step 2 — add members by username, then open the chat. Flat group chats are
 * add-by-username (ADR 0005), not invite-link joins, so we reuse that existing
 * infra (useAddGroupChatMember) rather than minting a server-style invite. The
 * roster below reflects each add live (a new row eases in) so the creator sees
 * who's in before entering.
 */
function InviteStep({ group }: { group: CreatedGroup }) {
  const { t } = useAppTranslation();
  const meId = useAuthStore((s) => s.user?.id);
  const details = useGroupChatDetails(group.id);
  const addMember = useAddGroupChatMember(group.id);

  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);

  const members = details.data?.members ?? [];

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

  const openChat = () =>
    router.replace({
      pathname: "/group-chat/[groupChatId]",
      params: { groupChatId: group.id, name: group.name },
    });

  return (
    <Animated.View entering={FadeIn.duration(motion.duration.standard).reduceMotion(ReduceMotion.System)} style={{ gap: space.xl }}>
      <StepMarker step={2} />
      <View style={{ gap: space.xs }}>
        <Text type="heading" tone="display" accessibilityRole="header">
          {t("mobile:newGroupChat.createdTitle", { name: group.name })}
        </Text>
        <Text type="ui" tone="muted" style={{ fontWeight: "400", lineHeight: 20 }}>
          {t("mobile:newGroupChat.createdIntro")}
        </Text>
      </View>

      <View style={{ gap: space.md }}>
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

      <View>
        <SectionEyebrow>{t("mobile:group.membersCount", { n: members.length })}</SectionEyebrow>
        {details.isLoading && members.length === 0 ? (
          <SkeletonList count={2} lines={2} leadingSize={40} />
        ) : (
          <View style={{ backgroundColor: colors.surface, borderRadius: radius.xl, borderCurve: "continuous", overflow: "hidden" }}>
            {members.map((member) => {
              const name = member.user.displayName || member.user.username;
              const isMe = member.userId === meId;
              return (
                <Animated.View
                  key={member.userId}
                  entering={FadeInDown.duration(motion.duration.standard).reduceMotion(ReduceMotion.System)}
                  layout={LinearTransition.duration(motion.duration.standard).reduceMotion(ReduceMotion.System)}
                  style={{ flexDirection: "row", alignItems: "center", gap: space.md, paddingHorizontal: space.lg, paddingVertical: space.md }}
                >
                  <Avatar name={name} size={40} uri={member.user.avatarUrl} ringColor={colors.surface} />
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text type="body" tone="default" numberOfLines={1} style={{ fontWeight: "600" }}>
                      {name}
                    </Text>
                    <Text type="meta" tone="faint" numberOfLines={1} style={{ fontWeight: "400" }}>
                      @{member.user.username}
                    </Text>
                  </View>
                  {isMe ? <Badge variant="neutral" label={t("mobile:common.you")} /> : null}
                </Animated.View>
              );
            })}
          </View>
        )}
      </View>

      <Button label={t("mobile:newGroupChat.openChat")} icon={MessageCircle} variant="accent" size="lg" block onPress={openChat} />
    </Animated.View>
  );
}

/**
 * Create a flat group chat (ADR 0005) as a two-step flow (audit #19): name it,
 * then add members before entering — so a new group opens with friends already
 * in it rather than as an empty room. `router.replace` into the chat at the end
 * keeps Back returning to the home list.
 */
export default function NewGroupChat() {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const [created, setCreated] = useState<CreatedGroup | null>(null);

  return (
    <View style={{ flex: 1, backgroundColor: colors.app }}>
      <Stack.Screen options={{ title: created ? t("mobile:newGroupChat.inviteTitle") : t("mobile:newGroupChat.title") }} />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.app }}
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.lg + insets.bottom + keyboard, gap: space.xl }}
        keyboardShouldPersistTaps="handled"
      >
        {created ? <InviteStep group={created} /> : <NameStep onCreated={setCreated} />}
      </ScrollView>
    </View>
  );
}
