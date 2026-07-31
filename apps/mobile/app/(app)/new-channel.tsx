import { useMemo, useState } from "react";
import { KeyboardAvoidingView, ScrollView, View } from "react-native";
import { Text } from "@/components/ui/Text";
import { router, Stack, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CHANNEL_NAME_MAX_LENGTH } from "@demli/config";
import { useAppTranslation } from "@/lib/i18n";
import type { CategoryId, ChannelKind, RoleId } from "@demli/types";
import { Button } from "@/components/Button";
import { NsfwToggle } from "@/components/NsfwToggle";
import { RoleMultiSelect } from "@/components/RoleMultiSelect";
import { Segmented } from "@/components/Segmented";
import { TextField } from "@/components/TextField";
import { localizeError } from "@/lib/errors";
import { useCreateChannel, useRoles } from "@/queries/chat-queries";
import { colors, radius, space } from "@/theme/theme";

type Visibility = "public" | "restricted";

/** Owner-only: add a text or voice channel to a server. Modal from the server screen. */
export default function NewChannel() {
  const { t } = useAppTranslation();
  const params = useLocalSearchParams<{ groupId: string; categoryId?: string }>();
  const groupId = params.groupId ?? null;
  /**
   * Set when the screen was opened from a category header's "+" (M18) — the new
   * channel is filed there instead of landing in the uncategorized list, which is
   * the whole point of that button.
   */
  const categoryId = (params.categoryId ?? null) as CategoryId | null;
  const insets = useSafeAreaInsets();

  const createChannel = useCreateChannel(groupId);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<ChannelKind>("text");
  const [visibility, setVisibility] = useState<Visibility>("public");
  const [selectedRoles, setSelectedRoles] = useState<Set<RoleId>>(new Set());
  const [nsfw, setNsfw] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Roles only exist on servers; an empty list (the MVP default) hides the whole
  // visibility section — no non-functional UI (task #51).
  const { data: roles } = useRoles(groupId);
  const hasRoles = (roles?.length ?? 0) > 0;

  const toggleRole = (roleId: RoleId) => {
    setSelectedRoles((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  };

  const roleList = useMemo(() => roles ?? [], [roles]);

  const onCreate = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > CHANNEL_NAME_MAX_LENGTH) {
      setError(t("mobile:channelSettings.validationName", { max: CHANNEL_NAME_MAX_LENGTH }));
      return;
    }
    setError(null);
    // Restricted with no roles selected stays public; an unrestricted channel
    // sends no roleIds at all.
    const roleIds =
      hasRoles && visibility === "restricted" ? [...selectedRoles] : [];
    // NSFW is a text-channel-only flag (the API rejects it on voice); only send
    // it when set so voice channels never carry it.
    createChannel.mutate(
      {
        name: trimmed,
        kind,
        roleIds,
        ...(kind === "text" && nsfw ? { nsfw: true } : {}),
        // Only sent when the screen was opened from a category header, so a
        // plain "new channel" keeps landing in the uncategorized list.
        ...(categoryId ? { categoryId } : {}),
      },
      {
        onSuccess: () => router.back(),
        onError: (err) => setError(localizeError(err, t)),
      },
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
      >
        <Stack.Screen options={{ title: t("mobile:newChannel.title") }} />

        {error ? (
          <View style={{ backgroundColor: colors.dangerSurface, borderRadius: radius.sm, padding: space.sm }}>
            <Text selectable style={{ color: colors.danger, fontSize: 13 }}>
              {error}
            </Text>
          </View>
        ) : null}

        <View style={{ gap: space.md }}>
          <Segmented<ChannelKind>
            value={kind}
            onChange={setKind}
            options={[
              { value: "text", label: t("mobile:newChannel.kindText") },
              { value: "voice", label: t("mobile:newChannel.kindVoice") },
            ]}
          />
          <TextField
            label={t("mobile:newChannel.nameLabel")}
            value={name}
            onChangeText={setName}
            maxLength={CHANNEL_NAME_MAX_LENGTH}
            placeholder={
              kind === "voice"
                ? t("mobile:newChannel.placeholderVoice")
                : t("mobile:newChannel.placeholderText")
            }
            autoCapitalize="none"
            autoFocus
            returnKeyType="done"
            onSubmitEditing={onCreate}
          />

          {kind === "text" ? <NsfwToggle value={nsfw} onChange={setNsfw} /> : null}

          {hasRoles ? (
            <View style={{ gap: space.sm }}>
              <Text style={{ color: colors.fg, fontSize: 14, fontWeight: "600" }}>
                {t("mobile:newChannel.visibilityLabel")}
              </Text>
              <Segmented<Visibility>
                value={visibility}
                onChange={setVisibility}
                options={[
                  { value: "public", label: t("mobile:newChannel.visibilityEveryone") },
                  { value: "restricted", label: t("mobile:newChannel.visibilityRoles") },
                ]}
              />
              <Text style={{ color: colors.fgFaint, fontSize: 12 }}>
                {t("mobile:newChannel.visibilityNote")}
              </Text>

              {visibility === "restricted" ? (
                <RoleMultiSelect
                  roles={roleList}
                  selected={selectedRoles}
                  onToggle={toggleRole}
                />
              ) : null}
            </View>
          ) : null}

          <Button label={t("mobile:newChannel.create")} onPress={onCreate} loading={createChannel.isPending} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
