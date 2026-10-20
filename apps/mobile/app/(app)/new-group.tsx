import { useState } from "react";
import { ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { LogIn, Plus, type LucideIcon } from "lucide-react-native";
import { GROUP_NAME_MAX_LENGTH } from "@demli/config";
import { useAppTranslation } from "@/lib/i18n";
import { Avatar } from "@/components/Avatar";
import { Segmented } from "@/components/Segmented";
import { TextField } from "@/components/TextField";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Text } from "@/components/ui/Text";
import { localizeError } from "@/lib/errors";
import { parseInviteCode } from "@/lib/deep-links";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import { useCreateGroup, useRedeemInvite } from "@/queries/chat-queries";
import { colors, motion, radius, space } from "@/theme/theme";

type Mode = "create" | "join";

/**
 * Create a new friend group, or join an existing one with an invite code.
 * Presented as a modal from the Groups screen.
 *
 * Koyu Masa: one switch between the two jobs (create / join) so each form is
 * calm and alone; the create side previews the server's initials tile as you
 * name it; validation sits on the field, request failures in a banner above.
 */
export default function NewGroup() {
  const { t } = useAppTranslation();
  const createGroup = useCreateGroup();
  const redeemInvite = useRedeemInvite();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();

  const [mode, setMode] = useState<Mode>("create");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);

  const switchMode = (next: Mode) => {
    setMode(next);
    setError(null);
    setFieldError(null);
  };

  const onCreate = () => {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed.length > GROUP_NAME_MAX_LENGTH) {
      setFieldError(t("mobile:serverSettings.validationName", { max: GROUP_NAME_MAX_LENGTH }));
      return;
    }
    setError(null);
    setFieldError(null);
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
      setFieldError(t("mobile:newServer.validationCode"));
      return;
    }
    setError(null);
    setFieldError(null);
    redeemInvite.mutate(normalized, {
      onSuccess: () => router.back(),
      onError: (err) => setError(localizeError(err, t)),
    });
  };

  const hero: { icon: LucideIcon; title: string; body: string } =
    mode === "create"
      ? { icon: Plus, title: t("mobile:newServer.createTitle"), body: t("mobile:newServer.createBody") }
      : { icon: LogIn, title: t("mobile:newServer.joinTitle"), body: t("mobile:newServer.joinBody") };
  const HeroIcon = hero.icon;

  return (
    <View style={{ flex: 1, backgroundColor: colors.app }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.app }}
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.lg + insets.bottom + keyboard, gap: space.xl }}
        keyboardShouldPersistTaps="handled"
      >
        <Segmented<Mode>
          accessibilityLabel={t("mobile:newServer.modeLabel")}
          value={mode}
          onChange={switchMode}
          options={[
            { value: "create", label: t("mobile:newServer.create") },
            { value: "join", label: t("mobile:newServer.join") },
          ]}
        />

        <Animated.View
          key={mode}
          entering={FadeIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
          style={{ gap: space.lg }}
        >
          <View style={{ alignItems: "center", gap: space.md, paddingTop: space.sm }}>
            {mode === "create" ? (
              <Avatar name={name.trim() || t("mobile:newServer.namePlaceholder")} size={72} uri={null} />
            ) : (
              <View style={{ width: 72, height: 72, borderRadius: radius.pill, backgroundColor: colors.accentSurface, alignItems: "center", justifyContent: "center" }}>
                <HeroIcon size={28} color={colors.accent} strokeWidth={2} />
              </View>
            )}
            <View style={{ gap: space.xs, alignItems: "center" }}>
              <Text type="heading" tone="display" accessibilityRole="header" style={{ textAlign: "center" }}>
                {hero.title}
              </Text>
              <Text type="ui" tone="muted" style={{ textAlign: "center", fontWeight: "400", lineHeight: 20 }}>
                {hero.body}
              </Text>
            </View>
          </View>

          {error ? (
            <Banner
              variant="danger"
              title={mode === "create" ? t("mobile:newServer.createErrorTitle") : t("mobile:newServer.joinErrorTitle")}
              description={error}
            />
          ) : null}

          {mode === "create" ? (
            <>
              <TextField
                label={t("mobile:newServer.nameLabel")}
                value={name}
                onChangeText={(next) => {
                  setName(next);
                  if (fieldError) setFieldError(null);
                }}
                maxLength={GROUP_NAME_MAX_LENGTH}
                placeholder={t("mobile:newServer.namePlaceholder")}
                autoFocus
                returnKeyType="done"
                onSubmitEditing={onCreate}
                error={fieldError}
                editable={!createGroup.isPending}
              />
              <Button
                label={t("mobile:newServer.create")}
                icon={Plus}
                variant="accent"
                size="lg"
                block
                onPress={onCreate}
                loading={createGroup.isPending}
              />
            </>
          ) : (
            <>
              <TextField
                label={t("mobile:newServer.codeLabel")}
                value={code}
                onChangeText={(next) => {
                  setCode(next);
                  if (fieldError) setFieldError(null);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                autoFocus
                placeholder={t("mobile:newServer.codePlaceholder")}
                returnKeyType="go"
                onSubmitEditing={onJoin}
                error={fieldError}
                editable={!redeemInvite.isPending}
              />
              <Button
                label={t("mobile:newServer.join")}
                icon={LogIn}
                variant="accent"
                size="lg"
                block
                onPress={onJoin}
                loading={redeemInvite.isPending}
              />
            </>
          )}
        </Animated.View>
      </ScrollView>
    </View>
  );
}
