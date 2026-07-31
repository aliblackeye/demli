import { useState } from "react";
import { KeyboardAvoidingView, ScrollView, View } from "react-native";
import { Text } from "@/components/ui/Text";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { GROUP_NAME_MAX_LENGTH } from "@demli/config";
import { useAppTranslation } from "@/lib/i18n";
import { Button } from "@/components/Button";
import { TextField } from "@/components/TextField";
import { localizeError } from "@/lib/errors";
import { parseInviteCode } from "@/lib/deep-links";
import { useCreateGroup, useRedeemInvite } from "@/queries/chat-queries";
import { colors, radius, space } from "@/theme/theme";

/**
 * Create a new friend group, or join an existing one with an invite code.
 * Presented as a modal from the Groups screen.
 */
export default function NewGroup() {
  const { t } = useAppTranslation();
  const createGroup = useCreateGroup();
  const redeemInvite = useRedeemInvite();
  const insets = useSafeAreaInsets();

  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);

  const onCreate = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > GROUP_NAME_MAX_LENGTH) {
      setError(t("mobile:serverSettings.validationName", { max: GROUP_NAME_MAX_LENGTH }));
      return;
    }
    setError(null);
    createGroup.mutate(
      { name: trimmed },
      {
        onSuccess: () => router.back(),
        onError: (err) => setError(localizeError(err, t)),
      },
    );
  };

  const onJoin = () => {
    const normalized = parseInviteCode(code);
    if (normalized.length < 4) {
      setError(t("mobile:newServer.validationCode"));
      return;
    }
    setError(null);
    redeemInvite.mutate(normalized, {
      onSuccess: () => router.back(),
      onError: (err) => setError(localizeError(err, t)),
    });
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
          paddingBottom: space.lg + insets.bottom,
          gap: space.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {error ? (
          <View style={{ backgroundColor: colors.dangerSurface, borderRadius: radius.sm, padding: space.sm }}>
            <Text selectable style={{ color: colors.danger, fontSize: 13 }}>
              {error}
            </Text>
          </View>
        ) : null}

        <View style={{ gap: space.md }}>
          <Text variant="display" style={{ color: colors.fg, fontSize: 16, fontWeight: "700" }}>
            {t("mobile:newServer.createTitle")}
          </Text>
          <TextField
            label={t("mobile:newServer.nameLabel")}
            value={name}
            onChangeText={setName}
            maxLength={GROUP_NAME_MAX_LENGTH}
            placeholder={t("mobile:newServer.namePlaceholder")}
            autoFocus
          />
          <Button label={t("mobile:newServer.create")} onPress={onCreate} loading={createGroup.isPending} />
        </View>

        <View style={{ height: 1, backgroundColor: colors.stroke }} />

        <View style={{ gap: space.md }}>
          <Text variant="display" style={{ color: colors.fg, fontSize: 16, fontWeight: "700" }}>
            {t("mobile:newServer.joinTitle")}
          </Text>
          <TextField
            label={t("mobile:newServer.codeLabel")}
            value={code}
            onChangeText={setCode}
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t("mobile:newServer.codePlaceholder")}
          />
          <Button label={t("mobile:newServer.join")} variant="ghost" onPress={onJoin} loading={redeemInvite.isPending} />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
