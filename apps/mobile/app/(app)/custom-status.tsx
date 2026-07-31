import { useState } from "react";
import { Alert, KeyboardAvoidingView, ScrollView, View } from "react-native";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { CUSTOM_STATUS_MAX_LENGTH } from "@demli/config";
import {
  buildCustomStatusInput,
  CUSTOM_STATUS_EXPIRY_CHOICES,
  visibleCustomStatus,
  type CustomStatusExpiry,
} from "@demli/client-core";
import { Text } from "@/components/ui/Text";
import { Button } from "@/components/Button";
import { ChipSelect } from "@/components/ChipSelect";
import { TextField } from "@/components/TextField";
import { localizeError } from "@/lib/errors";
import { useAppTranslation } from "@/lib/i18n";
import { useSetCustomStatus } from "@/queries/social-queries";
import { useAuthStore } from "@/stores/auth-store";
import { colors, radius, space } from "@/theme/theme";

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
  const setCustomStatus = useSetCustomStatus();

  // Seed from the CURRENT value once, read imperatively rather than through a
  // subscribed selector: as a dependency it would re-seed — and so wipe what the
  // user is typing — on any unrelated update to their own user record.
  const [text, setText] = useState(
    () => visibleCustomStatus(useAuthStore.getState().user) ?? "",
  );
  const [expiry, setExpiry] = useState<CustomStatusExpiry>("never");
  const [error, setError] = useState<string | null>(null);

  // Whether there is anything TO clear — read live, so the button disappears the
  // moment the status is gone (including when another device cleared it).
  const hasStatus = useAuthStore((s) => visibleCustomStatus(s.user) !== null);

  const busy = setCustomStatus.isPending;

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
    Alert.alert(t("mobile:customStatus.clear"), t("mobile:customStatus.description"), [
      { text: t("buttons.cancel"), style: "cancel" },
      {
        text: t("mobile:customStatus.clear"),
        style: "destructive",
        onPress: () =>
          setCustomStatus.mutate(
            { text: null },
            {
              onSuccess: () => router.back(),
              onError: (err) => setError(localizeError(err, t)),
            },
          ),
      },
    ]);
  };

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1, backgroundColor: colors.app }}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: colors.app }}
        contentContainerStyle={{
          padding: space.lg,
          paddingBottom: space.xl + insets.bottom,
          gap: space.lg,
        }}
        keyboardShouldPersistTaps="handled"
      >
        {error ? (
          <View
            style={{
              backgroundColor: colors.dangerSurface,
              borderRadius: radius.sm,
              borderCurve: "continuous",
              padding: space.sm,
            }}
          >
            <Text selectable style={{ color: colors.danger, fontSize: 13 }}>
              {error}
            </Text>
          </View>
        ) : null}

        <Text style={{ color: colors.fgMuted, fontSize: 13, lineHeight: 19 }}>
          {t("mobile:customStatus.description")}
        </Text>

        <View style={{ gap: space.xs }}>
          <TextField
            label={t("mobile:customStatus.textLabel")}
            value={text}
            onChangeText={setText}
            maxLength={CUSTOM_STATUS_MAX_LENGTH}
            autoFocus
            placeholder={t("mobile:customStatus.textPlaceholder")}
            returnKeyType="done"
            onSubmitEditing={onSave}
          />
          <Text style={{ color: colors.fgFaint, fontSize: 12, textAlign: "right" }}>
            {text.length}/{CUSTOM_STATUS_MAX_LENGTH}
          </Text>
        </View>

        <View style={{ gap: space.sm }}>
          <Text style={{ color: colors.fgMuted, fontSize: 13, fontWeight: "600" }}>
            {t("mobile:customStatus.clearAfter")}
          </Text>
          <ChipSelect
            options={CUSTOM_STATUS_EXPIRY_CHOICES.map((key) => ({
              key,
              label: t(EXPIRY_LABEL_KEY[key]),
            }))}
            selectedKey={expiry}
            onSelect={(key) => setExpiry(key as CustomStatusExpiry)}
          />
        </View>

        <View style={{ gap: space.sm }}>
          <Button label={t("mobile:customStatus.save")} onPress={onSave} loading={busy} />
          {/* Only offered when there IS something to clear — an always-on
              "Clear" next to an empty field would do nothing (§35). */}
          {hasStatus ? (
            <Button
              label={t("mobile:customStatus.clear")}
              variant="danger"
              onPress={onClear}
              disabled={busy}
              style={{ borderRadius: radius.md }}
            />
          ) : null}
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
