import { useState } from "react";
import { ActivityIndicator, KeyboardAvoidingView, ScrollView, View } from "react-native";
import { Text } from "@/components/ui/Text";
import { router, Stack } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GROUP_NAME_MAX_LENGTH, USERNAME_MAX_LENGTH } from "@demli/config";
import { useAppTranslation } from "@/lib/i18n";
import { Avatar } from "@/components/Avatar";
import { Button } from "@/components/Button";
import { TextField } from "@/components/TextField";
import { localizeError } from "@/lib/errors";
import {
  useAddGroupChatMember,
  useCreateGroupChat,
  useGroupChatDetails,
} from "@/queries/group-chat-queries";
import { useAuthStore } from "@/stores/auth-store";
import { colors, radius, space, typography } from "@/theme/theme";

/** The created group's id + name, held once creation succeeds. */
type CreatedGroup = { id: string; name: string };

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

function ErrorBox({ message }: { message: string }) {
  return (
    <View style={{ backgroundColor: colors.dangerSurface, borderRadius: radius.sm, padding: space.sm }}>
      <Text selectable style={{ color: colors.danger, fontSize: 13 }}>
        {message}
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

  const onCreate = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > GROUP_NAME_MAX_LENGTH) {
      setError(t("mobile:newGroupChat.validationName", { max: GROUP_NAME_MAX_LENGTH }));
      return;
    }
    setError(null);
    createGroupChat.mutate(
      { name: trimmed },
      {
        onSuccess: ({ group }) => onCreated({ id: group.id, name: group.name }),
        onError: (err) => setError(localizeError(err, t)),
      },
    );
  };

  return (
    <View style={{ gap: space.xl }}>
      {error ? <ErrorBox message={error} /> : null}
      <View style={{ gap: space.md }}>
        <Text variant="display" style={{ color: colors.fg, fontSize: 16, fontWeight: "700" }}>
          {t("mobile:newGroupChat.title")}
        </Text>
        <Text style={{ color: colors.fgMuted, fontSize: 14, lineHeight: 20 }}>
          {t("mobile:newGroupChat.intro")}
        </Text>
        <TextField
          label={t("mobile:newGroupChat.nameLabel")}
          value={name}
          onChangeText={setName}
          maxLength={GROUP_NAME_MAX_LENGTH}
          placeholder={t("mobile:newGroupChat.namePlaceholder")}
          autoFocus
          returnKeyType="done"
          onSubmitEditing={onCreate}
        />
        <Button
          label={t("mobile:newGroupChat.create")}
          onPress={onCreate}
          loading={createGroupChat.isPending}
        />
      </View>
    </View>
  );
}

/**
 * Step 2 — add members by username, then open the chat. Flat group chats are
 * add-by-username (ADR 0005), not invite-link joins, so we reuse that existing
 * infra (useAddGroupChatMember) rather than minting a server-style invite. The
 * roster below reflects each add live so the creator sees who's in before
 * entering.
 */
function InviteStep({ group }: { group: CreatedGroup }) {
  const { t } = useAppTranslation();
  const meId = useAuthStore((s) => s.user?.id);
  const details = useGroupChatDetails(group.id);
  const addMember = useAddGroupChatMember(group.id);

  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState(false);

  const members = details.data?.members ?? [];

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
        onSuccess: () => {
          setUsername("");
          setAdded(true);
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
    <View style={{ gap: space.xl }}>
      <View style={{ gap: space.sm }}>
        <Text variant="display" style={{ color: colors.fg, fontSize: 18, fontWeight: "800" }}>
          {t("mobile:newGroupChat.createdTitle", { name: group.name })}
        </Text>
        <Text style={{ color: colors.fgMuted, fontSize: 14, lineHeight: 20 }}>
          {t("mobile:newGroupChat.createdIntro")}
        </Text>
      </View>

      <View style={{ gap: space.md }}>
        <SectionLabel>{t("mobile:groupChatDetails.addMemberSection")}</SectionLabel>
        {error ? <ErrorBox message={error} /> : null}
        {added && !error ? (
          <Text style={{ color: colors.online, fontSize: 13 }}>
            {t("mobile:newGroupChat.memberAdded")}
          </Text>
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
        <Button
          label={t("mobile:groupChatDetails.addMemberButton")}
          variant="ghost"
          onPress={onAdd}
          loading={addMember.isPending}
        />
      </View>

      <View style={{ gap: space.md }}>
        <SectionLabel>{t("mobile:group.membersCount", { n: members.length })}</SectionLabel>
        {details.isLoading && members.length === 0 ? (
          <ActivityIndicator color={colors.fgFaint} />
        ) : (
          members.map((member) => {
            const name = member.user.displayName || member.user.username;
            const isMe = member.userId === meId;
            return (
              <View
                key={member.userId}
                style={{ flexDirection: "row", alignItems: "center", gap: space.md }}
              >
                <Avatar name={name} size={40} uri={member.user.avatarUrl} />
                <View style={{ flex: 1 }}>
                  <Text numberOfLines={1} style={{ color: colors.fg, fontSize: 15, fontWeight: "600" }}>
                    {name}
                    {isMe ? ` · ${t("mobile:common.you")}` : ""}
                  </Text>
                  <Text numberOfLines={1} style={{ color: colors.fgFaint, fontSize: 12 }}>
                    @{member.user.username}
                  </Text>
                </View>
              </View>
            );
          })
        )}
      </View>

      <Button label={t("mobile:newGroupChat.openChat")} onPress={openChat} />
    </View>
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
  const [created, setCreated] = useState<CreatedGroup | null>(null);

  return (
    <KeyboardAvoidingView
      behavior="padding"
      style={{ flex: 1, backgroundColor: colors.app }}
    >
      <Stack.Screen
        options={{
          title: created
            ? t("mobile:newGroupChat.inviteTitle")
            : t("mobile:newGroupChat.title"),
        }}
      />
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.app }}
        contentContainerStyle={{
          padding: space.lg,
          paddingBottom: space.lg + insets.bottom,
          gap: space.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {created ? <InviteStep group={created} /> : <NameStep onCreated={setCreated} />}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
