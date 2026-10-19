import { useState } from "react";
import { ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, { FadeIn, ReduceMotion } from "react-native-reanimated";
import { Eraser, Save } from "lucide-react-native";
import { CUSTOM_STATUS_MAX_LENGTH } from "@demli/config";
import {
  buildCustomStatusInput,
  CUSTOM_STATUS_EXPIRY_CHOICES,
  visibleCustomStatus,
  type CustomStatusExpiry,
} from "@demli/client-core";
import { Avatar } from "@/components/Avatar";
import { ChipSelect } from "@/components/ChipSelect";
import { TextField } from "@/components/TextField";
import { ConfirmSheet } from "@/components/settings/ConfirmSheet";
import { SectionEyebrow } from "@/components/settings/SettingsSection";
import { Banner } from "@/components/ui/Banner";
import { Button } from "@/components/ui/Button";
import { Text } from "@/components/ui/Text";
import { localizeError } from "@/lib/errors";
import { useAppTranslation } from "@/lib/i18n";
import { useKeyboardHeight } from "@/lib/use-keyboard-height";
import { useSetCustomStatus } from "@/queries/social-queries";
import { useAuthStore } from "@/stores/auth-store";
import { useSelfPresenceAsSeen } from "@/lib/use-self-presence";
import { colors, motion, radius, space } from "@/theme/theme";

/** One catalog key per duration, so a new choice is a compile error here. */
const EXPIRY_LABEL_KEY = {
  never: "mobile:customStatus.never",
  "30m": "mobile:customStatus.minutes30",
  "1h": "mobile:customStatus.hour1",
  today: "mobile:customStatus.today",
} as const satisfies Record<CustomStatusExpiry, string>;

/**
 * "Set a custom status" (M18) — mobile mirror of the desktop CustomStatusDialog:
 * a short free-text line shown under your name, with an optional auto-clear.
 * A live preview shows the line exactly where friends will see it (your avatar,
 * name, and the status bubble the profile card draws) while you type.
 *
 * The text is stored and rendered as PLAIN TEXT: it goes out raw and comes back
 * as a JSX child everywhere it is shown (roster row, profile card, You tab). It
 * is never fed to the markdown renderer — a status line is not a message and
 * must not be able to inject formatting (§28).
 *
 * What each duration MEANS lives in `@demli/client-core` (buildCustomStatusInput),
 * shared with desktop/web so "today" cannot mean local midnight on one surface
 * and something else on the other.
 */
export default function CustomStatusScreen() {
  const { t } = useAppTranslation();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardHeight();
  const setCustomStatus = useSetCustomStatus();
  const me = useAuthStore((s) => s.user);
  // The preview is "how others see you": your chosen status, invisible = offline.
  const selfPresence = useSelfPresenceAsSeen();

  // Seed from the CURRENT value once, read imperatively rather than through a
  // subscribed selector: as a dependency it would re-seed — and so wipe what the
  // user is typing — on any unrelated update to their own user record.
  const [text, setText] = useState(() => visibleCustomStatus(useAuthStore.getState().user) ?? "");
  const [expiry, setExpiry] = useState<CustomStatusExpiry>("never");
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  // Whether there is anything TO clear — read live, so the button disappears the
  // moment the status is gone (including when another device cleared it).
  const hasStatus = useAuthStore((s) => visibleCustomStatus(s.user) !== null);

  const busy = setCustomStatus.isPending;
  const name = me?.displayName || me?.username || t("mobile:common.you");
  const trimmed = text.trim();

  const onSave = () => {
    if (busy) return;
    setError(null);
    setCustomStatus.mutate(buildCustomStatusInput(text, expiry), {
      onSuccess: () => router.back(),
      onError: (err) => setError(localizeError(err, t)),
    });
  };

  const onClear = () => {
    if (busy) return;
    setError(null);
    setCustomStatus.mutate(
      { text: null },
      {
        onSuccess: () => {
          setConfirmClear(false);
          router.back();
        },
        onError: (err) => setError(localizeError(err, t)),
      },
    );
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.app }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.app }}
        contentContainerStyle={{ padding: space.lg, paddingBottom: space.xl + insets.bottom + keyboard, gap: space.xl }}
        keyboardShouldPersistTaps="handled"
      >
        {/* Live preview — where the line actually shows. */}
        <View>
          <SectionEyebrow>{t("mobile:customStatus.previewHeading")}</SectionEyebrow>
          <View
            accessible
            accessibilityLabel={`${t("mobile:customStatus.previewHeading")}: ${name}${trimmed ? `, ${trimmed}` : ""}`}
            style={{
              flexDirection: "row",
              alignItems: "flex-start",
              gap: space.md,
              padding: space.lg,
              borderRadius: radius.xl,
              borderCurve: "continuous",
              backgroundColor: colors.surface,
            }}
          >
            <Avatar name={name} size={44} uri={me?.avatarUrl} presence={selfPresence} ringColor={colors.surface} />
            <View style={{ flex: 1, gap: space.xs }}>
              <Text type="body" tone="default" numberOfLines={1} style={{ fontWeight: "600" }}>
                {name}
              </Text>
              {trimmed ? (
                <Animated.View
                  entering={FadeIn.duration(motion.duration.fast).reduceMotion(ReduceMotion.System)}
                  style={{
                    alignSelf: "flex-start",
                    maxWidth: "100%",
                    paddingHorizontal: space.md,
                    paddingVertical: space.xs + 2,
                    borderRadius: radius.lg,
                    borderTopLeftRadius: radius.sm / 2,
                    backgroundColor: colors.surfaceRaised,
                  }}
                >
                  <Text type="ui" tone="default" style={{ fontWeight: "400" }}>
                    {trimmed}
                  </Text>
                </Animated.View>
              ) : (
                <Text type="meta" tone="faint" style={{ fontWeight: "400" }}>
                  {t("mobile:customStatus.rowSubtitleEmpty")}
                </Text>
              )}
            </View>
          </View>
        </View>

        {error && !confirmClear ? (
          <Banner
            variant="danger"
            title={t("mobile:customStatus.saveErrorTitle")}
            description={error}
            onDismiss={() => setError(null)}
          />
        ) : null}

        <TextField
          label={t("mobile:customStatus.textLabel")}
          value={text}
          onChangeText={setText}
          maxLength={CUSTOM_STATUS_MAX_LENGTH}
          autoFocus
          placeholder={t("mobile:customStatus.textPlaceholder")}
          returnKeyType="done"
          onSubmitEditing={onSave}
          hint={`${t("mobile:customStatus.description")} · ${t("mobile:customStatus.count", {
            count: text.length,
            max: CUSTOM_STATUS_MAX_LENGTH,
          })}`}
          editable={!busy}
        />

        <View>
          <SectionEyebrow>{t("mobile:customStatus.clearAfter")}</SectionEyebrow>
          <ChipSelect
            accessibilityLabel={t("mobile:customStatus.clearAfter")}
            options={CUSTOM_STATUS_EXPIRY_CHOICES.map((key) => ({ key, label: t(EXPIRY_LABEL_KEY[key]) }))}
            selectedKey={expiry}
            onSelect={(key) => setExpiry(key as CustomStatusExpiry)}
          />
        </View>

        <View style={{ gap: space.sm }}>
          <Button
            label={t("mobile:customStatus.save")}
            icon={Save}
            variant="accent"
            size="lg"
            block
            onPress={onSave}
            loading={busy && !confirmClear}
            disabled={busy && confirmClear}
          />
          {/* Only offered when there IS something to clear — an always-on
              "Clear" next to an empty field would do nothing (§35). */}
          {hasStatus ? (
            <Button
              label={t("mobile:customStatus.clear")}
              icon={Eraser}
              variant="danger"
              size="lg"
              block
              onPress={() => {
                setError(null);
                setConfirmClear(true);
              }}
              disabled={busy}
            />
          ) : null}
        </View>
      </ScrollView>

      <ConfirmSheet
        visible={confirmClear}
        title={t("mobile:customStatus.clearConfirmTitle")}
        body={t("mobile:customStatus.clearConfirmBody")}
        confirmLabel={t("mobile:customStatus.clear")}
        confirmIcon={Eraser}
        onConfirm={onClear}
        cancelLabel={t("common:buttons.cancel")}
        onCancel={() => setConfirmClear(false)}
        busy={busy}
        error={confirmClear ? error : null}
      />
    </View>
  );
}
